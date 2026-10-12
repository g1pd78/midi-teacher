import { describe, expect, it } from "vitest";
import { FingerTally, LATE_MS, fingerByDay, fingerSummaryText, measuresText, type ExpectedNote } from "./fingers";

const note = (id: string, pitch: number, finger: number | null, measure = 1, hand: "right" | "left" = "right"): ExpectedNote => ({
  id,
  pitch,
  hand,
  finger,
  measure,
});

describe("сверка пальцев", () => {
  it("верно и не тот палец, путаницы с тактами", () => {
    const t = new FingerTally();
    t.setStep([note("a", 60, 1)], 0);
    expect(t.judge({ pitch: 60, finger: 1 }, 10)?.ok).toBe(true);
    t.setStep([note("b", 62, 4, 5)], 100);
    expect(t.judge({ pitch: 62, finger: 3 }, 110)).toMatchObject({ ok: false, played: 3 });
    t.setStep([note("c", 64, 4, 6)], 200);
    expect(t.judge({ pitch: 64, finger: 3 }, 210)?.ok).toBe(false);
    t.setStep([note("d", 65, 2, 7)], 300);
    expect(t.judge({ pitch: 65, finger: 1 }, 310)?.ok).toBe(false);
    const s = t.summary();
    expect(s).toMatchObject({ correct: 1, total: 4 });
    expect(s.confusions[0]).toEqual({ expected: 4, played: 3, count: 2, measures: [5, 6] });
    expect(fingerSummaryText(s)).toBe("Пальцы: 25% верно, чаще всего 3 вместо 4 — такты 5–6");
  });

  it("запоздавшее сообщение засчитывается прошлому шагу, но не позже LATE_MS", () => {
    const t = new FingerTally();
    t.setStep([note("a", 60, 1)], 0);
    t.setStep([note("b", 62, 2)], 100);
    expect(t.judge({ pitch: 60, finger: 1 }, 300)?.note.id).toBe("a");
    t.setStep([note("c", 64, 3)], 400);
    t.setStep([note("d", 65, 4)], 500);
    expect(t.judge({ pitch: 64, finger: 3 }, 500 + LATE_MS + 1)).toBeNull();
  });

  it("одна нота — одно сообщение; без аппликатуры и чужие клавиши не считаются", () => {
    const t = new FingerTally();
    t.setStep([note("a", 60, 1), note("b", 67, null)], 0);
    expect(t.judge({ pitch: 60, finger: 1 }, 1)).not.toBeNull();
    expect(t.judge({ pitch: 60, finger: 2 }, 2)).toBeNull();
    expect(t.judge({ pitch: 67, finger: 5 }, 3)).toBeNull();
    expect(t.judge({ pitch: 70, finger: 5 }, 4)).toBeNull();
    expect(t.summary().total).toBe(1);
  });

  it("аккорд обеими руками: рука выбирает ноту, чужая рука — ошибка", () => {
    const t = new FingerTally();
    t.setStep([note("l", 48, 5, 1, "left"), note("r", 48 + 12, 1, 1, "right")], 0);
    expect(t.judge({ pitch: 48, finger: 5, hand: "left" }, 1)?.ok).toBe(true);
    t.setStep([note("x", 60, 1, 2, "right")], 10);
    expect(t.judge({ pitch: 60, finger: 1, hand: "left" }, 11)?.ok).toBe(false);
  });

  it("повтор после отклонения снова сверяется", () => {
    const t = new FingerTally();
    t.setStep([note("a", 60, 2)], 0);
    expect(t.judge({ pitch: 60, finger: 3 }, 1)?.ok).toBe(false);
    t.retry("a");
    expect(t.judge({ pitch: 60, finger: 2 }, 2)?.ok).toBe(true);
    expect(t.summary()).toMatchObject({ correct: 1, total: 2 });
  });

  it("проходы цикла: те же ноты снова сверяются, запоздавшее — в счёт своего прохода", () => {
    const t = new FingerTally();
    t.setStep([note("a", 60, 1)], 0);
    t.judge({ pitch: 60, finger: 1 }, 1);
    t.setStep([note("b", 62, 2)], 10);
    const first = t.endPass(20);
    t.setStep([note("a", 60, 1)], 30);
    t.judge({ pitch: 62, finger: 3 }, 40);
    t.judge({ pitch: 60, finger: 2 }, 50);
    expect(t.summary(first)).toMatchObject({ correct: 1, total: 2 });
    expect(t.summary()).toMatchObject({ correct: 0, total: 1 });
  });

  it("подписи тактов и дни", () => {
    expect(measuresText([3])).toBe("такт 3");
    expect(measuresText([9, 2, 5])).toBe("такты 2, 5, 9");
    expect(fingerSummaryText({ correct: 0, total: 0, confusions: [] })).toBe("");
    const day = (d: number, h: number) => new Date(2026, 9, d, h).getTime() / 1000;
    expect(
      fingerByDay([
        { at: day(12, 10), correct: 9, total: 10 },
        { at: day(12, 9), correct: 7, total: 10 },
        { at: day(11, 9), correct: 1, total: 2 },
        { at: day(10, 9), correct: 0, total: 0 },
      ]),
    ).toEqual([
      { day: "12.10", pct: 80 },
      { day: "11.10", pct: 50 },
    ]);
  });
});
