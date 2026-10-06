import { describe, expect, it } from "vitest";
import {
  COURSE,
  COURSE_INSTRUMENTS,
  courseLessons,
  currentLesson,
  lessonStates,
  moduleOpen,
  reviewStep,
  stepDone,
  stepExists,
  stepRecordIds,
  stepTitle,
  type CourseInstrument,
  type CourseProgress,
} from "./course";
import type { ExerciseStatView } from "./exercises";

const stat = (exercise: string, passed = true, lastAt = 0): ExerciseStatView => ({ exercise, attempts: 1, passed, bestAccuracy: 1, lastAt, lastTimingSdMs: 0, lastLoudness: 1 });
const none: CourseProgress = { stats: [], trainer: [] };

/** Прогресс, в котором засчитаны все шаги уроков `ids`. */
function passedLessons(inst: CourseInstrument, ids: string[]): CourseProgress {
  const lessons = courseLessons(inst).filter((l) => ids.includes(l.id));
  const steps = lessons.flatMap((l) => l.steps);
  return {
    stats: steps.flatMap((s) => (s.kind === "notes" ? [] : [stat(stepRecordIds(s, inst)[0])])),
    trainer: steps.flatMap((s) => (s.kind === "notes" ? [{ level: s.level, sessions: 1, bestAccuracy: 1, lastAccuracy: 1, lastReactionMs: 500, passed: true }] : [])),
  };
}

describe("курс", () => {
  it("программа: все шаги ведут на существующие задания, у уроков 4–8 шагов, id уникальны", () => {
    for (const { id: inst } of COURSE_INSTRUMENTS) {
      const lessons = courseLessons(inst);
      expect(lessons.length, inst).toBeGreaterThanOrEqual(9);
      expect(new Set(lessons.map((l) => l.id)).size).toBe(lessons.length);
      for (const m of COURSE[inst]) {
        // «Музыка кодом»: урок — одно задание в редакторе; в последнем модуле один урок.
        if (inst !== "code") expect(m.check.length, m.id).toBeGreaterThanOrEqual(2);
        for (const s of m.check) expect(stepExists(s, inst), `${m.id} проверка ${JSON.stringify(s)}`).toBe(true);
        for (const l of m.lessons) {
          if (inst === "code") expect(l.steps, l.id).toEqual([{ kind: "code", id: l.id.replace("code-l", "code-") }]);
          else expect(l.steps.length, l.id).toBeGreaterThanOrEqual(4);
          expect(l.steps.length, l.id).toBeLessThanOrEqual(8);
          for (const s of l.steps) {
            expect(stepExists(s, inst), `${l.id} ${JSON.stringify(s)}`).toBe(true);
            expect(stepTitle(s, inst), l.id).not.toMatch(/undefined/);
          }
        }
        // Шаги проверки модуля — из его же уроков.
        const inModule = new Set(m.lessons.flatMap((l) => l.steps.map((s) => JSON.stringify(s))));
        for (const s of m.check) expect(inModule.has(JSON.stringify(s)), `${m.id}: ${JSON.stringify(s)}`).toBe(true);
      }
    }
  });

  it("названия шагов понятные", () => {
    const steps = COURSE.piano[0].lessons[0].steps;
    expect(stepTitle(steps[0], "piano")).toBe("Теория: Нотный стан");
    expect(steps.map((s) => stepTitle(s, "piano"))).toContain("Пьеса: Ах, скажу я вам, мама (правой рукой)");
    expect(stepTitle({ kind: "song", id: "builtin-ode", strum: "quarters" }, "guitar")).toBe("Песня: Ода к радости (Бетховен) — боем «Четверти вниз»");
    expect(stepTitle({ kind: "fret", level: 1 }, "bass")).toMatch(/^Гриф: /);
  });

  it("открытие: сначала только первый урок; потом по порядку; модуль — после предыдущего", () => {
    const s0 = lessonStates("piano", none);
    expect(s0.get("piano-1")).toBe("current");
    expect(s0.get("piano-2")).toBe("locked");
    expect(s0.get("piano-4")).toBe("locked");
    const p1 = passedLessons("piano", ["piano-1"]);
    expect(lessonStates("piano", p1).get("piano-1")).toBe("done");
    expect(lessonStates("piano", p1).get("piano-2")).toBe("current");
    expect(currentLesson("piano", p1).id).toBe("piano-2");
    const m1 = passedLessons("piano", ["piano-1", "piano-2", "piano-3"]);
    expect(lessonStates("piano", m1).get("piano-4")).toBe("current");
    expect(moduleOpen("piano", "piano-m2", m1)).toBe(true);
    expect(moduleOpen("piano", "piano-m3", m1)).toBe(false);
  });

  it("«я это уже умею»: проверка модуля засчитывает его и открывает следующий", () => {
    const check = COURSE.guitar[0].check;
    const p: CourseProgress = { stats: check.map((s) => stat(stepRecordIds(s, "guitar")[0])), trainer: [] };
    const st = lessonStates("guitar", p);
    expect(st.get("guitar-4")).toBe("current");
    // Уроки пропущенного модуля открыты (можно вернуться), но не засчитаны.
    expect(["open", "current", "done"]).toContain(st.get("guitar-1"));
  });

  it("шаг засчитан только с зачётом; теория — когда прочитана; чтение с листа — в темпе или в ожидании", () => {
    expect(stepDone({ kind: "exercise", id: "five-C-updown-right" }, "piano", { stats: [stat("five-C-updown-right", false)], trainer: [] })).toBe(false);
    expect(stepDone({ kind: "theory", card: "staff" }, "piano", { stats: [stat("course-theory-staff", false)], trainer: [] })).toBe(true);
    expect(stepDone({ kind: "read", level: 2 }, "piano", { stats: [stat("read-2-wait")], trainer: [] })).toBe(true);
    expect(stepRecordIds({ kind: "fret", level: 3 }, "bass")).toEqual(["fret-bass-3"]);
    expect(stepRecordIds({ kind: "jam", lesson: 2 }, "drums")).toEqual(["jam-piano-2"]);
  });

  it("повторение: упражнение из пройденных уроков, каждый день другое; у первого урока нет", () => {
    expect(reviewStep("piano", "piano-1", none, "2026-10-06")).toBeNull();
    const p = passedLessons("piano", ["piano-1", "piano-2", "piano-3"]);
    const days = ["2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09"].map((d) => reviewStep("piano", "piano-4", p, d));
    expect(days.every((s) => s && ["exercise", "read", "rhythm"].includes(s.kind))).toBe(true);
    expect(new Set(days.map((s) => JSON.stringify(s))).size).toBeGreaterThan(1);
  });
});
