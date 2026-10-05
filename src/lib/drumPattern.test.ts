import { describe, expect, it } from "vitest";
import { patternBar, patternPart } from "./drumPattern";
import { TPQ } from "./tabsong";
import { firstAtOrAfter } from "../components/Waterfall";

describe("барабанные узоры", () => {
  it("такт из узоров: удары по шестнадцатым, одновременные — одной долей", () => {
    const bar = patternBar(["k:x.......x.......", "h:x.x.x.x.x.x.x.x."]);
    expect(bar).toHaveLength(8);
    expect(bar[0]).toMatchObject({ tick: 0, dur: TPQ / 4 });
    expect(bar[0].notes.map((n) => n.pitch)).toEqual([36, 42]);
    expect(bar[4].tick).toBe(8 * (TPQ / 4));
  });

  it("такт 3/4 (12 клеток) обрезает длинный узор; партия повторяет узоры по кругу", () => {
    expect(patternBar(["s:....x...x...x..."], 12).map((b) => b.tick / (TPQ / 4))).toEqual([4, 8]);
    const part = patternPart([["k:x..............."], ["s:x..............."]], 3);
    expect(part.kind).toBe("drums");
    expect(part.staves[0].bars.map((b) => b[0][0].notes[0].pitch)).toEqual([36, 38, 36]);
  });
});

describe("окно падающих нот", () => {
  it("первая нота с началом не раньше заданного момента", () => {
    const notes = [0, 100, 100, 250, 400].map((startMs) => ({ startMs }));
    expect(firstAtOrAfter(notes, -50)).toBe(0);
    expect(firstAtOrAfter(notes, 100)).toBe(1);
    expect(firstAtOrAfter(notes, 101)).toBe(3);
    expect(firstAtOrAfter(notes, 1000)).toBe(5);
    expect(firstAtOrAfter([], 0)).toBe(0);
  });
});
