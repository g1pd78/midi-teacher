import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, PADS_DEVICE } from "../api";
import { LevelCard } from "../components/LevelCard";
import type { ExerciseStatView } from "../lib/exercises";
import { QUALITY_STEPS } from "../lib/chords";
import {
  CHORD_KINDS,
  EAR_KINDS,
  EAR_PASS_ACCURACY,
  EAR_RHYTHM_BPM,
  EAR_TIMBRE_PROGRAM,
  earLevelId,
  earSeries,
  earUnlocked,
  judgeChordPlay,
  judgeNote,
  judgeRhythm,
  levelsOf,
  melodyPrefix,
  pcName,
  type EarLevel,
  type EarNote,
  type EarQuestion,
} from "../lib/ear";
import { rhythmMei } from "../lib/rhythm";
import { renderSvg } from "../lib/verovio";
import { verovioOptions } from "../lib/staffOptions";
import { useMidi } from "../store";
import { useExpectChords, useStrum } from "./GuitarChords";
import { dayKey } from "./Exercises";

type Timbre = "piano" | "guitar";
const TIMBRE_KEY = "mt-ear-timbre";
function loadTimbre(): Timbre {
  try {
    return localStorage.getItem(TIMBRE_KEY) === "guitar" ? "guitar" : "piano";
  } catch {
    return "piano";
  }
}

const freshSeed = () => Math.floor(Date.now() / 1000) % 100000;

/** Проиграть задание выбранным тембром. */
function playQuestion(notes: EarNote[], timbre: Timbre) {
  void api
    .playNotes(
      notes.map((n) => ({ ...n, velocity: 90 })),
      EAR_TIMBRE_PROGRAM[timbre],
    )
    .catch(() => {});
}

/** Раздел «Слух» в «Тренажёрах». */
export function Ear({ tabs, autoStart, onAutoStarted }: { tabs: React.ReactNode; autoStart?: boolean; onAutoStarted?: () => void }) {
  const [stats, setStats] = useState<ExerciseStatView[] | null>(null);
  const [run, setRun] = useState<{ level: EarLevel; seed: number } | null>(null);
  const [timbre, setTimbreState] = useState<Timbre>(loadTimbre);
  const setTimbre = (t: Timbre) => {
    setTimbreState(t);
    try {
      localStorage.setItem(TIMBRE_KEY, t);
    } catch {
      /* без сохранения */
    }
  };
  const reload = useCallback(() => {
    api.exerciseStats().then(setStats).catch(() => setStats([]));
  }, []);
  useEffect(reload, [reload]);

  // С главной: вид по кругу (по дню), текущая ступень.
  useEffect(() => {
    if (!autoStart || !stats) return;
    const day = Math.floor(Date.parse(`${dayKey()}T00:00:00Z`) / 86_400_000) || 0;
    const kind = EAR_KINDS[day % 3].id;
    setRun({ level: levelsOf(kind)[earUnlocked(stats, kind) - 1], seed: freshSeed() });
    onAutoStarted?.();
  }, [autoStart, stats, onAutoStarted]);

  if (run) {
    const back = () => {
      setRun(null);
      reload();
    };
    const key = `${earLevelId(run.level)}-${run.seed}`;
    const props = { level: run.level, seed: run.seed, timbre, onBack: back, onAgain: () => setRun({ ...run, seed: run.seed + 1 }), onRecorded: reload };
    if (run.level.kind === "melody") return <MelodyDictation key={key} {...props} />;
    if (run.level.kind === "rhythm") return <RhythmDictation key={key} {...props} />;
    return <EarDrill key={key} {...props} />;
  }

  const statOf = (id: string) => (stats ?? []).find((s) => s.exercise === id);
  return (
    <main className="exercises trainers ear">
      {tabs}
      <section className="card">
        <h1>Слух</h1>
        <p className="hint">
          Прозвучит задание — ответь кнопкой или сыграй ответ на инструменте (клавиатура или гитара). «▶ Ещё раз» — послушать
          снова. Серия — 10 заданий (диктанты — 5); зачёт — от {Math.round(EAR_PASS_ACCURACY * 100)}% с первой попытки.
        </p>
        <span className="segmented" title="Чем звучат задания" data-ear-timbre={timbre}>
          {(["piano", "guitar"] as const).map((t) => (
            <button key={t} className={timbre === t ? "on" : ""} onClick={() => setTimbre(t)} data-ear-timbre-btn={t}>
              {t === "piano" ? "Фортепиано" : "Гитара"}
            </button>
          ))}
        </span>
      </section>
      {EAR_KINDS.map((k) => {
        const open = stats ? earUnlocked(stats, k.id) : 1;
        return (
          <section key={k.id} className="card ex-category" data-category={`ear-${k.id}`}>
            <h2 className="section-h">{k.title}</h2>
            <p className="hint">{k.description}</p>
            <div className="drum-list">
              {levelsOf(k.id).map((l) => {
                const st = statOf(earLevelId(l));
                const passed = !!st?.passed;
                return (
                  <LevelCard
                    key={l.id}
                    n={l.id}
                    title={l.title}
                    hint={l.description}
                    status={st ? `Серий: ${st.attempts}, лучшая ${Math.round(st.bestAccuracy * 100)}%` : "Ещё не играл"}
                    passed={passed}
                    open={l.id <= open}
                    current={l.id === open && !passed}
                    onClick={() => setRun({ level: l, seed: freshSeed() })}
                    data={{ "ear-level": `${k.id}-${l.id}` }}
                  />
                );
              })}
            </div>
          </section>
        );
      })}
    </main>
  );
}

interface DrillProps {
  level: EarLevel;
  seed: number;
  timbre: Timbre;
  onBack: () => void;
  onAgain: () => void;
  onRecorded: () => void;
}

/** Итог серии и запись результата — общий для всех видов. */
function useSeriesResult(level: EarLevel, done: boolean, results: boolean[], onRecorded: () => void) {
  const accuracy = results.length ? results.filter(Boolean).length / results.length : 0;
  const passed = done && accuracy >= EAR_PASS_ACCURACY;
  const recorded = useRef(false);
  useEffect(() => {
    if (!done || recorded.current) return;
    recorded.current = true;
    void api
      .exerciseRecord({ exercise: earLevelId(level), tempo: 1, accuracy, timingSdMs: 0, loudness: 1, passed })
      .then(onRecorded)
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [done]);
  return { accuracy, passed };
}

function useEscape(onBack: () => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onBack();
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      void api.midiPreviewStop().catch(() => {});
    };
  }, [onBack]);
}

function SeriesSummary({ passed, accuracy, onAgain, onBack }: { passed: boolean; accuracy: number; onAgain: () => void; onBack: () => void }) {
  return (
    <section className="card chord-card summary-inline">
      <h2>{passed ? "Засчитано ✓" : "Серия пройдена"}</h2>
      <div className="summary-stats">
        <div>
          <div className={`big ${passed ? "good" : ""}`}>{Math.round(accuracy * 100)}%</div>
          <div className="muted">с первой попытки</div>
        </div>
      </div>
      {!passed && <p className="hint">Для зачёта — от {Math.round(EAR_PASS_ACCURACY * 100)}% с первой попытки.</p>}
      {passed && <p className="hint">Следующая ступень открыта.</p>}
      <div className="summary-actions">
        <button className="primary" onClick={onAgain}>
          Ещё серия
        </button>
        <button className="ghost" onClick={onBack}>
          К списку
        </button>
      </div>
    </section>
  );
}

function DrillBar({ title, index, total, onBack, onReplay }: { title: string; index: number; total: number; onBack: () => void; onReplay?: () => void }) {
  return (
    <div className="piece-bar">
      <button className="ghost" onClick={onBack} title="Esc">
        ← Слух
      </button>
      <div className="piece-name">Слух · {title}</div>
      {onReplay && (
        <button className="primary" onClick={onReplay} data-ear-replay title="Пробел">
          ▶ Ещё раз
        </button>
      )}
      <span className="chip">
        {Math.min(index + 1, total)} / {total}
      </span>
    </div>
  );
}

/** Звуки всех видов аккорда от основного тона в гитарном диапазоне — кандидаты для распознавания звука. */
function chordCandidates(root: number, qualities: (typeof CHORD_KINDS)[number]["q"][]): number[][] {
  return qualities.map((q) => {
    const pcs = new Set(QUALITY_STEPS[q].map((s) => (root + s) % 12));
    const out: number[] = [];
    for (let p = 40; p <= 76; p++) if (pcs.has(p % 12)) out.push(p);
    return out;
  });
}

/** Интервалы, аккорды, ступени: кнопки или ответ игрой. */
function EarDrill({ level, seed, timbre, onBack, onAgain, onRecorded }: DrillProps) {
  const series = useMemo(() => earSeries(level, seed, timbre === "guitar"), [level, seed, timbre]);
  const [index, setIndex] = useState(0);
  const [results, setResults] = useState<boolean[]>([]);
  const [wrong, setWrong] = useState<string[]>([]);
  const [solved, setSolved] = useState(false);
  const [flash, setFlash] = useState<"ok" | "wrong" | null>(null);
  const missed = useRef(false);
  const done = index >= series.length;
  const q = series[Math.min(index, series.length - 1)];
  const chordAnswer = level.kind === "chord" || (level.kind === "degree" && !!level.romans);
  const noteAnswer = level.kind === "interval" || (level.kind === "degree" && !!level.degrees);
  useEscape(onBack);

  const replay = useCallback(() => playQuestion(q.notes, timbre), [q, timbre]);
  useEffect(() => {
    if (done) return;
    setWrong([]);
    setSolved(false);
    missed.current = false;
    const t = setTimeout(replay, 350);
    return () => clearTimeout(t);
  }, [index, done, replay]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === "Space" && !done) {
        e.preventDefault();
        replay();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [replay, done]);

  // Гитара в режиме аккорда: кандидаты — все виды аккорда ступени на этом основном тоне.
  const root = q.expected.length ? Math.min(...q.expected) : 60;
  useExpectChords(!done && chordAnswer && level.kind === "chord" ? chordCandidates(root, level.qualities ?? []) : !done && chordAnswer ? [q.expected] : []);

  const answer = (ok: boolean, label?: string) => {
    if (done || solved) return;
    if (ok) {
      setSolved(true);
      setFlash("ok");
      setResults((r) => [...r, !missed.current]);
      setTimeout(() => {
        setFlash(null);
        setIndex((i) => i + 1);
      }, 1400);
    } else {
      missed.current = true;
      if (label) setWrong((w) => [...w, label]);
      setFlash("wrong");
      setTimeout(() => setFlash((f) => (f === "wrong" ? null : f)), 400);
    }
  };

  useMidi((ev) => {
    if (!noteAnswer || ev.type !== "noteOn" || ev.device === PADS_DEVICE) return;
    answer(judgeNote(q, ev.note));
  });
  useStrum((ps) => {
    if (!chordAnswer) return;
    answer(judgeChordPlay(q, ps));
  });

  const { accuracy, passed } = useSeriesResult(level, done, results, onRecorded);
  return (
    <main className="chord-drill ear-drill" data-ear-index={index} data-ear-done={done ? (passed ? "passed" : "failed") : ""} data-ear-correct={done ? "" : q.answer} data-ear-expected={done ? "" : q.expected.join(",")}>
      <DrillBar title={levelTitle(level)} index={index} total={series.length} onBack={onBack} onReplay={done ? undefined : replay} />
      {!done ? (
        <section className={`card chord-card${flash ? ` flash-${flash}` : ""}`}>
          <div className="chord-name">{prompt(level, q)}</div>
          <div className="ear-options">
            {q.options.map((o) => (
              <button
                key={o}
                className={`ear-option${solved && o === q.answer ? " right" : ""}${wrong.includes(o) ? " wrong" : ""}`}
                onClick={() => answer(o === q.answer, o)}
                disabled={solved || wrong.includes(o)}
                data-ear-option={o}
              >
                {o}
              </button>
            ))}
          </div>
          <p className="muted ear-how">
            {noteAnswer
              ? "Или сыграй вторую ноту на инструменте."
              : chordAnswer
                ? "Или возьми этот аккорд на инструменте (любое расположение)."
                : "Последовательность — только кнопкой."}
          </p>
          {solved && <p className="ear-explain">{q.explain}</p>}
        </section>
      ) : (
        <SeriesSummary passed={passed} accuracy={accuracy} onAgain={onAgain} onBack={onBack} />
      )}
    </main>
  );
}

function levelTitle(level: EarLevel): string {
  return `${EAR_KINDS.find((k) => k.id === level.kind)!.title} · ${level.title}`;
}

function prompt(level: EarLevel, q: EarQuestion): string {
  switch (level.kind) {
    case "interval":
      return level.direction === "harmonic" ? "Какой интервал прозвучал (вместе)?" : `Какой интервал? Первая нота — ${pcName(q.given ?? 0)}`;
    case "chord":
      return "Какой аккорд прозвучал?";
    default:
      return level.progressions ? "Какая последовательность аккордов?" : level.romans ? "Какой аккорд после каденции?" : `Какая ступень? Тоника — ${pcName(q.given ?? 0)}`;
  }
}

/** Мелодический диктант: сыграть услышанную мелодию. */
function MelodyDictation({ level, seed, timbre, onBack, onAgain, onRecorded }: DrillProps) {
  const series = useMemo(() => earSeries(level, seed, timbre === "guitar"), [level, seed, timbre]);
  const [index, setIndex] = useState(0);
  const [played, setPlayed] = useState<number[]>([]);
  const [errorAt, setErrorAt] = useState<number | null>(null);
  const [solved, setSolved] = useState(false);
  const [results, setResults] = useState<boolean[]>([]);
  const missed = useRef(false);
  const done = index >= series.length;
  const q = series[Math.min(index, series.length - 1)];
  useEscape(onBack);
  const replay = useCallback(() => playQuestion(q.notes, timbre), [q, timbre]);
  useEffect(() => {
    if (done) return;
    setPlayed([]);
    setErrorAt(null);
    setSolved(false);
    missed.current = false;
    const t = setTimeout(replay, 350);
    return () => clearTimeout(t);
  }, [index, done, replay]);

  useMidi((ev) => {
    if (done || solved || ev.type !== "noteOn" || ev.device === PADS_DEVICE) return;
    const next = [...played, ev.note];
    const ok = melodyPrefix(q, next);
    if (ok < next.length) {
      // Ошибка: отметить и начать сначала.
      missed.current = true;
      setErrorAt(next.length - 1);
      setPlayed([]);
      return;
    }
    setErrorAt(null);
    setPlayed(next);
    if (ok === q.expected.length) {
      setSolved(true);
      setResults((r) => [...r, !missed.current]);
      setTimeout(() => setIndex((i) => i + 1), 1800);
    }
  });

  const { accuracy, passed } = useSeriesResult(level, done, results, onRecorded);
  return (
    <main className="chord-drill ear-drill" data-ear-index={index} data-ear-done={done ? (passed ? "passed" : "failed") : ""} data-ear-expected={done ? "" : q.expected.join(",")}>
      <DrillBar title={levelTitle(level)} index={index} total={series.length} onBack={onBack} onReplay={done ? undefined : replay} />
      {!done ? (
        <section className={`card chord-card${solved ? " flash-ok" : errorAt !== null ? " flash-wrong" : ""}`}>
          <div className="chord-name">Сыграй мелодию: {q.expected.length} нот, первая — {pcName(q.given ?? 0)}</div>
          <div className="dictation-slots">
            {q.expected.map((p, i) => (
              <span key={i} className={`dictation-slot${i < played.length ? " ok" : ""}${errorAt === i ? " bad" : ""}`}>
                {solved || i < played.length ? pcName(p) : "?"}
              </span>
            ))}
          </div>
          {errorAt !== null && <p className="bad-text">Нота {errorAt + 1} не та — сыграй мелодию сначала («▶ Ещё раз» — послушать).</p>}
          {solved && <p className="ear-explain">{q.explain}</p>}
        </section>
      ) : (
        <SeriesSummary passed={passed} accuracy={accuracy} onAgain={onAgain} onBack={onBack} />
      )}
    </main>
  );
}

/** Ритмический диктант: прослушать ритм, после отсчёта простучать. */
function RhythmDictation({ level, seed, timbre, onBack, onAgain, onRecorded }: DrillProps) {
  const series = useMemo(() => earSeries(level, seed, timbre === "guitar"), [level, seed, timbre]);
  const [index, setIndex] = useState(0);
  const [phase, setPhase] = useState<"listen" | "count" | "tap" | "result">("listen");
  const [verdict, setVerdict] = useState<{ ok: boolean; hits: number; total: number } | null>(null);
  const [results, setResults] = useState<boolean[]>([]);
  const [svg, setSvg] = useState("");
  const taps = useRef<number[]>([]);
  const tries = useRef(0);
  const done = index >= series.length;
  const q = series[Math.min(index, series.length - 1)];
  const beat = 60_000 / EAR_RHYTHM_BPM;
  const total = (q.rhythm?.score.right.length ?? 2) * 4 * beat;
  useEscape(onBack);

  // Прослушать: отсчёт (4 щелчка) и ритм.
  const listen = useCallback(() => {
    const clicks: EarNote[] = [0, 1, 2, 3].map((i) => ({ pitch: i === 0 ? 84 : 79, startMs: i * beat, durMs: 80 }));
    playQuestion([...clicks, ...q.notes.map((n) => ({ ...n, startMs: n.startMs + 4 * beat }))], "piano");
    setPhase("listen");
  }, [q, beat]);
  useEffect(() => {
    if (done) return;
    tries.current = 0;
    setVerdict(null);
    setSvg("");
    const t = setTimeout(listen, 350);
    return () => clearTimeout(t);
  }, [index, done, listen]);

  // «Твоя очередь»: отсчёт, потом удары; итог — через такт после конца ритма.
  const start = () => {
    taps.current = [];
    setVerdict(null);
    setPhase("count");
    playQuestion([0, 1, 2, 3].map((i) => ({ pitch: i === 0 ? 84 : 79, startMs: i * beat, durMs: 80 })), "piano");
    setTimeout(() => setPhase("tap"), 4 * beat - 200);
  };
  const finish = useCallback(() => {
    const v = judgeRhythm(q, taps.current);
    const ok = v.accuracy >= 0.9;
    tries.current++;
    setVerdict({ ok, hits: v.hits, total: v.total });
    setPhase("result");
    if (q.rhythm)
      renderSvg(rhythmMei(q.rhythm.score), verovioOptions("single", 1))
        .then(setSvg)
        .catch(() => {});
    if (ok || tries.current >= 2) setResults((r) => [...r, ok && tries.current === 1]);
  }, [q]);
  useEffect(() => {
    if (phase !== "tap") return;
    const t = setTimeout(finish, total + beat * 1.5);
    return () => clearTimeout(t);
  }, [phase, finish, total, beat]);

  useMidi((ev) => {
    if (phase !== "tap" || ev.type !== "noteOn") return;
    taps.current.push(performance.now());
  });

  const next = () => setIndex((i) => i + 1);
  const { accuracy, passed } = useSeriesResult(level, done, results, onRecorded);
  const canRetry = verdict && !verdict.ok && tries.current < 2;
  return (
    <main
      className="chord-drill ear-drill"
      data-ear-index={index}
      data-ear-done={done ? (passed ? "passed" : "failed") : ""}
      data-ear-phase={phase}
      data-ear-rhythm={done ? "" : (q.rhythm?.onsetsMs ?? []).join(",")}
    >
      <DrillBar title={levelTitle(level)} index={index} total={series.length} onBack={onBack} onReplay={done ? undefined : listen} />
      {!done ? (
        <section className={`card chord-card${verdict ? (verdict.ok ? " flash-ok" : " flash-wrong") : ""}`}>
          <div className="chord-name">
            {phase === "count" ? "Раз, два, три, четыре…" : phase === "tap" ? "Стучи!" : `Ритм: ${(q.rhythm?.score.right.length ?? 2)} такта по 4 счёта, ${EAR_RHYTHM_BPM} уд/мин`}
          </div>
          {verdict && (
            <p className={verdict.ok ? "good-text" : "bad-text"} data-ear-verdict={verdict.ok ? "ok" : "bad"}>
              {verdict.ok ? "Верно!" : `Попаданий: ${verdict.hits} из ${verdict.total}.`}
            </p>
          )}
          {svg && <div className="chord-staff paper" dangerouslySetInnerHTML={{ __html: svg }} />}
          <div className="summary-actions">
            {(phase === "listen" || canRetry) && (
              <button className="primary" onClick={start} data-ear-start>
                Твоя очередь
              </button>
            )}
            {phase === "tap" && (
              <button onClick={finish} data-ear-finish>
                Готово
              </button>
            )}
            {verdict && (verdict.ok || !canRetry) && (
              <button className="primary" onClick={next} data-ear-next>
                Дальше
              </button>
            )}
          </div>
          <p className="muted ear-how">Стучи любой клавишей или пэдом. Важны только моменты ударов.</p>
        </section>
      ) : (
        <SeriesSummary passed={passed} accuracy={accuracy} onAgain={onAgain} onBack={onBack} />
      )}
    </main>
  );
}

