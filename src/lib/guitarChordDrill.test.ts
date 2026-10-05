import { describe, expect, it } from "vitest";
import {
  CHANGE_PAIRS,
  GTR_CHORD_LEVELS,
  accuracyToChanges,
  changeId,
  changesToAccuracy,
  gtrChordLevelId,
  gtrChordSeries,
  gtrChordUnlocked,
  pcNames,
} from "./guitarChordDrill";
import { chordShape, judgeGuitarChord, shapePitches } from "./guitarChords";
import { TUNINGS } from "./guitar";
import type { ExerciseStatView } from "./exercises";

const stat = (exercise: string): ExerciseStatView => ({ exercise, attempts: 1, passed: true, bestAccuracy: 1, lastAt: 0, lastTimingSdMs: 0, lastLoudness: 1 });

describe("тренажёр гитарных аккордов", () => {
  it("у каждого аккорда каждой ступени есть форма, и она звучит как аккорд", () => {
    for (const l of GTR_CHORD_LEVELS)
      for (const it of l.pool) {
        const sh = chordShape(it.symbol, it.form);
        expect(sh, `${l.id}: ${it.symbol} ${it.form ?? ""}`).not.toBeNull();
        expect(judgeGuitarChord(it.symbol, shapePitches(sh!, TUNINGS.guitar)).ok, it.symbol).toBe(true);
      }
  });

  it("серия: 10 аккордов, все аккорды ступени, без повторов подряд", () => {
    for (const l of GTR_CHORD_LEVELS) {
      const s = gtrChordSeries(l, 42);
      expect(s).toHaveLength(10);
      for (let i = 1; i < s.length; i++) expect(s[i].item.symbol, `${l.id}`).not.toBe(s[i - 1].item.symbol);
      if (l.pool.length <= 10) expect(new Set(s.map((x) => x.item.symbol)).size).toBe(new Set(l.pool.map((p) => p.symbol)).size);
    }
  });

  it("ступени открываются по порядку", () => {
    expect(gtrChordUnlocked([])).toBe(1);
    expect(gtrChordUnlocked([stat(gtrChordLevelId(1)), stat(gtrChordLevelId(2))])).toBe(3);
    expect(gtrChordUnlocked([stat(gtrChordLevelId(2))])).toBe(1);
  });

  it("минута смен: id без «#», смены ↔ точность, названия звуков", () => {
    expect(new Set(CHANGE_PAIRS.map(changeId)).size).toBe(CHANGE_PAIRS.length);
    expect(changeId({ a: { symbol: "F#m" }, b: { symbol: "C" } })).toBe("gchange-Fsm-C");
    expect(accuracyToChanges(changesToAccuracy(37))).toBe(37);
    expect(changesToAccuracy(150)).toBe(1);
    expect(pcNames([7, 6])).toBe("соль, фа♯");
  });
});
