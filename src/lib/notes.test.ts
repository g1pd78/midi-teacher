import { describe, expect, it } from "vitest";
import { fullName, isBlack, keyboardLayout, keyLabel, octaveOf, pitchName } from "./notes";

describe("названия нот", () => {
  it("до первой октавы — это MIDI 60", () => {
    expect(fullName(60, "solfege")).toBe("До первой октавы");
    expect(fullName(60, "latin")).toBe("C4");
    expect(octaveOf(60)).toBe(4);
  });

  it("крайние клавиши рояля", () => {
    expect(fullName(21, "solfege")).toBe("Ля субконтроктавы");
    expect(fullName(108, "solfege")).toBe("До пятой октавы");
    expect(fullName(21, "latin")).toBe("A0");
  });

  it("диезы и малая октава", () => {
    expect(pitchName(54, "solfege")).toBe("Фа♯");
    expect(fullName(54, "solfege")).toBe("Фа♯ малой октавы");
    expect(keyLabel(66, "latin")).toBe("F♯4");
  });

  it("чёрные клавиши", () => {
    expect([60, 61, 62, 63, 64, 65, 66].map(isBlack)).toEqual([false, true, false, true, false, false, true]);
  });
});

describe("раскладка клавиатуры", () => {
  it("88 клавиш: 52 белые и 36 чёрных", () => {
    const keys = keyboardLayout(21, 108);
    expect(keys).toHaveLength(88);
    expect(keys.filter((k) => !k.black)).toHaveLength(52);
    expect(keys.filter((k) => k.black)).toHaveLength(36);
  });

  it("белые клавиши заполняют ширину без зазоров", () => {
    const whites = keyboardLayout(48, 72).filter((k) => !k.black);
    whites.forEach((k, i) => i > 0 && expect(k.x).toBeCloseTo(whites[i - 1].x + whites[i - 1].width));
    const last = whites[whites.length - 1];
    expect(last.x + last.width).toBeCloseTo(1);
  });

  it("чёрная клавиша лежит между соседними белыми", () => {
    const keys = keyboardLayout(60, 72);
    const cSharp = keys.find((k) => k.note === 61)!;
    const c = keys.find((k) => k.note === 60)!;
    const d = keys.find((k) => k.note === 62)!;
    expect(cSharp.x).toBeGreaterThan(c.x);
    expect(cSharp.x + cSharp.width).toBeLessThan(d.x + d.width);
  });

  it("диапазон расширяется до белых клавиш", () => {
    const keys = keyboardLayout(61, 70);
    expect(Math.min(...keys.map((k) => k.note))).toBe(60);
    expect(Math.max(...keys.map((k) => k.note))).toBe(71);
  });
});
