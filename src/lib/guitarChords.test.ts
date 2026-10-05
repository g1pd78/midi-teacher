import { describe, expect, it } from "vitest";
import { chordShape, judgeGuitarChord, shapeForTuning, shapePitches, upstrokePitches, diagramBase, type ChordForm } from "./guitarChords";
import { TUNINGS } from "./guitar";

const STD = TUNINGS.guitar;
const ROOTS = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];

describe("аппликатуры аккордов", () => {
  it("открытые аккорды: звучат ровно звуки аккорда", () => {
    for (const s of ["C", "A", "Am", "D", "Dm", "E", "Em", "G", "E7", "A7", "D7", "G7", "B7", "C7", "Cmaj7", "Fmaj7", "Amaj7", "Dmaj7", "Am7", "Em7", "Dm7", "Asus2", "Asus4", "Dsus2", "Dsus4", "Esus4", "Cadd9", "C6", "E5", "A5", "D5"]) {
      const shape = chordShape(s)!;
      expect(shape.form, s).toBe("open");
      expect(judgeGuitarChord(s, shapePitches(shape, STD)), s).toMatchObject({ ok: true });
    }
    expect(shapePitches(chordShape("C")!, STD)).toEqual([48, 52, 55, 60, 64]);
  });

  it("подвижные формы от любого основного тона — правильные звуки, лады 1–14", () => {
    const kinds: [string, ChordForm][] = [
      ["5", "power"],
      ["", "barre6"],
      ["m", "barre6"],
      ["7", "barre6"],
      ["m7", "barre6"],
      ["", "barre5"],
      ["m", "barre5"],
      ["7", "barre5"],
      ["m7", "barre5"],
      ["maj7", "jazz6"],
      ["m7", "jazz6"],
      ["7", "jazz6"],
      ["m7b5", "jazz6"],
      ["dim7", "jazz6"],
      ["maj7", "jazz5"],
      ["m7b5", "jazz5"],
      ["dim7", "jazz5"],
      ["9", "jazz5"],
      ["6", "jazz5"],
      ["m6", "jazz5"],
    ];
    for (const [q, form] of kinds)
      for (const r of ROOTS) {
        const sym = r + q;
        const shape = chordShape(sym, form);
        if (!shape) continue;
        const ps = shapePitches(shape, STD);
        expect(judgeGuitarChord(sym, ps), `${sym} ${form}`).toMatchObject({ ok: true });
        const played = shape.frets.filter((f) => f >= 0);
        expect(Math.min(...played), `${sym} ${form}`).toBeGreaterThanOrEqual(0);
        expect(Math.max(...played), `${sym} ${form}`).toBeLessThanOrEqual(14);
      }
  });

  it("баррэ: F — от 6-й струны на 1-м ладу, Bm — от 5-й на 2-м", () => {
    const f = chordShape("F")!;
    expect(f).toMatchObject({ form: "barre6", frets: [1, 3, 3, 2, 1, 1], barre: { fret: 1, from: 0, to: 5 } });
    const bm = chordShape("Bm")!;
    expect(bm).toMatchObject({ form: "barre5", frets: [-1, 2, 4, 4, 3, 2] });
    expect(diagramBase(chordShape("A", "barre6")!)).toBe(5);
    expect(diagramBase(chordShape("C")!)).toBe(1);
  });

  it("строй Drop D: те же звуки, на 6-й струне лад на 2 больше", () => {
    const dropD = [38, 45, 50, 55, 59, 64];
    const g = chordShape("G")!;
    const adapted = shapeForTuning(g, dropD);
    expect(adapted.frets[0]).toBe(5);
    expect(shapePitches(adapted, dropD)).toEqual(shapePitches(g, STD));
  });

  it("проверка: лишняя струна, не тот лад, не хватает звука", () => {
    expect(judgeGuitarChord("D", [40, 50, 57, 62, 66])).toMatchObject({ ok: false, foreign: [40] });
    expect(judgeGuitarChord("C", [48, 52, 55, 61, 64])).toMatchObject({ ok: false, foreign: [61], missing: [] });
    expect(judgeGuitarChord("C", [48, 52, 60, 64])).toMatchObject({ ok: false, missing: [7] });
    expect(upstrokePitches([40, 47, 52, 56, 59, 64])).toEqual([52, 56, 59, 64]);
  });
});
