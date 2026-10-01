import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  api,
  listen,
  type AttemptRecord,
  type Converted,
  type MidiInfo,
  type PieceInstrument,
  type PieceSetup,
  saveTextAs,
  type HandMode,
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
import { FRETS, meiToTab, nearestPosition, tabStaff, type StringInstrument } from "../lib/tab";
import { TUNINGS } from "../lib/guitar";
import { TrackDialog } from "../components/TrackDialog";
import { accompNotes, overrideFor, toggleOverride } from "../lib/midi";
import { TheoryPlaque } from "../components/Theory";
import { detectFeatures } from "../lib/theory";
import { Waterfall, type NoteState } from "../components/Waterfall";
import { keyLabel } from "../lib/notes";
import { fingerNotes, injectFingering, parseFinger, type Finger } from "../lib/fingering";
import { PASS_ACCURACY, PASS_TIMING_SD_MS, evaluate, type Evaluation, type HitRecord } from "../lib/exercises";
import {
  LEVELS,
  STREAK_TO_ADVANCE,
  levelPreset,
  levelTempo,
  measureHands,
  phraseEnds,
  rhythmAccuracy,
  unitLabel,
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
  type MeiStructure,
  type ScoreNote,
} from "../lib/score";
import { ClockSync, stepAt, transportPos, type Transport } from "../lib/transport";
import { loadScore, renderScore, warmUpVerovio } from "../lib/verovio";
import { deviceColor, useApp } from "../store";

export interface PieceSource {
  id: string;
  title: string;
  load: () => Promise<{ data: string | ArrayBuffer; zip: boolean }>;
  /** MIDI-файл библиотеки: ноты строятся из него с выбранными дорожками. */
  midi?: string;
}

const NO_SETUP: PieceSetup = { transpose: 0, roles: null, handOverrides: [], instrument: null, part: 0 };
const INSTRUMENT_NAME: Record<PieceInstrument, string> = { piano: "Фортепиано", guitar: "Гитара", bass: "Бас" };
const TRANSPOSE_MAX = 12;

const HAND_COLOR = { right: "#5AA9FF", left: "#FFB454" } as const;
/** Видимая высота падающих нот в секундах реального времени. */
const WATERFALL_SEC = 3;
const TEMPO_MIN = 0.3;
const TEMPO_MAX = 1.2;

const SOLFEGE: Record<string, string> = { c: "до", d: "ре", e: "ми", f: "фа", g: "соль", a: "ля", b: "си" };
const ACCID: Record<string, string> = { s: "♯", f: "♭", ss: "𝄪", ff: "𝄫" };
const HAND_NAME: Record<PlayHands, string> = { right: "правая рука", left: "левая рука", both: "обе руки", none: "слушаем" };

function verovioLayout(layout: "line" | "pages", width: number, tab = false): Record<string, unknown> {
  const common = {
    // Цифры ладов в табулатуре мелкие — таб крупнее нот.
    scale: tab ? 58 : 42,
    header: "none",
    footer: "none",
    svgViewBox: true,
    svgRemoveXlink: true,
    adjustPageHeight: true,
    pageMarginTop: tab ? 15 : 60,
    pageMarginBottom: tab ? 15 : 60,
    pageMarginLeft: 40,
    pageMarginRight: 40,
    lyricSize: 2.5,
  };
  return layout === "line"
    ? { ...common, breaks: "none", pageWidth: 60000, pageHeight: 60000, adjustPageWidth: true }
    : // Ширина страницы в единицах Verovio подбирается под окно: ~2 единицы на пиксель при scale 42.
      { ...common, breaks: "auto", pageWidth: Math.max(1500, Math.round(width * 2)), pageHeight: 60000 };
}

// «Страницы»: ширина страницы в Verovio — ~2 единицы на пиксель окна, отсюда масштаб
// ~1,24 от собственного размера SVG. Короткое упражнение (одна неполная строка) Verovio
// обрезает по содержимому — без ограничения оно растянулось бы на всю ширину и стало огромным.
const PAGE_ZOOM = 1.24;
function capPageWidth(svg: string): string {
  const m = /viewBox="0 0 ([\d.]+) /.exec(svg);
  return m ? svg.replace("<svg", `<svg style="max-width:${Math.round(Number(m[1]) * PAGE_ZOOM)}px"`) : svg;
}

function formatTime(ms: number): string {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function percent(x: number): string {
  return `${Math.round(x * 100)}%`;
}

interface Current {
  index: number;
  noteIds: string[];
  required: number[];
}

interface Loop {
  from: number;
  to: number;
}

interface Score {
  notes: ScoreNote[];
  structure: MeiStructure;
  starts: number[];
  tempoBpm: number;
  endMs: number;
}

interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Серия хороших проходов на уровне: для уровня 1 — у руки, которая сейчас играет. */
function streakOf(unit: UnitView): number {
  const s = unit.state;
  if (s.level === 1) return unit.hand === "left" ? s.leftStreak : unit.hand === "right" ? s.rightStreak : s.streak;
  return s.streak;
}

/** Упражнение: тот же экран игры, но своя оценка (ровность ритма и громкости) и свои кнопки. */
export interface ExerciseContext {
  id: string;
  /** Место в разминке дня: «2 из 4». */
  playlist?: { index: number; total: number };
  next?: { label: string; go: () => void } | null;
  onRecorded?: (ev: Evaluation) => void;
}

export function PieceView({ source, onBack, exercise }: { source: PieceSource; onBack: () => void; exercise?: ExerciseContext }) {
  const { prefs, setPrefs, held, devices } = useApp();
  const p = prefs.piece;
  const setPiece = (patch: Partial<PiecePrefs>) => setPrefs({ piece: { ...p, ...patch } });
  const naming = prefs.noteNames;
  const guided = !exercise && p.guided;
  // Упражнения: режим, темп и метроном — свои, не из настроек пьес.
  const [exMode, setExMode] = useState<"wait" | "rhythm">("rhythm");
  const [exTempo, setExTempo] = useState(1);
  const [exMetronome, setExMetronome] = useState(true);
  const [exResult, setExResult] = useState<Evaluation | null>(null);
  const hitLog = useRef<HitRecord[]>([]);
  // Настройки этой пьесы: тон, дорожки MIDI, правка рук.
  const setup: PieceSetup = { ...NO_SETUP, ...prefs.pieceSetup?.[source.id] };
  const setSetup = (patch: Partial<PieceSetup>) =>
    setPrefs({ pieceSetup: { ...prefs.pieceSetup, [source.id]: { ...setup, ...patch } } });
  const transpose = exercise ? 0 : setup.transpose;
  // На чём играем: фортепиано или гитара/бас (табы и гриф).
  const instrument: PieceInstrument = exercise ? "piano" : (setup.instrument ?? "piano");
  const strInst: StringInstrument | null = instrument === "piano" ? null : instrument;
  // Прогресс разучивания у гитары и баса свой.
  const practiceId = strInst ? `${source.id}#${strInst}` : source.id;
  const [guitarOn, setGuitarOn] = useState<boolean | null>(null);
  // Аппликатура своя для каждого тона: в другой тональности другие пальцы.
  const fingerKey = transpose ? `${source.id}@${transpose > 0 ? "+" : ""}${transpose}` : source.id;
  // MIDI: окно дорожек, результат перевода в ноты, правка рук.
  const [midiInfo, setMidiInfo] = useState<MidiInfo | null>(null);
  const [trackDialog, setTrackDialog] = useState(false);
  const [converted, setConverted] = useState<Converted | null>(null);
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
  const freeHands: HandMode = !hasLeft ? "right" : !hasRight ? "left" : exercise ? "both" : p.hands;
  const hands: PlayHands = unit ? unit.hand : freeHands;
  const tempo = exercise ? exTempo : unit ? levelTempo(level, unit.state.tempo) : p.tempo;
  const accompany = unit || exercise ? true : p.accompany;
  const countIn = p.countIn;
  const metronome = exercise ? exMetronome : p.metronome;
  const showNames = preset ? preset.names : p.names;
  const keyHints = preset ? preset.keyHints : p.keyHints;
  const showWaterfall = preset ? preset.waterfall : p.waterfall;
  const hideRange = preset?.hide ?? false;
  // Аппликатура в ведущем режиме — на уровнях 0–2, в свободной игре — по переключателю.
  const showFingers = !strInst && (editFingers || (unit ? level <= 2 : p.fingering));
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

  // Загрузка файла → MEI. MIDI сначала переводится в MusicXML с выбранными дорожками;
  // если дорожки ещё не выбраны — сначала окно дорожек.
  const rolesKey = setup.roles?.join(",") ?? "";
  const overridesKey = JSON.stringify(setup.handOverrides);
  useEffect(() => {
    warmUpVerovio();
    let alive = true;
    const fail = (e: unknown) => alive && setError(`Не удалось открыть ноты: ${(e as Error)?.message ?? e}`);
    if (source.midi) {
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
  }, [source, transpose, rolesKey, overridesKey]);
  useEffect(
    () => () => {
      void api.pieceStop();
      void api.rhythmStop();
      void api.midiPreviewStop();
    },
    [source],
  );
  // Аккомпанемент из MIDI: звучит вместе с учеником, на нотах не показывается.
  const accomp = useMemo(() => (converted ? accompNotes(converted.accompaniment) : []), [converted]);

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
  const staves = useMemo(() => (mei ? parseMei(mei).staves : 0), [mei]);
  // Гитара/бас: одна партия в табулатуре (готовые табы из файла — как есть).
  const fileTab = useMemo(() => (mei ? tabStaff(mei) : null), [mei]);
  const partStaff = strInst ? (fileTab ?? Math.min(Math.max(1, staves), setup.part || (strInst === "bass" && staves >= 2 ? 2 : 1))) : 0;
  const tab = useMemo(
    () => (strInst && mei ? meiToTab(mei, partStaff, strInst, parseMei(mei).meter) : null),
    [mei, strInst, partStaff],
  );
  const displayMei = tab?.mei ?? mei;
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
    renderScore(text, verovioLayout(p.layout, width, !!tab))
      .then((r) => {
        if (!alive) return;
        const structure = parseMei(displayMei);
        const notes = buildNotes(r.timemap, r.midi, structure);
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
        const all = buildNotes(r.timemap, r.midi, parseMei(mei));
        const staffOf = parseMei(mei).staffOf;
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
        if (g.config.instrument !== strInst) void api.guitarSet({ ...g.config, instrument: strInst });
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [strInst]);

  // Аппликатура пьесы от ядра: ручные правки → файл → автоматический подбор.
  const fingerInput = useMemo(
    () => (scoreRef.current ? fingerNotes(scoreRef.current.notes, scoreRef.current.structure) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [notesKey],
  );
  useEffect(() => {
    if (!fingerInput.length || strInst) return;
    api
      .fingeringGet(fingerKey, fingerInput)
      .then(setFingers)
      .catch(() => setFingers(null));
  }, [fingerInput, fingerKey, strInst]);
  const fingerOf = useMemo(() => new Map((fingers ?? []).map((f) => [f.id, f])), [fingers]);
  // Элементы нотной записи в пьесе — для плашек теории «Новое».
  const theoryFeatures = useMemo(
    () => (displayMei && scoreRef.current && !tab ? detectFeatures(displayMei, scoreRef.current.structure, scoreRef.current.notes) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [displayMei, notesKey],
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
    api
      .practiceOpen({
        id: practiceId,
        title: strInst ? `${source.title} (${INSTRUMENT_NAME[instrument].toLowerCase()})` : source.title,
        measures: sc.structure.measures,
        phraseEnds: phraseEnds(sc.notes, sc.structure, sc.starts, sc.endMs),
        measureHands: measureHands(sc.notes, sc.structure.measures),
      })
      .then((v) => {
        setPractice(v);
        setPracticeError(null);
      })
      .catch((e) => setPracticeError(String(e)));
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

  // Подсказка распознаванию гитары: какие ноты сейчас ждём (ошибки на октаву).
  const expectKey = strInst
    ? rhythmMode
      ? steps.ids.slice(Math.max(0, rhythmStep), Math.max(0, rhythmStep) + 3).flat().map((id) => noteById.get(id)?.pitch ?? 0).join(",")
      : (current?.required ?? []).join(",")
    : "";
  useEffect(() => {
    if (!strInst) return;
    void api.guitarExpect(expectKey ? expectKey.split(",").map(Number).filter(Boolean) : []).catch(() => {});
  }, [strInst, expectKey]);
  useEffect(() => () => void api.guitarExpect([]).catch(() => {}), []);

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
    void api.pieceStart(selected, { hands, accompany, tempo, looping: !!rangeFrom });
  }, [notesKey, hands, accompany, tempo, rangeFrom, rangeTo, rhythmMode, ready, otherReady, run, resetMarks, accompAll]);

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
    resetMarks();
    setRhythmSummary(null);
    setExResult(null);
    setToast(null);
    const beats = buildBeats(sc.starts, sc.endMs, sc.structure.meter, sc.tempoBpm);
    await api.rhythmStart([...sc.notes.map(toIn), ...(accompany ? accompAll : [])], beats, {
      hands,
      accompany,
      tempo,
      countIn,
      metronome,
      loopRange: loopMs,
      beatsPerMeasure: sc.structure.meter.count,
      beatMs: Math.round(beatDuration(sc.structure.meter, sc.tempoBpm)),
    });
    setPlaying(true);
  }, [hands, accompany, tempo, countIn, metronome, loopMs, resetMarks, accompAll]);
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

  const stopRhythm = useCallback(() => {
    void api.rhythmStop();
    setPlaying(false);
  }, []);

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
  const isExercise = !!exercise;
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

  // Подсветка нот в SVG: текущий шаг, сыгранные, пропущенные.
  useLayoutEffect(() => {
    const root = scrollRef.current;
    if (!root) return;
    for (const el of marked.current)
      el.classList.remove("mark-right", "mark-left", "mark-app", "mark-hit", "mark-poor", "mark-miss", "mark-select");
    marked.current = [];
    const mark = (id: string, cls: string) => {
      const el = root.querySelector(`g[id="${id}"]`);
      if (!el) return;
      el.classList.add(cls);
      marked.current.push(el);
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
  const highlight: Record<number, { color: string; strength?: number }> = {};
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
  for (const [n, h] of Object.entries(held)) highlight[Number(n)] = { color: deviceColor(h.device, devices), strength: 0.85 };
  if (wrongKey !== null) highlight[wrongKey] = { color: "#FF5C5C", strength: 0.9 };

  // Гитара/бас: куда поставить палец (подсказка) и что звучит сейчас — на грифе.
  const tuning = strInst ? TUNINGS[strInst] : [];
  const fretMarks: FretMark[] = [];
  if (tab && strInst) {
    const frets = FRETS[strInst];
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

  const needed = strInst ? [] : notes.filter((n) => includes(n.hand)).map((n) => n.pitch);
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
  const handLabel = strInst ? (hands === "none" ? "слушаем" : strInst === "bass" ? "бас" : "гитара") : HAND_NAME[hands];

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
  const setTranspose = (t: number) => setSetup({ transpose: Math.max(-TRANSPOSE_MAX, Math.min(TRANSPOSE_MAX, t)) });
  const pieceTools = exercise ? null : (
    <>
      <span className="transpose" title="Транспонирование: сдвиг всей пьесы на полутоны">
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
      </span>
      {source.midi && (
        <>
          <button className="small" onClick={openTracks} data-tracks>
            Дорожки…
          </button>
          <button
            className={`small${editHands ? " primary" : ""}`}
            disabled={!converted}
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
          {exercise ? "← Упражнения" : "← Пьесы"}
        </button>
        <div className="piece-name">{source.title}</div>
        {!exercise && (
          <span className="segmented" title="На чём играть: фортепиано — ноты и клавиатура, гитара и бас — табы и гриф" data-instrument-select>
            {(["piano", "guitar", "bass"] as PieceInstrument[]).map((k) => (
              <button key={k} className={instrument === k ? "on" : ""} onClick={() => setSetup({ instrument: k === "piano" ? null : k })} data-piece-instrument={k}>
                {INSTRUMENT_NAME[k]}
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
          <span className="segmented">
            <button className={!rhythmMode ? "on" : ""} onClick={() => setExMode("wait")} title="Разобрать ноты: курсор ждёт">
              Ожидание
            </button>
            <button className={rhythmMode ? "on" : ""} onClick={() => setExMode("rhythm")} title="В темпе с метрономом — с оценкой">
              В темпе
            </button>
          </span>
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
            {!strInst && <span className="segmented" title="1 / 2 / 3">
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
        <span className="segmented">
          <button className={p.layout === "line" ? "on" : ""} onClick={() => setPiece({ layout: "line" })}>
            Строка
          </button>
          <button className={p.layout === "pages" ? "on" : ""} onClick={() => setPiece({ layout: "pages" })}>
            Страницы
          </button>
        </span>
        {rhythmMode ? (
          <button className={playing ? "" : "primary"} onClick={() => (playing ? stopRhythm() : void startRhythm())} title="Пробел">
            {playing ? "■ Стоп" : startLabel}
          </button>
        ) : (
          <button onClick={restart} title="R">
            Заново
          </button>
        )}
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
                Разминка: {exercise.playlist.index + 1} из {exercise.playlist.total}
              </span>
            )}
            <span className="piece-progress">{progressText}</span>
          </div>
          <div className="piece-toggles secondary">
            <Toggle label="Падающие ноты" on={p.waterfall} onChange={(v) => setPiece({ waterfall: v })} />
            <Toggle label="Названия нот" on={p.names} onChange={(v) => setPiece({ names: v })} />
            <Toggle label="Аппликатура" on={p.fingering} onChange={(v) => setPiece({ fingering: v })} />
            <Toggle label="Подсветка клавиш" on={p.keyHints} onChange={(v) => setPiece({ keyHints: v })} />
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
          fingersAvailable={!strInst}
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
              {pieceTools}
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
            {pieceTools}
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
      {strInst && guitarOn === false && (
        <div className="notice info">
          Вход гитары выключен — приложение не услышит {strInst === "bass" ? "бас" : "гитару"}. Включи «Слушать вход» на
          вкладке «Гитара». Пока можно нажимать те же ноты на MIDI-клавиатуре.
        </div>
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
          data-ex-result={exResult ? (exResult.passed ? "passed" : "failed") : ""}
        >
          <div ref={contentRef} className="score-content" onClick={onScoreClick}>
            {!pages.length && !error && <div className="muted score-loading">Загрузка нот…</div>}
            {pages.map((svg, i) => (
              <div key={i} className="score-page" dangerouslySetInnerHTML={{ __html: p.layout === "pages" ? capPageWidth(svg) : svg }} />
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
      {showWaterfall && !tab && (
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

      <section className={`session-piano${tab ? " fretboard-box" : ""}`}>
        {tab && strInst ? (
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
        {waitSummary && !rhythmMode && <WaitSummary summary={waitSummary} onAgain={restart} onBack={onBack} />}
      {rhythmSummary && rhythmMode && (
        <RhythmSummaryPanel summary={rhythmSummary} onAgain={() => void startRhythm()} onClose={() => setRhythmSummary(null)} />
      )}
      {exResult && rhythmMode && exercise && (
        <ExerciseSummary
          ev={exResult}
          tempo={tempo}
          next={exercise.next ?? null}
          onAgain={() => void startRhythm()}
          onBack={onBack}
          onClose={() => setExResult(null)}
        />
      )}
    </main>
  );
}

/** Панель ведущего режима: отрезки в порядке разучивания и уровень подсказок. */
function GuidePanel({
  practice,
  unit,
  editBounds,
  onSelect,
  onLevel,
  onEditBounds,
  editFingers,
  fingersAvailable = true,
  onEditFingers,
  status,
  toggles,
}: {
  practice: PracticeView;
  unit: UnitView;
  editBounds: boolean;
  onSelect: (i: number) => void;
  onLevel: (l: number) => void;
  onEditBounds: () => void;
  editFingers: boolean;
  fingersAvailable?: boolean;
  onEditFingers: () => void;
  status: React.ReactNode;
  toggles: React.ReactNode;
}) {
  const level = unit.state.level;
  return (
    <div className="guide">
      <div className="guide-units">
        <span className="muted">Отрезки</span>
        <span className="unit-chips" title="Порядок разучивания: фрагменты по одному и сцепки. ← / → — соседний отрезок">
          {practice.units.map((u, i) => (
            <button
              key={`${u.from}-${u.to}`}
              className={`unit-chip${u === unit ? " on" : ""}${u.state.learned ? " learned" : ""}${i === practice.current ? " current" : ""}${u.started ? "" : " fresh"}`}
              onClick={() => onSelect(i)}
              title={`Такты ${u.from}–${u.to} · уровень ${u.state.level} «${LEVELS[u.state.level].title}»${u.state.learned ? " · выучено" : ""}`}
              data-unit={`${u.from}-${u.to}`}
            >
              <b>{unitLabel(u.frags)}</b>
              <span className="level-dots">
                {[1, 2, 3, 4].map((l) => (
                  <i key={l} className={u.state.learned || l <= u.state.level ? "on" : ""} />
                ))}
              </span>
            </button>
          ))}
        </span>
        <button className={`small${editBounds ? " primary" : ""}`} onClick={onEditBounds}>
          Границы…
        </button>
        {fingersAvailable && (
          <button className={`small${editFingers ? " primary" : ""}`} onClick={onEditFingers} title="Поправить аппликатуру">
            Пальцы…
          </button>
        )}
      </div>
      <div className="guide-level">
        <span className="muted">
          Такты {unit.from}–{unit.to}
        </span>
        <span className="segmented level-seg">
          {LEVELS.map((l) => (
            <button key={l.id} className={l.id === level ? "on" : ""} onClick={() => onLevel(l.id)} title={l.description} data-level={l.id}>
              {l.id} {l.short}
            </button>
          ))}
        </span>
        <span className="guide-status">{status}</span>
        {toggles}
      </div>
      <div className="guide-hint">
        <b>{LEVELS[level].title}.</b> {LEVELS[level].description}
        {unit.state.learned && <span className="learned-mark"> Отрезок выучен ✓</span>}
      </div>
    </div>
  );
}

function SuggestionBar({
  suggestion,
  unit,
  practice,
  onAccept,
  onDismiss,
}: {
  suggestion: Suggestion;
  unit: UnitView;
  practice: PracticeView | null;
  onAccept: () => void;
  onDismiss: () => void;
}) {
  let text: string;
  let accept: string;
  let stay: string;
  if (suggestion.kind === "levelUp") {
    text =
      unit.state.level === 0
        ? `Послушали. Попробуешь сыграть сам? Уровень ${suggestion.to} «${LEVELS[suggestion.to].title}».`
        : `${STREAK_TO_ADVANCE} прохода подряд без ошибок. Перейти на уровень ${suggestion.to} «${LEVELS[suggestion.to].title}»?`;
    accept = "Перейти";
    stay = "Ещё потренируюсь";
  } else if (suggestion.kind === "levelDown") {
    text = `Пока трудновато. Вернуться на уровень ${suggestion.to} «${LEVELS[suggestion.to].title}»?`;
    accept = "Вернуться";
    stay = "Продолжу здесь";
  } else {
    const next = practice?.units[practice.current];
    const done = !next || (next.from === unit.from && next.to === unit.to);
    text = done
      ? "Пьеса сыграна по памяти целиком. Отлично!"
      : `Такты ${unit.from}–${unit.to} выучены наизусть. Дальше: отрезок «${unitLabel(next!.frags)}» (такты ${next!.from}–${next!.to}).`;
    accept = done ? "Хорошо" : "Дальше";
    stay = "Повторить ещё";
  }
  return (
    <div className={`notice suggest ${suggestion.kind}`} data-suggestion={suggestion.kind}>
      <span>{text}</span>
      <span className="buttons">
        <button className="primary" onClick={onAccept} title="Enter">
          {accept}
        </button>
        <button onClick={onDismiss} title="Esc">
          {stay}
        </button>
      </span>
    </div>
  );
}

/** Рамки тактов одной строки (системы) — общий верх и низ. */
function alignRows(boxes: (Rect | null)[]): (Rect | null)[] {
  const rows: { top: number; bottom: number; idx: number[] }[] = [];
  boxes.forEach((b, i) => {
    if (!b) return;
    const mid = b.top + b.height / 2;
    const row = rows.find((r) => mid > r.top && mid < r.bottom);
    if (row) {
      row.top = Math.min(row.top, b.top);
      row.bottom = Math.max(row.bottom, b.top + b.height);
      row.idx.push(i);
    } else rows.push({ top: b.top, bottom: b.top + b.height, idx: [i] });
  });
  const out = [...boxes];
  for (const r of rows) for (const i of r.idx) out[i] = { ...boxes[i]!, top: r.top, height: r.bottom - r.top };
  return out;
}

/**
 * Номер такта под курсором. Клик по пустому месту попадает в сам <svg>, поэтому,
 * если элемент такта не найден по дереву, ищем по координатам: такт, в рамку
 * которого попадает точка, иначе ближайший по горизонтали в той же строке.
 */
function measureAt(x: number, y: number, target: Element, ids: string[], root: HTMLElement | null): number {
  const direct = target.closest?.("g.measure");
  if (direct) return ids.indexOf(direct.id) + 1;
  if (!root) return 0;
  let best = 0;
  let bestDist = Infinity;
  ids.forEach((id, i) => {
    const el = root.querySelector(`g[id="${id}"]`);
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (y < r.top - 20 || y > r.bottom + 20) return;
    const dist = x < r.left ? r.left - x : x > r.right ? x - r.right : 0;
    if (dist < bestDist) {
      bestDist = dist;
      best = i + 1;
    }
  });
  return bestDist < 60 ? best : 0;
}

function clampTempo(t: number): number {
  return Math.round(Math.min(TEMPO_MAX, Math.max(TEMPO_MIN, t)) * 100) / 100;
}

function toIn({ id, pitch, startMs, durMs, hand, measure }: ScoreNote): PieceNoteIn {
  return { id, pitch, startMs, durMs, hand, measure };
}

function WaitSummary({ summary, onAgain, onBack }: { summary: PieceSummary; onAgain: () => void; onBack: () => void }) {
  return (
    <div className="summary-overlay">
      <div className="summary card">
        <h2>Пьеса сыграна</h2>
        <div className="summary-stats">
          <div>
            <div className={`big ${summary.errors === 0 ? "good" : ""}`}>{summary.errors}</div>
            <div className="muted">ошибок</div>
          </div>
          <div>
            <div className="big">{formatTime(summary.durationMs)}</div>
            <div className="muted">время</div>
          </div>
        </div>
        <Trouble measures={summary.troubleMeasures} />
        <div className="summary-actions">
          <button className="primary" onClick={onAgain}>
            Ещё раз
          </button>
          <button className="ghost" onClick={onBack}>
            К списку пьес
          </button>
        </div>
      </div>
    </div>
  );
}

function RhythmSummaryPanel({ summary, onAgain, onClose }: { summary: RhythmSummary; onAgain: () => void; onClose: () => void }) {
  const tendency =
    summary.hits === 0
      ? ""
      : summary.meanDeltaMs > 25
        ? `чаще опаздываешь (в среднем на ${summary.meanDeltaMs} мс)`
        : summary.meanDeltaMs < -25
          ? `чаще спешишь (в среднем на ${-summary.meanDeltaMs} мс)`
          : "ровно, без спешки и опозданий";
  return (
    <div className="summary-overlay">
      <div className="summary card">
        <h2>Сыграно в темпе</h2>
        <div className="summary-stats">
          <div>
            <div className={`big ${summary.accuracy >= 0.9 ? "good" : summary.accuracy < 0.6 ? "bad" : ""}`}>{percent(summary.accuracy)}</div>
            <div className="muted">
              нот сыграно ({summary.hits} из {summary.requiredNotes})
            </div>
          </div>
          <div>
            <div className="big">±{summary.meanAbsDeltaMs} мс</div>
            <div className="muted">отклонение от ритма</div>
          </div>
        </div>
        <div className="grades">
          <span className="chip small good">точно: {summary.perfect}</span>
          <span className="chip small">нормально: {summary.good}</span>
          <span className="chip small warn-chip">неточно: {summary.poor}</span>
          <span className="chip small warn">пропущено: {summary.misses}</span>
          <span className="chip small warn">лишних: {summary.extras}</span>
        </div>
        {tendency && <p className="hint">Ритм: {tendency}.</p>}
        <Trouble measures={summary.troubleMeasures} />
        <div className="summary-actions">
          <button className="primary" onClick={onAgain}>
            Ещё раз
          </button>
          <button className="ghost" onClick={onClose}>
            Закрыть
          </button>
        </div>
      </div>
    </div>
  );
}

function ExerciseSummary({
  ev,
  tempo,
  next,
  onAgain,
  onBack,
  onClose,
}: {
  ev: Evaluation;
  tempo: number;
  next: { label: string; go: () => void } | null;
  onAgain: () => void;
  onBack: () => void;
  onClose: () => void;
}) {
  const reasons: string[] = [];
  if (ev.accuracy < PASS_ACCURACY) reasons.push(`точность от ${percent(PASS_ACCURACY)}`);
  if (ev.timingSdMs > PASS_TIMING_SD_MS) reasons.push(`ровнее ритм (разброс до ±${PASS_TIMING_SD_MS} мс)`);
  if (tempo < 0.999) reasons.push("темп от 100%");
  const maxV = Math.max(1, ...ev.byFinger.map((b) => b.velocity));
  return (
    <div className="summary-overlay">
      <div className="summary card exercise-summary">
        <h2>{ev.passed ? "Засчитано ✓" : "Упражнение сыграно"}</h2>
        <div className="summary-stats">
          <div>
            <div className={`big ${ev.accuracy >= PASS_ACCURACY ? "good" : ev.accuracy < 0.7 ? "bad" : ""}`}>{percent(ev.accuracy)}</div>
            <div className="muted">верных нот</div>
          </div>
          <div>
            <div className={`big ${ev.timingSdMs <= PASS_TIMING_SD_MS ? "good" : ""}`}>±{ev.timingSdMs} мс</div>
            <div className="muted">ровность ритма</div>
          </div>
          <div>
            <div className="big">{percent(ev.loudness)}</div>
            <div className="muted">ровность громкости</div>
          </div>
        </div>
        {!ev.passed && reasons.length > 0 && <p className="hint">Для зачёта нужно: {reasons.join(", ")}.</p>}
        {ev.passed && <p className="hint">Следующее упражнение открыто.</p>}
        {ev.crossingMs !== null && ev.otherMs !== null && ev.crossingMs > ev.otherMs + 20 && (
          <p className="hint">
            На подкладывании и перекладывании пальцев отклонение в среднем {ev.crossingMs} мс, на остальных нотах — {ev.otherMs} мс.
            Потренируй эти места медленнее.
          </p>
        )}
        {ev.byFinger.length > 1 && (
          <div className="finger-bars" title="Средняя сила нажатия каждым пальцем">
            {ev.byFinger.map((b) => (
              <div key={b.finger} className={`finger-bar${ev.weakFinger?.finger === b.finger ? " weak" : ""}`}>
                <div className="bar">
                  <div style={{ height: `${(b.velocity / maxV) * 100}%` }} />
                </div>
                <span>{b.finger}</span>
              </div>
            ))}
            <span className="muted finger-bars-note">
              {ev.weakFinger
                ? `${ev.weakFinger.finger}-й палец звучит тише остальных на ${Math.round((1 - ev.weakFinger.ratio) * 100)}%.`
                : "Пальцы звучат примерно одинаково."}
            </span>
          </div>
        )}
        <div className="summary-actions">
          {next && ev.passed ? (
            <button className="primary" onClick={next.go}>
              {next.label}
            </button>
          ) : (
            <button className="primary" onClick={onAgain}>
              Ещё раз
            </button>
          )}
          {next && ev.passed ? (
            <button onClick={onAgain}>Ещё раз</button>
          ) : next ? (
            <button onClick={next.go}>{next.label}</button>
          ) : null}
          <button className="ghost" onClick={onClose}>
            Закрыть
          </button>
          <button className="ghost" onClick={onBack}>
            К упражнениям
          </button>
        </div>
      </div>
    </div>
  );
}

function Trouble({ measures }: { measures: { measure: number; errors: number }[] }) {
  if (!measures.length) return null;
  return (
    <div className="trouble">
      <span className="muted">Трудные такты: </span>
      {measures.slice(0, 6).map((m) => (
        <span key={m.measure} className="chip small">
          такт {m.measure} — {m.errors}
        </span>
      ))}
    </div>
  );
}

function Toggle({ label, on, onChange, disabled }: { label: string; on: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <label className={`toggle${disabled ? " disabled" : ""}`}>
      <span className="switch">
        <input type="checkbox" checked={on} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
        <span />
      </span>
      {label}
    </label>
  );
}
