import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { parse } from "yaml";
import { api, type Journal as JournalData } from "../api";
import { BackLabelContext } from "../components/BackLabel";
import { COURSE_INSTRUMENT_KEY, COURSE_INSTRUMENTS, stepPlayedSince, storedCourseInstrument, type CourseInstrument, type CourseLesson, type CourseStep } from "../lib/course";
import { GOAL_FILE, claudePrompt, diaryDays, diaryYaml, goalFromYaml, goalYaml, weeklyFiles, type DiaryDay, type Goal } from "../lib/journal";
import { PLAN_FILE, dayPlanSteps, parsePlan, todayKey, type PlanParse, type PlanStep } from "../lib/plan";
import { dueToday, reviewItems, stageText, type ReviewItem } from "../lib/srs";
import { StepList, StepRun, useCourseProgress } from "./Course";

const BACK = "← Дневник";
const pct = (x: number) => `${Math.round(x * 100)}%`;
const dayStartSecs = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return Math.floor(d.getTime() / 1000);
};
const fmtDate = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString("ru-RU", { weekday: "short", day: "numeric", month: "long" });

type LessonView = { kind: "lesson"; lesson: CourseLesson; instrument: CourseInstrument; hints?: (string | undefined)[] };
/** Шаг запущен из урока — «назад» возвращает в урок. */
type View = { kind: "main" } | { kind: "run"; step: CourseStep; instrument: CourseInstrument; lesson?: LessonView } | LessonView;

/**
 * Дневник: история занятий по дням (из попыток в базе), цель, YAML по неделям в папке и запрос для Claude;
 * свои уроки и план по дням из YAML/JSON; повторение выученного по срокам.
 */
export function Journal({ onOpenPiece, focus, onFocused }: { onOpenPiece: (id: string) => void; focus?: "plan" | "review" | null; onFocused?: () => void }) {
  const [instrument, setInstrumentState] = useState<CourseInstrument>(storedCourseInstrument);
  const setInstrument = (i: CourseInstrument) => {
    setInstrumentState(i);
    try {
      localStorage.setItem(COURSE_INSTRUMENT_KEY, i);
    } catch {
      /* без сохранения */
    }
  };
  const [data, setData] = useState<JournalData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [goal, setGoal] = useState<Goal>({ text: "", minutesPerDay: null });
  const [planText, setPlanText] = useState<string | null>(null);
  const [saved, setSaved] = useState<number | null>(null);
  const [view, setView] = useState<View>({ kind: "main" });
  const [progress, reloadProgress] = useCourseProgress();

  const reload = useCallback(() => {
    api
      .journalEvents(0)
      .then((j) => {
        setData(j);
        setError(null);
      })
      .catch((e) => setError(String(e)));
    reloadProgress();
  }, [reloadProgress]);
  useEffect(() => {
    reload();
    api
      .journalRead(GOAL_FILE)
      .then((t) => t && setGoal(goalFromYaml(parse(t)) ?? { text: "", minutesPerDay: null }))
      .catch(() => {});
    api
      .journalRead(PLAN_FILE)
      .then(setPlanText)
      .catch(() => setPlanText(null));
  }, [reload]);

  const days = useMemo(() => (data ? diaryDays(data) : []), [data]);
  const reviews = useMemo(() => (data ? dueToday(reviewItems(data)) : []), [data]);
  const parsed: PlanParse | null = useMemo(() => (planText ? parsePlan(planText) : null), [planText]);
  const plan = parsed?.plan ?? null;

  // Недельные файлы дневника — в папку при каждом открытии (последние 8 недель).
  const savedOnce = useRef(false);
  useEffect(() => {
    if (!data || savedOnce.current) return;
    savedOnce.current = true;
    const since = todayKey(new Date(Date.now() - 56 * 86400000));
    const files = weeklyFiles(
      days.filter((d) => d.date >= since),
      goal,
    );
    Promise.all([...files].map(([name, text]) => api.journalWrite(name, text)))
      .then(() => setSaved(files.size))
      .catch((e) => setError(String(e)));
  }, [data, days, goal]);

  const planRef = useRef<HTMLElement>(null);
  const reviewRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!focus || !data) return;
    (focus === "plan" ? planRef : reviewRef).current?.scrollIntoView({ block: "start" });
    onFocused?.();
  }, [focus, data, onFocused]);

  const back = () => {
    setView({ kind: "main" });
    reload();
  };

  if (view.kind === "run")
    return (
      <BackLabelContext.Provider value={BACK}>
        <StepRun step={view.step} instrument={view.instrument} onDone={() => {
            reload();
            setView(view.lesson ?? { kind: "main" });
          }} backLabel={BACK} />
      </BackLabelContext.Provider>
    );
  if (view.kind === "lesson" && progress)
    return (
      <main className="exercises course journal" data-journal-lesson={view.lesson.id}>
        <div className="piece-bar">
          <button className="ghost" onClick={back}>
            {BACK}
          </button>
          <div className="piece-name">{view.lesson.title}</div>
        </div>
        <section className="card">
          {view.lesson.goal && <p className="hint">{view.lesson.goal}</p>}
          <StepList steps={view.lesson.steps} instrument={view.instrument} progress={progress} hints={view.hints} onRun={(step) => setView({ kind: "run", step, instrument: view.instrument, lesson: view })} />
        </section>
      </main>
    );

  const today = todayKey();
  const todayDay = plan?.days.find((d) => d.date === today) ?? null;
  const nextDay = plan?.days.find((d) => d.date > today) ?? null;
  const todaySteps: PlanStep[] = plan && todayDay ? dayPlanSteps(plan, todayDay) : [];
  const since = dayStartSecs();
  const planInst = plan?.instrument ?? instrument;
  const doneToday = progress ? todaySteps.filter((s) => stepPlayedSince(s.step, planInst, progress, since)).length : 0;

  return (
    <main className="exercises journal" data-journal>
      <section className="card">
        <h1>Дневник</h1>
        <p className="hint">
          Что и сколько ты играл — по дням, из истории занятий. Дневник сохраняется в папку YAML-файлами по неделям; его можно
          отдать Claude и получить в ответ свои уроки и план по дням — приложение их проверит и покажет здесь и на главной.
        </p>
        <span className="segmented ex-instrument">
          {COURSE_INSTRUMENTS.map((i) => (
            <button key={i.id} className={instrument === i.id ? "on" : ""} onClick={() => setInstrument(i.id)} data-journal-instrument={i.id}>
              {i.name}
            </button>
          ))}
        </span>
        <GoalEditor goal={goal} onSave={(g) => {
          setGoal(g);
          void api.journalWrite(GOAL_FILE, goalYaml(g)).catch((e) => setError(String(e)));
        }} />
        {error && <div className="notice warn">{error}</div>}
      </section>

      <section className="card" ref={planRef} data-journal-plan={plan ? plan.title : ""}>
        <div className="ex-category-head">
          <h2 className="section-h">{plan ? `План: ${plan.title}` : "План"}</h2>
          {plan && <span className="muted">уроков: {plan.lessons.length} · дней: {plan.days.length}</span>}
        </div>
        {!plan && !parsed?.errors.length && <p className="hint">Плана пока нет. Попроси его у Claude (ниже) или вставь свой файл в формате midi-teacher/plan@1.</p>}
        {parsed && parsed.errors.length > 0 && (
          <div className="notice warn" data-plan-errors>
            Сохранённый план не читается: {parsed.errors.slice(0, 5).join("; ")}
          </div>
        )}
        {plan && (
          <>
            {plan.goal && <p className="hint">Цель плана: {plan.goal}</p>}
            {todayDay && progress ? (
              <>
                <h3 className="journal-day-h">
                  Сегодня, {fmtDate(today)} — сделано {doneToday} из {todaySteps.length}
                </h3>
                {todayDay.note && <p className="hint">{todayDay.note}</p>}
                <div data-plan-today>
                  <StepList
                    steps={todaySteps.map((s) => s.step)}
                    instrument={planInst}
                    progress={progress}
                    hints={todaySteps.map((s) => [s.target && `цель: ${s.target}`, s.note].filter(Boolean).join(" · ") || undefined)}
                    done={todaySteps.map((s) => stepPlayedSince(s.step, planInst, progress, since))}
                    onRun={(step) => setView({ kind: "run", step, instrument: planInst })}
                  />
                </div>
              </>
            ) : (
              <p className="hint">На сегодня в плане ничего нет{nextDay ? ` — следующий день: ${fmtDate(nextDay.date)}` : ""}.</p>
            )}
            {plan.lessons.length > 0 && (
              <div className="drum-list journal-lessons">
                {plan.lessons.map((l) => (
                  <button
                    key={l.id}
                    className="drum-item open"
                    onClick={() => setView({ kind: "lesson", lesson: l, instrument: planInst, hints: l.planSteps.map((s) => [s.target && `цель: ${s.target}`, s.note].filter(Boolean).join(" · ") || undefined) })}
                    data-plan-lesson={l.id}
                  >
                    <span className="drum-item-title">{l.title}</span>
                    {l.goal && <span className="drum-item-hint">{l.goal}</span>}
                    <span className="drum-item-hint muted">
                      Шагов: {l.steps.length}
                      {plan.days.filter((d) => d.lessons.includes(l.id)).length ? ` · в плане: ${plan.days.filter((d) => d.lessons.includes(l.id)).map((d) => d.date.slice(5)).join(", ")}` : ""}
                    </span>
                  </button>
                ))}
              </div>
            )}
            <details className="journal-days">
              <summary>Весь план по дням</summary>
              <ul>
                {plan.days.map((d) => (
                  <li key={d.date} className={d.date === today ? "today" : d.date < today ? "past" : ""}>
                    <b>{fmtDate(d.date)}</b> — {[...d.lessons.map((id) => plan.lessons.find((l) => l.id === id)?.title ?? id), ...d.course.map((c) => `урок курса ${c}`), d.steps.length ? `шагов: ${d.steps.length}` : ""].filter(Boolean).join(", ")}
                    {d.note && <span className="muted"> · {d.note}</span>}
                  </li>
                ))}
              </ul>
            </details>
          </>
        )}
        <PlanImport
          current={planText}
          warnings={parsed?.warnings ?? []}
          onSave={(text) => {
            setPlanText(text);
            void api.journalWrite(PLAN_FILE, text).catch((e) => setError(String(e)));
          }}
          onRemove={() => {
            setPlanText(null);
            void api.journalDelete(PLAN_FILE).catch((e) => setError(String(e)));
          }}
        />
      </section>

      <section className="card" ref={reviewRef} data-journal-review={reviews.length}>
        <div className="ex-category-head">
          <h2 className="section-h">Повторить сегодня</h2>
          <span className="muted">{reviews.length ? `${reviews.length}` : "ничего"}</span>
        </div>
        <p className="hint">
          Выученное возвращается через 1, 3, 7, 14 и 30 дней: упражнения после «Засчитано», отрезки пьес после уровня «В темпе»,
          пройденные уроки курса. Удачно повторил — следующий срок дальше, ошибся — повтор завтра.
        </p>
        {reviews.length === 0 ? (
          <p className="muted">На сегодня повторять нечего.</p>
        ) : (
          <ol className="course-steps">
            {reviews.slice(0, 12).map((r) => (
              <li key={r.key} className="course-step" data-review-item={r.key}>
                <span className="course-step-mark">↻</span>
                <span className="course-step-title">
                  {r.title}
                  <span className="course-step-hint muted">
                    {r.group} · {stageText(r)}
                  </span>
                </span>
                <button className="small" onClick={() => runReview(r)} data-review-run={r.key}>
                  ▶
                </button>
              </li>
            ))}
          </ol>
        )}
      </section>

      <section className="card" data-journal-history={days.length}>
        <div className="ex-category-head">
          <h2 className="section-h">История</h2>
          <span className="muted">{saved !== null ? `в папке: ${saved} нед.` : ""}</span>
        </div>
        {days.length === 0 ? <p className="muted">Занятий ещё не было.</p> : <History days={days.slice(0, 14)} />}
      </section>

      <ClaudeCard instrument={instrument} days={days} goal={goal} />
    </main>
  );

  function runReview(r: ReviewItem) {
    const t = r.target;
    if (t.kind === "fragment") onOpenPiece(t.piece);
    else if (t.kind === "step") setView({ kind: "run", step: t.step, instrument: t.instrument });
    else setView({ kind: "lesson", lesson: t.lesson, instrument: t.instrument });
  }
}

function GoalEditor({ goal, onSave }: { goal: Goal; onSave: (g: Goal) => void }) {
  const [text, setText] = useState(goal.text);
  const [minutes, setMinutes] = useState(goal.minutesPerDay ? String(goal.minutesPerDay) : "");
  useEffect(() => {
    setText(goal.text);
    setMinutes(goal.minutesPerDay ? String(goal.minutesPerDay) : "");
  }, [goal]);
  const save = () => {
    const m = Number(minutes);
    const next = { text: text.trim(), minutesPerDay: Number.isFinite(m) && m > 0 ? Math.round(m) : null };
    if (next.text !== goal.text || next.minutesPerDay !== goal.minutesPerDay) onSave(next);
  };
  return (
    <div className="journal-goal">
      <label>
        Цель
        <input value={text} placeholder="Например: сыграть «К Элизе» к Новому году" onChange={(e) => setText(e.target.value)} onBlur={save} data-goal-text />
      </label>
      <label className="journal-goal-min">
        минут в день
        <input type="number" min={5} max={240} value={minutes} onChange={(e) => setMinutes(e.target.value)} onBlur={save} data-goal-minutes />
      </label>
    </div>
  );
}

function History({ days }: { days: DiaryDay[] }) {
  return (
    <ul className="journal-history">
      {days.map((d) => (
        <li key={d.date} data-history-day={d.date}>
          <div className="journal-history-head">
            <b>{fmtDate(d.date)}</b>
            <span className="muted">{d.minutes ? `${d.minutes} мин` : "меньше минуты"}</span>
          </div>
          <div className="journal-history-items">
            {d.pieces.flatMap((p) =>
              p.fragments.map((f) => (
                <span key={`${p.id}${f.bars}`} className="chip" title={f.hardBars.length ? `Ошибки в тактах ${f.hardBars.join(", ")}` : undefined}>
                  {p.title}, т. {f.bars.replace("-", "–")}
                  {f.level !== null ? ` · ур. ${f.level}` : ""} · {pct(f.bestAccuracy)}
                </span>
              )),
            )}
            {d.exercises.map((e) => (
              <span key={e.id} className={`chip${e.passed ? " good" : ""}`}>
                {e.passed ? "✓ " : ""}
                {e.title.replace(/^[^:]+: /, "")} · {pct(e.bestAccuracy)}
              </span>
            ))}
            {d.trainer.map((t) => (
              <span key={t.level} className={`chip${t.passed ? " good" : ""}`}>
                Тренажёр нот, ступень {t.level} · {pct(t.bestAccuracy)}
              </span>
            ))}
          </div>
        </li>
      ))}
    </ul>
  );
}

function PlanImport({ current, warnings, onSave, onRemove }: { current: string | null; warnings: string[]; onSave: (text: string) => void; onRemove: () => void }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [result, setResult] = useState<PlanParse | null>(null);
  const check = (t: string) => {
    const r = parsePlan(t);
    setResult(r);
    if (r.plan) {
      onSave(t);
      setOpen(false);
      setText("");
    }
  };
  return (
    <div className="journal-import">
      <div className="journal-actions">
        <button className={current ? "" : "primary"} onClick={() => setOpen((o) => !o)} data-plan-paste>
          {current ? "Заменить план…" : "Вставить план…"}
        </button>
        <label className="button-like">
          Открыть файл…
          <input
            type="file"
            accept=".yaml,.yml,.json,.txt"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void f.text().then(check);
              e.target.value = "";
            }}
          />
        </label>
        {current && (
          <button className="ghost" onClick={onRemove} data-plan-remove>
            Убрать план
          </button>
        )}
      </div>
      {open && (
        <div className="journal-paste">
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={12} placeholder="Вставь сюда YAML или JSON плана" data-plan-text />
          <button className="primary" onClick={() => check(text)} disabled={!text.trim()} data-plan-load>
            Проверить и загрузить
          </button>
        </div>
      )}
      {result && result.errors.length > 0 && (
        <div className="notice warn" data-plan-import-errors>
          <b>План не загружен — исправь в файле:</b>
          <ul>
            {result.errors.slice(0, 12).map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        </div>
      )}
      {(result?.warnings.length ? result.warnings : warnings).length > 0 && (
        <p className="hint">Замечания: {(result?.warnings.length ? result.warnings : warnings).join("; ")}</p>
      )}
    </div>
  );
}

function ClaudeCard({ instrument, days, goal }: { instrument: CourseInstrument; days: DiaryDay[]; goal: Goal }) {
  const [weeks, setWeeks] = useState(2);
  const [planWeeks, setPlanWeeks] = useState(2);
  const [status, setStatus] = useState<string | null>(null);
  const prompt = useMemo(() => {
    const from = todayKey(new Date(Date.now() - weeks * 7 * 86400000));
    const to = todayKey();
    const diary = diaryYaml(
      days.filter((d) => d.date >= from),
      goal,
      from,
      to,
    );
    return claudePrompt({ instrument, goal, diary, weeks, planWeeks });
  }, [instrument, days, goal, weeks, planWeeks]);
  const copy = () => {
    navigator.clipboard
      .writeText(prompt)
      .then(() => setStatus("Скопировано — вставь в Claude, а его ответ — в «Вставить план…»"))
      .catch(() => setStatus("Не удалось скопировать — выдели текст ниже и скопируй вручную"));
  };
  return (
    <section className="card" data-journal-claude>
      <h2 className="section-h">План от Claude</h2>
      <p className="hint">
        Кнопка копирует запрос: цель, дневник за выбранный срок, описание формата плана и каталог заданий для выбранного
        инструмента. Вставь его в Claude — в ответ придёт YAML; вставь его выше через «Вставить план…».
      </p>
      <div className="journal-actions">
        <label>
          дневник за{" "}
          <select value={weeks} onChange={(e) => setWeeks(Number(e.target.value))}>
            {[1, 2, 4, 8].map((w) => (
              <option key={w} value={w}>
                {w} нед.
              </option>
            ))}
          </select>
        </label>
        <label>
          план на{" "}
          <select value={planWeeks} onChange={(e) => setPlanWeeks(Number(e.target.value))}>
            {[1, 2, 4].map((w) => (
              <option key={w} value={w}>
                {w} нед.
              </option>
            ))}
          </select>
        </label>
        <button className="primary" onClick={copy} data-claude-copy>
          Скопировать для Claude
        </button>
        <button onClick={() => void api.journalOpenFolder()} data-journal-folder>
          Открыть папку дневника
        </button>
      </div>
      {status && <p className="hint">{status}</p>}
      <details>
        <summary>Текст запроса</summary>
        <textarea className="journal-prompt" readOnly value={prompt} rows={14} data-claude-prompt />
      </details>
    </section>
  );
}
