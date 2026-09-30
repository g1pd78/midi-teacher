import { describe, expect, it } from "vitest";
import { levelPreset, levelTempo, measureHands, minutesByDay, phraseEnds, rhythmAccuracy, unitLabel, waitAccuracy } from "./practice";
import type { MeiStructure, ScoreNote } from "./score";

function note(measure: number, startMs: number, durMs: number, hand: "right" | "left" = "right"): ScoreNote {
  return { id: `n${measure}-${startMs}-${hand}`, pitch: 60, startMs, durMs, hand, measure, staff: hand === "right" ? 1 : 2 };
}

function structure(measures: number, sectionEnds: number[] = []): MeiStructure {
  return {
    staffOf: new Map(),
    measureOf: new Map(),
    fingerOf: new Map(),
    tieEndToStart: new Map(),
    staves: 2,
    clefOf: new Map(),
    measures,
    measureIds: [],
    meter: { count: 4, unit: 4 },
    sectionEnds,
  };
}

describe("phraseEnds", () => {
  // Такт = 2000 мс (4 четверти по 500).
  const starts = [0, 2000, 4000, 6000, 8000];
  it("долгая нота и пауза в конце такта заканчивают фразу", () => {
    const notes = [
      // 1: четыре четверти
      ...[0, 500, 1000, 1500].map((t) => note(1, t, 500)),
      // 2: две четверти и половинная
      note(2, 2000, 500),
      note(2, 2500, 500),
      note(2, 3000, 1000),
      // 3: две четверти и пауза
      note(3, 4000, 500),
      note(3, 4500, 500),
      // 4: четверти
      ...[6000, 6500, 7000, 7500].map((t) => note(4, t, 500)),
      // 5: четверти
      ...[8000, 8500, 9000, 9500].map((t) => note(5, t, 500)),
    ];
    expect(phraseEnds(notes, structure(5), starts, 10000)).toEqual([2, 3, 5]);
  });

  it("двойная черта из MEI и последний такт", () => {
    const notes = [0, 2000, 4000].map((t, i) => [0, 500, 1000, 1500].map((d) => note(i + 1, t + d, 500))).flat();
    expect(phraseEnds(notes, structure(3, [1]), [0, 2000, 4000], 6000)).toEqual([1, 3]);
  });
});

describe("helpers", () => {
  it("маска рук по тактам", () => {
    expect(measureHands([note(1, 0, 1), note(2, 0, 1, "left"), note(2, 5, 1)], 3)).toEqual([1, 3, 0]);
  });

  it("точность как в ядре", () => {
    expect(waitAccuracy(0, 2)).toBe(1);
    expect(waitAccuracy(19, 1)).toBeCloseTo(0.95);
    expect(rhythmAccuracy(10, 10, 10)).toBeCloseTo(0.5);
  });

  it("пресеты уровней убирают подсказки по порядку", () => {
    expect(levelPreset(0).mode).toBe("rhythm");
    expect(levelPreset(1)).toMatchObject({ mode: "wait", names: true, keyHints: true });
    expect(levelPreset(2)).toMatchObject({ mode: "wait", names: false, keyHints: true });
    expect(levelPreset(3)).toMatchObject({ mode: "rhythm", keyHints: false, waterfall: false, hide: false });
    expect(levelPreset(4)).toMatchObject({ hide: true, waterfall: false });
    expect(levelTempo(3, 0.7)).toBe(0.7);
    expect(levelTempo(4, 0.7)).toBe(1);
  });

  it("подписи отрезков", () => {
    expect(unitLabel([0, 0])).toBe("1");
    expect(unitLabel([0, 1])).toBe("1+2");
    expect(unitLabel([0, 2])).toBe("1–3");
  });

  it("минуты по дням в местном времени", () => {
    const now = new Date(2026, 8, 30, 12, 0);
    const today = new Date(2026, 8, 30, 9, 0).getTime() / 1000;
    const yesterday = new Date(2026, 8, 29, 23, 45).getTime() / 1000;
    const days = minutesByDay(
      [
        [today, 600],
        [today + 900, 300],
        [yesterday, 120],
      ],
      3,
      now,
    );
    expect(days.map((d) => d.minutes)).toEqual([0, 2, 15]);
    expect(days[2].key).toBe("2026-09-30");
  });
});
