import { beforeAll, describe, expect, it } from "vitest";
import createVerovioModule from "verovio/wasm";
import { VerovioToolkit } from "verovio/esm";
import { readFileSync } from "node:fs";
import { buildNotes, parseMei, timemapNoteIds, type MidiValues, type TimemapEntry } from "./score";
import { CARDS, THEORY_GROUPS, detectFeatures, trainerFeatures } from "./theory";
import { EXERCISE_BY_ID, exerciseMei } from "./exercises";

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

function features(data: string) {
  tk.resetXmlIdSeed(1);
  tk.setOptions({ breaks: "none" });
  expect(tk.loadData(data)).toBeTruthy();
  const mei = tk.getMEI({});
  const timemap = tk.renderToTimemap({ includeMeasures: true });
  const midi: MidiValues = {};
  for (const id of timemapNoteIds(timemap)) midi[id] = tk.getMIDIValuesForElement(id);
  const structure = parseMei(mei);
  return detectFeatures(mei, structure, buildNotes(timemap, midi, structure));
}

describe("карточки теории", () => {
  it("около 25 карточек, у всех группа и короткий текст", () => {
    expect(CARDS.length).toBeGreaterThanOrEqual(25);
    expect(new Set(CARDS.map((c) => c.id)).size).toBe(CARDS.length);
    for (const c of CARDS) {
      expect(THEORY_GROUPS).toContain(c.group);
      expect(c.short.length).toBeGreaterThan(10);
      expect(c.body.length).toBeGreaterThan(0);
    }
  });

  it("каждый пример рисуется и показывает свой элемент", () => {
    for (const c of CARDS) {
      if (!c.example) continue;
      const mei = c.example();
      tk.resetXmlIdSeed(1);
      tk.setOptions({ breaks: "none", adjustPageHeight: true });
      expect(tk.loadData(mei), c.id).toBeTruthy();
      const svg = tk.renderToSVG(1);
      expect(svg.length, c.id).toBeGreaterThan(1000);
      // Пример содержит элемент своей карточки.
      expect(features(mei), c.id).toContain(c.id);
    }
  });
});

describe("поиск элементов", () => {
  it("«Ода к радости»: два ключа, система, точка, лига, аккордов нет", () => {
    const f = features(readFileSync("src/pieces/ode-to-joy.musicxml", "utf8"));
    for (const id of ["treble-clef", "bass-clef", "grand-staff", "dot", "durations", "tempo"]) expect(f).toContain(id);
    expect(f).not.toContain("sharp-flat");
  });

  it("Менуэт: знаки при ключе, восьмые, аккорды, лиги", () => {
    const f = features(readFileSync("src/pieces/minuet-g-anh114.musicxml", "utf8"));
    for (const id of ["key-signature", "eighths", "chord", "tie", "sharp-flat", "natural"]) expect(f).toContain(id);
  });

  it("упражнение в ре мажоре — знаки при ключе", () => {
    const ex = EXERCISE_BY_ID.get("major-D-rh")!;
    expect(features(exerciseMei(ex.build()))).toContain("key-signature");
  });

  it("ступени тренажёра", () => {
    expect(trainerFeatures(1, false, false)).toEqual(["staff", "treble-clef"]);
    expect(trainerFeatures(4, false, true)).toEqual(["staff", "bass-clef"]);
    expect(trainerFeatures(9, true, false)).toEqual(["staff", "treble-clef", "bass-clef", "grand-staff", "ledger", "sharp-flat"]);
  });
});
