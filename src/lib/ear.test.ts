import { describe, expect, it } from "vitest";
import {
  EAR_KINDS,
  EAR_LEVELS,
  INTERVALS,
  cadence,
  earLevelId,
  earSeries,
  earUnlocked,
  judgeChordPlay,
  judgeNote,
  judgeRhythm,
  levelsOf,
  melodyPrefix,
  voiceChord,
} from "./ear";
import type { ExerciseStatView } from "./exercises";

const stat = (exercise: string): ExerciseStatView => ({ exercise, attempts: 1, passed: true, bestAccuracy: 1, lastAt: 0, lastTimingSdMs: 0, lastLoudness: 1 });

describe("тренажёр слуха", () => {
  it("у каждого вида есть ступени; серия — 10 заданий (диктанты — 5), ответ среди вариантов", () => {
    for (const k of EAR_KINDS) {
      expect(levelsOf(k.id).length, k.id).toBeGreaterThanOrEqual(4);
      for (const l of levelsOf(k.id)) {
        const s = earSeries(l, 3);
        expect(s.length, earLevelId(l)).toBe(k.id === "melody" || k.id === "rhythm" ? 5 : 10);
        for (const q of s) {
          expect(q.notes.length).toBeGreaterThan(0);
          if (q.options.length) expect(q.options, earLevelId(l)).toContain(q.answer);
          for (const n of q.notes) {
            expect(n.pitch).toBeGreaterThanOrEqual(36);
            expect(n.pitch).toBeLessThanOrEqual(96);
            expect(n.durMs).toBeGreaterThan(0);
          }
        }
      }
    }
  });

  it("интервал: вторая нота на нужном расстоянии и в нужную сторону, подсказка-мелодия", () => {
    for (const dir of ["up", "down", "harmonic"] as const) {
      const l = EAR_LEVELS.find((x) => x.kind === "interval" && x.direction === dir)!;
      for (const q of earSeries(l, 11)) {
        const [a, b] = q.notes.map((n) => n.pitch);
        const semis = INTERVALS.find((i) => i.short === q.answer)!.semis;
        expect(dir === "down" ? a - b : b - a).toBe(semis);
        expect(q.explain).toContain(INTERVALS.find((i) => i.short === q.answer)!.song);
        if (dir === "harmonic") expect(q.notes[1].startMs).toBeLessThan(50);
      }
    }
  });

  it("ответ игрой: нота по названию звука, октава от данной ноты — не та же клавиша", () => {
    const l = EAR_LEVELS.find((x) => x.kind === "interval" && x.id === 1)!;
    const q = earSeries(l, 5).find((x) => x.answer === "ч5")!;
    expect(judgeNote(q, q.expected[0])).toBe(true);
    expect(judgeNote(q, q.expected[0] + 12)).toBe(true);
    expect(judgeNote(q, q.expected[0] + 1)).toBe(false);
    const oct = earSeries(l, 5).find((x) => x.answer === "ч8")!;
    expect(judgeNote(oct, oct.given!)).toBe(false);
    expect(judgeNote(oct, oct.given! + 12)).toBe(true);
  });

  it("аккорд: виды и обращения, ответ игрой — любые октавы тех же звуков", () => {
    expect(voiceChord(60, "m")).toEqual([60, 63, 67]);
    expect(voiceChord(60, "", 1)).toEqual([64, 67, 72]);
    const l = EAR_LEVELS.find((x) => x.kind === "chord" && x.id === 5)!;
    for (const q of earSeries(l, 9)) {
      expect(judgeChordPlay(q, q.expected.map((p) => p - 12))).toBe(true);
      expect(judgeChordPlay(q, q.expected.slice(1))).toBe(false);
    }
  });

  it("ступени: каденция I–IV–V–I, потом нота или аккорд; последовательности — без каденции", () => {
    expect(cadence(60).slice(0, 3).map((n) => n.pitch)).toEqual([60, 64, 67]);
    const notes = EAR_LEVELS.find((x) => x.kind === "degree" && x.id === 2)!;
    for (const q of earSeries(notes, 4)) {
      const target = q.notes[q.notes.length - 1].pitch;
      const deg = ["I", "II", "III", "IV", "V", "VI", "VII"].indexOf(q.answer);
      expect((target - q.given! + 120) % 12).toBe([0, 2, 4, 5, 7, 9, 11][deg]);
    }
    const prog = EAR_LEVELS.find((x) => x.kind === "degree" && x.progressions)!;
    const q = earSeries(prog, 2)[0];
    expect(q.notes.length).toBe(12);
    expect(q.options).toContain(q.answer);
  });

  it("мелодический диктант: начинается с тоники, скачки в пределах ступени; проверка по порядку", () => {
    for (const l of levelsOf("melody")) {
      for (const q of earSeries(l, 7)) {
        expect(q.expected).toHaveLength(l.length!);
        expect(q.expected[0]).toBe(q.given);
        expect(melodyPrefix(q, q.expected)).toBe(l.length);
        expect(melodyPrefix(q, q.expected.map((p) => p + 12))).toBe(l.length);
      }
    }
    const q = earSeries(levelsOf("melody")[1], 1)[0];
    expect(melodyPrefix(q, [q.expected[0], q.expected[1] + 1])).toBe(1);
  });

  it("ритмический диктант: точные удары — зачёт, сдвиг всего ритма не важен, лишние и пропуски — ошибки", () => {
    const q = earSeries(levelsOf("rhythm")[1], 4)[0];
    const ref = q.rhythm!.onsetsMs;
    expect(judgeRhythm(q, ref.map((t) => t + 1234)).accuracy).toBe(1);
    expect(judgeRhythm(q, ref.map((t, i) => t + 500 + (i % 2 ? 40 : -40))).accuracy).toBe(1);
    expect(judgeRhythm(q, ref.slice(0, -1)).accuracy).toBeLessThan(1);
    expect(judgeRhythm(q, [...ref, ref[ref.length - 1] + 300]).accuracy).toBeLessThan(1);
    expect(judgeRhythm(q, []).accuracy).toBe(0);
  });

  it("ступени открываются по порядку внутри вида", () => {
    expect(earUnlocked([], "interval")).toBe(1);
    expect(earUnlocked([stat("ear-interval-1"), stat("ear-interval-2")], "interval")).toBe(3);
    expect(earUnlocked([stat("ear-interval-1")], "chord")).toBe(1);
  });
});
