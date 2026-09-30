import { describe, expect, it } from "vitest";
import { stepAt, transportPos } from "./transport";

describe("транспорт", () => {
  it("позиция с учётом темпа", () => {
    const t = { originUs: 1_000_000, pos0: 1800, tempo: 0.5 };
    expect(transportPos(t, 1_000_000)).toBe(1800);
    expect(transportPos(t, 3_000_000)).toBe(2800); // 2 с реального времени при 50% = 1 с пьесы
    expect(transportPos(t, 0)).toBe(1300); // до начала — отрицательный сдвиг (отсчёт)
  });

  it("шаг по времени", () => {
    const onsets = [0, 600, 900, 1200];
    expect(stepAt(onsets, -50)).toBe(-1);
    expect(stepAt(onsets, 0)).toBe(0);
    expect(stepAt(onsets, 899)).toBe(1);
    expect(stepAt(onsets, 900)).toBe(2);
    expect(stepAt(onsets, 99999)).toBe(3);
    expect(stepAt([], 10)).toBe(-1);
  });
});
