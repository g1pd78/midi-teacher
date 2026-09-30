import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  api,
  listen,
  type HandMode,
  type PieceNoteIn,
  type PiecePrefs,
  type PieceSummary,
  type RhythmSummary,
} from "../api";
import { Piano } from "../components/Piano";
import { Waterfall, type NoteState } from "../components/Waterfall";
import { keyLabel } from "../lib/notes";
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

export function PieceView({ source, onBack }: { source: PieceSource; onBack: () => void }) {
  const { prefs, setPrefs, held, devices } = useApp();
  const p = prefs.piece;
  const setPiece = (patch: Partial<PiecePrefs>) => setPrefs({ piece: { ...p, ...patch } });
  const naming = prefs.noteNames;
  const rhythmMode = p.mode === "rhythm";

  const [mei, setMei] = useState<string | null>(null);
  const [pages, setPages] = useState<string[]>([]);
  const [score, setScore] = useState<Score | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [width, setWidth] = useState(1200);
  const [run, setRun] = useState(0);

  // Режим ожидания
  const [current, setCurrent] = useState<Current | null>(null);
  const [hits, setHits] = useState<Set<string>>(new Set());
  const [waitSummary, setWaitSummary] = useState<PieceSummary | null>(null);
  // Режим ритма
  const [playing, setPlaying] = useState(false);
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
  const [loopRects, setLoopRects] = useState<{ left: number; top: number; width: number; height: number }[]>([]);

  const notes = useMemo(() => score?.notes ?? [], [score]);

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

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(Math.round(el.clientWidth / 100) * 100));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Рендер нот и разбор пьесы.
  const layoutKey = p.layout === "pages" ? `pages-${width}` : "line";
  useEffect(() => {
    if (!mei) return;
    let alive = true;
    const text = p.names
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
  }, [mei, p.names, naming, layoutKey]);

  const hasLeft = notes.some((n) => n.hand === "left");
  const hasRight = notes.some((n) => n.hand === "right");
  const hands: HandMode = !hasLeft ? "right" : !hasRight ? "left" : p.hands;
  const includes = useCallback((hand: "right" | "left") => hands === "both" || hands === hand, [hands]);
  const noteById = useMemo(() => new Map(notes.map((n) => [n.id, n])), [notes]);
  const measures = score?.structure.measures ?? 0;
  const loopMs = useMemo(
    () => (score && loop ? loopRangeMs(score.starts, score.endMs, loop.from, loop.to) : null),
    [score, loop],
  );
  const notesKey = useMemo(() => notes.map((n) => n.id).join(","), [notes]);

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
  const scoreRef = useRef(score);
  scoreRef.current = score;
  useEffect(() => {
    const sc = scoreRef.current;
    if (!sc || !sc.notes.length || rhythmMode) return;
    setWaitSummary(null);
    setHits(new Set());
    setCurrent(null);
    resetMarks();
    const selected = loop ? sc.notes.filter((n) => n.measure >= loop.from && n.measure <= loop.to) : sc.notes;
    void api.pieceStart(selected.map(toIn), {
      hands,
      accompany: p.accompany,
      tempo: p.tempo,
      looping: !!loop,
    });
  }, [notesKey, hands, p.accompany, p.tempo, loop, rhythmMode, run, resetMarks]);

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

  // Смена настроек во время игры в темпе — остановка (запускать заново).
  useEffect(() => {
    if (!playing) return;
    void api.rhythmStop();
    setPlaying(false);
    // Только при смене параметров, а не при старте.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hands, p.tempo, p.accompany, p.countIn, p.metronome, loop, notesKey]);

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
      accompany: p.accompany,
      tempo: p.tempo,
      countIn: p.countIn,
      metronome: p.metronome,
      loopRange: loopMs,
      beatsPerMeasure: sc.structure.meter.count,
      beatMs: Math.round(beatDuration(sc.structure.meter, sc.tempoBpm)),
    });
    setPlaying(true);
  }, [hands, p.accompany, p.tempo, p.countIn, p.metronome, loopMs, resetMarks]);

  const stopRhythm = useCallback(() => {
    void api.rhythmStop();
    setPlaying(false);
  }, []);

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
      } else if (e.kind === "loopPass") {
        setToast(`Круг ${e.pass}: ${e.summary.errors === 0 ? "без ошибок" : `ошибок: ${e.summary.errors}`}`);
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
        setToast(`Круг ${e.pass}: ${percent(e.summary.accuracy)} нот, ±${e.summary.meanAbsDeltaMs} мс`);
      } else if (e.kind === "finished") {
        setPlaying(false);
        setRhythmSummary(e.summary);
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
      mark(id, includes(n.hand) ? `mark-${n.hand}` : "mark-app");
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

  // Прямоугольники выделенных тактов поверх нот.
  useLayoutEffect(() => {
    const content = contentRef.current;
    if (!content || !loop || !score) {
      setLoopRects([]);
      return;
    }
    const base = content.getBoundingClientRect();
    const rects = [];
    for (let m = loop.from; m <= loop.to; m++) {
      const el = content.querySelector(`g[id="${score.structure.measureIds[m - 1]}"]`);
      if (!el) continue;
      const r = el.getBoundingClientRect();
      rects.push({ left: r.left - base.left, top: r.top - base.top, width: r.width, height: r.height });
    }
    setLoopRects(rects);
  }, [loop, score, pages, width]);

  const onScoreClick = (e: React.MouseEvent) => {
    if (!score) return;
    const m = measureAt(e.clientX, e.clientY, e.target as Element, score.structure.measureIds, contentRef.current);
    if (m < 1) return;
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

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT") return;
      if (e.key === "Escape") {
        if (loop) {
          setLoop(null);
          loopClicks.current = 0;
        } else onBack();
      } else if (e.code === "Space" && rhythmMode) {
        e.preventDefault();
        if (playing) stopRhythm();
        else void startRhythm();
      } else if (e.key === "r" || e.key === "R" || e.key === "к" || e.key === "К") restart();
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
  if (p.keyHints) {
    for (const id of cursorIds) {
      const n = noteById.get(id);
      if (n && includes(n.hand) && !hits.has(id) && !noteStates.current.has(id))
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

  return (
    <main className={`piece${p.waterfall ? " with-waterfall" : ""}`}>
      <div className="piece-bar">
        <button className="ghost" onClick={onBack} title="Esc">
          ← Пьесы
        </button>
        <div className="piece-name">{source.title}</div>
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
            {playing ? "■ Стоп" : "▶ Старт"}
          </button>
        ) : (
          <button onClick={restart} title="R">
            Заново
          </button>
        )}
      </div>

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
        <span className="piece-progress">
          {rhythmMode
            ? playing
              ? rhythmStep < 0
                ? "приготовься…"
                : `шаг ${rhythmStep + 1} из ${totalSteps}`
              : "пробел — старт"
            : current
              ? `шаг ${current.index + 1}`
              : waitSummary
                ? "сыграно"
                : ""}
        </span>
      </div>
      <div className="piece-toggles secondary">
        <Toggle label="Вторая рука звучит" on={p.accompany} disabled={hands === "both"} onChange={(v) => setPiece({ accompany: v })} />
        <Toggle label="Падающие ноты" on={p.waterfall} onChange={(v) => setPiece({ waterfall: v })} />
        <Toggle label="Названия нот" on={p.names} onChange={(v) => setPiece({ names: v })} />
        <Toggle label="Аппликатура" on={p.fingering} onChange={(v) => setPiece({ fingering: v })} />
        <Toggle label="Подсветка клавиш" on={p.keyHints} onChange={(v) => setPiece({ keyHints: v })} />
      </div>

      {error && <div className="notice warn">{error}</div>}
      {narrow.map((d) => (
        <div key={d.name} className="notice info">
          Пьеса выходит за диапазон «{d.name}» ({keyLabel(d.settings.range![0], naming)}–{keyLabel(d.settings.range![1], naming)}).
          Часть нот придётся играть на другом инструменте.
        </div>
      ))}

      <section className="paper piece-paper">
        <div
          ref={scrollRef}
          className={`score-scroll ${p.layout}${p.fingering ? "" : " hide-fing"}`}
          // Для сквозных тестов: текущий шаг и какие клавиши он ждёт.
          data-current-step={current ? current.index : ""}
          data-current-pitches={current ? current.required.join(",") : ""}
          data-finished={waitSummary || rhythmSummary ? "1" : "0"}
          data-playing={playing ? "1" : "0"}
        >
          <div ref={contentRef} className="score-content" onClick={onScoreClick}>
            {!pages.length && !error && <div className="muted score-loading">Загрузка нот…</div>}
            {pages.map((svg, i) => (
              <div key={i} className="score-page" dangerouslySetInnerHTML={{ __html: svg }} />
            ))}
            {loopRects.map((r, i) => (
              <div key={i} className="loop-rect" style={{ left: r.left, top: r.top, width: r.width, height: r.height }} />
            ))}
          </div>
        </div>
        {toast && <div className="toast">{toast}</div>}
        {waitSummary && !rhythmMode && (
          <WaitSummary summary={waitSummary} onAgain={restart} onBack={onBack} />
        )}
        {rhythmSummary && rhythmMode && (
          <RhythmSummaryPanel summary={rhythmSummary} onAgain={() => void startRhythm()} onClose={() => setRhythmSummary(null)} />
        )}
      </section>

      {p.waterfall && (
        <section className="waterfall-box">
          <Waterfall
            notes={notes}
            low={low}
            high={high}
            getPos={getPos}
            windowMs={WATERFALL_SEC * 1000 * p.tempo}
            includes={includes}
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
