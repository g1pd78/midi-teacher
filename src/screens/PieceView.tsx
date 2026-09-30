import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  api,
  listen,
  type AttemptRecord,
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
import { Waterfall, type NoteState } from "../components/Waterfall";
import { keyLabel } from "../lib/notes";
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
}

const HAND_COLOR = { right: "#5AA9FF", left: "#FFB454" } as const;
/** Видимая высота падающих нот в секундах реального времени. */
const WATERFALL_SEC = 3;
const TEMPO_MIN = 0.3;
const TEMPO_MAX = 1.2;

const SOLFEGE: Record<string, string> = { c: "до", d: "ре", e: "ми", f: "фа", g: "соль", a: "ля", b: "си" };
const ACCID: Record<string, string> = { s: "♯", f: "♭", ss: "𝄪", ff: "𝄫" };
const HAND_NAME: Record<PlayHands, string> = { right: "правая рука", left: "левая рука", both: "обе руки", none: "слушаем" };

function verovioLayout(layout: "line" | "pages", width: number): Record<string, unknown> {
  const common = {
    scale: 42,
    header: "none",
    footer: "none",
    svgViewBox: true,
    svgRemoveXlink: true,
    adjustPageHeight: true,
    pageMarginTop: 60,
    pageMarginBottom: 60,
    pageMarginLeft: 40,
    pageMarginRight: 40,
    lyricSize: 3,
  };
  return layout === "line"
    ? { ...common, breaks: "none", pageWidth: 60000, pageHeight: 60000, adjustPageWidth: true }
    : // Ширина страницы в единицах Verovio подбирается под окно: ~2 единицы на пиксель при scale 42.
      { ...common, breaks: "auto", pageWidth: Math.max(1500, Math.round(width * 2)), pageHeight: 60000 };
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

export function PieceView({ source, onBack }: { source: PieceSource; onBack: () => void }) {
  const { prefs, setPrefs, held, devices } = useApp();
  const p = prefs.piece;
  const setPiece = (patch: Partial<PiecePrefs>) => setPrefs({ piece: { ...p, ...patch } });
  const naming = prefs.noteNames;
  const guided = p.guided;

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
  const notesKey = useMemo(() => notes.map((n) => n.id).join(","), [notes]);
  const measures = score?.structure.measures ?? 0;
  const hasLeft = notes.some((n) => n.hand === "left");
  const hasRight = notes.some((n) => n.hand === "right");

  // --- Что сейчас играем: отрезок и уровень (ведущий режим) или свои настройки ---
  const unit: UnitView | null = guided && practice ? (practice.units[unitSel ?? practice.current] ?? null) : null;
  const level = unit?.state.level ?? 0;
  const preset = unit ? levelPreset(level) : null;
  const rhythmMode = (preset ? preset.mode : p.mode) === "rhythm";
  const freeHands: HandMode = !hasLeft ? "right" : !hasRight ? "left" : p.hands;
  const hands: PlayHands = unit ? unit.hand : freeHands;
  const tempo = unit ? levelTempo(level, unit.state.tempo) : p.tempo;
  const accompany = unit ? true : p.accompany;
  const showNames = preset ? preset.names : p.names;
  const keyHints = preset ? preset.keyHints : p.keyHints;
  const showWaterfall = preset ? preset.waterfall : p.waterfall;
  const hideRange = preset?.hide ?? false;
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

  // Загрузка файла → MEI.
  useEffect(() => {
    warmUpVerovio();
    let alive = true;
    source
      .load()
      .then(({ data, zip }) => loadScore(data, zip))
      .then((m) => alive && setMei(m))
      .catch((e) => alive && setError(`Не удалось открыть ноты: ${e.message ?? e}`));
    return () => {
      alive = false;
      void api.pieceStop();
      void api.rhythmStop();
    };
  }, [source]);

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
  useEffect(() => {
    if (!mei) return;
    let alive = true;
    const text = showNames
      ? addNoteNames(mei, (pname, accid) => {
          const base = naming === "solfege" ? SOLFEGE[pname] : pname.toUpperCase();
          return base + (accid ? (ACCID[accid] ?? "") : "");
        })
      : mei;
    renderScore(text, verovioLayout(p.layout, width))
      .then((r) => {
        if (!alive) return;
        const structure = parseMei(mei);
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
    // width входит в layoutKey
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mei, showNames, naming, layoutKey]);

  const scoreRef = useRef(score);
  scoreRef.current = score;

  // Пьеса в базе практики: фрагменты, уровни, трудные такты.
  useEffect(() => {
    const sc = scoreRef.current;
    if (!sc || !sc.notes.length) return;
    api
      .practiceOpen({
        id: source.id,
        title: source.title,
        measures: sc.structure.measures,
        phraseEnds: phraseEnds(sc.notes, sc.structure, sc.starts, sc.endMs),
        measureHands: measureHands(sc.notes, sc.structure.measures),
      })
      .then((v) => {
        setPractice(v);
        setPracticeError(null);
      })
      .catch((e) => setPracticeError(String(e)));
  }, [notesKey, source]);

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

  const resetMarks = useCallback(() => {
    noteStates.current = new Map();
    setMarksVersion((v) => v + 1);
  }, []);

  // --- Режим ожидания ---
  useEffect(() => {
    const sc = scoreRef.current;
    if (!sc || !sc.notes.length || rhythmMode || !ready) return;
    setWaitSummary(null);
    setHits(new Set());
    setCurrent(null);
    resetMarks();
    const selected = rangeFrom ? sc.notes.filter((n) => n.measure >= rangeFrom && n.measure <= rangeTo) : sc.notes;
    void api.pieceStart(selected.map(toIn), { hands, accompany, tempo, looping: !!rangeFrom });
  }, [notesKey, hands, accompany, tempo, rangeFrom, rangeTo, rhythmMode, ready, run, resetMarks]);

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
    setToast(null);
    const beats = buildBeats(sc.starts, sc.endMs, sc.structure.meter, sc.tempoBpm);
    await api.rhythmStart(sc.notes.map(toIn), beats, {
      hands,
      accompany,
      tempo,
      countIn: p.countIn,
      metronome: p.metronome,
      loopRange: loopMs,
      beatsPerMeasure: sc.structure.meter.count,
      beatMs: Math.round(beatDuration(sc.structure.meter, sc.tempoBpm)),
    });
    setPlaying(true);
  }, [hands, accompany, tempo, p.countIn, p.metronome, loopMs, resetMarks]);
  const startRhythmRef = useRef(startRhythm);
  startRhythmRef.current = startRhythm;

  const stopRhythm = useCallback(() => {
    void api.rhythmStop();
    setPlaying(false);
  }, []);

  // Смена настроек во время игры в темпе: в свободной игре — остановка,
  // в ведущем режиме (темп вырос, другой отрезок) — сразу заново.
  const rhythmKey = `${hands}|${tempo}|${accompany}|${p.countIn}|${p.metronome}|${rangeFrom}-${rangeTo}|${notesKey}`;
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
    if (!practice) return;
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
      .practiceRecord(source.id, attempt)
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
      } else if (e.kind === "hit") {
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
        setRhythmSummary(e.summary);
        const s = e.summary;
        passRef.current(rhythmAccuracy(s.requiredNotes, s.hits, s.extras), null, s.troubleMeasures);
      }
    }).then(keep);
    return () => {
      alive = false;
      offs.forEach((f) => f());
    };
  }, [resetMarks]);

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
    for (const el of marked.current) el.classList.remove("mark-right", "mark-left", "mark-app", "mark-hit", "mark-poor", "mark-miss");
    marked.current = [];
    const mark = (id: string, cls: string) => {
      const el = root.querySelector(`g[id="${id}"]`);
      if (!el) return;
      el.classList.add(cls);
      marked.current.push(el);
    };
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
      .practiceSetFragments(source.id, starts)
      .then((v) => {
        setUnitSel(null);
        setPractice(v);
      })
      .catch((e) => setPracticeError(String(e)));

  // Такты с началом фрагмента (для правки границ).
  const fragmentStarts = useMemo(() => practice?.fragments.map((f) => f[0]) ?? [], [practice]);

  const onScoreClick = (e: React.MouseEvent) => {
    if (!score) return;
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
      .practiceSetLevel(source.id, unit.from, unit.to, to)
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

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT") return;
      if (e.key === "Escape") {
        if (editBounds) setEditBounds(false);
        else if (suggestion) dismissSuggestion();
        else if (!guided && loop) {
          setLoop(null);
          loopClicks.current = 0;
        } else onBack();
      } else if (e.code === "Space" && rhythmMode) {
        e.preventDefault();
        if (playing) stopRhythm();
        else void startRhythm();
      } else if (e.key === "Enter" && suggestion) acceptSuggestion();
      else if (e.key === "r" || e.key === "R" || e.key === "к" || e.key === "К") restart();
      else if (guided && practice && unit && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
        const i = practice.units.indexOf(unit) + (e.key === "ArrowLeft" ? -1 : 1);
        if (i >= 0 && i < practice.units.length) selectUnit(i);
      } else if (guided) return;
      else if (e.key === "h" || e.key === "H" || e.key === "р" || e.key === "Р") setPiece({ waterfall: !p.waterfall });
      else if (e.key === "+" || e.key === "=") setPiece({ tempo: clampTempo(p.tempo + 0.05) });
      else if (e.key === "-" || e.key === "_") setPiece({ tempo: clampTempo(p.tempo - 0.05) });
      else if (e.key === "1") setPiece({ hands: "right" });
      else if (e.key === "2") setPiece({ hands: "left" });
      else if (e.key === "3") setPiece({ hands: "both" });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // Клавиатура: диапазон пьесы, подсветка нужных клавиш и нажатий.
  const [low, high] = useMemo(() => {
    if (!notes.length) return [48, 84];
    const ps = notes.map((n) => n.pitch);
    return [Math.min(...ps) - 2, Math.max(...ps) + 2];
  }, [notes]);
  const highlight: Record<number, { color: string; strength?: number }> = {};
  if (keyHints) {
    for (const id of cursorIds) {
      const n = noteById.get(id);
      if (n && shows(n.hand) && !hits.has(id) && !noteStates.current.has(id))
        highlight[n.pitch] = { color: HAND_COLOR[n.hand], strength: 0.45 };
    }
  }
  for (const [n, h] of Object.entries(held)) highlight[Number(n)] = { color: deviceColor(h.device, devices), strength: 0.85 };
  if (wrongKey !== null) highlight[wrongKey] = { color: "#FF5C5C", strength: 0.9 };

  const needed = notes.filter((n) => includes(n.hand)).map((n) => n.pitch);
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

  return (
    <main className={`piece${showWaterfall ? " with-waterfall" : ""}`}>
      <div className="piece-bar">
        <button className="ghost" onClick={onBack} title="Esc">
          ← Пьесы
        </button>
        <div className="piece-name">{source.title}</div>
        <span className="segmented" title="Ведущий режим или свободная игра">
          <button className={guided ? "on" : ""} onClick={() => setPiece({ guided: true })}>
            Разучить
          </button>
          <button className={!guided ? "on" : ""} onClick={() => setPiece({ guided: false })}>
            Свободно
          </button>
        </span>
        {!guided && (
          <>
            <span className="segmented" title="1 / 2 / 3">
              <button className={hands === "right" ? "on" : ""} disabled={!hasRight} onClick={() => setPiece({ hands: "right" })}>
                Правая
              </button>
              <button className={hands === "left" ? "on" : ""} disabled={!hasLeft} onClick={() => setPiece({ hands: "left" })}>
                Левая
              </button>
              <button className={hands === "both" ? "on" : ""} disabled={!hasLeft || !hasRight} onClick={() => setPiece({ hands: "both" })}>
                Обе
              </button>
            </span>
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

      {guided && unit && practice ? (
        <GuidePanel
          practice={practice}
          unit={unit}
          editBounds={editBounds}
          onSelect={selectUnit}
          onLevel={setLevel}
          onEditBounds={() => setEditBounds((v) => !v)}
          status={
            <>
              {HAND_NAME[hands]}
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
            <Toggle label="Вторая рука звучит" on={p.accompany} disabled={hands === "both"} onChange={(v) => setPiece({ accompany: v })} />
            <Toggle label="Падающие ноты" on={p.waterfall} onChange={(v) => setPiece({ waterfall: v })} />
            <Toggle label="Названия нот" on={p.names} onChange={(v) => setPiece({ names: v })} />
            <Toggle label="Аппликатура" on={p.fingering} onChange={(v) => setPiece({ fingering: v })} />
            <Toggle label="Подсветка клавиш" on={p.keyHints} onChange={(v) => setPiece({ keyHints: v })} />
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
      {suggestion && unit && (
        <SuggestionBar suggestion={suggestion.s} unit={unit} practice={practice} onAccept={acceptSuggestion} onDismiss={dismissSuggestion} />
      )}

      <section className="paper piece-paper">
        <div
          ref={scrollRef}
          className={`score-scroll ${p.layout}${p.fingering ? "" : " hide-fing"}`}
          // Для сквозных тестов: текущий шаг, какие клавиши он ждёт, уровень и отрезок.
          data-current-step={current ? current.index : ""}
          data-current-pitches={current ? current.required.join(",") : ""}
          data-finished={waitSummary || rhythmSummary ? "1" : "0"}
          data-playing={playing ? "1" : "0"}
          data-level={unit ? level : ""}
          data-unit={unitKey}
          data-hands={hands}
        >
          <div ref={contentRef} className="score-content" onClick={onScoreClick}>
            {!pages.length && !error && <div className="muted score-loading">Загрузка нот…</div>}
            {pages.map((svg, i) => (
              <div key={i} className="score-page" dangerouslySetInnerHTML={{ __html: svg }} />
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
        {waitSummary && !rhythmMode && <WaitSummary summary={waitSummary} onAgain={restart} onBack={onBack} />}
        {rhythmSummary && rhythmMode && (
          <RhythmSummaryPanel summary={rhythmSummary} onAgain={() => void startRhythm()} onClose={() => setRhythmSummary(null)} />
        )}
      </section>

      {showWaterfall && (
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
          />
        </section>
      )}

      <section className="session-piano">
        <Piano low={low} high={high} naming={naming} highlight={highlight} labels="c" />
      </section>
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
  status,
  toggles,
}: {
  practice: PracticeView;
  unit: UnitView;
  editBounds: boolean;
  onSelect: (i: number) => void;
  onLevel: (l: number) => void;
  onEditBounds: () => void;
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
