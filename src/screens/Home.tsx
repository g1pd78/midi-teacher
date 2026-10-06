import { Piano } from "../components/Piano";
import { Notices } from "../components/Notices";
import { fullName, keyLabel } from "../lib/notes";
import { deviceColor, useApp } from "../store";
import type { Screen } from "../App";
import { useEffect, useState } from "react";
import { api, type TodayStatus } from "../api";
import { dayStartSecs } from "./Exercises";

const SECTIONS: { title: string; text: string; stage: string; screen?: Screen }[] = [
  { title: "Тренажёры", text: "Ноты на стане, чтение с листа, ритм", stage: "Этап 1", screen: "trainer" },
  { title: "Пьесы", text: "Разучивание по фрагментам: от подсказок до игры по памяти", stage: "Этап 2", screen: "pieces" },
  { title: "Упражнения", text: "Гаммы, арпеджио, пять пальцев, разминка дня", stage: "Этап 5", screen: "exercises" },
  { title: "Справочник", text: "Длительности, знаки, ключи", stage: "Этап 5", screen: "reference" },
  { title: "Прогресс", text: "Минуты занятий, выученные фрагменты, трудные такты", stage: "Этап 4", screen: "progress" },
];

export interface TodayActions {
  /** Урок курса (текущий). */
  course: () => void;
  /** Дневник: план на сегодня или повторение. */
  journal: (focus: "plan" | "review") => void;
  warmup: () => void;
  trainer: () => void;
  reading: () => void;
  rhythm: () => void;
  ear: () => void;
  piece: (id: string | null) => void;
  /** Гитара или бас: упражнения на сегодня. */
  guitar: (instrument: "guitar" | "bass") => void;
}

/** Сколько мелодий с листа и ритмов — в занятии на день. */
const READ_PER_DAY = 2;
const RHYTHM_PER_DAY = 1;
/** Шагов урока курса в день, чтобы шаг «Урок курса» считался сделанным. */
const COURSE_STEPS_PER_DAY = 3;

/** «Занятие на сегодня»: разминка → тренажёр нот → чтение с листа → ритм → пьеса. */
function Today({ actions }: { actions: TodayActions }) {
  const [st, setSt] = useState<TodayStatus | null>(null);
  const [drills, setDrills] = useState({ read: 0, rhythm: 0, ear: 0 });
  // Шаг «Гитара» — если вход гитары включён или гитарные упражнения уже были.
  const [gtr, setGtr] = useState<{ instrument: "guitar" | "bass"; today: number } | null>(null);
  // Шаг «Урок курса»: текущий урок выбранного инструмента и шаги, сделанные сегодня.
  const [course, setCourse] = useState<{ title: string; n: number; today: number; done: boolean } | null>(null);
  // Шаги из дневника: план на сегодня (из план.yaml) и повторение выученного по срокам.
  const [planDay, setPlanDay] = useState<{ title: string; total: number; done: number } | null>(null);
  const [due, setDue] = useState<number>(0);
  useEffect(() => {
    api
      .todayStatus(dayStartSecs())
      .then(setSt)
      .catch(() => setSt(null));
    Promise.all([api.exerciseHistory("read-", dayStartSecs()), api.exerciseHistory("rhythm-", dayStartSecs()), api.exerciseHistory("ear-", dayStartSecs())])
      .then(([r, h, e]) => setDrills({ read: r.length, rhythm: h.length, ear: e.length }))
      .catch(() => {});
    Promise.all([api.guitarState(), api.exerciseStats(), api.exerciseHistory("gtr-", dayStartSecs()), api.exerciseHistory("bass-", dayStartSecs()), api.exerciseHistory("fret-", dayStartSecs()), api.exerciseHistory("gchord-", dayStartSecs()), api.exerciseHistory("gchange-", dayStartSecs())])
      .then(([g, stats, a, b, f, c, ch]) => {
        const used = g.config.enabled || stats.some((s) => /^(gtr|bass|fret|gchord|gchange)-/.test(s.exercise));
        if (used) setGtr({ instrument: g.config.instrument, today: a.length + b.length + f.length + c.length + ch.length });
      })
      .catch(() => {});
    // Курс грузится отдельно: программа большая, главной она не нужна до первого показа.
    Promise.all([import("../lib/course"), api.exerciseStats(), api.trainerOverview().then((o) => o.levelStats).catch(() => [])])
      .then(([c, stats, trainer]) => {
        const inst = c.storedCourseInstrument();
        const p = { stats, trainer };
        const lesson = c.currentLesson(inst, p);
        const n = c.courseLessons(inst).indexOf(lesson) + 1;
        const since = dayStartSecs();
        // Шаг, который встречается в нескольких уроках, считается один раз.
        const played = c.courseLessons(inst).flatMap((l) => l.steps).filter((s) => c.stepPlayedSince(s, inst, p, since));
        const today = new Set(played.map((s) => c.stepRecordIds(s, inst).join())).size;
        setCourse({ title: lesson.title, n, today, done: today >= COURSE_STEPS_PER_DAY });
      })
      .catch(() => {});
    Promise.all([import("../lib/plan"), import("../lib/srs"), import("../lib/course"), api.journalRead("план.yaml").catch(() => null), api.journalEvents(0), api.exerciseStats(), api.trainerOverview().then((o) => o.levelStats).catch(() => [])])
      .then(([pl, srs, c, text, journal, stats, trainer]) => {
        setDue(srs.dueToday(srs.reviewItems(journal)).length);
        const plan = text ? pl.parsePlan(text).plan : null;
        const day = plan?.days.find((d) => d.date === pl.todayKey());
        if (!plan || !day) return;
        const steps = pl.dayPlanSteps(plan, day);
        const p = { stats, trainer };
        const done = steps.filter((x) => c.stepPlayedSince(x.step, plan.instrument, p, dayStartSecs())).length;
        setPlanDay({ title: plan.title, total: steps.length, done });
      })
      .catch(() => {});
  }, []);
  if (!st) return null;
  const steps = [
    ...(planDay
      ? [
          {
            done: planDay.total > 0 && planDay.done >= planDay.total,
            title: "По плану",
            text: `«${planDay.title}» — сделано ${planDay.done} из ${planDay.total}`,
            go: () => actions.journal("plan"),
          },
        ]
      : []),
    ...(due
      ? [
          {
            done: false,
            title: "Повторить",
            text: `Выученное по срокам: ${due}`,
            go: () => actions.journal("review"),
          },
        ]
      : []),
    ...(course
      ? [
          {
            done: course.done,
            title: `Урок курса ${course.n}`,
            text: course.today ? `«${course.title}» — шагов сегодня: ${course.today}` : `«${course.title}»`,
            go: actions.course,
          },
        ]
      : []),
    {
      done: st.warmupDone,
      title: "Разминка",
      text: st.warmupDone ? "Сделана сегодня" : st.exercises ? `Сыграно упражнений: ${st.exercises}` : "Упражнения на ~5 минут",
      go: actions.warmup,
    },
    {
      done: st.trainerSessions > 0,
      title: "Тренажёр нот",
      text: st.trainerSessions ? `Серий сегодня: ${st.trainerSessions}` : "Одна серия из 20 нот",
      go: actions.trainer,
    },
    {
      done: drills.read >= READ_PER_DAY,
      title: "Чтение с листа",
      text: drills.read
        ? `Мелодий сегодня: ${drills.read}${drills.read < READ_PER_DAY ? ` из ${READ_PER_DAY}` : ""}`
        : `${READ_PER_DAY} новые мелодии`,
      go: actions.reading,
    },
    {
      done: drills.rhythm >= RHYTHM_PER_DAY,
      title: "Ритм",
      text: drills.rhythm ? `Ритмов сегодня: ${drills.rhythm}` : "Простучать один ритм",
      go: actions.rhythm,
    },
    {
      done: drills.ear > 0,
      title: "Слух",
      text: drills.ear ? `Серий сегодня: ${drills.ear}` : "Одна серия: интервалы, аккорды или ступени",
      go: actions.ear,
    },
    ...(gtr
      ? [
          {
            done: gtr.today > 0,
            title: gtr.instrument === "bass" ? "Бас" : "Гитара",
            text: gtr.today ? `Упражнений сегодня: ${gtr.today}` : "Паучок и ещё одно упражнение",
            go: () => actions.guitar(gtr.instrument),
          },
        ]
      : []),
    {
      done: st.pieceAttempts > 0,
      title: st.lastPiece ? `«${st.lastPiece[1]}»` : "Пьеса",
      text: st.lastPiece
        ? st.pieceAttempts
          ? `Проходов сегодня: ${st.pieceAttempts}`
          : "Продолжить с того же отрезка"
        : "Выбрать пьесу и начать разучивать",
      go: () => actions.piece(st.lastPiece?.[0] ?? null),
    },
  ];
  const next = steps.findIndex((s) => !s.done);
  return (
    <section className="card today" data-today>
      <div className="today-title">
        <h2>Занятие на сегодня</h2>
        <span className="muted">{next < 0 ? "всё сделано — отлично!" : "по порядку, без спешки"}</span>
      </div>
      {steps.map((s, i) => (
        <button key={i} className={`today-step${s.done ? " done" : ""}${i === next ? " next" : ""}`} onClick={s.go}>
          <span className="num">Шаг {i + 1}</span>
          <b>{s.title}</b>
          <span className="muted">{s.text}</span>
        </button>
      ))}
    </section>
  );
}

export function Home({ onNavigate, today }: { onNavigate: (s: Screen) => void; today: TodayActions }) {
  const { held, lastNote, devices, prefs, pressScreenKey, sustain } = useApp();
  const naming = prefs.noteNames;

  const highlight = Object.fromEntries(
    Object.entries(held).map(([note, h]) => [
      note,
      { color: deviceColor(h.device, devices), strength: 0.55 + (0.45 * h.velocity) / 127 },
    ]),
  );
  const chord = Object.keys(held)
    .map(Number)
    .sort((a, b) => a - b);

  return (
    <main className="home">
      <Notices />
      <Today actions={today} />
      <section className="now card">
        {lastNote ? (
          <>
            <div className="now-name">{fullName(lastNote.note, naming)}</div>
            <div className="now-meta">
              <span>{keyLabel(lastNote.note, naming === "solfege" ? "latin" : "solfege")}</span>
              <span className="sep">·</span>
              <span>сила {lastNote.velocity}</span>
              <span className="sep">·</span>
              <span style={{ color: deviceColor(lastNote.device, devices) }}>{lastNote.device}</span>
              {sustain && (
                <>
                  <span className="sep">·</span>
                  <span className="pedal">педаль</span>
                </>
              )}
            </div>
            <div className="velocity">
              <div className="velocity-bar" style={{ width: `${(lastNote.velocity / 127) * 100}%` }} />
            </div>
            <div className="chord">
              {chord.map((n) => (
                <span key={n} className="chip small">
                  {keyLabel(n, naming)}
                </span>
              ))}
            </div>
          </>
        ) : (
          <>
            <div className="now-name muted">Нажми любую клавишу</div>
            <div className="now-meta">
              {devices.inputs.some((d) => d.connected)
                ? "На пианино, MIDI-клавиатуре или прямо на экране"
                : "Подключи пианино или MIDI-клавиатуру по USB, приложение найдёт их само"}
            </div>
          </>
        )}
      </section>

      <section className="sections">
        {SECTIONS.map((s) =>
          s.screen ? (
            <button key={s.title} className="section-tile" onClick={() => onNavigate(s.screen!)}>
              <div className="section-title">{s.title}</div>
              <div className="section-text">{s.text}</div>
              <div className="section-stage go">Открыть →</div>
            </button>
          ) : (
            <div key={s.title} className="section-tile disabled" aria-disabled>
              <div className="section-title">{s.title}</div>
              <div className="section-text">{s.text}</div>
              <div className="section-stage">Скоро · {s.stage}</div>
            </div>
          ),
        )}
      </section>

      <section className="home-piano">
        <Piano naming={naming} highlight={highlight} onPress={pressScreenKey} lights={false} />
      </section>
    </main>
  );
}
