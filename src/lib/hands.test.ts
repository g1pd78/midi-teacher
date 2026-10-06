import { describe, expect, it } from "vitest";
import { handFingers, handOfMiss } from "./hands";

const notes: Record<string, { hand: "left" | "right"; finger?: number }> = {
  r1: { hand: "right", finger: 3 },
  r2: { hand: "right", finger: 1 },
  l1: { hand: "left", finger: 5 },
  r3: { hand: "right", finger: 3 },
  r4: { hand: "right" },
  l2: { hand: "left", finger: 2 },
};
const hand = (id: string) => notes[id]?.hand;
const finger = (id: string) => notes[id]?.finger;

describe("схема ладоней", () => {
  it("пальцы шага по рукам, следующий шаг — бледно, без повторов", () => {
    const f = handFingers(["r1", "r2", "l1"], ["r3", "r4", "l2"], hand, finger);
    expect(f.right).toEqual({ next: [1, 3], soon: [] }); // 3-й нужен и сейчас — показан как текущий
    expect(f.left).toEqual({ next: [5], soon: [2] });
  });

  it("сыгранные ноты не подсвечиваются; рука, которая не играет, пуста", () => {
    const f = handFingers(["r1", "r2"], [], (id) => (id === "r2" ? undefined : hand(id)), finger, (id) => id === "r1");
    expect(f.right.next).toEqual([]);
    expect(f.left.next).toEqual([]);
  });

  it("промах — у руки с ближайшей ожидаемой нотой", () => {
    const exp = [
      { pitch: 48, hand: "left" as const },
      { pitch: 72, hand: "right" as const },
    ];
    expect(handOfMiss(50, exp)).toBe("left");
    expect(handOfMiss(70, exp)).toBe("right");
    expect(handOfMiss(55, [])).toBe("left");
    expect(handOfMiss(64, [])).toBe("right");
  });
});
