import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import type { Journal } from "../api";
import { claudePrompt, diaryDays, diaryYaml, isoWeek, weeklyFiles } from "./journal";
import { catalogText, dayPlanSteps, parsePlan, planCatalog, recordTitle, stepFromYaml, stepToYaml, todayKey } from "./plan";
import { dueToday, reviewItems, schedule } from "./srs";
import { stepExists } from "./course";

const T = (date: string, hh = 12) => Date.parse(`${date}T${String(hh).padStart(2, "0")}:00:00`) / 1000;
const empty = (): Journal => ({ exercises: [], attempts: [], trainer: [], play: [] });

describe("дневник", () => {
  it("дни из истории: минуты, отрезки пьес с трудными тактами, упражнения с названиями, тренажёр", () => {
    const j = empty();
    j.play.push([T("2026-10-05", 10), 600], [T("2026-10-05", 11), 300], [T("2026-10-06", 9), 120]);
    j.attempts.push(
      { piece: "builtin:fur-elise", title: "К Элизе", from: 1, to: 4, level: 2, mode: "wait", hands: "both", tempo: 0.8, accuracy: 0.85, durationMs: 30000, finishedAt: T("2026-10-05"), hard: [3] },
      { piece: "builtin:fur-elise", title: "К Элизе", from: 1, to: 4, level: 2, mode: "wait", hands: "both", tempo: 0.8, accuracy: 0.92, durationMs: 30000, finishedAt: T("2026-10-05", 13), hard: [3, 4] },
    );
    j.exercises.push({ exercise: "major-C-rh", finishedAt: T("2026-10-06"), tempo: 1, accuracy: 0.97, timingSdMs: 30, passed: true });
    j.trainer.push({ level: 2, finishedAt: T("2026-10-06"), notes: 20, firstTry: 19, avgReactionMs: 900, passed: true });
    const days = diaryDays(j);
    expect(days.map((d) => d.date)).toEqual(["2026-10-06", "2026-10-05"]);
    expect(days[1].minutes).toBe(15);
    expect(days[1].pieces[0].fragments[0]).toMatchObject({ bars: "1-4", attempts: 2, bestAccuracy: 0.92, hardBars: [3, 4] });
    expect(days[0].exercises[0].title).toMatch(/Гамма до мажор/);
    expect(days[0].trainer[0]).toMatchObject({ level: 2, series: 1, passed: true });
    const doc = parse(diaryYaml(days, { text: "К Элизе к Новому году", minutesPerDay: 25 }, "2026-10-05", "2026-10-06"));
    expect(doc.format).toBe("midi-teacher/journal@1");
    expect(doc.goal).toEqual({ text: "К Элизе к Новому году", minutes_per_day: 25 });
    expect(doc.days[0].pieces[0].fragments[0].hard_bars).toEqual([3, 4]);
    expect(doc.days[1].exercises[0]).toMatchObject({ id: "major-C-rh", passed: true, best_accuracy: 0.97 });
    expect(doc.days[1].note_trainer[0].best_accuracy).toBe(0.95);
    expect([...weeklyFiles(days, null).keys()]).toEqual(["2026-W41.yaml"]);
    expect(isoWeek("2026-01-01")).toBe("2026-W01");
    expect(isoWeek("2024-12-30")).toBe("2025-W01");
  });

  it("запрос для Claude: цель, формат плана, каталог инструмента и дневник", () => {
    const text = claudePrompt({ instrument: "guitar", goal: { text: "Гринсливз", minutesPerDay: 20 }, diary: "format: x\n", weeks: 2, planWeeks: 2 });
    expect(text).toContain("midi-teacher/plan@1");
    expect(text).toContain("guitar: gtr-piece-greensleeves");
    expect(text).toContain("guitar-16");
    expect(text).toContain("около 20 минут");
    expect(text).not.toContain("exercise: major-C-rh — ");
  });
});

describe("свои уроки и план из YAML", () => {
  const yaml = `
format: midi-teacher/plan@1
title: Тест
instrument: piano
goal: Сыграть Элизу
lessons:
  - id: a
    title: Урок А
    steps:
      - theory: staff
      - exercise: major-C-rh
        target: { tempo: 0.8, accuracy: 0.95 }
        note: медленно
      - piece: fur-elise
        hands: right
      - song: korobeiniki
        style: oompah
      - rhythm: line-1
      - ear: interval-1
plan:
  - date: 2026-10-08
    course: piano-2
  - date: 2026-10-07
    lesson: a
    steps:
      - read: 3
`;
  it("разбор: уроки, дни по порядку, приставки id, цели шагов", () => {
    const r = parsePlan(yaml);
    expect(r.errors).toEqual([]);
    const p = r.plan!;
    expect(p.lessons[0].steps.map((s) => s.kind)).toEqual(["theory", "exercise", "piece", "song", "rhythm", "ear"]);
    expect(p.lessons[0].planSteps[1]).toMatchObject({ note: "медленно", target: "темп 80%, точность 95%" });
    expect(p.lessons[0].steps[2]).toEqual({ kind: "piece", id: "builtin:fur-elise", hands: "right" });
    expect(p.days.map((d) => d.date)).toEqual(["2026-10-07", "2026-10-08"]);
    expect(dayPlanSteps(p, p.days[0]).length).toBe(7);
    expect(dayPlanSteps(p, p.days[1]).length).toBeGreaterThan(3);
  });

  it("JSON тоже читается; ошибки — с местом и по-русски", () => {
    expect(parsePlan(JSON.stringify({ lessons: [{ id: "x", title: "X", steps: [{ exercise: "major-C-rh" }] }] })).errors).toEqual([]);
    const bad = parsePlan(`
lessons:
  - id: a
    steps:
      - exercise: nope
      - piece: fur-elise
        hands: three
      - dance: 1
plan:
  - date: 7 октября
  - date: 2026-10-09
    lesson: zzz
`);
    expect(bad.plan).toBeNull();
    expect(bad.errors.join("\n")).toMatch(/lessons\[1\]\.steps\[1\]: нет такого задания/);
    expect(bad.errors.join("\n")).toMatch(/hands: «three»/);
    expect(bad.errors.join("\n")).toMatch(/непонятный шаг: dance/);
    expect(bad.errors.join("\n")).toMatch(/plan\[1\]: date/);
    expect(bad.errors.join("\n")).toMatch(/нет урока «zzz»/);
    expect(parsePlan("title: [").errors[0]).toMatch(/не читается/);
    expect(parsePlan("instrument: flute\nlessons: []").errors[0]).toMatch(/instrument/);
  });

  it("каталог: каждая запись разбирается обратно в существующий шаг", () => {
    for (const inst of ["piano", "guitar", "bass", "drums"] as const) {
      const groups = planCatalog(inst);
      expect(groups.every((g) => g.items.length > 0), inst).toBe(true);
      for (const g of groups)
        for (const it of g.items) {
          const s = stepFromYaml(it.yaml);
          expect(typeof s, JSON.stringify(it.yaml)).toBe("object");
          expect(stepExists(s as never, inst), `${inst} ${JSON.stringify(it.yaml)}`).toBe(true);
          expect(stepToYaml(s as never)).toEqual(it.yaml);
        }
      expect(catalogText(inst).length).toBeGreaterThan(500);
    }
    expect(recordTitle("course-theory-staff")).toBe("Теория: Нотный стан");
    expect(recordTitle("drum-song-ode")).toMatch(/Ода к радости/);
    expect(recordTitle("неизвестно")).toBe("неизвестно");
  });
});

describe("повторение с интервалами", () => {
  it("сроки 1-3-7-14-30: удачное повторение — дальше, неудачное — снова через день, игра до срока не считается", () => {
    const days = (o: Record<string, boolean>) => new Map(Object.entries(o));
    expect(schedule("2026-10-01", days({}))).toEqual({ stage: 0, due: "2026-10-02" });
    expect(schedule("2026-10-01", days({ "2026-10-02": true }))).toEqual({ stage: 1, due: "2026-10-05" });
    expect(schedule("2026-10-01", days({ "2026-10-02": true, "2026-10-03": false }))).toEqual({ stage: 1, due: "2026-10-05" });
    expect(schedule("2026-10-01", days({ "2026-10-02": true, "2026-10-05": true, "2026-10-12": true }))).toEqual({ stage: 3, due: "2026-10-26" });
    expect(schedule("2026-10-01", days({ "2026-10-02": true, "2026-10-06": false }))).toEqual({ stage: 0, due: "2026-10-07" });
  });

  it("упражнения, отрезки пьес и уроки курса из истории", () => {
    const j = empty();
    const ex = (exercise: string, date: string, passed = true) => j.exercises.push({ exercise, finishedAt: T(date), tempo: 1, accuracy: passed ? 0.97 : 0.7, timingSdMs: 30, passed });
    ex("major-C-rh", "2026-10-01");
    ex("gtr-piece-ode", "2026-09-20");
    ex("gtr-piece-ode", "2026-09-21");
    ex("read-2", "2026-10-01"); // ступень чтения — не упражнение для повторения
    for (const id of ["course-theory-staff", "course-theory-treble-clef", "course-theory-fingering", "five-C-updown-right", "rhythm-line-1", "course-piece-twinkle", "ear-interval-1"]) ex(id, "2026-09-30");
    j.trainer.push({ level: 1, finishedAt: T("2026-09-30"), notes: 20, firstTry: 20, avgReactionMs: 800, passed: true });
    j.attempts.push({ piece: "builtin:ode-to-joy", title: "Ода к радости", from: 1, to: 4, level: 3, mode: "rhythm", hands: "both", tempo: 1, accuracy: 0.95, durationMs: 20000, finishedAt: T("2026-10-03"), hard: [] });
    const items = reviewItems(j);
    const keys = items.map((i) => i.key).sort();
    expect(keys).toContain("ex:major-C-rh");
    expect(keys).toContain("ex:gtr-piece-ode");
    expect(keys).toContain("ex:five-C-updown-right");
    expect(keys).not.toContain("ex:read-2");
    expect(keys).toContain("frag:builtin:ode-to-joy:1-4");
    expect(keys).toContain("lesson:piano-1");
    const ode = items.find((i) => i.key === "ex:gtr-piece-ode")!;
    // Выучено 20-го, повторено в срок 21-го → следующий срок через 3 дня.
    expect(ode).toMatchObject({ learnedOn: "2026-09-20", stage: 1, due: "2026-09-24" });
    const due = dueToday(items, "2026-10-04");
    expect(due.map((i) => i.key)).toContain("frag:builtin:ode-to-joy:1-4");
    expect(due.find((i) => i.key === "ex:major-C-rh")).toBeTruthy();
    expect(dueToday(items, "2026-10-01").some((i) => i.key === "ex:major-C-rh")).toBe(false);
    expect(todayKey(new Date(2026, 0, 5))).toBe("2026-01-05");
  });
});
