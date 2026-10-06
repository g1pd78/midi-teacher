import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  api,
  listen,
  PADS_DEVICE,
  type AttemptRecord,
  type Converted,
  type GuitarConfig,
  type MidiInfo,
  type PieceInstrument,
  type PieceSetup,
  saveTextAs,
  type HandMode,
  type KeyMap,
  type MeasureErrors,
  type PieceNoteIn,
  type PiecePrefs,
  type PieceSummary,
  type PlayHands,
  type PracticeView,
  type RhythmSummary,
  type Suggestion,
  type UnitView,
} from "../api";
import { Piano } from "../components/Piano";
import { Fretboard, type FretMark } from "../components/Fretboard";
import { TabHighway, type HighwayNote } from "../components/TabHighway";
import { DrumHighway, type DrumLaneNote } from "../components/DrumHighway";
import { DrumPads } from "../components/DrumPads";
import { RecordTake } from "../components/RecordTake";
import { MoreMenu } from "../components/MoreMenu";
import { RhythmPads } from "../components/RhythmPads";
import { PASS_DYNAMICS, drumMei, drumPartFromMidi, dynamicsOf, evaluateDynamics } from "../lib/drums";
import { FRETS, MIRROR, meiToTab, nearestPosition, readTuning, tabStaff, withStaff, type StringInstrument } from "../lib/tab";
import { TUNINGS, openTuning, sameTuning, tuningLabel, TUNING_PRESETS } from "../lib/guitar";
import { openSongFile, type FileSong } from "../lib/filesong";
import { PART_KIND_NAME } from "../lib/tabsong";
import { RetunePanel } from "../components/Tuner";
import { TrackDialog } from "../components/TrackDialog";
import { accompNotes, overrideFor, toggleOverride } from "../lib/midi";
import { grooveStats } from "../lib/groove";
import { TheoryPlaque } from "../components/Theory";
import { detectFeatures, tabFeatures } from "../lib/theory";
import { Waterfall, type NoteState } from "../components/Waterfall";
import { keyLabel } from "../lib/notes";
import { fingerNotes, injectFingering, parseFinger, type Finger } from "../lib/fingering";
import { PASS_ACCURACY, evaluate, type Evaluation, type HitRecord } from "../lib/exercises";
import type { Hints } from "../lib/reading";
import { songFromScore } from "../lib/songs";
import { RHYTHM_LEFT, RHYTHM_RIGHT } from "../lib/rhythm";
import {
  STREAK_TO_ADVANCE,
  levelPreset,
  levelTempo,
  measureHands,
  phraseEnds,
  rhythmAccuracy,
  waitAccuracy,
} from "../lib/practice";
import {
  addNoteNames,
  beatDuration,
  buildBeats,
  buildNotes,
  initialTempo,
  loopRangeMs,
  measureStarts,
  parseMei,
} from "../lib/score";
import { ClockSync, stepAt, transportPos, type Transport } from "../lib/transport";
import { loadScore, renderScore, warmUpVerovio } from "../lib/verovio";
import { SCREEN_DEVICE, deviceColor, useApp } from "../store";
import { Toggle } from "../components/Toggle";
import { GuidePanel, SuggestionBar } from "./piece/GuidePanel";
import { ExerciseSummary, ExerciseWaitSummary, RhythmSummaryPanel, WaitSummary } from "./piece/Summaries";
import {
  ACCID,
  HAND_COLOR,
  HAND_NAME,
  INSTRUMENT_NAME,
  NO_SETUP,
  SOLFEGE,
  TEMPO_MAX,
  TEMPO_MIN,
  TRANSPOSE_MAX,
  WATERFALL_SEC,
  alignRows,
  capPageWidth,
  clampTempo,
  measureAt,
  percent,
  streakOf,
  toIn,
  verovioLayout,
  type Current,
  type Loop,
  type Rect,
  type Score,
} from "./piece/helpers";
import type { ExerciseContext, PieceSource, WaitResult } from "./piece/types";
import { useGuitarHints } from "./piece/useGuitarHints";

export type { ExerciseContext, PieceSource } from "./piece/types";

export function PieceView({ source, onBack, exercise }: { source: PieceSource; onBack: () => void; exercise?: ExerciseContext }) {
  const { prefs, setPrefs, held, devices } = useApp();
  const p = prefs.piece;
  // Свежие настройки из хранилища: две правки подряд (до перерисовки) не затирают друг друга.
  const setPiece = (patch: Partial<PiecePrefs>) => setPrefs({ piece: { ...useApp.getState().prefs.piece, ...patch } });
  const naming = prefs.noteNames;
  const guided = !exercise && p.guided;
  // Упражнения: режим, темп и метроном — свои, не из настроек пьес.
  const [exMode, setExMode] = useState<"wait" | "rhythm">(exercise?.rhythmOnly ? "rhythm" : (exercise?.defaultMode ?? "rhythm"));
  // Подсказки ступени (чтение с листа): переключатели меняют их только для этой мелодии.
  const [exHints, setExHints] = useState<Hints | null>(exercise?.hints ?? null);
  const [waitResult, setWaitResult] = useState<WaitResult | null>(null);
  // «▶ Послушать»: приложение играет всё само, потом — обратно в прежний режим.
  const [listening, setListening] = useState<"wait" | "rhythm" | null>(null);
  const listeningRef = useRef(listening);
  listeningRef.current = listening;
  const rhythmEx = exercise?.instrument === "rhythm";
  const keyMap: KeyMap = exercise?.keyMap ?? source.keyMap ?? "exact";
  const [exTempo, setExTempo] = useState(1);
  const [exMetronome, setExMetronome] = useState(true);
  const [exResult, setExResult] = useState<Evaluation | null>(null);
  const hitLog = useRef<HitRecord[]>([]);
  // Настройки этой пьесы: тон, дорожки MIDI, правка рук.
  const setup: PieceSetup = { ...NO_SETUP, ...prefs.pieceSetup?.[source.id] };
  const setSetup = (patch: Partial<PieceSetup>) => {
    const all = useApp.getState().prefs.pieceSetup ?? {};
    setPrefs({ pieceSetup: { ...all, [source.id]: { ...NO_SETUP, ...all[source.id], ...patch } } });
  };
  const transpose = exercise || source.songFile ? 0 : setup.transpose;
  // Песня из файла с партиями: выбранная партия (инструмент — по ней).
  const [fileSong, setFileSong] = useState<FileSong | null>(null);
  const partIndex = fileSong ? Math.min(setup.arrangement ?? 0, fileSong.parts.length - 1) : 0;
  const filePart = fileSong ? fileSong.parts[partIndex] : null;
  const partMei = useMemo(() => (fileSong ? fileSong.chart(partIndex) : null), [fileSong, partIndex]);
  // На чём играем: фортепиано или гитара/бас (табы и гриф).
  const [guitarOn, setGuitarOn] = useState<boolean | null>(null);
  // Аппликатура своя для каждого тона: в другой тональности другие пальцы.
  const fingerKey = transpose ? `${source.id}@${transpose > 0 ? "+" : ""}${transpose}` : source.id;
  // MIDI: окно дорожек, результат перевода в ноты, правка рук.
  const [midiInfo, setMidiInfo] = useState<MidiInfo | null>(null);
  const [trackDialog, setTrackDialog] = useState(false);
  const [converted, setConverted] = useState<Converted | null>(null);
  // Барабаны у пьесы — только у MIDI с ролью «Барабаны»; MIDI из одних барабанов — сразу барабаны.
  const wantDrums = setup.instrument === "drums";
  const midiDrums = !!converted?.drums;
  const drumsOnly = midiDrums && !converted?.handsAccompaniment.length;
  const instrument: PieceInstrument = exercise
    ? exercise.instrument === "drums"
      ? "drums"
      : exercise.instrument === "guitar" || exercise.instrument === "bass"
        ? exercise.instrument
        : "piano"
    : source.instrument
      ? source.instrument
    : source.songFile
      ? filePart?.kind === "bass"
        ? "bass"
        : filePart?.kind === "drums"
          ? "drums"
          : filePart?.kind === "piano" || filePart?.kind === "other"
            ? "piano"
            : "guitar"
    : drumsOnly
      ? "drums"
      : wantDrums && !(source.midi && (midiDrums || !converted))
        ? "piano"
        : (setup.instrument ?? "piano");
  const strInst: StringInstrument | null = instrument === "guitar" || instrument === "bass" ? instrument : null;
  // Барабаны: ударный стан, дорожка по барабанам, пэды вместо клавиатуры.
  const drums = instrument === "drums";
  // Прогресс разучивания у гитары, баса и барабанов свой.
  const practiceId = filePart ? `${source.id}#${filePart.id}` : instrument !== "piano" ? `${source.id}#${instrument}` : source.id;
  const [editHands, setEditHands] = useState(false);

  const [mei, setMei] = useState<string | null>(null);
  const [pages, setPages] = useState<string[]>([]);
  const [score, setScore] = useState<Score | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [width, setWidth] = useState(1200);
  const [run, setRun] = useState(0);

  // Движок практики
  const [practice, setPractice] = useState<PracticeView | null>(null);
  const [practiceError, setPracticeError] = useState<string | null>(null);
  const [unitSel, setUnitSel] = useState<number | null>(null);
  const [suggestion, setSuggestion] = useState<{ s: Suggestion; key: string } | null>(null);
  const dismissed = useRef(new Set<string>());
  const [editBounds, setEditBounds] = useState(false);
  // Аппликатура
  const [fingers, setFingers] = useState<Finger[] | null>(null);
  const [editFingers, setEditFingers] = useState(false);
  const [selNote, setSelNote] = useState<string | null>(null);

  // Режим ожидания
  const [current, setCurrent] = useState<Current | null>(null);
  const [hits, setHits] = useState<Set<string>>(new Set());
  const [waitSummary, setWaitSummary] = useState<PieceSummary | null>(null);
  // Режим ритма
  const [playing, setPlaying] = useState(false);
  const playingRef = useRef(false);
  playingRef.current = playing;
  const [rhythmStep, setRhythmStep] = useState(-1);
  const [rhythmSummary, setRhythmSummary] = useState<RhythmSummary | null>(null);
  const [marksVersion, setMarksVersion] = useState(0);
  const transport = useRef<Transport | null>(null);
  const clock = useRef(new ClockSync());
  // Общее
  const [wrongKey, setWrongKey] = useState<number | null>(null);
  const [loop, setLoop] = useState<Loop | null>(null);
  const loopClicks = useRef(0);
  const [toast, setToast] = useState<string | null>(null);
  const noteStates = useRef(new Map<string, NoteState>());

  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const marked = useRef<Element[]>([]);
  const [boxes, setBoxes] = useState<(Rect | null)[]>([]);

  const notes = useMemo(() => score?.notes ?? [], [score]);
  // Высота и рука входят в ключ: при смене тона id нот не меняются, а ноты — да.
  const notesKey = useMemo(() => notes.map((n) => `${n.id}:${n.pitch}:${n.hand}`).join(","), [notes]);
  const measures = score?.structure.measures ?? 0;
  const hasLeft = notes.some((n) => n.hand === "left");
  const hasRight = notes.some((n) => n.hand === "right");

  // --- Что сейчас играем: отрезок и уровень (ведущий режим) или свои настройки ---
  const unit: UnitView | null = guided && practice ? (practice.units[unitSel ?? practice.current] ?? null) : null;
  const level = unit?.state.level ?? 0;
  const preset = unit ? levelPreset(level) : null;
  const rhythmMode = exercise ? exMode === "rhythm" : (preset ? preset.mode : p.mode) === "rhythm";
  const freeHands: HandMode = !hasLeft ? "right" : !hasRight ? "left" : exercise ? (exercise.hands ?? "both") : p.hands;
  const hands: PlayHands = listening ? "none" : unit ? unit.hand : freeHands;
  const tempo = exercise ? exTempo : unit ? levelTempo(level, unit.state.tempo) : p.tempo;
  const accompany = unit || exercise ? true : p.accompany;
  const countIn = p.countIn;
  const metronome = exercise ? exMetronome : p.metronome;
  const showNames = drums || rhythmEx ? false : exHints ? exHints.names : preset ? preset.names : p.names;
  const keyHints = exHints ? exHints.keyHints : preset ? preset.keyHints : p.keyHints;
  const showWaterfall = exHints ? exHints.waterfall : preset ? preset.waterfall : p.waterfall;
  const hideRange = preset?.hide ?? false;
  // Аппликатура в ведущем режиме — на уровнях 0–2, в свободной игре — по переключателю.
  const showFingers = !strInst && !rhythmEx && (editFingers || (exHints ? exHints.fingering : unit ? level <= 2 : p.fingering));
  const range: Loop | null = unit ? { from: unit.from, to: unit.to } : loop;
  const rangeFrom = range?.from ?? 0;
  const rangeTo = range?.to ?? 0;
  const unitKey = unit ? `${unit.from}-${unit.to}` : "";
  // Ведущий режим ждёт данные практики (если база недоступна — играем свободно).
  const ready = !guided || practice !== null || practiceError !== null;

  const includes = useCallback((hand: "right" | "left") => hands === "both" || hands === hand, [hands]);
  // При прослушивании подсвечиваем все ноты цветом рук.
  const shows = useCallback((hand: "right" | "left") => hands === "none" || includes(hand), [hands, includes]);
  const noteById = useMemo(() => new Map(notes.map((n) => [n.id, n])), [notes]);
  const loopMs = useMemo(
    () => (score && rangeFrom ? loopRangeMs(score.starts, score.endMs, rangeFrom, rangeTo) : null),
    [score, rangeFrom, rangeTo],
  );

  const scoreRef = useRef(score);
  scoreRef.current = score;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // Загрузка файла → MEI. MIDI сначала переводится в MusicXML с выбранными дорожками;
  // если дорожки ещё не выбраны — сначала окно дорожек.
  const rolesKey = setup.roles?.join(",") ?? "";
  const overridesKey = JSON.stringify(setup.handOverrides);
  useEffect(() => {
    warmUpVerovio();
    let alive = true;
    const fail = (e: unknown) => alive && setError(`Не удалось открыть ноты: ${(e as Error)?.message ?? e}`);
    if (source.songFile) {
      if (!fileSong)
        openSongFile(source.songFile.id, source.songFile.format, source.title)
          .then((song) => alive && setFileSong(song))
          .catch(fail);
      else if (partMei)
        loadScore(partMei, false)
          .then((m) => alive && setMei(m))
          .catch(fail);
    } else if (source.midi) {
      const file = source.midi;
      if (!setup.roles) {
        api
          .midiInspect(file)
          .then((info) => {
            if (!alive) return;
            setMidiInfo(info);
            setTrackDialog(true);
          })
          .catch(fail);
      } else {
        api
          .midiConvert(file, { roles: setup.roles, handOverrides: setup.handOverrides, transpose, title: source.title })
          .then((c) => {
            if (!alive) return null;
            setConverted(c);
            if (c.drums && (wantDrums || !c.handsAccompaniment.length))
              return drumMei(drumPartFromMidi(c.drums, c.bpm, c.meter), { title: source.title });
            return loadScore(c.musicxml, false);
          })
          .then((m) => alive && m && setMei(m))
          .catch(fail);
      }
    } else {
      source
        .load()
        .then(({ data, zip }) => loadScore(data, zip, transpose))
        .then((m) => alive && setMei(m))
        .catch(fail);
    }
    return () => {
      alive = false;
    };
    // setup.roles и setup.handOverrides входят в rolesKey и overridesKey
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source, transpose, rolesKey, overridesKey, wantDrums, fileSong, partMei]);
  useEffect(
    () => () => {
      void api.pieceStop();
      void api.rhythmStop();
      void api.midiPreviewStop();
    },
    [source],
  );
  // Аккомпанемент из MIDI: звучит вместе с учеником, на нотах не показывается.
  // Играешь барабаны — руки тоже звучат аккомпанементом.
  // Песня из файла: остальные партии.
  const accomp = useMemo(
    () =>
      fileSong
        ? accompNotes(fileSong.accompaniment(partIndex)).map((n) => ({ ...n, id: `fs-${n.id}` }))
        : source.accompaniment
          ? accompNotes(source.accompaniment).map((n) => ({ ...n, id: `ex-${n.id}` }))
          : converted
          ? accompNotes(drums ? [...converted.accompaniment, ...converted.handsAccompaniment] : converted.accompaniment)
          : [],
    [converted, drums, fileSong, partIndex, source.accompaniment],
  );

  // Размер области нот: ширина — для раскладки страниц, полный размер — для рамок тактов.
  const [boxSize, setBoxSize] = useState("");
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setWidth(Math.round(el.clientWidth / 100) * 100);
      setBoxSize(`${el.clientWidth}x${el.clientHeight}`);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Рендер нот и разбор пьесы.
  const layoutKey = p.layout === "pages" ? `pages-${width}` : "line";
  // Названия нот — только у рук, которые играет ученик: так строка нот ниже и крупнее.
  // Разбор MEI пьесы — один раз на файл (он нужен табам, аккомпанементу и числу станов).
  const meiInfo = useMemo(() => (mei ? parseMei(mei) : null), [mei]);
  const staves = meiInfo?.staves ?? 0;
  // Гитара/бас: одна партия в табулатуре (готовые табы из файла — как есть).
  const fileTab = useMemo(() => (mei ? tabStaff(mei) : null), [mei]);
  const partStaff = strInst ? (fileTab ?? Math.min(Math.max(1, staves), setup.part || (strInst === "bass" && staves >= 2 ? 2 : 1))) : 0;
  // Строй: свой у инструмента (настройки гитары) и у пьесы (песня Rocksmith, табы из файла или выбранный).
  const [guitarCfg, setGuitarCfg] = useState<GuitarConfig | null>(null);
  const myOpen = strInst ? openTuning({ instrument: strInst, tuning: guitarCfg?.tuning ?? null }) : [];
  const myCapo = guitarCfg?.capo ?? 0;
  const fileTuning = useMemo(() => (mei && fileTab ? readTuning(mei, fileTab) : null), [mei, fileTab]);
  const fixedTab = !!((filePart?.tuning && strInst) || fileTab);
  const pieceOpen: number[] = !strInst
    ? []
    : filePart?.tuning && filePart.tuning.length
      ? filePart.tuning
      : fileTab
        ? (fileTuning ?? TUNINGS[strInst])
        : setup.tuning && setup.tuning.length === TUNINGS[strInst].length
          ? setup.tuning
          : myOpen;
  const pieceCapo = filePart?.tuning ? filePart.capo : fileTab ? 0 : (setup.capo ?? myCapo);
  const sounding = (t: number[], capo: number) => t.map((m) => m + capo);
  const tuningDiffers = !!strInst && !!guitarCfg && !sameTuning(sounding(pieceOpen, pieceCapo), sounding(myOpen, myCapo));
  const relayout = tuningDiffers && !!setup.relayout;
  const tabOpen = relayout ? myOpen : pieceOpen;
  const tabCapo = relayout ? myCapo : pieceCapo;
  const tabKey = `${tabOpen.join(",")}|${tabCapo}|${relayout}`;
  const tab = useMemo(
    () =>
      strInst && mei
        ? meiToTab(mei, partStaff, strInst, meiInfo!.meter, fixedTab && !relayout ? {} : { tuning: tabOpen, capo: tabCapo, relayout })
        : null,
    // tabOpen, tabCapo и relayout входят в tabKey
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [mei, strInst, partStaff, fixedTab, tabKey],
  );
  const [retune, setRetune] = useState(false);
  // Обычные ноты над табулатурой (копии нот таба, в оценке не участвуют).
  const staffWithTab = !!p.staffWithTab;
  const displayMei = tab ? (staffWithTab ? withStaff(tab.mei, tab.tuning, strInst!) : tab.mei) : mei;
  const nameStaves = staves < 2 || hands === "both" || hands === "none" ? "all" : hands === "right" ? "1" : "2";
  const fingersKey = useMemo(() => fingers?.map((f) => `${f.id}:${f.finger}:${f.source[0]}`).join(",") ?? "", [fingers]);
  useEffect(() => {
    if (!displayMei) return;
    let alive = true;
    let text = showNames && !tab
      ? addNoteNames(displayMei, (pname, accid) => {
          const base = naming === "solfege" ? SOLFEGE[pname] : pname.toUpperCase();
          return base + (accid ? (ACCID[accid] ?? "") : "");
        }, nameStaves === "all" ? undefined : new Set([Number(nameStaves)]))
      : displayMei;
    // Цифры пальцев (файл + правки + подбор) заменяют аппликатуру из файла.
    const sc = scoreRef.current;
    if (fingers && sc && !tab) text = injectFingering(text, fingers, sc.notes);
    renderScore(text, verovioLayout(p.layout, width, !!tab, !!tab && staffWithTab))
      .then((r) => {
        if (!alive) return;
        const structure = parseMei(displayMei);
        const notes = buildNotes(r.timemap, r.midi, structure).filter((n) => !n.id.endsWith(MIRROR));
        setPages(r.pages);
        setScore({
          notes,
          structure,
          starts: measureStarts(r.timemap, structure),
          tempoBpm: initialTempo(r.timemap),
          endMs: Math.max(0, ...notes.map((n) => n.startMs + n.durMs)),
        });
      })
      .catch((e) => alive && setError(String(e)));
    return () => {
      alive = false;
    };
    // width входит в layoutKey, fingers — в fingersKey
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [displayMei, showNames, naming, layoutKey, fingersKey, nameStaves]);

  // Гитара/бас: остальные партии пьесы звучат аккомпанементом (ноты того же MEI).
  const [otherNotes, setOtherNotes] = useState<PieceNoteIn[]>([]);
  // Сессия стартует, когда аккомпанемент готов, — иначе она перезапустилась бы на первой ноте.
  const [otherReady, setOtherReady] = useState(true);
  useEffect(() => {
    setOtherNotes([]);
    if (!tab || !mei || fileTab) {
      setOtherReady(true);
      return;
    }
    setOtherReady(false);
    let alive = true;
    renderScore(mei, verovioLayout("line", 1200))
      .then((r) => {
        if (!alive) return;
        const info = meiInfo ?? parseMei(mei);
        const all = buildNotes(r.timemap, r.midi, info);
        const staffOf = info.staffOf;
        setOtherNotes(all.filter((n) => staffOf.get(n.id) !== partStaff).map((n) => ({ ...toIn(n), id: `o-${n.id}`, hand: "accomp" })));
      })
      .catch(() => {})
      .finally(() => alive && setOtherReady(true));
    return () => {
      alive = false;
    };
  }, [tab, mei, fileTab, partStaff]);
  // Всё, что играет приложение помимо ученика: аккомпанемент MIDI и другие партии для гитары/баса.
  const accompAll = useMemo(() => [...accomp, ...otherNotes], [accomp, otherNotes]);
  // Вход гитары: инструмент тюнера — как у пьесы; предупреждение, если вход выключен.
  useEffect(() => {
    if (!strInst) return;
    let alive = true;
    api
      .guitarState()
      .then((g) => {
        if (!alive) return;
        setGuitarOn(g.config.enabled);
        setGuitarCfg({ ...g.config, instrument: strInst });
        if (g.config.instrument !== strInst) void api.guitarSet({ ...g.config, instrument: strInst });
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [strInst, retune]);

  // Аппликатура пьесы от ядра: ручные правки → файл → автоматический подбор.
  const fingerInput = useMemo(
    () => (scoreRef.current ? fingerNotes(scoreRef.current.notes, scoreRef.current.structure) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [notesKey],
  );
  useEffect(() => {
    if (!fingerInput.length || strInst || drums) return;
    // Ответ для прежнего тона или пьесы не должен перезаписать новый.
    let alive = true;
    api
      .fingeringGet(fingerKey, fingerInput)
      .then((f) => alive && setFingers(f))
      .catch(() => alive && setFingers(null));
    return () => {
      alive = false;
    };
  }, [fingerInput, fingerKey, strInst, drums]);
  const fingerOf = useMemo(() => new Map((fingers ?? []).map((f) => [f.id, f])), [fingers]);
  // Элементы нотной записи в пьесе — для плашек теории «Новое».
  const tabTuningChanged = !!strInst && !!tab && !sameTuning(tab.tuning.map((m) => m - tab.capo), TUNINGS[strInst]);
  const theoryFeatures = useMemo(
    () =>
      displayMei && tab
        ? tabFeatures(displayMei, { capo: tab.capo, tuningChanged: tabTuningChanged, fingers: false, bass: strInst === "bass", drums: !!source.accompaniment })
        : displayMei && scoreRef.current && !drums && !rhythmEx
          ? detectFeatures(displayMei, scoreRef.current.structure, scoreRef.current.notes)
          : [],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [displayMei, notesKey, tabTuningChanged],
  );
  const waterfallFingers = useMemo(
    () => (showFingers ? new Map((fingers ?? []).map((f) => [f.id, { finger: f.finger, auto: f.source === "auto" }])) : null),
    [fingers, showFingers],
  );

  const setFinger = (id: string, finger: number | null) =>
    api
      .fingeringSet(fingerKey, fingerInput, id, finger)
      .then(setFingers)
      .catch((e) => setToast(`Палец не сохранён: ${e}`));

  // Ноты по порядку — для стрелок в режиме «Пальцы…».
  const noteOrder = useMemo(
    () =>
      [...notes]
        .sort((a, b) => a.startMs - b.startMs || (a.hand === b.hand ? b.pitch - a.pitch : a.hand === "right" ? -1 : 1))
        .map((n) => n.id),
    [notes],
  );

  // Пьеса в базе практики: фрагменты, уровни, трудные такты.
  useEffect(() => {
    const sc = scoreRef.current;
    if (!sc || !sc.notes.length || exercise) return;
    let alive = true;
    api
      .practiceOpen({
        id: practiceId,
        title: instrument !== "piano" ? `${source.title} (${INSTRUMENT_NAME[instrument].toLowerCase()})` : source.title,
        measures: sc.structure.measures,
        phraseEnds: phraseEnds(sc.notes, sc.structure, sc.starts, sc.endMs),
        measureHands: measureHands(sc.notes, sc.structure.measures),
      })
      .then((v) => {
        if (!alive) return;
        setPractice(v);
        setPracticeError(null);
      })
      .catch((e) => alive && setPracticeError(String(e)));
    return () => {
      alive = false;
    };
  }, [notesKey, practiceId]);

  // Выбранный отрезок пропал (поменяли границы) — к текущему.
  useEffect(() => {
    if (practice && unitSel !== null && unitSel >= practice.units.length) setUnitSel(null);
  }, [practice, unitSel]);

  // Смена отрезка или уровня убирает старое предложение.
  useEffect(() => setSuggestion(null), [unitKey, level]);

  // Шаги (моменты начала нот) для курсора в режиме ритма.
  const steps = useMemo(() => {
    const byStart = new Map<number, string[]>();
    for (const n of notes) byStart.set(n.startMs, [...(byStart.get(n.startMs) ?? []), n.id]);
    const onsets = [...byStart.keys()].sort((a, b) => a - b);
    return { onsets, ids: onsets.map((t) => byStart.get(t)!) };
  }, [notes]);

  useGuitarHints(strInst, rhythmMode, steps, rhythmStep, noteById, current);

  const resetMarks = useCallback(() => {
    noteStates.current = new Map();
    setMarksVersion((v) => v + 1);
  }, []);

  // --- Режим ожидания ---
  useEffect(() => {
    const sc = scoreRef.current;
    if (!sc || !sc.notes.length || rhythmMode || !ready || !otherReady) return;
    setWaitSummary(null);
    setHits(new Set());
    setCurrent(null);
    resetMarks();
    const inRange = (n: { measure: number }) => !rangeFrom || (n.measure >= rangeFrom && n.measure <= rangeTo);
    const selected = [...sc.notes.filter(inRange).map(toIn), ...(accompany ? accompAll.filter(inRange) : [])];
    setWaitResult(null);
    void api.pieceStart(selected, { hands, accompany, tempo, looping: !!rangeFrom, keyMap });
  }, [notesKey, hands, accompany, tempo, rangeFrom, rangeTo, rhythmMode, ready, otherReady, run, resetMarks, accompAll, keyMap]);

  // При переходе в режим ритма — остановить ожидание; при выходе — остановить ритм.
  useEffect(() => {
    if (rhythmMode) void api.pieceStop();
    else void api.rhythmStop();
    setPlaying(false);
    setRhythmSummary(null);
    setRhythmStep(-1);
    transport.current = null;
    resetMarks();
  }, [rhythmMode, resetMarks]);

  const startRhythm = useCallback(async () => {
    const sc = scoreRef.current;
    if (!sc) return;
    await clock.current.sync();
    // Пока сверяли часы, экран могли закрыть — тогда не запускать музыку.
    if (!mounted.current) return;
    resetMarks();
    setRhythmSummary(null);
    setExResult(null);
    setToast(null);
    const beats = buildBeats(sc.starts, sc.endMs, sc.structure.meter, sc.tempoBpm);
    const demo = !!listeningRef.current;
    await api.rhythmStart([...sc.notes.map(toIn), ...(accompany ? accompAll : [])], beats, {
      hands: demo ? "none" : hands,
      accompany,
      tempo,
      countIn: demo ? false : countIn,
      metronome: demo ? false : metronome,
      loopRange: loopMs,
      beatsPerMeasure: sc.structure.meter.count,
      beatMs: Math.round(beatDuration(sc.structure.meter, sc.tempoBpm)),
      keyMap,
    });
    if (!mounted.current) {
      void api.rhythmStop();
      return;
    }
    setPlaying(true);
  }, [hands, accompany, tempo, countIn, metronome, loopMs, resetMarks, accompAll, keyMap]);
  const startRhythmRef = useRef(startRhythm);
  startRhythmRef.current = startRhythm;

  // Остановка замораживает транспорт: падающие ноты встают на месте, а не едут дальше.
  useEffect(() => {
    if (playing) return;
    const t = transport.current;
    if (!t || t.tempo === 0) return;
    const now = clock.current.nowUs();
    transport.current = { originUs: now, pos0: transportPos(t, now), tempo: 0 };
  }, [playing]);

  // Конец прослушивания: обратно в прежний режим (ожидание запустится заново само).
  const endListening = useCallback(() => {
    const from = listeningRef.current;
    if (!from) return;
    listeningRef.current = null;
    setListening(null);
    if (from === "wait") setExMode("wait");
  }, []);
  const stopRhythm = useCallback(() => {
    void api.rhythmStop();
    setPlaying(false);
    endListening();
  }, [endListening]);
  // «▶ Послушать»: в режим «в темпе» без оценки, руки ученика — никакие.
  const startListening = useCallback(() => {
    if (listeningRef.current) return;
    void api.rhythmStop();
    setPlaying(false);
    setExResult(null);
    setWaitResult(null);
    const from = exMode;
    listeningRef.current = from;
    setListening(from);
    setExMode("rhythm");
  }, [exMode]);
  // Когда режим «в темпе» включился — начать проигрывание.
  useEffect(() => {
    if (listening && rhythmMode && !playingRef.current) void startRhythmRef.current();
  }, [listening, rhythmMode]);

  // Смена настроек во время игры в темпе: в свободной игре — остановка,
  // в ведущем режиме (темп вырос, другой отрезок) — сразу заново.
  const rhythmKey = `${hands}|${tempo}|${accompany}|${countIn}|${metronome}|${rangeFrom}-${rangeTo}|${notesKey}|${accompAll.length}`;
  const prevRhythmKey = useRef(rhythmKey);
  useEffect(() => {
    if (prevRhythmKey.current === rhythmKey) return;
    prevRhythmKey.current = rhythmKey;
    if (!playingRef.current) return;
    if (guided && rhythmMode) void startRhythmRef.current();
    else {
      void api.rhythmStop();
      setPlaying(false);
    }
  }, [rhythmKey, guided, rhythmMode]);

  // --- Проходы: запись в историю и решения движка практики ---
  const onPass = (accuracy: number, durationMs: number | null, trouble: MeasureErrors[]) => {
    if (!practice || exercise) return;
    const from = range?.from ?? 1;
    const to = range?.to ?? measures;
    const span = loopMs ? loopMs[1] - loopMs[0] : (score?.endMs ?? 0);
    const attempt: AttemptRecord = {
      from,
      to,
      level: unit ? level : null,
      mode: rhythmMode ? "rhythm" : "wait",
      hands,
      tempo,
      accuracy,
      durationMs: Math.round(durationMs ?? span / Math.max(0.1, tempo)),
      trouble,
    };
    const passLevel = level;
    // Закрепляем отрезок: после «выучено» текущим станет следующий, а предложение относится к этому.
    if (unit && unitSel === null) setUnitSel(practice.units.indexOf(unit));
    api
      .practiceRecord(practiceId, attempt)
      .then(({ outcome, view }) => {
        setPractice(view);
        if (!outcome || !unit) return;
        const after = view.units.find((u) => u.from === from && u.to === to);
        const parts = [
          passLevel === 0 ? "Прослушано" : outcome.good ? `Проход засчитан (${percent(accuracy)})` : `${percent(accuracy)} — серия сначала`,
        ];
        if (after && outcome.good && passLevel > 0 && !outcome.suggestion && !outcome.tempo)
          parts.push(`серия ${Math.min(streakOf(after), STREAK_TO_ADVANCE)} из ${STREAK_TO_ADVANCE}`);
        if (outcome.tempo) parts.push(`темп ${percent(outcome.tempo)}`);
        setToast(parts.join(" · "));
        if (outcome.suggestion) {
          const key = `${from}-${to}-${passLevel}-${outcome.suggestion.kind}`;
          if (!dismissed.current.has(key)) setSuggestion({ s: outcome.suggestion, key });
        }
      })
      .catch((e) => setPracticeError(String(e)));
  };
  const passRef = useRef(onPass);
  passRef.current = onPass;

  // Упражнение сыграно в темпе: оценка ровности и запись результата.
  const onExerciseFinished = (s: RhythmSummary) => {
    if (!exercise || !score) return;
    const fingerMap = new Map<string, number>();
    for (const n of score.notes) {
      const fg = fingerOf.get(n.id)?.finger ?? parseFinger(score.structure.fingerOf.get(n.id));
      if (fg) fingerMap.set(n.id, fg);
    }
    const ev = evaluate(hitLog.current, s.requiredNotes, s.extras, score.notes, fingerMap, tempo);
    if (exercise.pass) ev.passed = ev.accuracy >= exercise.pass.accuracy && ev.timingSdMs <= exercise.pass.timingSdMs && tempo >= 0.999;
    if (exercise.groove) ev.groove = grooveStats(hitLog.current, score.notes, 60000 / exercise.groove.bpm, exercise.groove.beats) ?? undefined;
    // Барабаны: акценты и тихие ноты — по силе удара относительно обычных ударов.
    if (drums && displayMei) {
      ev.dynamics = evaluateDynamics(hitLog.current, dynamicsOf(displayMei));
      ev.passed = ev.passed && ev.dynamics.share >= PASS_DYNAMICS;
    }
    setExResult(ev);
    api
      .exerciseRecord({
        exercise: exercise.id,
        tempo,
        accuracy: ev.accuracy,
        timingSdMs: ev.timingSdMs,
        loudness: ev.loudness,
        passed: ev.passed,
      })
      .then(() => exercise.onRecorded?.(ev))
      .catch((e) => setToast(`Результат не сохранён: ${e}`));
  };
  const exFinishRef = useRef(onExerciseFinished);
  exFinishRef.current = onExerciseFinished;

  // Упражнение с зачётом в ожидании (чтение с листа): доля нот без ошибочных нажатий.
  const onExerciseWaitFinished = (s: PieceSummary) => {
    if (!exercise?.waitRecord) return;
    const accuracy = waitAccuracy(s.requiredNotes, s.errors);
    const passed = accuracy >= (exercise.pass?.accuracy ?? PASS_ACCURACY);
    setWaitResult({ accuracy, errors: s.errors, durationMs: s.durationMs, passed });
    api
      .exerciseRecord({ exercise: exercise.waitRecord, tempo, accuracy, timingSdMs: 0, loudness: 1, passed })
      .then(() => exercise.onRecorded?.({ accuracy, passed } as Evaluation))
      .catch((e) => setToast(`Результат не сохранён: ${e}`));
  };
  const exWaitRef = useRef(onExerciseWaitFinished);
  exWaitRef.current = onExerciseWaitFinished;
  const isExercise = !!exercise;
  const endListeningRef = useRef(endListening);
  endListeningRef.current = endListening;
  const guidedRef = useRef(guided);
  guidedRef.current = guided;

  // События ядра.
  useEffect(() => {
    const offs: (() => void)[] = [];
    let alive = true;
    const keep = (fn: () => void) => (alive ? offs.push(fn) : fn());
    void listen("piece", (e) => {
      if (e.kind === "step") {
        setCurrent({ index: e.index, noteIds: e.noteIds, required: e.required });
        setHits(new Set());
        if (e.index === 0) resetMarks();
      } else if (e.kind === "hit") {
        setHits((h) => new Set([...h, ...e.noteIds]));
        for (const id of e.noteIds) noteStates.current.set(id, "hit");
      } else if (e.kind === "wrong") {
        flashWrong(e.pitch);
      } else if (e.kind === "finished") {
        setCurrent(null);
        setWaitSummary(e.summary);
        exWaitRef.current(e.summary);
        passRef.current(waitAccuracy(e.summary.requiredNotes, e.summary.errors), e.summary.durationMs, e.summary.troubleMeasures);
      } else if (e.kind === "loopPass") {
        if (!guidedRef.current)
          setToast(`Круг ${e.pass}: ${e.summary.errors === 0 ? "без ошибок" : `ошибок: ${e.summary.errors}`}`);
        passRef.current(waitAccuracy(e.summary.requiredNotes, e.summary.errors), e.summary.durationMs, e.summary.troubleMeasures);
      }
    }).then(keep);
    void listen("rhythm", (e) => {
      if (e.kind === "clock") {
        const first = !transport.current;
        transport.current = { originUs: e.originUs, pos0: e.pos0, tempo: e.tempo };
        // Для сквозных тестов: часы транспорта (бот играет в темпе).
        scrollRef.current?.setAttribute("data-transport", `${e.originUs},${e.pos0},${e.tempo}`);
        if (!first) resetMarks();
        hitLog.current = [];
      } else if (e.kind === "hit") {
        hitLog.current.push({ id: e.id, deltaMs: e.deltaMs, velocity: e.velocity });
        noteStates.current.set(e.id, e.grade === "poor" ? "poor" : "hit");
        setMarksVersion((v) => v + 1);
      } else if (e.kind === "miss") {
        noteStates.current.set(e.id, "miss");
        setMarksVersion((v) => v + 1);
      } else if (e.kind === "extra") {
        flashWrong(e.pitch);
      } else if (e.kind === "loopPass") {
        if (!guidedRef.current) setToast(`Круг ${e.pass}: ${percent(e.summary.accuracy)} нот, ±${e.summary.meanAbsDeltaMs} мс`);
        const s = e.summary;
        passRef.current(rhythmAccuracy(s.requiredNotes, s.hits, s.extras), null, s.troubleMeasures);
      } else if (e.kind === "finished") {
        setPlaying(false);
        if (listeningRef.current) {
          endListeningRef.current();
          return;
        }
        if (isExercise) {
          exFinishRef.current(e.summary);
          return;
        }
        setRhythmSummary(e.summary);
        const s = e.summary;
        passRef.current(rhythmAccuracy(s.requiredNotes, s.hits, s.extras), null, s.troubleMeasures);
      }
    }).then(keep);
    return () => {
      alive = false;
      offs.forEach((f) => f());
    };
  }, [resetMarks, isExercise]);

  function flashWrong(pitch: number) {
    setWrongKey(pitch);
    setTimeout(() => setWrongKey((k) => (k === pitch ? null : k)), 600);
  }

  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), 2500);
    return () => clearTimeout(id);
  }, [toast]);

  // --- Позиция для падающих нот и курсора ---
  const waitTarget = useMemo(() => {
    if (!current) return loopMs?.[0] ?? 0;
    return Math.min(...current.noteIds.map((id) => noteById.get(id)?.startMs ?? Infinity));
  }, [current, noteById, loopMs]);
  const waitPos = useRef(0);
  const waitTargetRef = useRef(waitTarget);
  waitTargetRef.current = waitTarget;
  const lastFrame = useRef(performance.now());

  const getPos = useCallback(() => {
    const now = performance.now();
    const dt = Math.min(100, now - lastFrame.current);
    lastFrame.current = now;
    if (rhythmMode) {
      const t = transport.current;
      if (!t) return loopMs?.[0] ?? 0;
      return transportPos(t, clock.current.nowUs());
    }
    // В режиме ожидания ноты плавно подъезжают к клавиатуре и замирают.
    const target = waitTargetRef.current;
    const k = 1 - Math.exp(-dt / 90);
    waitPos.current += (target - waitPos.current) * k;
    if (Math.abs(target - waitPos.current) < 0.5) waitPos.current = target;
    return waitPos.current;
  }, [rhythmMode, loopMs]);

  // Курсор режима ритма: какой шаг сейчас звучит (проверка ~15 раз в секунду).
  useEffect(() => {
    if (!rhythmMode || !playing) return;
    const id = setInterval(() => {
      const t = transport.current;
      if (!t) return;
      const i = stepAt(steps.onsets, transportPos(t, clock.current.nowUs()));
      setRhythmStep((prev) => (prev === i ? prev : i));
    }, 60);
    const sync = setInterval(() => void clock.current.sync(), 3000);
    return () => {
      clearInterval(id);
      clearInterval(sync);
    };
  }, [rhythmMode, playing, steps]);

  const cursorIds: string[] = rhythmMode
    ? playing && rhythmStep >= 0
      ? steps.ids[rhythmStep]
      : []
    : (current?.noteIds ?? []);

  // Элементы нот в SVG по id (с копиями «ноты над табами») — строятся один раз на отрисовку,
  // а не поиском по всему SVG на каждой перерисовке во время игры.
  // Ключ — сам HTML страниц: он меняется и при смене вида «строка/страницы».
  const noteEls = useRef<{ pages: string[]; map: Map<string, Element[]> }>({ pages: [], map: new Map() });
  const elsOf = (root: HTMLElement, id: string): Element[] => {
    if (noteEls.current.pages !== pageHtml) {
      const map = new Map<string, Element[]>();
      for (const el of root.querySelectorAll("g[id]")) {
        const key = el.id.endsWith(MIRROR) ? el.id.slice(0, -MIRROR.length) : el.id;
        const list = map.get(key);
        if (list) list.push(el);
        else map.set(key, [el]);
      }
      noteEls.current = { pages: pageHtml, map };
    }
    return noteEls.current.map.get(id) ?? [];
  };

  // Подсветка нот в SVG: текущий шаг, сыгранные, пропущенные.
  useLayoutEffect(() => {
    const root = scrollRef.current;
    if (!root) return;
    for (const el of marked.current)
      el.classList.remove("mark-right", "mark-left", "mark-app", "mark-hit", "mark-poor", "mark-miss", "mark-select");
    marked.current = [];
    const mark = (id: string, cls: string) => {
      for (const el of elsOf(root, id)) {
        el.classList.add(cls);
        marked.current.push(el);
      }
    };
    // Правка рук: все ноты окрашены по рукам, без курсора и отметок игры.
    if (editHands) {
      for (const n of notes) mark(n.id, `mark-${n.hand}`);
      return;
    }
    for (const [id, st] of noteStates.current) {
      if (st === "hit") mark(id, "mark-hit");
      else if (st === "poor") mark(id, "mark-poor");
      else if (st === "miss") mark(id, "mark-miss");
    }
    for (const id of cursorIds) {
      const n = noteById.get(id);
      if (!n || noteStates.current.has(id)) continue;
      mark(id, shows(n.hand) ? `mark-${n.hand}` : "mark-app");
    }
    if (editFingers && selNote) mark(selNote, "mark-select");
  });

  // Для сквозных тестов: моменты нот упражнения (бот играет в темпе).
  const onsetsAttr = useMemo(() => (exercise ? notes.map((n) => `${Math.round(n.startMs)}:${n.pitch}`).join(",") : undefined), [exercise, notes]);
  // Готовый HTML страниц: не пересчитывать большие SVG на каждой перерисовке во время игры.
  const pageHtml = useMemo(() => (p.layout === "pages" ? pages.map(capPageWidth) : pages), [pages, p.layout]);

  // Прокрутка к текущему месту.
  const cursorKey = cursorIds[0] ?? "";
  useEffect(() => {
    const root = scrollRef.current;
    if (!root || !cursorKey) return;
    const el = root.querySelector(`g[id="${cursorKey}"]`);
    if (!el) return;
    const box = el.getBoundingClientRect();
    const view = root.getBoundingClientRect();
    if (p.layout === "line") {
      const target = root.scrollLeft + (box.left - view.left) - view.width * 0.25;
      root.scrollTo({ left: Math.max(0, target), behavior: "smooth" });
    } else {
      const system = el.closest("g.system") ?? el;
      const sb = system.getBoundingClientRect();
      if (sb.top < view.top + 10 || sb.bottom > view.bottom - 10) {
        root.scrollTo({ top: root.scrollTop + (sb.top - view.top) - 20, behavior: "smooth" });
      }
    }
  }, [cursorKey, p.layout, pages]);

  // Прямоугольники тактов поверх нот (для выделения, «по памяти», тепловой карты).
  useLayoutEffect(() => {
    const content = contentRef.current;
    if (!content || !score) {
      setBoxes([]);
      return;
    }
    const base = content.getBoundingClientRect();
    setBoxes(
      score.structure.measureIds.map((id) => {
        const el = content.querySelector(`g[id="${id}"]`);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { left: r.left - base.left, top: r.top - base.top, width: r.width, height: r.height };
      }),
    );
  }, [score, pages, boxSize]);

  const applyFragments = (starts: number[] | null) =>
    api
      .practiceSetFragments(practiceId, starts)
      .then((v) => {
        setUnitSel(null);
        setPractice(v);
      })
      .catch((e) => setPracticeError(String(e)));

  // Такты с началом фрагмента (для правки границ).
  const fragmentStarts = useMemo(() => practice?.fragments.map((f) => f[0]) ?? [], [practice]);

  const onScoreClick = (e: React.MouseEvent) => {
    if (!score) return;
    if (editHands && converted) {
      // Клик по ноте переносит её в другую руку; продолжение лиги — всю лигу.
      let id = (e.target as Element).closest?.("g.note")?.id;
      while (id && score.structure.tieEndToStart.has(id)) id = score.structure.tieEndToStart.get(id);
      const n = id ? noteById.get(id) : undefined;
      if (!n) return;
      const o = overrideFor(n, converted.bpm, converted.trim, transpose);
      const next = toggleOverride(setup.handOverrides, o);
      setSetup({ handOverrides: next });
      setToast(next.length < setup.handOverrides.length ? "Нота возвращена" : o.hand === "left" ? "Нота → левая рука" : "Нота → правая рука");
      return;
    }
    if (editFingers) {
      // Клик по ноте выбирает её; продолжение лиги — первую ноту лиги.
      let id = (e.target as Element).closest?.("g.note")?.id;
      while (id && score.structure.tieEndToStart.has(id)) id = score.structure.tieEndToStart.get(id);
      if (id && noteById.has(id)) setSelNote(id);
      return;
    }
    const m = measureAt(e.clientX, e.clientY, e.target as Element, score.structure.measureIds, contentRef.current);
    if (m < 1) return;
    if (guided && practice) {
      if (editBounds) {
        if (m === 1) return;
        const starts = fragmentStarts.includes(m) ? fragmentStarts.filter((s) => s !== m) : [...fragmentStarts, m];
        void applyFragments(starts.sort((a, b) => a - b));
      } else {
        // Клик по такту — учить фрагмент, в котором он лежит.
        const idx = practice.units.findIndex((u) => u.frags[0] === u.frags[1] && u.from <= m && m <= u.to);
        if (idx >= 0) setUnitSel(idx);
      }
      return;
    }
    if (e.shiftKey && loop) {
      setLoop({ from: Math.min(loop.from, m), to: Math.max(loop.to, m) });
      loopClicks.current = 0;
    } else if (loopClicks.current === 1 && loop) {
      setLoop({ from: Math.min(loop.from, m), to: Math.max(loop.from, m) });
      loopClicks.current = 0;
    } else {
      setLoop({ from: m, to: m });
      loopClicks.current = 1;
    }
  };

  const setLoopField = (field: "from" | "to", value: number) => {
    if (!measures || Number.isNaN(value)) return;
    const v = Math.min(measures, Math.max(1, Math.round(value)));
    const cur = loop ?? { from: 1, to: measures };
    const next = field === "from" ? { from: v, to: Math.max(v, cur.to) } : { from: Math.min(cur.from, v), to: v };
    loopClicks.current = 0;
    setLoop(next);
  };

  const restart = useCallback(() => {
    if (rhythmMode) void startRhythm();
    else setRun((r) => r + 1);
  }, [rhythmMode, startRhythm]);

  const setLevel = (to: number) => {
    if (!unit) return;
    api
      .practiceSetLevel(practiceId, unit.from, unit.to, to)
      .then(setPractice)
      .catch((e) => setPracticeError(String(e)));
  };

  const acceptSuggestion = () => {
    if (!suggestion) return;
    const s = suggestion.s;
    setSuggestion(null);
    if (s.kind === "learned") setUnitSel(null);
    else setLevel(s.to);
  };

  const dismissSuggestion = () => {
    if (!suggestion) return;
    dismissed.current.add(suggestion.key);
    setSuggestion(null);
  };

  const selectUnit = (i: number) => {
    if (!practice) return;
    setUnitSel(i === practice.current ? null : i);
  };

  // Обработчик клавиш регистрируется один раз и вызывает свежую версию функции:
  // иначе перерисовка посреди нажатия (нажатие одновременно играет ноту) снимала бы его.
  const keyHandler = useRef<(e: KeyboardEvent) => void>(() => {});
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => keyHandler.current(e);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  {
    keyHandler.current = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || trackDialog) return;
      if (editHands) {
        if (e.key === "Escape") setEditHands(false);
        return;
      }
      if (editFingers) {
        if (e.key === "Escape") setEditFingers(false);
        else if (selNote && /^[1-5]$/.test(e.key)) void setFinger(selNote, Number(e.key));
        else if (selNote && (e.key === "0" || e.key === "Delete" || e.key === "Backspace")) void setFinger(selNote, null);
        else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
          e.preventDefault();
          const i = selNote ? noteOrder.indexOf(selNote) : -1;
          const next = noteOrder[Math.min(noteOrder.length - 1, Math.max(0, i + (e.key === "ArrowLeft" ? -1 : 1)))];
          if (next) setSelNote(next);
        }
        return;
      }
      if (e.key === "Escape") {
        if (editBounds) setEditBounds(false);
        else if (suggestion) dismissSuggestion();
        else if (!guided && loop) {
          setLoop(null);
          loopClicks.current = 0;
        } else onBack();
      } else if (e.code === "Space" && rhythmMode) {
        e.preventDefault();
        // Иначе кнопка с фокусом («■ Стоп» → «▶ Старт») нажмётся ещё раз при отпускании пробела.
        if (document.activeElement instanceof HTMLButtonElement) document.activeElement.blur();
        if (playing) stopRhythm();
        else void startRhythm();
      } else if (e.key === "Enter" && suggestion) acceptSuggestion();
      else if (e.key === "r" || e.key === "R" || e.key === "к" || e.key === "К") restart();
      else if (guided && practice && unit && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
        const i = practice.units.indexOf(unit) + (e.key === "ArrowLeft" ? -1 : 1);
        if (i >= 0 && i < practice.units.length) selectUnit(i);
      } else if (guided) return;
      else if (exercise) {
        if (e.key === "+" || e.key === "=") setExTempo((t) => clampTempo(t + 0.05));
        else if (e.key === "-" || e.key === "_") setExTempo((t) => clampTempo(t - 0.05));
        else if (e.key === "h" || e.key === "H" || e.key === "р" || e.key === "Р") setPiece({ waterfall: !p.waterfall });
        return;
      } else if (e.key === "h" || e.key === "H" || e.key === "р" || e.key === "Р") setPiece({ waterfall: !p.waterfall });
      else if (e.key === "+" || e.key === "=") setPiece({ tempo: clampTempo(p.tempo + 0.05) });
      else if (e.key === "-" || e.key === "_") setPiece({ tempo: clampTempo(p.tempo - 0.05) });
      else if (e.key === "1") setPiece({ hands: "right" });
      else if (e.key === "2") setPiece({ hands: "left" });
      else if (e.key === "3") setPiece({ hands: "both" });
    };
  }

  // Клавиатура: диапазон пьесы, подсветка нужных клавиш и нажатий.
  const [low, high] = useMemo(() => {
    if (!notes.length) return [48, 84];
    const ps = notes.map((n) => n.pitch);
    let lo = Math.min(...ps) - 2;
    let hi = Math.max(...ps) + 2;
    // Не уже двух октав: иначе клавиши огромные и трудно узнать место на клавиатуре.
    const lack = 24 - (hi - lo);
    if (lack > 0) {
      lo -= Math.floor(lack / 2);
      hi += Math.ceil(lack / 2);
    }
    return [lo, hi];
  }, [notes]);
  const highlight: Record<number, { color: string; strength?: number; held?: boolean }> = {};
  if (keyHints) {
    for (const id of cursorIds) {
      const n = noteById.get(id);
      if (n && shows(n.hand) && !hits.has(id) && !noteStates.current.has(id))
        highlight[n.pitch] = {
          color: HAND_COLOR[n.hand],
          strength: 0.45,
          ...(showFingers && fingerOf.get(id) ? { finger: fingerOf.get(id)!.finger, auto: fingerOf.get(id)!.source === "auto" } : {}),
        };
    }
  }
  for (const [n, h] of Object.entries(held)) highlight[Number(n)] = { color: deviceColor(h.device, devices), strength: 0.85, held: true };
  if (wrongKey !== null) highlight[wrongKey] = { color: "#FF5C5C", strength: 0.9 };

  // Барабаны: какие пэды бить сейчас, какой пэд клавиатуры назначен барабану.
  const padHints = new Set<number>();
  if (drums && keyHints)
    for (const id of cursorIds) {
      const n = noteById.get(id);
      if (n && !hits.has(id) && !noteStates.current.has(id)) padHints.add(n.pitch);
    }
  const padLabels = useMemo(
    () => new Map((devices.pads ?? []).map((pb) => [pb.drum, `пэд ${pb.note}`])),
    [devices.pads],
  );

  // Гитара/бас: куда поставить палец (подсказка) и что звучит сейчас — на грифе.
  const tuning = tab ? tab.tuning : strInst ? TUNINGS[strInst] : [];
  const fretMarks: FretMark[] = [];
  if (tab && strInst) {
    const frets = FRETS[strInst] - tab.capo;
    if (keyHints)
      for (const id of cursorIds) {
        const pos = tab.positions.get(id);
        if (pos && !hits.has(id) && !noteStates.current.has(id))
          fretMarks.push({ ...pos, color: HAND_COLOR.right, strength: 0.45, label: String(pos.fret) });
      }
    const hand = fretMarks.find((m) => m.fret > 0)?.fret ?? 3;
    const show = (pitch: number, color: string, strength: number) => {
      const exp = fretMarks.find((m) => tuning[m.string] + m.fret === pitch);
      const pos = exp ?? nearestPosition(pitch, tuning, frets, hand);
      if (pos) fretMarks.push({ string: pos.string, fret: pos.fret, color, strength });
    };
    for (const [n, h] of Object.entries(held)) show(Number(n), deviceColor(h.device, devices), 0.85);
    if (wrongKey !== null) show(wrongKey, "#FF5C5C", 0.9);
  }
  const maxFret = tab ? Math.max(0, ...[...tab.positions.values()].map((p) => p.fret)) : 0;
  const boardFrets = strInst ? Math.min(FRETS[strInst], Math.max(12, maxFret + 1)) : 12;

  const needed = strInst || drums || rhythmEx ? [] : notes.filter((n) => includes(n.hand)).map((n) => n.pitch);
  const narrow = devices.inputs.filter(
    (d) => d.connected && d.settings.range && needed.some((x) => x < d.settings.range![0] || x > d.settings.range![1]),
  );
  const totalSteps = steps.onsets.length;
  void marksVersion;

  // Наложения на ноты. Рамки тактов одной строки выравниваются по высоте
  // (у первого такта строки она больше из-за ключей и обозначения темпа).
  const aligned = useMemo(() => alignRows(boxes), [boxes]);
  const rangeRects: Rect[] = [];
  if (range && !editBounds) for (let m = range.from; m <= range.to; m++) if (aligned[m - 1]) rangeRects.push(aligned[m - 1]!);
  const heatMax = Math.max(1, ...(practice?.heat.map((h) => h.errors) ?? []));
  const heatRects = p.heat && practice ? practice.heat.filter((h) => boxes[h.measure - 1]).map((h) => ({ ...h, rect: boxes[h.measure - 1]! })) : [];
  const fragRects =
    editBounds && practice
      ? practice.fragments.flatMap(([a, b], i) =>
          aligned
            .slice(a - 1, b)
            .filter((r): r is Rect => !!r)
            .map((rect, k) => ({ rect, i, first: k === 0 })),
        )
      : [];

  // Барабаны: удары для дорожки с акцентами и тихими нотами из партии.
  const drumLaneNotes: DrumLaneNote[] = useMemo(() => {
    if (!drums || !displayMei) return [];
    const dyn = dynamicsOf(displayMei);
    return notes.map((n) => ({ id: n.id, pitch: n.pitch, startMs: n.startMs, accent: dyn.get(n.id) === "accent", ghost: dyn.get(n.id) === "ghost" }));
  }, [drums, displayMei, notes]);

  // Ритм: строки дорожки и какие строки сейчас нажаты (по тому же правилу, что в ядре).
  const twoLines = rhythmEx && notes.some((n) => n.pitch === RHYTHM_LEFT);
  const rhythmLanes = useMemo(
    () =>
      twoLines
        ? [
            { id: "R", name: "Правая", color: HAND_COLOR.right, pitches: [RHYTHM_RIGHT] },
            { id: "L", name: "Левая", color: HAND_COLOR.left, pitches: [RHYTHM_LEFT] },
          ]
        : [{ id: "R", name: "Ритм", color: HAND_COLOR.right, pitches: [RHYTHM_RIGHT] }],
    [twoLines],
  );
  const rhythmLit = new Set<"R" | "L">();
  if (rhythmEx)
    for (const [k, h] of Object.entries(held)) {
      const pitch = Number(k);
      const left = h.device === PADS_DEVICE ? [35, 36, 41, 43, 45, 47].includes(pitch) : pitch < 60;
      rhythmLit.add(twoLines && left ? "L" : "R");
    }
  const hitRhythmPad = (lane: "R" | "L") => {
    const pitch = lane === "L" ? RHYTHM_LEFT : RHYTHM_RIGHT;
    void api.simulateMidi(SCREEN_DEVICE, [0x90, pitch, 100]);
    setTimeout(() => void api.simulateMidi(SCREEN_DEVICE, [0x80, pitch, 0]), 120);
  };

  const highwayNotes: HighwayNote[] = useMemo(
    () =>
      tab
        ? notes.flatMap((n) => {
            const pos = tab.positions.get(n.id);
            return pos ? [{ id: n.id, string: pos.string, fret: pos.fret, startMs: n.startMs, durMs: n.durMs }] : [];
          })
        : [],
    [tab, notes],
  );
  const handLabel = drums
    ? hands === "none"
      ? "слушаем"
      : "барабаны"
    : strInst
      ? hands === "none"
        ? "слушаем"
        : strInst === "bass"
          ? "бас"
          : "гитара"
      : HAND_NAME[hands];

  const progressText = rhythmMode
    ? playing
      ? rhythmStep < 0
        ? "приготовься…"
        : `шаг ${rhythmStep + 1} из ${totalSteps}`
      : "пробел — старт"
    : current
      ? `шаг ${current.index + 1}`
      : waitSummary
        ? "сыграно"
        : "";

  const startLabel = hands === "none" ? "▶ Слушать" : "▶ Старт";

  // --- Тон, дорожки MIDI, правка рук, сохранение в MusicXML ---
  const openTracks = () => {
    if (!source.midi) return;
    const show = (info: MidiInfo) => {
      setMidiInfo(info);
      setTrackDialog(true);
    };
    if (midiInfo) show(midiInfo);
    else api.midiInspect(source.midi).then(show).catch((e) => setToast(String(e)));
  };
  const saveMusicXml = async () => {
    if (!converted) return;
    const name = `${source.title.replace(/[\\/:*?"<>|]/g, "-")}${transpose ? ` (${transpose > 0 ? "+" : ""}${transpose})` : ""}.musicxml`;
    try {
      const path = await saveTextAs(name, converted.musicxml, "musicxml", "MusicXML");
      if (path) setToast(`Сохранено: ${path}`);
    } catch (e) {
      setToast(`Не сохранено: ${e}`);
    }
  };
  // Песня по буквам из пьесы: мелодия и аккорды → «Тренажёры» → «Аккорды» → «Мои песни».
  const makeChordSong = () => {
    const sc = scoreRef.current;
    // Буквы — из исходных нот (не из табулатуры).
    if (!sc || !mei) return;
    const song = songFromScore(
      { notes: sc.notes, starts: sc.starts, tempoBpm: sc.tempoBpm, endMs: sc.endMs, meter: sc.structure.meter },
      mei,
      source.title,
      `my-${Date.now()}`,
    );
    setPrefs({ songs: [...(prefs.songs ?? []), song] });
    const n = song.chords.split("|").filter((b) => b.trim() && b.trim() !== "-").length;
    setToast(`Песня по буквам «${song.title}» добавлена: Тренажёры → Аккорды → Мои песни (тактов с аккордами: ${n})`);
  };
  const setTranspose = (t: number) => setSetup({ transpose: Math.max(-TRANSPOSE_MAX, Math.min(TRANSPOSE_MAX, t)) });
  const pieceTools = exercise ? null : (
    <>
      {!drums && !source.songFile && <span className="transpose" title="Транспонирование: сдвиг всей пьесы на полутоны">
        Тон
        <button className="small" onClick={() => setTranspose(transpose - 1)} disabled={transpose <= -TRANSPOSE_MAX} data-transpose-down>
          −
        </button>
        <b data-transpose={transpose}>{transpose > 0 ? `+${transpose}` : transpose}</b>
        <button className="small" onClick={() => setTranspose(transpose + 1)} disabled={transpose >= TRANSPOSE_MAX} data-transpose-up>
          +
        </button>
        {transpose !== 0 && (
          <button className="link" onClick={() => setTranspose(0)}>
            как в файле
          </button>
        )}
      </span>}
      {strInst && (
        <span data-staff-with-tab={staffWithTab ? "on" : "off"}>
          <Toggle label="Ноты над табами" on={staffWithTab} onChange={(v) => setPiece({ staffWithTab: v })} />
        </span>
      )}
      {strInst && !fixedTab && (
        <span className="transpose" title="Строй, под который раскладываются табы этой пьесы">
          Строй
          <select
            value={setup.tuning ? (TUNING_PRESETS[strInst].find((t) => sameTuning(t.notes, setup.tuning!))?.id ?? "") : ""}
            onChange={(e) => {
              const t = TUNING_PRESETS[strInst].find((x) => x.id === e.target.value);
              setSetup({ tuning: t ? t.notes : null, relayout: false });
            }}
            data-piece-tuning
          >
            <option value="">мой ({tuningLabel(myOpen, 0, strInst)})</option>
            {TUNING_PRESETS[strInst].map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
          <select value={setup.capo ?? ""} onChange={(e) => setSetup({ capo: e.target.value === "" ? null : Number(e.target.value), relayout: false })} data-piece-capo>
            <option value="">каподастр: мой ({myCapo || "нет"})</option>
            {Array.from({ length: 10 }, (_, k) => (
              <option key={k} value={k}>
                {k ? `каподастр ${k}` : "без каподастра"}
              </option>
            ))}
          </select>
        </span>
      )}
      {source.midi && (
        <>
          <button className="small" onClick={openTracks} data-tracks>
            Дорожки…
          </button>
          <button
            className={`small${editHands ? " primary" : ""}`}
            disabled={!converted || drums}
            onClick={() => {
              setEditFingers(false);
              setEditBounds(false);
              setEditHands((v) => !v);
            }}
          >
            Руки…
          </button>
          <button className="small" disabled={!converted} onClick={() => void saveMusicXml()} data-save-xml>
            Сохранить MusicXML…
          </button>
        </>
      )}
    </>
  );

  return (
    <main className={`piece${showWaterfall ? " with-waterfall" : ""}`}>
      <div className="piece-bar">
        <button className="ghost" onClick={onBack} title="Esc">
          {exercise?.backLabel ?? source.backLabel ?? (drums && exercise ? "← Барабаны" : exercise ? "← Упражнения" : "← Пьесы")}
        </button>
        <div className="piece-name">
          {fileSong ? [fileSong.artist, fileSong.title].filter(Boolean).join(" — ") || source.title : source.title}
          {strInst && tab && (
            <span className="rs-meta muted" data-tuning-meta={tab.tuning.join(",")} data-capo-meta={tab.capo}>
              {" · "}
              {tuningLabel(tabOpen, tabCapo, strInst)}
            </span>
          )}
        </div>
        {fileSong && filePart && fileSong.parts.length > 1 && (
          fileSong.parts.length <= 4 ? (
            <span className="segmented" title="Какую партию песни играть" data-arrangement-select>
              {fileSong.parts.map((a, k) => (
                <button key={a.id} className={k === partIndex ? "on" : ""} onClick={() => setSetup({ arrangement: k, relayout: false })} data-arrangement={a.slug} data-part-kind={a.kind}>
                  {a.title}
                </button>
              ))}
            </span>
          ) : (
            <select
              value={partIndex}
              onChange={(e) => setSetup({ arrangement: Number(e.target.value), relayout: false })}
              title="Какую партию песни играть"
              data-arrangement-select
            >
              {fileSong.parts.map((a, k) => (
                <option key={a.id} value={k} data-arrangement={a.slug}>
                  {a.title} — {PART_KIND_NAME[a.kind].toLowerCase()}
                </option>
              ))}
            </select>
          )
        )}
        {!exercise && !source.songFile && !source.instrument && (
          <span className="segmented" title="На чём играть: фортепиано — ноты и клавиатура, гитара и бас — табы и гриф" data-instrument-select>
            {(drumsOnly ? ["drums"] : ["piano", "guitar", "bass", ...(midiDrums ? ["drums"] : [])]).map((k) => (
              <button
                key={k}
                className={instrument === k ? "on" : ""}
                onClick={() => setSetup({ instrument: k === "piano" ? null : (k as PieceInstrument) })}
                data-piece-instrument={k}
              >
                {INSTRUMENT_NAME[k as PieceInstrument]}
              </button>
            ))}
          </span>
        )}
        {strInst && !fileTab && staves >= 2 && (
          <span className="segmented" title="Какую партию пьесы играть">
            <button className={partStaff === 1 ? "on" : ""} onClick={() => setSetup({ part: 1 })}>
              Мелодия
            </button>
            <button className={partStaff === 2 ? "on" : ""} onClick={() => setSetup({ part: 2 })}>
              Бас
            </button>
          </span>
        )}
        {exercise ? (
          exercise.rhythmOnly ? null : (
            <span className="segmented" data-ex-mode={exMode}>
              <button className={!rhythmMode ? "on" : ""} disabled={!!listening} onClick={() => setExMode("wait")} title="Разобрать ноты: курсор ждёт">
                Ожидание
              </button>
              <button className={rhythmMode ? "on" : ""} disabled={!!listening} onClick={() => setExMode("rhythm")} title="В темпе с метрономом — с оценкой">
                В темпе
              </button>
            </span>
          )
        ) : (
        <span className="segmented" title="Ведущий режим или свободная игра">
          <button className={guided ? "on" : ""} onClick={() => setPiece({ guided: true })}>
            Разучить
          </button>
          <button className={!guided ? "on" : ""} onClick={() => setPiece({ guided: false })}>
            Свободно
          </button>
        </span>
        )}
        {!guided && !exercise && (
          <>
            {!strInst && !drums && <span className="segmented" title="1 / 2 / 3">
              <button className={hands === "right" ? "on" : ""} disabled={!hasRight} onClick={() => setPiece({ hands: "right" })}>
                Правая
              </button>
              <button className={hands === "left" ? "on" : ""} disabled={!hasLeft} onClick={() => setPiece({ hands: "left" })}>
                Левая
              </button>
              <button className={hands === "both" ? "on" : ""} disabled={!hasLeft || !hasRight} onClick={() => setPiece({ hands: "both" })}>
                Обе
              </button>
            </span>}
            <span className="segmented">
              <button className={!rhythmMode ? "on" : ""} onClick={() => setPiece({ mode: "wait" })}>
                Ожидание
              </button>
              <button className={rhythmMode ? "on" : ""} onClick={() => setPiece({ mode: "rhythm" })}>
                Ритм
              </button>
            </span>
          </>
        )}
        {exercise?.listen && (
          <button
            className={listening ? "primary" : ""}
            onClick={() => (listening ? stopRhythm() : startListening())}
            disabled={playing && !listening}
            title="Приложение сыграет мелодию само — без оценки"
            data-listen
          >
            {listening ? "■ Стоп" : "▶ Послушать"}
          </button>
        )}
        {listening ? null : rhythmMode ? (
          <button className={playing ? "" : "primary"} onClick={() => (playing ? stopRhythm() : void startRhythm())} title="Пробел">
            {playing ? "■ Стоп" : startLabel}
          </button>
        ) : (
          <button onClick={restart} title="R">
            Заново
          </button>
        )}
        <RecordTake
          title={source.title}
          bpm={Math.round((score?.tempoBpm ?? 100) * tempo)}
          beatsPerBar={score?.structure.meter.count ?? 4}
          onSaved={setToast}
        />
        <MoreMenu title="Вид и инструменты пьесы">
          <span className="segmented" data-layout-select>
            <button className={p.layout === "line" ? "on" : ""} onClick={() => setPiece({ layout: "line" })}>
              Строка
            </button>
            <button className={p.layout === "pages" ? "on" : ""} onClick={() => setPiece({ layout: "pages" })}>
              Страницы
            </button>
          </span>
          {pieceTools}
          {!exercise && !drums && !strInst && score && (
            <button className="small" onClick={makeChordSong} title="Песня по буквам: мелодия правой руки и аккорды (из файла или распознанные)" data-make-song>
              Аккорды по буквам…
            </button>
          )}
        </MoreMenu>
      </div>

      {exercise ? (
        <>
          <div className="piece-toggles">
            <label className="tempo" title="+ / −">
              Темп
              <input
                type="range"
                min={0.5}
                max={TEMPO_MAX}
                step={0.05}
                value={exTempo}
                onChange={(e) => setExTempo(clampTempo(Number(e.target.value)))}
              />
              <b>{percent(exTempo)}</b>
              {score && <span className="muted">{Math.round(score.tempoBpm * exTempo)} уд/мин</span>}
              {exTempo < 0.999 && <span className="muted">· для зачёта — от 100%</span>}
            </label>
            {rhythmMode && (
              <>
                <Toggle label="Отсчёт" on={p.countIn} onChange={(v) => setPiece({ countIn: v })} />
                <Toggle label="Метроном" on={exMetronome} onChange={setExMetronome} />
              </>
            )}
            {exercise.playlist && (
              <span className="chip small">
                {exercise.playlist.label ?? "Разминка"}: {exercise.playlist.index + 1} из {exercise.playlist.total}
              </span>
            )}
            <span className="piece-progress">{progressText}</span>
          </div>
          <div className="piece-toggles secondary">
            <Toggle
              label={drums || rhythmEx ? "Дорожка" : "Падающие ноты"}
              on={showWaterfall}
              onChange={(v) => (exHints ? setExHints({ ...exHints, waterfall: v }) : setPiece({ waterfall: v }))}
            />
            {!drums && !rhythmEx && (
              <Toggle label="Названия нот" on={showNames} onChange={(v) => (exHints ? setExHints({ ...exHints, names: v }) : setPiece({ names: v }))} />
            )}
            {!drums && !rhythmEx && (
              <Toggle
                label="Аппликатура"
                on={exHints ? exHints.fingering : p.fingering}
                onChange={(v) => (exHints ? setExHints({ ...exHints, fingering: v }) : setPiece({ fingering: v }))}
              />
            )}
            {!rhythmEx && (
              <Toggle
                label={drums ? "Подсветка пэдов" : "Подсветка клавиш"}
                on={keyHints}
                onChange={(v) => (exHints ? setExHints({ ...exHints, keyHints: v }) : setPiece({ keyHints: v }))}
              />
            )}
            {rhythmEx && (
              <span className="muted" data-rhythm-keys={keyMap}>
                {keyMap === "byHand"
                  ? "Правая — любая клавиша от до первой октавы и выше (пэды: малый, тарелки), левая — ниже (пэды: бочка, томы)."
                  : "Стучи любой клавишей или пэдом. Длительность нажатия не важна — только начало."}
              </span>
            )}
          </div>
        </>
      ) : guided && unit && practice ? (
        <GuidePanel
          practice={practice}
          unit={unit}
          editBounds={editBounds}
          onSelect={selectUnit}
          onLevel={setLevel}
          onEditBounds={() => {
            setEditFingers(false);
            setEditHands(false);
            setEditBounds((v) => !v);
          }}
          editFingers={editFingers}
          fingersAvailable={!strInst && !drums}
          onEditFingers={() => {
            setEditBounds(false);
            setEditHands(false);
            setEditFingers((v) => !v);
          }}
          status={
            <>
              {handLabel}
              {level > 0 && ` · серия ${Math.min(streakOf(unit), STREAK_TO_ADVANCE)} из ${STREAK_TO_ADVANCE}`}
              {rhythmMode && ` · темп ${percent(tempo)}`}
              {progressText && ` · ${progressText}`}
            </>
          }
          toggles={
            <>
              {rhythmMode && <Toggle label="Отсчёт" on={p.countIn} onChange={(v) => setPiece({ countIn: v })} />}
              {rhythmMode && <Toggle label="Метроном" on={p.metronome} onChange={(v) => setPiece({ metronome: v })} />}
              <Toggle label="Трудные такты" on={p.heat} onChange={(v) => setPiece({ heat: v })} />
            </>
          }
        />
      ) : (
        <>
          <div className="piece-toggles">
            <label className="tempo" title="+ / −">
              Темп
              <input
                type="range"
                min={TEMPO_MIN}
                max={TEMPO_MAX}
                step={0.05}
                value={p.tempo}
                onChange={(e) => setPiece({ tempo: clampTempo(Number(e.target.value)) })}
              />
              <b>{percent(p.tempo)}</b>
              {score && <span className="muted">{Math.round(score.tempoBpm * p.tempo)} уд/мин</span>}
            </label>
            <span className="loop-fields" title="Клик по такту на нотах — начало, второй клик — конец">
              Такты
              <input
                type="number"
                min={1}
                max={measures || 1}
                value={loop?.from ?? ""}
                placeholder="с"
                onChange={(e) => setLoopField("from", Number(e.target.value))}
              />
              –
              <input
                type="number"
                min={1}
                max={measures || 1}
                value={loop?.to ?? ""}
                placeholder="по"
                onChange={(e) => setLoopField("to", Number(e.target.value))}
              />
              {loop && (
                <button className="link" onClick={() => setLoop(null)}>
                  сбросить
                </button>
              )}
            </span>
            {rhythmMode && (
              <>
                <Toggle label="Отсчёт" on={p.countIn} onChange={(v) => setPiece({ countIn: v })} />
                <Toggle label="Метроном" on={p.metronome} onChange={(v) => setPiece({ metronome: v })} />
              </>
            )}
            <span className="piece-progress">{progressText}</span>
          </div>
          <div className="piece-toggles secondary">
            <Toggle
              label={strInst ? "Аккомпанемент" : "Вторая рука звучит"}
              on={p.accompany}
              disabled={!strInst && hands === "both"}
              onChange={(v) => setPiece({ accompany: v })}
            />
            <Toggle label="Падающие ноты" on={p.waterfall} onChange={(v) => setPiece({ waterfall: v })} />
            {!strInst && <Toggle label="Названия нот" on={p.names} onChange={(v) => setPiece({ names: v })} />}
            {!strInst && <Toggle label="Аппликатура" on={p.fingering} onChange={(v) => setPiece({ fingering: v })} />}
            <button
              hidden={!!strInst}
              className={`small${editFingers ? " primary" : ""}`}
              onClick={() => {
                setEditHands(false);
                setEditFingers((v) => !v);
              }}
            >
              Пальцы…
            </button>
            <Toggle label={strInst ? "Подсказки на грифе" : "Подсветка клавиш"} on={p.keyHints} onChange={(v) => setPiece({ keyHints: v })} />
            <Toggle label="Трудные такты" on={p.heat} onChange={(v) => setPiece({ heat: v })} />
          </div>
        </>
      )}

      {error && <div className="notice warn">{error}</div>}
      {guided && practiceError && (
        <div className="notice warn">Прогресс недоступен ({practiceError}). Можно играть, но проходы не сохраняются.</div>
      )}
      {narrow.map((d) => (
        <div key={d.name} className="notice info">
          Пьеса выходит за диапазон «{d.name}» ({keyLabel(d.settings.range![0], naming)}–{keyLabel(d.settings.range![1], naming)}).
          Часть нот придётся играть на другом инструменте.
        </div>
      ))}
      {exercise?.hint && (
        <div className="notice info" data-ex-hint>
          {exercise.hint}
        </div>
      )}
      {source.banner}
      {strInst && guitarOn === false && (
        <div className="notice info">
          Вход гитары выключен — приложение не услышит {strInst === "bass" ? "бас" : "гитару"}. Включи «Слушать вход» на
          вкладке «Гитара». Пока можно нажимать те же ноты на MIDI-клавиатуре.
        </div>
      )}
      {strInst && tuningDiffers && !relayout && !retune && (
        <div className="notice info tuning-notice" data-tuning-mismatch>
          <span>
            Строй пьесы — <b>{tuningLabel(pieceOpen, pieceCapo, strInst)}</b>, у тебя — <b>{tuningLabel(myOpen, myCapo, strInst)}</b>.
          </span>
          <span className="buttons">
            <button className="small primary" onClick={() => setRetune(true)} data-retune-open>
              Перестроить {strInst === "bass" ? "бас" : "гитару"}
            </button>
            <button className="small" onClick={() => setSetup({ relayout: true })} data-relayout>
              Переложить табы под мой строй
            </button>
          </span>
        </div>
      )}
      {strInst && relayout && (
        <div className="notice info tuning-notice" data-relayout-on>
          <span>
            Табы переложены под твой строй ({tuningLabel(myOpen, myCapo, strInst)}); звучат те же ноты.
          </span>
          <button className="small" onClick={() => setSetup({ relayout: false })}>
            Вернуть строй пьесы
          </button>
        </div>
      )}
      {strInst && retune && (
        <RetunePanel
          instrument={strInst}
          tuning={pieceOpen}
          capo={pieceCapo}
          naming={naming}
          onSaved={() => {
            setRetune(false);
            setSetup({ relayout: false });
            setToast(`Строй сохранён: ${tuningLabel(pieceOpen, pieceCapo, strInst)}`);
          }}
          onClose={() => setRetune(false)}
        />
      )}
      {tab && tab.folded > 0 && (
        <div className="notice info">
          {tab.folded} {tab.folded === 1 ? "нота перенесена" : "нот перенесено"} на октаву, чтобы лечь на гриф.
        </div>
      )}
      {editBounds && practice && (
        <div className="notice info guide-edit">
          <span>
            Клик по такту делает его началом нового фрагмента, повторный клик убирает границу. Фрагментов: {practice.fragments.length}
            {practice.custom ? " (свои границы)" : " (автоматически)"}.
          </span>
          <span className="buttons">
            {practice.custom && (
              <button onClick={() => void applyFragments(null)}>
                Автоматически
              </button>
            )}
            <button className="primary" onClick={() => setEditBounds(false)}>
              Готово
            </button>
          </span>
        </div>
      )}
      {editFingers && (
        <div className="notice info guide-edit">
          <span>
            Кликни по ноте, затем нажми <b>1–5</b> — палец. <b>0</b> или Delete — вернуть подобранный, ← / → — соседняя нота.
            Цифры: <span className="fing-legend file">из файла</span>, <span className="fing-legend manual">твои</span>,{" "}
            <span className="fing-legend auto">подобраны автоматически</span>.
            {selNote && fingerOf.get(selNote) && (
              <>
                {" "}
                Выбрана нота: палец {fingerOf.get(selNote)!.finger}.
              </>
            )}
          </span>
          <button className="primary" onClick={() => setEditFingers(false)}>
            Готово
          </button>
        </div>
      )}
      {editHands && (
        <div className="notice info guide-edit">
          <span>
            Кликни по ноте — она перейдёт в другую руку (верхний стан ↔ нижний). Повторный клик возвращает. Ноты
            окрашены по рукам: <span className="fing-legend hand-right">правая</span>,{" "}
            <span className="fing-legend hand-left">левая</span>.
            {setup.handOverrides.length > 0 && ` Перенесено нот: ${setup.handOverrides.length}.`}
          </span>
          <span className="buttons">
            {setup.handOverrides.length > 0 && <button onClick={() => setSetup({ handOverrides: [] })}>Сбросить правки</button>}
            <button className="primary" onClick={() => setEditHands(false)}>
              Готово
            </button>
          </span>
        </div>
      )}
      {suggestion && unit && (
        <SuggestionBar suggestion={suggestion.s} unit={unit} practice={practice} onAccept={acceptSuggestion} onDismiss={dismissSuggestion} />
      )}

      <section className="paper piece-paper">
        <div
          ref={scrollRef}
          className={`score-scroll ${p.layout}${showFingers ? "" : " hide-fing"}${editFingers ? " edit-fing" : ""}${tab ? " tab-score" : ""}`}
          // Для сквозных тестов: текущий шаг, какие клавиши он ждёт, уровень и отрезок.
          data-current-step={current ? current.index : ""}
          data-current-pitches={current ? current.required.join(",") : ""}
          data-finished={waitSummary || rhythmSummary ? "1" : "0"}
          data-playing={playing ? "1" : "0"}
          data-level={unit ? level : ""}
          data-unit={unitKey}
          data-hands={hands}
          data-ex-result={exResult ? (exResult.passed ? "passed" : "failed") : waitResult ? (waitResult.passed ? "passed" : "failed") : ""}
          data-listening={listening ? "1" : "0"}
          data-onsets={onsetsAttr}
        >
          <div ref={contentRef} className="score-content" onClick={onScoreClick}>
            {!pages.length && !error && <div className="muted score-loading">Загрузка нот…</div>}
            {pageHtml.map((html, i) => (
              <div key={i} className="score-page" dangerouslySetInnerHTML={{ __html: html }} />
            ))}
            {heatRects.map((h) => (
              <div
                key={`h${h.measure}`}
                className="heat-rect"
                title={`Такт ${h.measure}: ошибок ${h.errors} за 4 недели`}
                style={{ ...h.rect, opacity: 0.25 + (0.65 * h.errors) / heatMax }}
              />
            ))}
            {rangeRects.map((r, i) => (
              <div key={`r${i}`} className={hideRange ? "memory-cover" : "loop-rect"} style={r}>
                {hideRange && i === 0 && <span>по памяти</span>}
              </div>
            ))}
            {fragRects.map(({ rect, i, first }) => (
              <div key={`f${i}-${rect.left}-${rect.top}`} className={`frag-rect${i % 2 ? " odd" : ""}${first ? " first" : ""}`} style={rect}>
                {first && <span>{i + 1}</span>}
              </div>
            ))}
          </div>
        </div>
        {toast && <div className="toast">{toast}</div>}
      </section>

      {showWaterfall && tab && strInst && (
        <section className="waterfall-box">
          <TabHighway
            notes={highwayNotes}
            strings={tuning.length}
            getPos={getPos}
            windowMs={WATERFALL_SEC * 1000 * tempo}
            states={noteStates}
            bars={score?.starts ?? []}
            loop={loopMs}
          />
        </section>
      )}
      {showWaterfall && rhythmEx && (
        <section className="waterfall-box rhythm-box">
          <DrumHighway
            notes={notes}
            lanes={rhythmLanes}
            getPos={getPos}
            windowMs={WATERFALL_SEC * 1000 * tempo}
            states={noteStates}
            bars={score?.starts ?? []}
            loop={loopMs}
          />
        </section>
      )}
      {showWaterfall && drums && (
        <section className="waterfall-box">
          <DrumHighway
            notes={drumLaneNotes}
            getPos={getPos}
            windowMs={WATERFALL_SEC * 1000 * tempo}
            states={noteStates}
            bars={score?.starts ?? []}
            loop={loopMs}
          />
        </section>
      )}
      {showWaterfall && !tab && !drums && !rhythmEx && (
        <section className="waterfall-box">
          <Waterfall
            notes={notes}
            low={low}
            high={high}
            getPos={getPos}
            windowMs={WATERFALL_SEC * 1000 * tempo}
            includes={shows}
            states={noteStates}
            bars={score?.starts ?? []}
            loop={loopMs}
            fingers={waterfallFingers}
          />
        </section>
      )}

      <section className={`session-piano${tab ? " fretboard-box" : ""}${drums || rhythmEx ? " pads-box" : ""}`}>
        {rhythmEx ? (
          <RhythmPads two={twoLines} lit={rhythmLit} onHit={hitRhythmPad} />
        ) : drums ? (
          <DrumPads
            expected={padHints}
            held={new Set(Object.keys(held).map(Number))}
            wrong={wrongKey}
            labels={padLabels}
            onHit={(d) => void api.hitDrum(d.gm, 100)}
          />
        ) : tab && strInst ? (
          <Fretboard tuning={tuning} frets={boardFrets} naming={naming} marks={fretMarks} />
        ) : (
          <Piano low={low} high={high} naming={naming} highlight={highlight} labels="c" />
        )}
      </section>
      <TheoryPlaque features={theoryFeatures} />
      {trackDialog && midiInfo && source.midi && (
        <TrackDialog
          fileId={source.midi}
          info={midiInfo}
          initial={setup.roles}
          onApply={(roles) => {
            setTrackDialog(false);
            setSetup({ roles });
          }}
          onCancel={() => {
            setTrackDialog(false);
            if (!setup.roles) onBack();
          }}
        />
      )}
      {/* Итоги — поверх всего экрана игры, чтобы помещались при любой высоте нот. */}
        {waitSummary && !rhythmMode && !exercise?.waitRecord && <WaitSummary summary={waitSummary} onAgain={restart} onBack={onBack} />}
      {waitResult && !rhythmMode && exercise && (
        <ExerciseWaitSummary
          result={waitResult}
          need={exercise.pass?.accuracy ?? PASS_ACCURACY}
          next={exercise.next ?? null}
          onAgain={restart}
          onTempo={() => {
            setWaitResult(null);
            setExMode("rhythm");
          }}
          onBack={onBack}
          backLabel={exercise.backLabel}
        />
      )}
      {rhythmSummary && rhythmMode && (
        <RhythmSummaryPanel summary={rhythmSummary} onAgain={() => void startRhythm()} onClose={() => setRhythmSummary(null)} />
      )}
      {exResult && rhythmMode && exercise && (
        <ExerciseSummary
          ev={exResult}
          tempo={tempo}
          pass={exercise.pass}
          grooveDrums={exercise.groove?.drums}
          backLabel={exercise.backLabel}
          next={exercise.next ?? null}
          onAgain={() => void startRhythm()}
          onBack={onBack}
          onClose={() => setExResult(null)}
        />
      )}
    </main>
  );
}
