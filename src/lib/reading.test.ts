import { beforeAll, describe, expect, it } from "vitest";
import createVerovioModule from "verovio/wasm";
import { VerovioToolkit } from "verovio/esm";
import { buildNotes, parseMei, timemapNoteIds, type MidiValues, type TimemapEntry } from "./score";
import { exerciseMei, type ExerciseStatView } from "./exercises";
import { READ_LEVELS, readUnlocked, readingMelody, readId, readWaitId, scalePool } from "./reading";
import { HANDS_GATE, RHYTHM_LEVELS, onsets, rhythmKey, rhythmMei, rhythmScore, rhythmUnlocked, RHYTHM_LEFT, RHYTHM_RIGHT } from "./rhythm";

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

/** Загрузить MEI в Verovio так же, как это делает приложение. */
function load(data: string) {
  tk.resetXmlIdSeed(1);
  tk.setOptions({ breaks: "none" });
  expect(tk.loadData(data)).toBeTruthy();
  const mei = tk.getMEI({});
  const timemap = tk.renderToTimemap({ includeMeasures: true });
  const midi: MidiValues = {};
  for (const tid of timemapNoteIds(timemap)) midi[tid] = tk.getMIDIValuesForElement(tid);
  const structure = parseMei(mei);
  const notes = buildNotes(timemap, midi, structure);
  const hand = (h: "right" | "left") => notes.filter((n) => n.hand === h).sort((a, b) => a.startMs - b.startMs);
  return { notes, structure, hand };
}

const stat = (exercise: string, passes: number): ExerciseStatView => ({
  exercise,
  attempts: passes,
  passed: passes > 0,
  passes,
  bestAccuracy: 1,
  lastAt: 0,
  lastTimingSdMs: 20,
  lastLoudness: 1,
});

describe("чтение с листа", () => {
  it("гамма ступени: соль мажор с фа-диезом, в диапазоне", () => {
    const pool = scalePool({ letter: "g", alter: 0, oct: 4 }, 62, 74);
    expect(pool.map((n) => n.midi)).toEqual([62, 64, 66, 67, 69, 71, 72, 74]);
    expect(pool.find((n) => n.midi === 67)!.degree).toBe(0);
  });

  it("каждая ступень даёт мелодию, которую Verovio читает: ноты в диапазоне, конец на тонике, такты полные", () => {
    for (const level of READ_LEVELS) {
      for (const seed of [1, 2, 3, 17, 42]) {
        const m = readingMelody(level, seed);
        const { notes, structure, hand } = load(exerciseMei(m.score));
        expect(structure.measures).toBe(level.measures);
        const mel = hand(level.melodyLeft ? "left" : "right").map((n) => n.pitch);
        expect(mel).toEqual(m.pitches);
        expect(Math.min(...mel)).toBeGreaterThanOrEqual(level.low);
        expect(Math.max(...mel)).toBeLessThanOrEqual(level.high);
        // Последняя нота — тоника (по высотному классу).
        const tonicPc = scalePool(level.tonic, level.low, level.high).find((p) => p.degree === 0)!.midi % 12;
        expect(mel[mel.length - 1] % 12).toBe(tonicPc);
        // Ходы не больше разрешённого (кроме последней ноты — к тонике).
        const pool = scalePool(level.tonic, level.low, level.high).map((p) => p.midi);
        for (let i = 1; i < mel.length - 1; i++) expect(Math.abs(pool.indexOf(mel[i]) - pool.indexOf(mel[i - 1]))).toBeLessThanOrEqual(level.maxLeap);
        // Обе руки — у левой бас в каждом такте.
        if (level.staves === "grand") expect(hand("left").length).toBeGreaterThanOrEqual(level.measures);
        else expect(hand(level.melodyLeft ? "right" : "left")).toHaveLength(0);
        expect(notes.length).toBeGreaterThan(level.measures);
      }
    }
  });

  it("мелодия одна для одного зерна и разная для разных", () => {
    const l = READ_LEVELS[2];
    expect(readingMelody(l, 5).pitches).toEqual(readingMelody(l, 5).pitches);
    const set = new Set([1, 2, 3, 4, 5, 6].map((s) => readingMelody(l, s).pitches.join(",")));
    expect(set.size).toBeGreaterThan(3);
  });

  it("пальцы в позиции «до»: палец = место ноты", () => {
    const m = readingMelody(READ_LEVELS[0], 3);
    const fingers = m.score.right!.map((n) => n.finger);
    const expected = m.pitches.map((p) => [60, 62, 64, 65, 67].indexOf(p) + 1);
    expect(fingers).toEqual(expected);
  });

  it("ступени открываются по три засчитанные мелодии, из них хотя бы одна в темпе", () => {
    expect(readUnlocked([])).toBe(1);
    expect(readUnlocked([stat(readWaitId(1), 5)])).toBe(1);
    expect(readUnlocked([stat(readWaitId(1), 2), stat(readId(1), 1)])).toBe(2);
    expect(readUnlocked([stat(readId(1), 3), stat(readId(2), 3)])).toBe(3);
  });
});

describe("ритм", () => {
  it("каждая ступень даёт полные такты, Verovio читает ритм с нужными ударами", () => {
    for (const level of RHYTHM_LEVELS) {
      for (const seed of [1, 2, 3, 9, 31]) {
        const s = rhythmScore(level, seed);
        for (const m of [...s.right, ...(s.left ?? [])]) expect(m.reduce((a, e) => a + e.len, 0)).toBe(level.beats * 4);
        const { notes, structure, hand } = load(rhythmMei(s));
        expect(structure.measures).toBe(level.measures);
        const beatMs = 60000 / level.bpm;
        const right = hand("right");
        expect(right.every((n) => n.pitch === RHYTHM_RIGHT)).toBe(true);
        expect(right.map((n) => Math.round((n.startMs / beatMs) * 4))).toEqual(onsets(s.right, level.beats));
        if (s.left) {
          const left = hand("left");
          expect(left.every((n) => n.pitch === RHYTHM_LEFT)).toBe(true);
          expect(left.map((n) => Math.round((n.startMs / beatMs) * 4))).toEqual(onsets(s.left, level.beats));
        } else expect(notes.every((n) => n.hand === "right")).toBe(true);
      }
    }
  });

  it("руки по очереди: на каждой доле одна рука, в конце обе", () => {
    const level = RHYTHM_LEVELS.find((l) => l.alternate)!;
    const s = rhythmScore(level, 4);
    for (let m = 0; m < level.measures - 1; m++)
      for (let b = 0; b < level.beats; b++) expect(!!s.right[m][b].rest).toBe(!s.left![m][b].rest);
  });

  it("«Две руки» открываются после третьей ступени одной строки", () => {
    expect(rhythmUnlocked([], "line")).toBe(1);
    expect(rhythmUnlocked([], "hands")).toBe(0);
    const passed = Array.from({ length: HANDS_GATE }, (_, i) => stat(rhythmKey({ track: "line", id: i + 1 }), 3));
    expect(rhythmUnlocked(passed, "line")).toBe(HANDS_GATE + 1);
    expect(rhythmUnlocked(passed, "hands")).toBe(1);
  });
});
