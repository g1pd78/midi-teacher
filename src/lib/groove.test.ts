import { describe, expect, it } from "vitest";
import { grooveStats, grooveTendency, slotLabel, worstSlot } from "./groove";
import type { ScoreNote } from "./score";

const note = (id: string, startMs: number): ScoreNote => ({ id, pitch: 40, startMs, durMs: 100, hand: "right", measure: 1, staff: 1 });

describe("грув", () => {
  it("места в такте: доли, «и», шестнадцатые и триоли", () => {
    expect([0, 6, 3, 4, 12, 18, 36].map(slotLabel)).toEqual(["1", "и", "·", "·", "2", "и", "4"]);
  });

  it("среднее со знаком, разброс и отклонения по местам; второй такт ложится на те же места", () => {
    // 120 уд/мин: доля 500 мс. Ноты на 1, «и» первой доли, 3; второй такт — так же.
    const notes = [0, 250, 1000, 2000, 2250, 3000].map((t, i) => note(`n${i}`, t));
    const deltas = [10, 50, 10, 10, 50, 10];
    const g = grooveStats(
      notes.map((n, i) => ({ id: n.id, deltaMs: deltas[i], velocity: 80 })),
      notes,
      500,
      4,
    )!;
    expect(g.meanMs).toBe(23);
    expect(g.sdMs).toBe(19);
    expect(g.slots.map((s) => [s.label, s.meanMs, s.count])).toEqual([
      ["1", 10, 2],
      ["и", 50, 2],
      ["3", 10, 2],
    ]);
    expect(grooveTendency(g)).toBe("В среднем на 23 мс позже барабанов.");
    expect(worstSlot(g)?.label).toBe("и");
  });

  it("раньше барабанов и «вместе»; без попаданий — нет оценки", () => {
    const notes = [note("a", 0), note("b", 500)];
    expect(grooveTendency(grooveStats([{ id: "a", deltaMs: -30, velocity: 1 }, { id: "b", deltaMs: -20, velocity: 1 }], notes, 500, 4)!)).toBe(
      "В среднем на 25 мс раньше барабанов.",
    );
    expect(grooveTendency(grooveStats([{ id: "a", deltaMs: 5, velocity: 1 }], notes, 500, 4)!)).toMatch(/^Вместе/);
    expect(grooveStats([], notes, 500, 4)).toBeNull();
  });

  it("шаффл: вторая восьмая триолью — своё место, не «и»", () => {
    const notes = [note("a", 0), note("b", 333.3)];
    const g = grooveStats([{ id: "a", deltaMs: 0, velocity: 1 }, { id: "b", deltaMs: 0, velocity: 1 }], notes, 500, 4)!;
    expect(g.slots.map((s) => s.slot)).toEqual([0, 8]);
  });
});
