import { describe, expect, it } from "vitest";
import { accompNotes, hasPlayable, instrumentName, keyName, overrideFor, recordingName, toggleOverride } from "./midi";

describe("импорт MIDI в интерфейсе", () => {
  it("названия инструментов General MIDI", () => {
    expect(instrumentName({ program: 0, drums: false })).toBe("Рояль");
    expect(instrumentName({ program: 42, drums: false })).toBe("Виолончель");
    expect(instrumentName({ program: 50, drums: false })).toBe("Ансамбль");
    expect(instrumentName({ program: null, drums: false })).toBe("Фортепиано");
    expect(instrumentName({ program: 0, drums: true })).toBe("Ударные");
  });

  it("на стане должна быть хотя бы одна дорожка", () => {
    expect(hasPlayable(["accompany", "off"])).toBe(false);
    expect(hasPlayable(["off", "both"])).toBe(true);
  });

  it("тональности", () => {
    expect(keyName(0, false)).toBe("до мажор");
    expect(keyName(-1, true)).toBe("ре минор");
    expect(keyName(3, false)).toBe("ля мажор");
  });

  it("правка руки: доли сетки до обрезки и высота до транспонирования", () => {
    // 120 уд/мин: четверть = 500 мс = 12 долей; обрезано 48 долей (такт 4/4); тон +2.
    const o = overrideFor({ startMs: 750, pitch: 62, hand: "left" }, 120, 48, 2);
    expect(o).toEqual({ start: 18 + 48, pitch: 60, hand: "right" });
  });

  it("повторный клик по ноте снимает правку", () => {
    const o = { start: 12, pitch: 60, hand: "left" as const };
    const once = toggleOverride([], o);
    expect(once).toEqual([o]);
    // На стане нота теперь в левой руке; клик даёт правку «в правую» для той же ноты — снимает прежнюю.
    expect(toggleOverride(once, { ...o, hand: "right" })).toEqual([]);
    expect(toggleOverride(once, { start: 24, pitch: 60, hand: "left" })).toHaveLength(2);
  });

  it("аккомпанемент — ноты приложения", () => {
    const [n] = accompNotes([{ pitch: 55, startMs: 100, durMs: 400, measure: 2, channel: 9, program: null }]);
    expect(n).toEqual({ id: "acc0", pitch: 55, startMs: 100, durMs: 400, hand: "accomp", measure: 2, channel: 9, program: null, velocity: null });
    expect(accompNotes([{ pitch: 55, startMs: 0, durMs: 1, measure: 1, channel: 2, program: 0, velocity: 40 }])[0].velocity).toBe(40);
  });

  it("имя файла записи", () => {
    expect(recordingName(new Date(2026, 8, 30, 14, 5))).toBe("Запись 30.09 14-05");
  });
});
