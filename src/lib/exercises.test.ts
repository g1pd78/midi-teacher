import { beforeAll, describe, expect, it } from "vitest";
import createVerovioModule from "verovio/wasm";
import { VerovioToolkit } from "verovio/esm";
import { buildNotes, parseMei, timemapNoteIds, type MidiValues, type ScoreNote, type TimemapEntry } from "./score";
import { parseFinger } from "./fingering";
import {
  CATEGORY_GATE,
  EXERCISES,
  EXERCISE_BY_ID,
  crossingNotes,
  evaluate,
  exerciseMei,
  midiOf,
  scaleFingers,
  scaleUp,
  unlockedSet,
  warmup,
  type ExerciseStatView,
} from "./exercises";

type Tk = VerovioToolkit & {
  getMEI(o: object): string;
  renderToTimemap(o: object): TimemapEntry[];
  getMIDIValuesForElement(id: string): { time: number; duration: number; pitch: number };
  resetXmlIdSeed(seed: number): void;
};
let tk: Tk;

beforeAll(async () => {
  tk = new VerovioToolkit(await createVerovioModule()) as Tk;
}, 60_000);

/** Загрузить упражнение в Verovio так же, как это делает приложение. */
function load(id: string) {
  const ex = EXERCISE_BY_ID.get(id)!;
  tk.resetXmlIdSeed(1);
  tk.setOptions({ breaks: "none" });
  expect(tk.loadData(exerciseMei(ex.build()))).toBeTruthy();
  const mei = tk.getMEI({});
  const timemap = tk.renderToTimemap({ includeMeasures: true });
  const midi: MidiValues = {};
  for (const tid of timemapNoteIds(timemap)) midi[tid] = tk.getMIDIValuesForElement(tid);
  const structure = parseMei(mei);
  const notes = buildNotes(timemap, midi, structure);
  const fingers = new Map(notes.map((n) => [n.id, parseFinger(structure.fingerOf.get(n.id))!]));
  const hand = (h: "right" | "left") => notes.filter((n) => n.hand === h).sort((a, b) => a.startMs - b.startMs);
  return { notes, structure, fingers, hand, svg: tk.renderToSVG(1) };
}

describe("гаммы", () => {
  it("названия нот и высоты: ре мажор и си-бемоль мажор", () => {
    expect(scaleUp({ letter: "d", alter: 0, oct: 4 }, "major", 1).map(midiOf)).toEqual([62, 64, 66, 67, 69, 71, 73, 74]);
    const bb = scaleUp({ letter: "b", alter: -1, oct: 3 }, "major", 1);
    expect(bb.map((p) => p.letter + p.alter).join(" ")).toBe("b-1 c0 d0 e-1 f0 g0 a0 b-1");
    const fs = scaleUp({ letter: "f", alter: 1, oct: 4 }, "harmonic", 1);
    expect(fs.map((p) => p.letter + p.alter).join(" ")).toBe("f1 g1 a0 b0 c1 d0 e1 f1"); // ми-диез
  });

  it("аппликатура на две октавы", () => {
    expect(scaleFingers([1, 2, 3, 1, 2, 3, 4, 5], 2, "right").join("")).toBe("123123412312345");
    expect(scaleFingers([5, 4, 3, 2, 1, 3, 2, 1], 2, "left").join("")).toBe("543213214321321");
    expect(scaleFingers([3, 2, 1, 4, 3, 2, 1, 3], 2, "left").join("")).toBe("321432132143213");
  });

  it("до мажор правой: 15 нот вверх-вниз, пальцы 1 2 3 1 2 3 4 5 …", () => {
    const { hand, fingers } = load("major-C-rh");
    const r = hand("right");
    expect(r.map((n) => n.pitch)).toEqual([60, 62, 64, 65, 67, 69, 71, 72, 71, 69, 67, 65, 64, 62, 60]);
    expect(r.map((n) => fingers.get(n.id)).join("")).toBe("123123454321321");
    expect(hand("left")).toHaveLength(0);
  });

  it("ля мажор обеими руками в две октавы: знаки при ключе применяются к звуку", () => {
    const { hand, fingers } = load("major-A-parallel2");
    const r = hand("right").map((n) => n.pitch);
    expect(r.slice(0, 8)).toEqual([57, 59, 61, 62, 64, 66, 68, 69]);
    expect(r).toHaveLength(29);
    const l = hand("left");
    expect(l[0].pitch).toBe(45);
    expect(l.slice(0, 15).map((n) => fingers.get(n.id)).join("")).toBe("543213214321321");
  });

  it("мелодический минор: вверх с повышенными ступенями, вниз натуральный (бекары)", () => {
    const { hand, svg } = load("minor-mel-a-parallel");
    const r = hand("right").map((n) => n.pitch);
    expect(r).toEqual([57, 59, 60, 62, 64, 66, 68, 69, 67, 65, 64, 62, 60, 59, 57]);
    expect(svg).toContain("accid"); // диезы и бекары видны
  });

  it("расходящаяся: правая вверх, левая вниз зеркальными пальцами", () => {
    const { hand, fingers } = load("major-C-contrary");
    const r = hand("right");
    const l = hand("left");
    expect(r[1].pitch - r[0].pitch).toBeGreaterThan(0);
    expect(l[1].pitch - l[0].pitch).toBeLessThan(0);
    expect(l[0].pitch).toBe(48);
    expect(l.slice(0, 8).map((n) => fingers.get(n.id)).join("")).toBe("12312345");
  });

  it("ми-бемоль мажор левой: пальцы 3 2 1 4 3 2 1 3", () => {
    const { hand, fingers } = load("major-Eb-lh");
    const l = hand("left");
    expect(l[0].pitch).toBe(51);
    expect(l.slice(0, 8).map((n) => fingers.get(n.id)).join("")).toBe("32143213");
  });
});

describe("пять пальцев, арпеджио, Ганон", () => {
  it("позиция «соль»: обе руки, левая октавой ниже с пальцами 5…1", () => {
    const { hand, fingers } = load("five-G-updown-both");
    expect(hand("right").map((n) => n.pitch)).toEqual([67, 69, 71, 72, 74, 72, 71, 69, 67]);
    expect(hand("left").map((n) => fingers.get(n.id)).join("")).toBe("543212345");
  });

  it("арпеджио до мажор в две октавы", () => {
    const { hand, fingers } = load("arp-C-parallel2");
    const r = hand("right");
    expect(r.map((n) => n.pitch)).toEqual([60, 64, 67, 72, 76, 79, 84, 79, 76, 72, 67, 64, 60]);
    expect(r.slice(0, 7).map((n) => fingers.get(n.id)).join("")).toBe("1231235");
  });

  it("Ганон: восьмые, 113 нот, начинается и кончается на до", () => {
    const { hand, structure } = load("hanon-1-right");
    const r = hand("right");
    expect(r).toHaveLength(113);
    expect(r[0].pitch).toBe(60);
    expect(r[r.length - 1].pitch).toBe(60);
    expect(r.slice(0, 8).map((n) => n.pitch)).toEqual([60, 64, 65, 67, 69, 67, 65, 64]);
    expect(structure.measures).toBe(15);
  });

  it("каждое упражнение каталога загружается и все ноты с пальцами", () => {
    expect(EXERCISES.length).toBeGreaterThan(100);
    expect(new Set(EXERCISES.map((e) => e.id)).size).toBe(EXERCISES.length);
    for (const ex of EXERCISES) {
      const mei = exerciseMei(ex.build());
      tk.resetXmlIdSeed(1);
      expect(tk.loadData(mei), ex.id).toBeTruthy();
      const s = parseMei(tk.getMEI({}));
      expect(s.fingerOf.size, ex.id).toBeGreaterThan(5);
    }
  }, 60_000);
});

describe("ступени и разминка", () => {
  it("открыто только начало, дальше по порядку и по ключевым упражнениям", () => {
    const open = unlockedSet(new Set());
    expect([...open]).toEqual(["five-C-updown-right"]);
    const passed = new Set(["five-C-updown-right", "five-C-updown-left", "five-C-updown-both"]);
    const open2 = unlockedSet(passed);
    expect(open2.has("five-C-thirds-both")).toBe(true);
    expect(open2.has("hanon-1-right")).toBe(true);
    expect(open2.has("major-C-rh")).toBe(true);
    expect(open2.has("major-C-lh")).toBe(false);
    expect(open2.has("minor-a-rh")).toBe(false);
    for (const gate of Object.values(CATEGORY_GATE)) if (gate) expect(EXERCISE_BY_ID.has(gate)).toBe(true);
  });

  it("разминка: из открытого, передний край в приоритете, постоянна в течение дня", () => {
    const st = (exercise: string, passed = true): ExerciseStatView => ({
      exercise,
      attempts: 1,
      passed,
      bestAccuracy: 1,
      lastAt: 0,
      lastTimingSdMs: 30,
      lastLoudness: 0.9,
    });
    const first = warmup([], "2026-10-01");
    expect(first.map((e) => e.id)).toEqual(["five-C-updown-right"]);
    const stats = ["five-C-updown-right", "five-C-updown-left", "five-C-updown-both"].map((id) => st(id));
    const w = warmup(stats, "2026-10-01");
    expect(w.map((e) => e.id)).toEqual(["five-C-thirds-both", "major-C-rh", "hanon-1-right"]);
    expect(warmup(stats, "2026-10-01")).toEqual(w);
  });
});

describe("оценка ровности", () => {
  const note = (id: string, pitch: number, startMs: number, hand: "right" | "left" = "right"): ScoreNote => ({
    id,
    pitch,
    startMs,
    durMs: 500,
    hand,
    measure: 1,
    staff: hand === "right" ? 1 : 2,
  });
  // До ре ми фа соль: 1 2 3 1 2 — на фа первый палец подкладывается.
  const notes = [note("a", 60, 0), note("b", 62, 500), note("c", 64, 1000), note("d", 65, 1500), note("e", 67, 2000)];
  const fingers = new Map([
    ["a", 1],
    ["b", 2],
    ["c", 3],
    ["d", 1],
    ["e", 2],
  ]);

  it("подкладывание пальца находится", () => {
    expect([...crossingNotes(notes, fingers)]).toEqual(["d"]);
  });

  it("ровно и громко одинаково — пройдено", () => {
    const hits = notes.map((n, i) => ({ id: n.id, deltaMs: [5, -8, 10, -5, 3][i], velocity: 80 }));
    const e = evaluate(hits, 5, 0, notes, fingers, 1);
    expect(e.passed).toBe(true);
    expect(e.loudness).toBeCloseTo(1);
    expect(e.weakFinger).toBeNull();
  });

  it("сбивка на подкладывании и слабый палец видны", () => {
    const hits = [
      { id: "a", deltaMs: 0, velocity: 90 },
      { id: "b", deltaMs: 10, velocity: 60 },
      { id: "c", deltaMs: -10, velocity: 88 },
      { id: "d", deltaMs: 140, velocity: 92 },
      { id: "e", deltaMs: 0, velocity: 58 },
    ];
    const e = evaluate(hits, 5, 1, notes, fingers, 1);
    expect(e.crossingMs).toBe(140);
    expect(e.otherMs).toBe(5);
    expect(e.weakFinger?.finger).toBe(2);
    expect(e.worst[0]).toEqual({ id: "d", deltaMs: 140 });
    expect(e.passed).toBe(false); // лишняя нота и разброс
    expect(e.accuracy).toBeCloseTo(5 / 6);
  });

  it("в медленном темпе не засчитывается", () => {
    const hits = notes.map((n) => ({ id: n.id, deltaMs: 0, velocity: 80 }));
    expect(evaluate(hits, 5, 0, notes, fingers, 0.8).passed).toBe(false);
  });
});
