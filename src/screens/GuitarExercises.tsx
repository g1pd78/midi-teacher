import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../api";
import type { ExerciseStatView } from "../lib/exercises";
import { openTuning, tuningLabel } from "../lib/guitar";
import {
  GTR_CATEGORIES,
  GTR_EXERCISES,
  GTR_EXERCISE_BY_ID,
  GTR_PASS,
  gtrGate,
  gtrUnlocked,
  gtrWarmup,
  type GtrExercise,
  type GtrInstrument,
} from "../lib/guitarExercises";
import { partChart, songAccompaniment } from "../lib/tabsong";
import { PieceView, type PieceSource } from "./PieceView";
import { dayKey, dayStartSecs } from "./Exercises";
import { useApp } from "../store";

interface Run {
  list: GtrExercise[];
  index: number;
  warmup: boolean;
  /** Подпись серии: «Разминка» (На сегодня) или «Подряд» (все варианты группы). */
  label?: string;
}

/** Свёрнутые разделы (по инструменту): запоминаются на этом компьютере. */
const COLLAPSED_KEY = "mt-gtr-collapsed";
function loadCollapsed(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? "[]") as string[]);
  } catch {
    return new Set();
  }
}

/** Упражнения для гитары и баса: те же правила, что у фортепианных, — открытие по порядку, зачёт в темпе. */
export function GuitarExercises({
  instrument,
  switcher,
  startWarmup,
  onWarmupStarted,
}: {
  instrument: GtrInstrument;
  switcher: React.ReactNode;
  startWarmup?: boolean;
  onWarmupStarted?: () => void;
}) {
  const [stats, setStats] = useState<ExerciseStatView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [run, setRun] = useState<Run | null>(null);
  const [tuning, setTuning] = useState<{ open: number[]; capo: number } | null>(null);
  const { prefs, setPrefs } = useApp();
  const daily = useMemo(() => prefs.daily ?? [], [prefs.daily]);
  const toggleDaily = (id: string) => {
    const cur = useApp.getState().prefs.daily ?? [];
    setPrefs({ daily: cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id] });
  };
  const [collapsed, setCollapsed] = useState<Set<string>>(loadCollapsed);
  const toggleCollapsed = (key: string) =>
    setCollapsed((cur) => {
      const next = new Set(cur);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      try {
        localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next]));
      } catch {
        /* без сохранения */
      }
      return next;
    });

  const reload = useCallback(() => {
    api
      .exerciseStats()
      .then((s) => {
        setStats(s);
        setError(null);
      })
      .catch((e) => {
        setStats([]);
        setError(String(e));
      });
  }, []);
  useEffect(reload, [reload]);
  // Упражнения строятся под строй с вкладки «Гитара».
  useEffect(() => {
    api
      .guitarState()
      .then((g) => setTuning({ open: openTuning({ instrument, tuning: g.config.instrument === instrument ? g.config.tuning : null }), capo: g.config.capo }))
      .catch(() => setTuning({ open: openTuning({ instrument, tuning: null }), capo: 0 }));
  }, [instrument]);

  const passed = useMemo(() => new Set((stats ?? []).filter((s) => s.passed).map((s) => s.exercise)), [stats]);
  const open = useMemo(() => gtrUnlocked(passed, instrument), [passed, instrument]);
  const statOf = useMemo(() => new Map((stats ?? []).map((s) => [s.exercise, s])), [stats]);
  const today = dayStartSecs();
  const warm = useMemo(() => (stats ? gtrWarmup(stats, dayKey(), instrument, daily) : []), [stats, instrument, daily]);
  const startWarm = useCallback(() => warm.length && setRun({ list: warm, index: 0, warmup: true }), [warm]);
  useEffect(() => {
    if (startWarmup && warm.length && tuning) {
      startWarm();
      onWarmupStarted?.();
    }
  }, [startWarmup, warm, tuning, startWarm, onWarmupStarted]);

  const current = run ? run.list[run.index] : null;
  // Источник — один объект на упражнение (иначе экран игры перезапустится).
  const source: PieceSource | null = useMemo(() => {
    if (!current || !tuning) return null;
    const song = current.build(tuning.open);
    return {
      id: `exercise:${current.id}`,
      title: current.title,
      load: async () => ({ data: partChart(song, 0).mei, zip: false }),
      accompaniment: song.parts.length > 1 ? songAccompaniment(song, 0) : undefined,
    };
  }, [current, tuning]);

  if (run && source && current) {
    const isLast = run.index === run.list.length - 1;
    const nextSingle = () => {
      const list = GTR_EXERCISES.filter((e) => e.instrument === instrument && e.group === current.group);
      return list[list.indexOf(current) + 1] ?? null;
    };
    const next = run.warmup
      ? { label: isLast ? "Готово" : "Дальше", go: () => (isLast ? setRun(null) : setRun({ ...run, index: run.index + 1 })) }
      : nextSingle()
        ? { label: "Следующее упражнение", go: () => setRun({ list: [nextSingle()!], index: 0, warmup: false }) }
        : null;
    return (
      <PieceView
        key={`${current.id}-${run.index}`}
        source={source}
        onBack={() => {
          setRun(null);
          reload();
        }}
        exercise={{
          id: current.id,
          instrument,
          hint: current.hint,
          pass: GTR_PASS,
          playlist: run.warmup ? { index: run.index, total: run.list.length, label: run.label } : undefined,
          next,
          onRecorded: reload,
        }}
      />
    );
  }

  const warmDone = warm.length > 0 && warm.every((e) => (statOf.get(e.id)?.lastAt ?? 0) >= today);
  const name = instrument === "bass" ? "бас" : "гитару";
  return (
    <main className="exercises" data-gtr-exercises={instrument}>
      <section className="card warmup-card">
        <div className="warmup-head">
          <div>
            <h1>Упражнения</h1>
            {switcher}
            <p className="hint">
              Табы под твой строй{tuning ? ` (${tuningLabel(tuning.open, 0, instrument)})` : ""}: играешь {name} в темпе под метроном,
              приложение слушает звук и оценивает верные ноты и ровность ритма. Следующее упражнение открывается, когда
              предыдущее засчитано (точность от {Math.round(GTR_PASS.accuracy * 100)}%, ровный ритм, темп от 100%). Можно играть
              и в режиме ожидания — разобрать узор без темпа.
            </p>
          </div>
        </div>
        <div className="warmup">
          <div className="warmup-title">
            <b>На сегодня</b>
            <span className="muted">~5 минут · {warm.length} упр.</span>
          </div>
          <ol className="warmup-list">
            {warm.map((e) => (
              <li key={e.id} className={(statOf.get(e.id)?.lastAt ?? 0) >= today ? "done" : ""}>
                {daily.includes(e.id) && <span className="daily-mark" title="Каждый день">★ </span>}
                {e.title}
              </li>
            ))}
          </ol>
          <button className={warmDone ? "" : "primary"} onClick={startWarm} disabled={!warm.length || !tuning} data-gtr-warmup>
            {warmDone ? "Сделано сегодня ✓ — ещё раз" : "▶ Начать"}
          </button>
        </div>
      </section>
      {error && <div className="notice warn">Результаты упражнений недоступны: {error}</div>}
      <p className="hint ex-legend">
        ★ — «каждый день»: упражнение всегда попадёт в «На сегодня». Обведены упражнения, сыгранные сегодня. Раздел
        сворачивается кликом по заголовку.
      </p>
      {GTR_CATEGORIES[instrument].map((c) => {
        const list = GTR_EXERCISES.filter((e) => e.instrument === instrument && e.category === c.id);
        const gate = gtrGate(instrument, c.id);
        const locked = !!gate && !passed.has(gate);
        const done = list.filter((e) => passed.has(e.id)).length;
        const groups = [...new Set(list.map((e) => e.group))];
        const key = `${instrument}:${c.id}`;
        // Закрытый раздел — одной строкой; открытый сворачивается кликом по заголовку.
        if (locked)
          return (
            <section key={c.id} className="card ex-category locked compact" data-category={c.id}>
              <div className="ex-category-head">
                <h2 className="section-h">{c.title}</h2>
                <span className="muted">откроется после «{GTR_EXERCISE_BY_ID.get(gate!)!.title}»</span>
              </div>
            </section>
          );
        const folded = collapsed.has(key);
        const playedToday = list.filter((e) => (statOf.get(e.id)?.lastAt ?? 0) >= today).length;
        return (
          <section key={c.id} className={`card ex-category${folded ? " folded" : ""}`} data-category={c.id} data-folded={folded ? "1" : "0"}>
            <button className="ex-category-head ex-fold" onClick={() => toggleCollapsed(key)} aria-expanded={!folded} data-category-toggle={c.id}>
              <h2 className="section-h">
                <span className="fold-mark">{folded ? "▸" : "▾"}</span> {c.title}
              </h2>
              <span className="muted">
                засчитано {done} из {list.length}
                {playedToday ? ` · сегодня ${playedToday}` : ""}
              </span>
            </button>
            {!folded && (
              <>
                <p className="hint">{c.description}</p>
                <div className="ex-groups">
                  {groups.map((g) => {
                    const inGroup = list.filter((e) => e.group === g);
                    const openInGroup = inGroup.filter((e) => open.has(e.id));
                    return (
                      <div key={g} className="ex-group">
                        <span className="ex-group-name">{g}</span>
                        <span className="ex-variants">
                          {inGroup.map((e) => {
                            const st = statOf.get(e.id);
                            const isOpen = open.has(e.id);
                            const isPassed = passed.has(e.id);
                            const isToday = (st?.lastAt ?? 0) >= today;
                            const pinned = daily.includes(e.id);
                            return (
                              <span key={e.id} className="ex-chip-wrap">
                                <button
                                  className={`ex-chip${isPassed ? " passed" : isOpen ? " open" : ""}${isToday ? " today" : ""}`}
                                  disabled={!isOpen || !tuning}
                                  title={
                                    (isToday ? "Сыграно сегодня. " : "") +
                                    (st
                                      ? `Попыток: ${st.attempts}, лучшая точность ${Math.round(st.bestAccuracy * 100)}%, ритм ±${Math.round(st.lastTimingSdMs)} мс`
                                      : isOpen
                                        ? "Ещё не играл"
                                        : "Откроется, когда будет засчитано предыдущее")
                                  }
                                  data-exercise={e.id}
                                  data-today={isToday ? "1" : undefined}
                                  onClick={() => setRun({ list: [e], index: 0, warmup: false })}
                                >
                                  {isPassed && "✓ "}
                                  {e.variant}
                                </button>
                                {isOpen && (
                                  <button
                                    className={`ex-star${pinned ? " on" : ""}`}
                                    title={pinned ? "Убрать из «каждый день»" : "Каждый день: всегда в «На сегодня»"}
                                    aria-pressed={pinned}
                                    onClick={() => toggleDaily(e.id)}
                                    data-daily-toggle={e.id}
                                  >
                                    {pinned ? "★" : "☆"}
                                  </button>
                                )}
                              </span>
                            );
                          })}
                          {openInGroup.length >= 2 && (
                            <button
                              className="small ex-all"
                              disabled={!tuning}
                              title="Сыграть все открытые варианты группы один за другим"
                              onClick={() => setRun({ list: openInGroup, index: 0, warmup: true, label: "Подряд" })}
                              data-group-all={g}
                            >
                              ▶ Все подряд
                            </button>
                          )}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </>
            )}
          </section>
        );
      })}
    </main>
  );
}
