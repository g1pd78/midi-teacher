import { describe, expect, it } from "vitest";
import { nearestString, TUNINGS } from "./guitar";

const hz = (midi: number, cents = 0) => 440 * 2 ** ((midi - 69 + cents / 100) / 12);

describe("тюнер: ближайшая струна", () => {
  it("гитара: ми большой октавы чуть ниже строя", () => {
    expect(nearestString(hz(40, -12), TUNINGS.guitar)).toEqual({ index: 0, cents: expect.closeTo(-12, 1) });
  });
  it("гитара: си и высокая ми", () => {
    expect(nearestString(hz(59, 3), TUNINGS.guitar).index).toBe(4);
    expect(nearestString(hz(64), TUNINGS.guitar).index).toBe(5);
  });
  it("бас: ля контроктавы, соль на октаву выше строя — ближайшая соль", () => {
    expect(nearestString(hz(33, 20), TUNINGS.bass)).toEqual({ index: 1, cents: expect.closeTo(20, 1) });
    expect(nearestString(hz(45), TUNINGS.bass).index).toBe(3);
  });
});
