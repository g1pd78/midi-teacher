import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { BackLabelContext } from "../components/BackLabel";
import { TheoryCardView } from "../components/Theory";
import { BUILTIN_PIECES } from "../pieces";
import { ROOT_LEVELS } from "../lib/bassRoot";
import { CHORD_LEVELS } from "../lib/chordDrill";
import {
  COURSE,
  COURSE_INSTRUMENTS,
  COURSE_INSTRUMENT_KEY,
  storedCourseInstrument,
  courseLessons,
  currentLesson,
  lessonDone,
  lessonStates,
  moduleDone,
  moduleOpen,
  reviewStep,
  songRecordId,
  stepDone,
  stepTitle,
  type CourseInstrument,
  type CourseLesson,
  type CourseProgress,
  type CourseStep,
  type LessonState,
} from "../lib/course";
import { DRUM_EXERCISE_BY_ID, drumMei } from "../lib/drums";
import { EAR_LEVELS, earLevelId } from "../lib/ear";
import { EXERCISE_BY_ID, exerciseMei } from "../lib/exercises";
import { FRET_LEVELS } from "../lib/fretboard";
import { openTuning } from "../lib/guitar";
import { GTR_CHORD_LEVELS } from "../lib/guitarChordDrill";
import { GTR_EXERCISE_BY_ID, GTR_PASS } from "../lib/guitarExercises";
import { ECHO_LEVELS, JAM_LESSONS } from "../lib/jam";
import { READ_LEVEL_BY_ID } from "../lib/reading";
import { RHYTHM_BY_KEY } from "../lib/rhythm";
import { BUILTIN_SONGS, songMei, songSourceId } from "../lib/songs";
import { STRUM_BY_ID } from "../lib/strum";
import { partChart, songAccompaniment } from "../lib/tabsong";
import { CARD_BY_ID } from "../lib/theory";
import { BassSongView, RootDrill } from "./Bass";
import { ChordDrill } from "./Chords";
import { EarRun } from "./Ear";
import { dayKey } from "./Exercises";
import { FretDrill } from "./FretTrainer";
import { GuitarChordDrill, GuitarSongView } from "./GuitarChords";
import { EchoRun, JamLessonRun } from "./Jam";
import { PieceView, type ExerciseContext, type PieceSource } from "./PieceView";
import { Trainer } from "./Trainer";
import { DrillRun, drillSource, type Run } from "./Trainers";

/** Прогресс курса: результаты упражнений и ступени тренажёра нот. */
export function useCourseProgress(): [CourseProgress | null, () => void] {
  const [p, setP] = useState<CourseProgress | null>(null);
  const reload = useCallback(() => {
    Promise.all([api.exerciseStats().catch(() => []), api.trainerOverview().then((o) => o.levelStats).catch(() => [])]).then(([stats, trainer]) => setP({ stats, trainer }));
  }, []);
  useEffect(reload, [reload]);
  return [p, reload];
}

const freshSeed = () => Math.floor(Date.now() / 1000) % 100000;

type View = { kind: "list" } | { kind: "lesson"; lessonId: string } | { kind: "check"; moduleId: string } | { kind: "run"; step: CourseStep; back: View };

const STATE_NAME: Record<LessonState, string> = { done: "пройден", current: "сейчас", open: "открыт", locked: "закрыт" };

/** Раздел «Курс»: уроки по порядку для выбранного инструмента. */
export function Course({ openLesson, onOpened }: { openLesson?: boolean; onOpened?: () => void }) {
  const [instrument, setInstrumentState] = useState<CourseInstrument>(storedCourseInstrument);
  const setInstrument = (i: CourseInstrument) => {
    setInstrumentState(i);
    try {
      localStorage.setItem(COURSE_INSTRUMENT_KEY, i);
    } catch {
      /* без сохранения */
    }
  };
  const [progress, reload] = useCourseProgress();
  const [view, setView] = useState<View>({ kind: "list" });

  // С главной: сразу текущий урок.
  useEffect(() => {
    if (!openLesson || !progress) return;
    setView({ kind: "lesson", lessonId: currentLesson(instrument, progress).id });
    onOpened?.();
  }, [openLesson, progress, instrument, onOpened]);

  if (!progress) return <main className="exercises course">Загрузка…</main>;

  if (view.kind === "run")
    return (
      <BackLabelContext.Provider value="← Курс">
        <StepRun
          step={view.step}
          instrument={instrument}
          onDone={() => {
            setView(view.back);
            reload();
          }}
        />
      </BackLabelContext.Provider>
    );
  if (view.kind === "lesson") {
    const lesson = courseLessons(instrument).find((l) => l.id === view.lessonId)!;
    return <LessonView lesson={lesson} instrument={instrument} progress={progress} onRun={(step) => setView({ kind: "run", step, back: view })} onLesson={(id) => setView({ kind: "lesson", lessonId: id })} onBack={() => setView({ kind: "list" })} />;
  }
  if (view.kind === "check") {
    const m = COURSE[instrument].find((x) => x.id === view.moduleId)!;
    const done = moduleDone(m, instrument, progress);
    return (
      <main className="exercises course" data-course-view="check">
        <div className="piece-bar">
          <button className="ghost" onClick={() => setView({ kind: "list" })}>
            ← Курс
          </button>
          <div className="piece-name">Проверка: {m.title}</div>
        </div>
        <section className="card">
          <p className="hint">
            Уже умеешь то, чему учит модуль? Пройди эти задания с зачётом — модуль засчитается, и откроется следующий. Уроки
            модуля останутся доступны.
          </p>
          <StepList steps={m.check} instrument={instrument} progress={progress} onRun={(step) => setView({ kind: "run", step, back: view })} />
          {done && (
            <p className="good-text" data-course-check-done>
              Модуль засчитан ✓ — следующий открыт.
            </p>
          )}
        </section>
      </main>
    );
  }

  const states = lessonStates(instrument, progress);
  const cur = currentLesson(instrument, progress);
  const total = courseLessons(instrument).length;
  const passed = courseLessons(instrument).filter((l) => states.get(l.id) === "done").length;
  return (
    <main className="exercises course" data-course-view="list" data-course-instrument={instrument}>
      <section className="card">
        <h1>Курс</h1>
        <span className="segmented ex-instrument">
          {COURSE_INSTRUMENTS.map((i) => (
            <button key={i.id} className={instrument === i.id ? "on" : ""} onClick={() => setInstrument(i.id)} data-course-instrument-btn={i.id}>
              {i.name}
            </button>
          ))}
        </span>
        <p className="hint">
          Уроки по порядку: в каждом — теория, упражнения, тренажёры, пьеса или песня, слух и импровизация из разделов приложения.
          Урок пройден, когда засчитаны все его шаги; следующий открывается сам. Модуль можно перескочить — «Я это уже умею».
        </p>
        <div className="course-progress">
          <div className="course-progress-bar">
            <div style={{ width: `${(passed / total) * 100}%` }} />
          </div>
          <span className="muted">
            Уроков пройдено: {passed} из {total}
          </span>
        </div>
        <button className="primary" onClick={() => setView({ kind: "lesson", lessonId: cur.id })} data-course-continue>
          ▶ {passed ? "Продолжить" : "Начать"}: {cur.title}
        </button>
      </section>
      {COURSE[instrument].map((m, mi) => {
        const open = moduleOpen(instrument, m.id, progress);
        const done = moduleDone(m, instrument, progress);
        return (
          <section key={m.id} className={`card ex-category${open ? "" : " locked"}`} data-course-module={m.id}>
            <div className="ex-category-head">
              <h2 className="section-h">
                {done && "✓ "}Модуль {mi + 1}. {m.title}
              </h2>
              {open && !done && (
                <button className="small" onClick={() => setView({ kind: "check", moduleId: m.id })} data-course-check={m.id}>
                  Я это уже умею
                </button>
              )}
            </div>
            <p className="hint">{m.description}</p>
            <div className="drum-list">
              {m.lessons.map((l) => {
                const st = states.get(l.id)!;
                const n = l.steps.filter((s) => stepDone(s, instrument, progress)).length;
                return (
                  <button
                    key={l.id}
                    className={`drum-item${st === "done" ? " passed" : st !== "locked" ? " open" : ""}${st === "current" ? " current" : ""}`}
                    disabled={st === "locked"}
                    onClick={() => setView({ kind: "lesson", lessonId: l.id })}
                    data-course-lesson={l.id}
                    data-lesson-state={st}
                  >
                    <span className="drum-item-title">
                      {st === "done" && "✓ "}
                      {l.title}
                    </span>
                    <span className="drum-item-hint">{l.goal}</span>
                    <span className="drum-item-hint muted">
                      {st === "locked" ? "Откроется после предыдущего урока" : `Шагов: ${n} из ${l.steps.length} · ${STATE_NAME[st]}`}
                    </span>
                  </button>
                );
              })}
            </div>
          </section>
        );
      })}
    </main>
  );
}

function StepList({ steps, instrument, progress, onRun, review }: { steps: CourseStep[]; instrument: CourseInstrument; progress: CourseProgress; onRun: (s: CourseStep) => void; review?: CourseStep | null }) {
  const firstUndone = steps.findIndex((s) => !stepDone(s, instrument, progress));
  return (
    <ol className="course-steps">
      {review && (
        <li className="course-step review" data-course-review>
          <span className="course-step-mark">↻</span>
          <span className="course-step-title">
            Повторение: {stepTitle(review, instrument).replace(/^[^:]+: /, "")}
            <span className="muted"> — по желанию, каждый день другое</span>
          </span>
          <button className="small" onClick={() => onRun(review)}>
            ▶
          </button>
        </li>
      )}
      {steps.map((s, i) => {
        const done = stepDone(s, instrument, progress);
        return (
          <li key={i} className={`course-step${done ? " done" : ""}${i === firstUndone ? " next" : ""}`} data-course-step={i} data-step-done={done ? "1" : "0"} data-step-kind={s.kind}>
            <span className="course-step-mark">{done ? "✓" : i + 1}</span>
            <span className="course-step-title">{stepTitle(s, instrument)}</span>
            <button className={`small${i === firstUndone ? " primary" : ""}`} onClick={() => onRun(s)} data-course-run={i}>
              {done ? "Ещё раз" : "▶"}
            </button>
          </li>
        );
      })}
    </ol>
  );
}

function LessonView({
  lesson,
  instrument,
  progress,
  onRun,
  onLesson,
  onBack,
}: {
  lesson: CourseLesson;
  instrument: CourseInstrument;
  progress: CourseProgress;
  onRun: (s: CourseStep) => void;
  onLesson: (id: string) => void;
  onBack: () => void;
}) {
  const all = courseLessons(instrument);
  const idx = all.indexOf(lesson);
  const done = lessonDone(lesson, instrument, progress);
  const next = all[idx + 1];
  const nextOpen = next && lessonStates(instrument, progress).get(next.id) !== "locked";
  const review = useMemo(() => reviewStep(instrument, lesson.id, progress, dayKey()), [instrument, lesson.id, progress]);
  const firstUndone = lesson.steps.find((s) => !stepDone(s, instrument, progress));
  const n = lesson.steps.filter((s) => stepDone(s, instrument, progress)).length;
  return (
    <main className="exercises course" data-course-view="lesson" data-course-lesson-open={lesson.id} data-lesson-done={done ? "1" : "0"}>
      <div className="piece-bar">
        <button className="ghost" onClick={onBack}>
          ← Курс
        </button>
        <div className="piece-name">
          Урок {idx + 1}. {lesson.title}
        </div>
        <span className="chip">
          {n} / {lesson.steps.length}
        </span>
      </div>
      <section className="card">
        <p className="hint">{lesson.goal} Урок — около 20–30 минут; шаги можно проходить в любом порядке и за несколько дней.</p>
        <StepList steps={lesson.steps} instrument={instrument} progress={progress} onRun={onRun} review={review} />
        {done ? (
          <div className="course-done">
            <p className="good-text" data-course-lesson-done>
              Урок пройден ✓
            </p>
            {next && nextOpen && (
              <button className="primary" onClick={() => onLesson(next.id)} data-course-next>
                Следующий урок: {next.title}
              </button>
            )}
          </div>
        ) : (
          firstUndone && (
            <button className="primary" onClick={() => onRun(firstUndone)} data-course-go>
              ▶ {n ? "Продолжить" : "Начать урок"}
            </button>
          )
        )}
      </section>
    </main>
  );
}

/** Строй гитары или баса с вкладки «Гитара». */
function useStringTuning(kind: "guitar" | "bass"): number[] | null {
  const [t, setT] = useState<number[] | null>(null);
  useEffect(() => {
    api
      .guitarState()
      .then((g) => setT(openTuning({ instrument: kind, tuning: g.config.instrument === kind ? g.config.tuning : null })))
      .catch(() => setT(openTuning({ instrument: kind, tuning: null })));
  }, [kind]);
  return t;
}

const BACK = "← Курс";

/**
 * Нотный шаг (упражнение, пьеса, песня, чтение, ритм): источник и зачёт. Собираются один раз на шаг —
 * новый объект источника на каждой перерисовке перезапускал бы пьесу и сбрасывал режим ожидания.
 */
function stepPiece(step: CourseStep, tuning: number[] | null, seed: number): { source: PieceSource; exercise?: ExerciseContext; run?: Run } | null {
  switch (step.kind) {
    case "exercise": {
      const ex = EXERCISE_BY_ID.get(step.id)!;
      return {
        source: { id: `exercise:${ex.id}`, title: ex.title, load: async () => ({ data: exerciseMei(ex.build()), zip: false }) },
        exercise: { id: ex.id, backLabel: BACK },
      };
    }
    case "gtr": {
      if (!tuning) return null;
      const ex = GTR_EXERCISE_BY_ID.get(step.id)!;
      const song = ex.build(tuning);
      return {
        source: {
          id: `exercise:${ex.id}`,
          title: ex.title,
          load: async () => ({ data: partChart(song, 0).mei, zip: false }),
          accompaniment: song.parts.length > 1 ? songAccompaniment(song, 0) : undefined,
        },
        exercise: {
          id: ex.id,
          instrument: ex.instrument,
          hint: ex.hint,
          pass: GTR_PASS,
          backLabel: BACK,
          groove: ex.instrument === "bass" ? { bpm: ex.bpm, beats: 4, drums: song.parts.length > 1 } : undefined,
        },
      };
    }
    case "drum": {
      const ex = DRUM_EXERCISE_BY_ID.get(step.id)!;
      return {
        source: { id: `exercise:${ex.id}`, title: ex.title, load: async () => ({ data: drumMei(ex.build(), { title: ex.title }), zip: false }) },
        exercise: { id: ex.id, instrument: "drums", backLabel: BACK },
      };
    }
    case "read":
    case "rhythm": {
      const run: Run = step.kind === "read" ? { kind: "reading", level: READ_LEVEL_BY_ID.get(step.level)!, seed } : { kind: "rhythm", level: RHYTHM_BY_KEY.get(step.key)!, seed };
      return { source: drillSource(run), run };
    }
    case "piece": {
      const p = BUILTIN_PIECES.find((x) => x.id === step.id)!;
      const id = `course-piece-${p.id.replace(/^builtin:/, "")}`;
      return {
        source: { id: p.id, title: p.title, load: async () => ({ data: p.data, zip: false }) },
        exercise: {
          id,
          waitRecord: id,
          defaultMode: "wait",
          pass: { accuracy: 0.85, timingSdMs: 120 },
          hands: step.hands,
          hint: step.hands === "right" ? "Играй правой рукой." : step.hands === "left" ? "Играй левой рукой." : "Двумя руками. Сначала разбери в режиме ожидания, потом — в темпе.",
          backLabel: BACK,
        },
      };
    }
    case "song": {
      if (step.strum || step.bass) return null;
      const song = BUILTIN_SONGS.find((s) => s.id === step.id)!;
      const style = step.style ?? "block";
      const id = songRecordId(step);
      return {
        source: {
          id: songSourceId(song, style),
          title: song.title,
          load: async () => ({ data: songMei(song, style), zip: false }),
          keyMap: song.melody.length ? "leftAnyOctave" : "anyOctave",
          backLabel: BACK,
        },
        exercise: { id, waitRecord: id, defaultMode: "wait", pass: { accuracy: 0.85, timingSdMs: 120 }, backLabel: BACK },
      };
    }
    default:
      return null;
  }
}

/** Запуск шага урока: то же задание, что в разделе приложения; «назад» — в урок. */
function StepRun({ step, instrument, onDone }: { step: CourseStep; instrument: CourseInstrument; onDone: () => void }) {
  const [seed, setSeed] = useState(freshSeed);
  const strings = instrument === "bass" ? "bass" : "guitar";
  const tuning = useStringTuning(strings);
  const tuningKey = tuning?.join(",") ?? "";
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const piece = useMemo(() => stepPiece(step, tuning, seed), [step, tuningKey, seed]);
  const back = BACK;
  if (piece?.run) return <DrillRun key={seed} run={piece.run} source={piece.source} backLabel={back} onBack={onDone} onAgain={() => setSeed((s) => s + 1)} onRecorded={() => {}} />;
  if (piece) return <PieceView key={piece.source.id} source={piece.source} onBack={onDone} exercise={piece.exercise} />;
  switch (step.kind) {
    case "theory": {
      const card = CARD_BY_ID.get(step.card)!;
      const ok = () =>
        void api
          .exerciseRecord({ exercise: `course-theory-${step.card}`, tempo: 1, accuracy: 1, timingSdMs: 0, loudness: 1, passed: true })
          .catch(() => {})
          .finally(onDone);
      return (
        <main className="exercises course" data-course-view="theory">
          <div className="piece-bar">
            <button className="ghost" onClick={onDone}>
              {back}
            </button>
            <div className="piece-name">Теория</div>
          </div>
          <section className="card">
            <TheoryCardView card={card} />
            <button className="primary" onClick={ok} data-course-theory-ok>
              Понятно
            </button>
          </section>
        </main>
      );
    }
    case "notes":
      return <Trainer startLevel={step.level} onDone={onDone} backLabel={back} />;
    case "chords":
      return <ChordDrill key={seed} level={CHORD_LEVELS.find((l) => l.id === step.level)!} seed={seed} onAgain={() => setSeed((s) => s + 1)} onBack={onDone} onRecorded={() => {}} />;
    case "gchord":
      return <GuitarChordDrill key={seed} level={GTR_CHORD_LEVELS.find((l) => l.id === step.level)!} seed={seed} onAgain={() => setSeed((s) => s + 1)} onBack={onDone} onRecorded={() => {}} />;
    case "fret":
      if (!tuning) return null;
      return (
        <FretDrill
          key={seed}
          instrument={strings}
          level={FRET_LEVELS[strings].find((l) => l.id === step.level)!}
          tuning={tuning}
          seed={seed}
          onAgain={() => setSeed((s) => s + 1)}
          onBack={onDone}
          onRecorded={() => {}}
        />
      );
    case "ear":
      return <EarRun key={seed} level={EAR_LEVELS.find((l) => earLevelId(l) === step.id)!} seed={seed} onAgain={() => setSeed((s) => s + 1)} onBack={onDone} onRecorded={() => {}} />;
    case "root":
      return <RootDrill key={seed} level={ROOT_LEVELS.find((l) => l.id === step.level)!} seed={seed} onAgain={() => setSeed((s) => s + 1)} onBack={onDone} onRecorded={() => {}} />;
    case "echo":
      return <EchoRun level={ECHO_LEVELS.find((l) => l.id === step.level)!} instrument={instrument === "drums" ? "piano" : instrument} onBack={onDone} onRecorded={() => {}} />;
    case "jam":
      return <JamLessonRun lesson={JAM_LESSONS.find((l) => l.id === step.lesson)!} instrument={instrument === "drums" ? "piano" : instrument} onBack={onDone} onRecorded={() => {}} />;
    case "song": {
      const song = BUILTIN_SONGS.find((s) => s.id === step.id)!;
      if (step.strum) return <GuitarSongView song={song} pattern={STRUM_BY_ID.get(step.strum)!} onBack={onDone} exerciseId={songRecordId(step)} />;
      if (step.bass) return <BassSongView song={song} style={step.bass} onBack={onDone} />;
      return null;
    }
    default:
      return null;
  }
}
