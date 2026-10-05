import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../api";
import {
  CATEGORIES,
  CATEGORY_GATE,
  EXERCISES,
  EXERCISE_BY_ID,
  exerciseMei,
  unlockedSet,
  warmup,
  type Exercise,
  type ExerciseStatView,
} from "../lib/exercises";
import { PieceView } from "./PieceView";
import { GuitarExercises } from "./GuitarExercises";

export type ExInstrument = "piano" | "guitar" | "bass";
const INSTRUMENTS: { id: ExInstrument; title: string }[] = [
  { id: "piano", title: "Фортепиано" },
  { id: "guitar", title: "Гитара" },
  { id: "bass", title: "Бас" },
];

function savedInstrument(): ExInstrument {
  try {
    const v = localStorage.getItem("mt-ex-instrument");
    return v === "guitar" || v === "bass" ? v : "piano";
  } catch {
    return "piano";
  }
}

/** Ключ местного дня: «2026-10-01». */
export function dayKey(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Начало местных суток в секундах Unix. */
export function dayStartSecs(d = new Date()): number {
  return Math.floor(new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() / 1000);
}

interface Run {
  list: Exercise[];
  index: number;
  warmup: boolean;
}

/** «Упражнения»: фортепиано, гитара и бас — переключатель вверху (запоминается). */
export function Exercises({
  startWarmup,
  onWarmupStarted,
  instrument: forced,
}: {
  startWarmup?: boolean;
  onWarmupStarted?: () => void;
  /** С главной: открыть упражнения этого инструмента. */
  instrument?: ExInstrument;
}) {
  const [instrument, setInstrument] = useState<ExInstrument>(forced ?? savedInstrument());
  useEffect(() => {
    if (forced) setInstrument(forced);
  }, [forced]);
  const choose = (i: ExInstrument) => {
    setInstrument(i);
    try {
      localStorage.setItem("mt-ex-instrument", i);
    } catch {
      // не страшно
    }
  };
  const switcher = (
    <span className="segmented ex-instrument" data-ex-instrument={instrument}>
      {INSTRUMENTS.map((x) => (
        <button key={x.id} className={instrument === x.id ? "on" : ""} onClick={() => choose(x.id)} data-ex-instrument-btn={x.id}>
          {x.title}
        </button>
      ))}
    </span>
  );
  if (instrument !== "piano")
    return <GuitarExercises key={instrument} instrument={instrument} switcher={switcher} startWarmup={startWarmup} onWarmupStarted={onWarmupStarted} />;
  return <PianoExercises switcher={switcher} startWarmup={startWarmup} onWarmupStarted={onWarmupStarted} />;
}

function PianoExercises({ switcher, startWarmup, onWarmupStarted }: { switcher: React.ReactNode; startWarmup?: boolean; onWarmupStarted?: () => void }) {
  const [stats, setStats] = useState<ExerciseStatView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [run, setRun] = useState<Run | null>(null);

  const reload = useCallback(() => {
    api
      .exerciseStats()
      .then((s) => {
        setStats(s);
        setError(null);
      })
      .catch((e) => setError(String(e)))
      .finally(() => setStatsLoaded(true));
  }, []);
  useEffect(reload, [reload]);

  const passed = useMemo(() => new Set(stats.filter((s) => s.passed).map((s) => s.exercise)), [stats]);
  const open = useMemo(() => unlockedSet(passed), [passed]);
  const statOf = useMemo(() => new Map(stats.map((s) => [s.exercise, s])), [stats]);
  const today = dayStartSecs();
  // Разминка выбирается один раз на день и запоминается (иначе список менялся бы после каждого зачёта).
  const [statsLoaded, setStatsLoaded] = useState(false);
  const warm = useMemo(() => {
    if (!statsLoaded) return [];
    const key = `mt-warmup-${dayKey()}`;
    try {
      const saved = JSON.parse(localStorage.getItem(key) ?? "null") as string[] | null;
      const list = saved?.map((id) => EXERCISE_BY_ID.get(id)).filter((e): e is Exercise => !!e);
      if (list?.length) return list;
    } catch {
      // нет доступа к хранилищу — просто выберем заново
    }
    const list = warmup(stats, dayKey());
    try {
      localStorage.setItem(key, JSON.stringify(list.map((e) => e.id)));
    } catch {
      // не страшно
    }
    return list;
    // Выбор — по статистике на момент первой загрузки за день.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statsLoaded]);

  const startWarm = useCallback(() => setRun({ list: warm, index: 0, warmup: true }), [warm]);

  // Источник нот должен быть одним объектом, пока играем упражнение: иначе экран игры перезапустится.
  const current = run ? run.list[run.index] : null;
  const source = useMemo(
    () =>
      current
        ? { id: `exercise:${current.id}`, title: current.title, load: async () => ({ data: exerciseMei(current.build()), zip: false }) }
        : null,
    [current],
  );

  // Переход с главной: «Разминка дня».
  useEffect(() => {
    if (startWarmup && warm.length) {
      startWarm();
      onWarmupStarted?.();
    }
  }, [startWarmup, warm, startWarm, onWarmupStarted]);

  if (run && source) {
    const ex = run.list[run.index];
    const isLast = run.index === run.list.length - 1;
    // Одиночное упражнение: «дальше» — следующее по порядку в разделе, если оно открылось.
    const nextSingle = () => {
      const list = EXERCISES.filter((e) => e.category === ex.category);
      return list[list.indexOf(ex) + 1] ?? null;
    };
    const next = run.warmup
      ? {
          label: isLast ? "Завершить разминку" : "Дальше",
          go: () => {
            if (isLast) {
              void api.warmupDone().catch(() => {});
              setRun(null);
            } else setRun({ ...run, index: run.index + 1 });
          },
        }
      : nextSingle()
        ? { label: "Следующее упражнение", go: () => setRun({ list: [nextSingle()!], index: 0, warmup: false }) }
        : null;
    return (
      <PieceView
        key={`${ex.id}-${run.index}`}
        source={source}
        onBack={() => {
          setRun(null);
          reload();
        }}
        exercise={{
          id: ex.id,
          playlist: run.warmup ? { index: run.index, total: run.list.length } : undefined,
          next,
          onRecorded: reload,
        }}
      />
    );
  }

  const warmDoneToday = warm.every((e) => (statOf.get(e.id)?.lastAt ?? 0) >= today);

  return (
    <main className="exercises">
      <section className="card warmup-card">
        <div className="warmup-head">
          <div>
            <h1>Упражнения</h1>
            {switcher}
            <p className="hint">
              Гаммы, арпеджио и узоры для пальцев со стандартной аппликатурой. Играются в темпе под метроном: приложение
              оценивает верные ноты, ровность ритма и громкости. Следующее упражнение открывается, когда предыдущее
              засчитано (точность от 95%, ровный ритм, темп от 100%).
            </p>
          </div>
        </div>
        <div className="warmup">
          <div className="warmup-title">
            <b>Разминка дня</b>
            <span className="muted">~5 минут · {warm.length} упр.</span>
          </div>
          <ol className="warmup-list">
            {warm.map((e) => (
              <li key={e.id} className={(statOf.get(e.id)?.lastAt ?? 0) >= today ? "done" : ""}>
                {e.title}
              </li>
            ))}
          </ol>
          <button className={warmDoneToday ? "" : "primary"} onClick={startWarm} disabled={!warm.length}>
            {warmDoneToday ? "Разминка сегодня сделана ✓ — ещё раз" : "▶ Начать разминку"}
          </button>
        </div>
      </section>
      {error && <div className="notice warn">Результаты упражнений недоступны: {error}</div>}

      {CATEGORIES.map((c) => {
        const list = EXERCISES.filter((e) => e.category === c.id);
        const gate = CATEGORY_GATE[c.id];
        const locked = !!gate && !passed.has(gate);
        const done = list.filter((e) => passed.has(e.id)).length;
        const groups = [...new Set(list.map((e) => e.group))];
        return (
          <section key={c.id} className={`card ex-category${locked ? " locked" : ""}`} data-category={c.id}>
            <div className="ex-category-head">
              <h2 className="section-h">{c.title}</h2>
              <span className="muted">
                {locked ? `откроется после «${EXERCISE_BY_ID.get(gate!)!.title}»` : `засчитано ${done} из ${list.length}`}
              </span>
            </div>
            <p className="hint">{c.description}</p>
            {!locked && (
              <div className="ex-groups">
                {groups.map((g) => (
                  <div key={g} className="ex-group">
                    <span className="ex-group-name">{g}</span>
                    <span className="ex-variants">
                      {list
                        .filter((e) => e.group === g)
                        .map((e) => {
                          const st = statOf.get(e.id);
                          const isOpen = open.has(e.id);
                          const isPassed = passed.has(e.id);
                          const tip = st
                            ? `Попыток: ${st.attempts}, лучшая точность ${Math.round(st.bestAccuracy * 100)}%, ритм ±${Math.round(st.lastTimingSdMs)} мс`
                            : isOpen
                              ? "Ещё не играл"
                              : "Откроется, когда будет засчитано предыдущее";
                          return (
                            <button
                              key={e.id}
                              className={`ex-chip${isPassed ? " passed" : isOpen ? " open" : ""}`}
                              disabled={!isOpen}
                              title={tip}
                              data-exercise={e.id}
                              onClick={() => setRun({ list: [e], index: 0, warmup: false })}
                            >
                              {isPassed && "✓ "}
                              {e.variant}
                            </button>
                          );
                        })}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </section>
        );
      })}
    </main>
  );
}
