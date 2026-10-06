import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  api,
  listen,
  type Feedback,
  type SessionView,
  type TrainerLevel,
  type TrainerOverview,
  type TrainerPrefs,
  type TrainerSummary,
} from "../api";
import { Piano } from "../components/Piano";
import { TheoryPlaque } from "../components/Theory";
import { trainerFeatures } from "../lib/theory";
import { Staff, type NoteMark } from "../components/Staff";
import { spelledName } from "../lib/mei";
import { fullName } from "../lib/notes";
import { warmUpVerovio } from "../lib/verovio";
import { deviceColor, useApp } from "../store";

const SERIES = 20;
const LANE_PAGE = 8;
/** Через сколько миллисекунд раздумья показать подсказку. */
const STRUGGLE_MS = 3000;

export function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1).replace(".", ",")} с`;
}

function percent(x: number): string {
  return `${Math.round(x * 100)}%`;
}

export function Trainer({
  tabs,
  startLevel,
  onDone,
  backLabel,
}: {
  tabs?: React.ReactNode;
  startLevel?: number;
  onDone?: () => void;
  backLabel?: string;
}) {
  const [overview, setOverview] = useState<TrainerOverview | null>(null);
  const [session, setSession] = useState<SessionView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { prefs } = useApp();

  const reload = useCallback(() => {
    api.trainerOverview().then(setOverview).catch((e) => setError(String(e)));
  }, []);

  useEffect(() => {
    warmUpVerovio();
    reload();
    return () => void api.trainerStop();
  }, [reload]);

  const start = async (level: number) => {
    try {
      setSession(await api.trainerStart(level, prefs.trainer.errorMode, SERIES));
    } catch (e) {
      setError(String(e));
    }
  };

  // Курс: сразу нужная ступень, выход — обратно в урок.
  const autoStarted = useRef(false);
  useEffect(() => {
    if (!startLevel || !overview || autoStarted.current) return;
    autoStarted.current = true;
    void start(startLevel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startLevel, overview]);

  if (error) return <main className="trainer">{tabs}<div className="notice warn">{error}</div></main>;
  if (!overview) return <main className="trainer">{tabs}<div className="muted">Загрузка…</div></main>;

  if (session) {
    const level = overview.levels.find((l) => l.id === session.level)!;
    return (
      <TrainerSession
        key={session.targets.map((t) => t.id + t.midi).join()}
        session={session}
        level={level}
        overview={overview}
        backLabel={backLabel}
        onExit={() => {
          void api.trainerStop();
          setSession(null);
          reload();
          onDone?.();
        }}
        onRestart={(lvl) => {
          reload();
          void start(lvl);
        }}
      />
    );
  }
  return <TrainerLevels overview={overview} onStart={start} tabs={tabs} />;
}

function TrainerSettings() {
  const { prefs, setPrefs } = useApp();
  const t = prefs.trainer;
  const set = (patch: Partial<TrainerPrefs>) => setPrefs({ trainer: { ...t, ...patch } });
  return (
    <div className="trainer-settings">
      <label>
        <span>Подача</span>
        <span className="segmented">
          <button className={t.layout === "single" ? "on" : ""} onClick={() => set({ layout: "single" })}>
            По одной
          </button>
          <button className={t.layout === "lane" ? "on" : ""} onClick={() => set({ layout: "lane" })}>
            Лентой
          </button>
        </span>
      </label>
      <label>
        <span>При ошибке</span>
        <span className="segmented">
          <button className={t.errorMode === "wait" ? "on" : ""} onClick={() => set({ errorMode: "wait" })}>
            Ждать правильную
          </button>
          <button className={t.errorMode === "advance" ? "on" : ""} onClick={() => set({ errorMode: "advance" })}>
            Идти дальше
          </button>
        </span>
      </label>
      <label>
        <span>Названия нот</span>
        <span className="segmented">
          <button className={t.names === "always" ? "on" : ""} onClick={() => set({ names: "always" })}>
            Всегда
          </button>
          <button className={t.names === "struggle" ? "on" : ""} onClick={() => set({ names: "struggle" })}>
            При затруднении
          </button>
          <button className={t.names === "never" ? "on" : ""} onClick={() => set({ names: "never" })}>
            Никогда
          </button>
        </span>
      </label>
    </div>
  );
}

function TrainerLevels({ overview, onStart, tabs }: { overview: TrainerOverview; onStart: (level: number) => void; tabs?: React.ReactNode }) {
  const { prefs } = useApp();
  const stats = new Map(overview.levelStats.map((s) => [s.level, s]));

  // Как хорошо известна каждая нота: зелёный — уверенно, красный — путаю.
  const heat: Record<number, { color: string; strength: number }> = {};
  const byMidi = new Map<number, { acc: number; n: number }>();
  for (const s of overview.noteStats) {
    const cur = byMidi.get(s.midi) ?? { acc: 0, n: 0 };
    byMidi.set(s.midi, { acc: cur.acc + s.accuracy * s.attempts, n: cur.n + s.attempts });
  }
  for (const [midi, { acc, n }] of byMidi) {
    const a = n > 0 ? acc / n : 0;
    heat[midi] = { color: a >= 0.9 ? "#4CC38A" : a >= 0.7 ? "#F2C94C" : "#FF5C5C", strength: 0.35 + 0.5 * Math.min(1, n / 10) };
  }

  return (
    <main className="trainer">
      {tabs}
      <section className="card trainer-intro">
        <div>
          <h1>Тренажёр нот</h1>
          <p className="hint">
            На нотном стане появляется нота — нажми эту клавишу (октава важна). В серии {SERIES} нот. Следующая ступень
            открывается, когда с первого раза верно не меньше {percent(overview.passAccuracy)} нот, а в среднем на ноту
            уходит не больше {seconds(overview.passReactionMs)}.
          </p>
          {overview.storageError && (
            <div className="notice warn">Прогресс не сохраняется: база данных недоступна (подробности в логе).</div>
          )}
        </div>
        <TrainerSettings />
      </section>

      <section className="levels">
        {overview.levels.map((l) => {
          const st = stats.get(l.id);
          const locked = l.id > overview.unlocked;
          const recommended = l.id === overview.unlocked && !st?.passed;
          return (
            <div key={l.id} className={`level card${locked ? " locked" : ""}${recommended ? " recommended" : ""}`}>
              <div className="level-head">
                <span className="level-num">{l.id}</span>
                <span className="level-title">{l.title}</span>
                {st?.passed && <span className="chip small good">пройдена</span>}
                {recommended && <span className="chip small accent">сейчас</span>}
              </div>
              <div className="level-desc">{l.description}</div>
              <div className="level-stats">
                {st
                  ? `Лучший результат ${percent(st.bestAccuracy)} · последняя серия ${percent(st.lastAccuracy)}, ${seconds(st.lastReactionMs)} на ноту`
                  : locked
                    ? "Откроется после предыдущей ступени"
                    : "Ещё не пробовали"}
              </div>
              <button className={recommended ? "primary" : ""} disabled={locked} onClick={() => onStart(l.id)}>
                {locked ? "Закрыта" : st ? "Ещё серия" : "Начать"}
              </button>
            </div>
          );
        })}
      </section>

      {byMidi.size > 0 && (
        <section className="card">
          <h2>Как ты знаешь ноты</h2>
          <p className="hint">Зелёные — уверенно, жёлтые — иногда путаешь, красные — стоит повторить.</p>
          <div className="heat-piano">
            <Piano low={36} high={84} naming={prefs.noteNames} highlight={heat} labels="c" lights={false} />
          </div>
        </section>
      )}
    </main>
  );
}

interface SessionProps {
  session: SessionView;
  level: TrainerLevel;
  overview: TrainerOverview;
  backLabel?: string;
  onExit: () => void;
  onRestart: (level: number) => void;
}

function TrainerSession({ session, level, overview, backLabel, onExit, onRestart }: SessionProps) {
  const { prefs, held, devices } = useApp();
  const naming = prefs.noteNames;
  const t = prefs.trainer;
  const targets = session.targets;

  const [index, setIndex] = useState(0);
  const [marks, setMarks] = useState<Record<string, NoteMark>>({});
  const [message, setMessage] = useState<{ text: string; kind: "good" | "bad" | "info" } | null>(null);
  const [struggling, setStruggling] = useState(false);
  const [hintKey, setHintKey] = useState<number | null>(null);
  const [wrongKey, setWrongKey] = useState<number | null>(null);
  const [summary, setSummary] = useState<TrainerSummary | null>(null);
  const readySent = useRef(false);
  // Ноты уже нарисованы (первая загрузка Verovio может занять пару секунд).
  const [shown, setShown] = useState(false);
  const errorsOnCurrent = useRef(0);

  const current = targets[index];
  const lane = t.layout === "lane";
  const page = Math.floor(index / LANE_PAGE);
  const visible = lane ? targets.slice(page * LANE_PAGE, page * LANE_PAGE + LANE_PAGE) : current ? [current] : [];
  const firstClef = targets[0]?.clef ?? "treble";

  // Подсказка после раздумья.
  useEffect(() => {
    setStruggling(false);
    errorsOnCurrent.current = 0;
    if (summary || !shown) return;
    const id = setTimeout(() => setStruggling(true), STRUGGLE_MS);
    return () => clearTimeout(id);
  }, [index, summary, shown]);

  const onFeedback = useCallback(
    (fb: Feedback, finished: TrainerSummary | null) => {
      const target = targets[fb.index];
      if (!target) return;
      if (fb.kind === "correct") {
        setMarks((m) => ({ ...m, [target.id]: errorsOnCurrent.current === 0 ? "correct" : "done-wrong" }));
        setMessage({ text: `Верно · ${seconds(fb.reactionMs)}`, kind: "good" });
        setHintKey(null);
        setWrongKey(null);
        setIndex(fb.index + 1);
      } else {
        errorsOnCurrent.current += 1;
        setWrongKey(fb.played);
        setTimeout(() => setWrongKey((k) => (k === fb.played ? null : k)), 700);
        if (fb.advanced) {
          setMarks((m) => ({ ...m, [target.id]: "done-wrong" }));
          setMessage({ text: `Это была ${fullName(fb.expected, naming).toLowerCase()}`, kind: "bad" });
          setHintKey(fb.expected);
          setTimeout(() => setHintKey((k) => (k === fb.expected ? null : k)), 1200);
          setIndex(fb.index + 1);
        } else {
          setMarks((m) => ({ ...m, [target.id]: "wrong" }));
          setMessage({ text: `Нажата ${fullName(fb.played, naming).toLowerCase()} — попробуй ещё`, kind: "bad" });
          if (fb.hint) setStruggling(true);
        }
      }
      if (finished) setSummary(finished);
    },
    [targets, naming],
  );

  useEffect(() => {
    let off: (() => void) | undefined;
    let alive = true;
    void listen("trainer", (e) => onFeedback(e.feedback, e.finished)).then((fn) => (alive ? (off = fn) : fn()));
    return () => {
      alive = false;
      off?.();
    };
  }, [onFeedback]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onExit();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onExit]);

  const showHint = struggling && !summary && current;
  const displayMarks: Record<string, NoteMark> = { ...marks };
  if (current && !summary) displayMarks[current.id] = marks[current.id] === "wrong" ? "wrong" : "current";
  const names: "all" | "none" | string[] =
    t.names === "always" ? "all" : t.names === "never" || !showHint ? "none" : [current.id];

  // Клавиатура вокруг диапазона ступени.
  const [low, high] = useMemo(() => {
    const ms = level.pool.map((p) => p[0]);
    const lo = Math.min(...ms) - 4;
    const hi = Math.max(...ms) + 4;
    const pad = Math.max(0, 25 - (hi - lo)) / 2;
    return [Math.floor(lo - pad), Math.ceil(hi + pad)];
  }, [level]);

  const highlight: Record<number, { color: string; strength?: number; held?: boolean }> = {};
  for (const [n, h] of Object.entries(held)) highlight[Number(n)] = { color: deviceColor(h.device, devices), strength: 0.6, held: true };
  if (showHint && current) highlight[current.midi] = { color: "#4CC38A", strength: 0.55 };
  if (hintKey !== null) highlight[hintKey] = { color: "#4CC38A", strength: 0.7 };
  if (wrongKey !== null) highlight[wrongKey] = { color: "#FF5C5C", strength: 0.8 };

  return (
    <main
      className="trainer session"
      // Для сквозных тестов: какую ноту ждёт серия.
      data-current-midi={summary ? "" : (current?.midi ?? "")}
    >
      <div className="session-bar">
        <button className="ghost" onClick={onExit} title="Esc">
          {backLabel ?? "← Ступени"}
        </button>
        <div className="session-title">
          <span className="level-num">{level.id}</span> {level.title}
        </div>
        <div className="session-progress">
          <div className="progress-track">
            <div className="progress-fill" style={{ width: `${(Math.min(index, targets.length) / targets.length) * 100}%` }} />
          </div>
          <span>
            {Math.min(index, targets.length)} / {targets.length}
          </span>
        </div>
      </div>

      <section className="paper">
        {visible.length > 0 && (
          <Staff
            notes={visible}
            grand={session.grandStaff}
            clef={firstClef}
            layout={lane ? "lane" : "single"}
            naming={naming}
            marks={displayMarks}
            names={names}
            onRendered={() => {
              setShown(true);
              if (!readySent.current) {
                readySent.current = true;
                void api.trainerReady();
              }
            }}
          />
        )}
        {summary && (
          <SummaryPanel
            summary={summary}
            overview={overview}
            backLabel={backLabel}
            onExit={onExit}
            onRestart={onRestart}
          />
        )}
      </section>

      <div className={`session-message ${message?.kind ?? ""}`}>
        {summary
          ? " "
          : showHint && current
            ? `Подсказка: это ${spelledName(current, naming).toLowerCase()} — подсвечена на клавиатуре`
            : (message?.text ?? "Сыграй ноту, которая на стане")}
      </div>

      <section className="session-piano">
        <Piano low={low} high={high} naming={naming} highlight={highlight} labels="c" />
      </section>
      <TheoryPlaque
        features={trainerFeatures(level.id, session.grandStaff, level.pool.every(([, clef]) => clef === "bass"))}
      />
    </main>
  );
}

function SummaryPanel({
  summary,
  overview,
  backLabel,
  onExit,
  onRestart,
}: {
  summary: TrainerSummary;
  overview: TrainerOverview;
  backLabel?: string;
  onExit: () => void;
  onRestart: (level: number) => void;
}) {
  const { prefs } = useApp();
  const accOk = summary.accuracy >= overview.passAccuracy;
  const rtOk = summary.avgReactionMs <= overview.passReactionMs;
  const next = overview.levels.find((l) => l.id === summary.level + 1);
  const nextOpen = next && (summary.unlockedLevel === next.id || next.id <= overview.unlocked);

  return (
    <div className="summary-overlay">
      <div className="summary card">
        <h2>Серия завершена</h2>
        <div className="summary-stats">
          <div>
            <div className={`big ${accOk ? "good" : "bad"}`}>{percent(summary.accuracy)}</div>
            <div className="muted">
              с первого раза ({summary.firstTry} из {summary.notes})
            </div>
          </div>
          <div>
            <div className={`big ${rtOk ? "good" : "bad"}`}>{seconds(summary.avgReactionMs)}</div>
            <div className="muted">в среднем на ноту</div>
          </div>
        </div>
        <ul className="criteria">
          <li className={accOk ? "good" : "bad"}>
            {accOk ? "✓" : "✗"} точность от {percent(overview.passAccuracy)}
          </li>
          <li className={rtOk ? "good" : "bad"}>
            {rtOk ? "✓" : "✗"} не дольше {seconds(overview.passReactionMs)} на ноту
          </li>
        </ul>
        {summary.trouble.length > 0 && (
          <div className="trouble">
            <span className="muted">Путал: </span>
            {summary.trouble.map((t) => (
              <span key={`${t.clef}${t.midi}`} className="chip small">
                {fullName(t.midi, prefs.noteNames)} ({t.clef === "treble" ? "скрипичный" : "басовый"})
              </span>
            ))}
          </div>
        )}
        {summary.unlockedLevel && next && (
          <div className="notice info">
            Открыта ступень {next.id}: «{next.title}»
          </div>
        )}
        <div className="summary-actions">
          <button className="primary" onClick={() => onRestart(summary.level)}>
            Ещё серия
          </button>
          {nextOpen && next && <button onClick={() => onRestart(next.id)}>Ступень {next.id} →</button>}
          <button className="ghost" onClick={onExit}>
            {backLabel ?? "К ступеням"}
          </button>
        </div>
      </div>
    </div>
  );
}
