import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { LevelCard } from "../components/LevelCard";
import { exerciseMei, type ExerciseStatView } from "../lib/exercises";
import {
  READ_LEVELS,
  READ_LEVEL_PASSES,
  READ_PASS_ACCURACY,
  READ_PASS_TIMING_SD_MS,
  readId,
  readLevelPassed,
  readPasses,
  readUnlocked,
  readWaitId,
  readingMelody,
  type ReadLevel,
} from "../lib/reading";
import {
  RHYTHM_LEVELS,
  RHYTHM_LEVEL_PASSES,
  RHYTHM_PASS_ACCURACY,
  RHYTHM_PASS_TIMING_SD_MS,
  HANDS_GATE,
  rhythmKey,
  rhythmLevelPassed,
  rhythmMei,
  rhythmPasses,
  rhythmScore,
  rhythmUnlocked,
  type RhythmLevel,
  type RhythmTrack,
} from "../lib/rhythm";
import { PieceView } from "./PieceView";
import { Trainer } from "./Trainer";
import { Chords } from "./Chords";
import { FretTrainer } from "./FretTrainer";

export type TrainerSection = "notes" | "reading" | "rhythm" | "chords" | "fretboard";

const SECTIONS: { id: TrainerSection; title: string }[] = [
  { id: "notes", title: "Ноты" },
  { id: "reading", title: "Чтение с листа" },
  { id: "rhythm", title: "Ритм" },
  { id: "chords", title: "Аккорды" },
  { id: "fretboard", title: "Гриф" },
];

/** Новое зерно: каждая попытка — новая мелодия или ритм. */
const freshSeed = () => Math.floor(Date.now() / 1000) % 100000;

/**
 * «Тренажёры»: ноты (узнать ноту на стане), чтение с листа (сыграть новую мелодию)
 * и ритм (простучать ритм любой клавишей или пэдом).
 */
export function Trainers({
  section,
  onSection,
  autoStart,
  onAutoStarted,
}: {
  section: TrainerSection;
  onSection: (s: TrainerSection) => void;
  /** С главной («Занятие на сегодня»): сразу открыть текущую ступень раздела. */
  autoStart?: boolean;
  onAutoStarted?: () => void;
}) {
  const tabs = (
    <nav className="segmented trainer-tabs" data-trainer-tabs>
      {SECTIONS.map((s) => (
        <button key={s.id} className={section === s.id ? "on" : ""} onClick={() => onSection(s.id)} data-trainer-section={s.id}>
          {s.title}
        </button>
      ))}
    </nav>
  );
  if (section === "notes") return <Trainer tabs={tabs} />;
  if (section === "chords") return <Chords tabs={tabs} />;
  if (section === "fretboard") return <FretTrainer tabs={tabs} />;
  return <Drills key={section} kind={section} tabs={tabs} autoStart={autoStart} onAutoStarted={onAutoStarted} />;
}

type Run = { kind: "reading"; level: ReadLevel; seed: number } | { kind: "rhythm"; level: RhythmLevel; seed: number };

function Drills({
  kind,
  tabs,
  autoStart,
  onAutoStarted,
}: {
  kind: "reading" | "rhythm";
  tabs: React.ReactNode;
  autoStart?: boolean;
  onAutoStarted?: () => void;
}) {
  const [stats, setStats] = useState<ExerciseStatView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [run, setRun] = useState<Run | null>(null);
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

  // С главной: текущая ступень (первая непройденная из открытых).
  useEffect(() => {
    if (!autoStart || !stats) return;
    if (kind === "reading") setRun({ kind, level: READ_LEVELS[readUnlocked(stats) - 1], seed: freshSeed() });
    else {
      const hands = rhythmUnlocked(stats, "hands");
      const line = rhythmUnlocked(stats, "line");
      const lineLevels = RHYTHM_LEVELS.filter((l) => l.track === "line");
      // Одна строка, пока не пройдена вся; потом — две руки.
      const level =
        hands && rhythmLevelPassed(stats, lineLevels[lineLevels.length - 1])
          ? RHYTHM_LEVELS.filter((l) => l.track === "hands")[hands - 1]
          : lineLevels[line - 1];
      setRun({ kind, level, seed: freshSeed() });
    }
    onAutoStarted?.();
  }, [autoStart, stats, kind, onAutoStarted]);

  // Источник нот — один объект на попытку, иначе экран игры перезапустится.
  const source = useMemo(() => {
    if (!run) return null;
    if (run.kind === "reading") {
      const m = readingMelody(run.level, run.seed);
      return { id: `reading:${run.level.id}:${run.seed}`, title: `Чтение с листа · ${run.level.title}`, load: async () => ({ data: exerciseMei(m.score), zip: false }) };
    }
    const sc = rhythmScore(run.level, run.seed);
    return { id: `rhythm:${rhythmKey(run.level)}:${run.seed}`, title: `Ритм · ${run.level.title}`, load: async () => ({ data: rhythmMei(sc), zip: false }) };
  }, [run]);

  if (run && source) {
    const back = () => {
      setRun(null);
      reload();
    };
    const again = () => setRun({ ...run, seed: run.seed + 1 } as Run);
    if (run.kind === "reading") {
      return (
        <PieceView
          key={source.id}
          source={source}
          onBack={back}
          exercise={{
            id: readId(run.level.id),
            waitRecord: readWaitId(run.level.id),
            hints: run.level.hints,
            defaultMode: "wait",
            listen: true,
            pass: { accuracy: READ_PASS_ACCURACY, timingSdMs: READ_PASS_TIMING_SD_MS },
            next: { label: "Новая мелодия", go: again },
            backLabel: "← Тренажёры",
            onRecorded: reload,
          }}
        />
      );
    }
    return (
      <PieceView
        key={source.id}
        source={source}
        onBack={back}
        exercise={{
          id: rhythmKey(run.level),
          instrument: "rhythm",
          keyMap: run.level.track === "hands" ? "byHand" : "anyKey",
          rhythmOnly: true,
          listen: true,
          hints: { names: false, keyHints: false, waterfall: true, fingering: false },
          pass: { accuracy: RHYTHM_PASS_ACCURACY, timingSdMs: RHYTHM_PASS_TIMING_SD_MS },
          next: { label: "Новый ритм", go: again },
          backLabel: "← Тренажёры",
          onRecorded: reload,
        }}
      />
    );
  }

  return (
    <main className="exercises trainers">
      {tabs}
      {error && <div className="notice warn">Результаты недоступны: {error}</div>}
      {kind === "reading" ? (
        <ReadingList stats={stats ?? []} onStart={(level) => setRun({ kind: "reading", level, seed: freshSeed() })} />
      ) : (
        <RhythmList stats={stats ?? []} onStart={(level) => setRun({ kind: "rhythm", level, seed: freshSeed() })} />
      )}
    </main>
  );
}

function ReadingList({ stats, onStart }: { stats: ExerciseStatView[]; onStart: (l: ReadLevel) => void }) {
  const open = readUnlocked(stats);
  return (
    <>
      <section className="card">
        <h1>Чтение с листа</h1>
        <p className="hint">
          Каждый раз — новая короткая мелодия: выучить наизусть не получится, только прочитать. Сначала можно сыграть в
          режиме ожидания (курсор ждёт верную ноту), потом — в темпе с метрономом. «▶ Послушать» — приложение сыграет мелодию
          само. Мелодия засчитана, если без ошибки сыграно от {Math.round(READ_PASS_ACCURACY * 100)}% нот (в темпе — ещё и ровный
          ритм, темп от 100%). Следующая ступень открывается после {READ_LEVEL_PASSES} засчитанных мелодий, из них хотя бы одна —
          в темпе. Подсказки с каждой ступенью убираются: сначала названия нот и подсветка клавиш, потом только ноты.
        </p>
      </section>
      <section className="card ex-category" data-category="reading">
        <div className="drum-list">
          {READ_LEVELS.map((l) => {
            const p = readPasses(stats, l.id);
            const passed = readLevelPassed(stats, l.id);
            const isOpen = l.id <= open;
            const current = l.id === open && !passed;
            return (
              <LevelCard
                key={l.id}
                n={l.id}
                title={l.title}
                hint={l.description}
                status={
                  p.tempo + p.wait
                    ? `Засчитано мелодий: ${p.tempo + p.wait} (в темпе — ${p.tempo})${passed ? "" : ` · нужно ${READ_LEVEL_PASSES}, одна в темпе`}`
                    : "Ещё не играл"
                }
                passed={passed}
                open={isOpen}
                current={current}
                onClick={() => onStart(l)}
                data={{ "read-level": l.id }}
              />
            );
          })}
        </div>
      </section>
    </>
  );
}

const TRACKS: { id: RhythmTrack; title: string; description: string }[] = [
  {
    id: "line",
    title: "Одна строка",
    description: "Стучи любой клавишей пианино, клавиатуры или любым пэдом — важно только, когда нажал.",
  },
  {
    id: "hands",
    title: "Две руки",
    description:
      "Верхняя строка — правая рука (клавиши от до первой октавы и выше; на пэдах — малый и тарелки), нижняя — левая (ниже до первой октавы; бочка и томы).",
  },
];

function RhythmList({ stats, onStart }: { stats: ExerciseStatView[]; onStart: (l: RhythmLevel) => void }) {
  return (
    <>
      <section className="card">
        <h1>Ритм</h1>
        <p className="hint">
          Читаем ритм без высоты нот: на стане одна линия, стучишь в темпе под метроном. Каждый раз — новый ритм.
          Засчитывается от {Math.round(RHYTHM_PASS_ACCURACY * 100)}% верных ударов при ровном ритме (разброс до ±
          {RHYTHM_PASS_TIMING_SD_MS} мс) и темпе от 100%. Следующая ступень — после {RHYTHM_LEVEL_PASSES} засчитанных ритмов.
        </p>
      </section>
      {TRACKS.map((t) => {
        const open = rhythmUnlocked(stats, t.id);
        const list = RHYTHM_LEVELS.filter((l) => l.track === t.id);
        return (
          <section key={t.id} className={`card ex-category${open ? "" : " locked"}`} data-category={`rhythm-${t.id}`}>
            <div className="ex-category-head">
              <h2 className="section-h">{t.title}</h2>
              <span className="muted">
                {open ? `пройдено ${list.filter((l) => rhythmLevelPassed(stats, l)).length} из ${list.length}` : `откроется после ступени «${RHYTHM_LEVELS[HANDS_GATE - 1].title}»`}
              </span>
            </div>
            <p className="hint">{t.description}</p>
            {open > 0 && (
              <div className="drum-list">
                {list.map((l) => {
                  const passes = rhythmPasses(stats, l);
                  const passed = rhythmLevelPassed(stats, l);
                  const isOpen = l.id <= open;
                  return (
                    <LevelCard
                      key={l.id}
                      n={l.id}
                      title={l.title}
                      hint={l.description}
                      status={passes ? `Засчитано: ${passes}${passed ? "" : ` из ${RHYTHM_LEVEL_PASSES}`}` : "Ещё не играл"}
                      passed={passed}
                      open={isOpen}
                      onClick={() => onStart(l)}
                      data={{ "rhythm-level": rhythmKey(l) }}
                    />
                  );
                })}
              </div>
            )}
          </section>
        );
      })}
    </>
  );
}
