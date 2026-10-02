import { describe, expect, it } from "vitest";
import type { SongNote } from "../api";
import { addTake, barMs, mergePunch, newSong, newTrack, placedNotes, position, quantize, takeAccuracy } from "./studio";

const n = (startMs: number, pitch = 60): SongNote => ({ startMs, durMs: 200, pitch, velocity: 90 });

describe("студия", () => {
  it("сетка как в ядре: восьмые, сила, триоли", () => {
    expect(quantize(260, 120, 8, 1)).toBe(250);
    expect(quantize(260, 120, 8, 0.5)).toBe(255);
    expect(quantize(260, 120, 0, 1)).toBe(260);
    expect(quantize(160, 120, 12, 1)).toBeCloseTo(500 / 3);
  });

  it("позиция: такт и доля", () => {
    const s = newSong("т", 120, [4, 4], 8);
    expect(barMs(s)).toBe(2000);
    expect(position(s, 0)).toEqual({ bar: 1, beat: 1 });
    expect(position(s, 2600)).toEqual({ bar: 2, beat: 2 });
  });

  it("перезапись куска заменяет ноты только внутри", () => {
    const merged = mergePunch([n(0), n(1000), n(2500)], [n(1100, 62), n(3000, 64)], 900, 2000);
    expect(merged.map((x) => [x.startMs, x.pitch])).toEqual([
      [0, 60],
      [1100, 62],
      [2500, 60],
    ]);
  });

  it("точность к оригиналу: верные, лишние, пропущенные", () => {
    const orig = [n(0), n(500, 62), n(1000, 64), n(1500, 65)];
    expect(takeAccuracy(orig, orig)).toBe(1);
    // Три верные (одна чуть позже), одна не та нота: 3 / (4 + 1).
    expect(takeAccuracy([n(10), n(560, 62), n(1000, 64), n(1500, 67)], orig)).toBeCloseTo(3 / 5);
    // Только кусок 900–2000.
    expect(takeAccuracy([n(1000, 64), n(1500, 65)], orig, [900, 2000])).toBe(1);
  });

  it("новый дубль: с куском — склейка, точность, длина трека растёт", () => {
    let s = newSong("т", 120, [4, 4], 2);
    const t = newTrack("keys", []);
    s = { ...s, tracks: [{ ...t, takes: [{ id: "o", name: "Оригинал", notes: [n(0), n(2000), n(4000)], cc: [], accuracy: null, original: true }] }] };
    s = addTake(s, 0, { notes: [n(0), n(2050), n(6100)], cc: [] }, null);
    expect(s.tracks[0].takes).toHaveLength(2);
    expect(s.tracks[0].active).toBe(1);
    expect(s.tracks[0].takes[1].name).toBe("Дубль 1");
    expect(s.bars).toBe(4);
    // Перезапись такта 2 (2000–4000 мс) в выбранном дубле.
    s = addTake(s, 0, { notes: [n(2010, 62)], cc: [] }, [2, 2]);
    const last = s.tracks[0].takes[2];
    expect(last.name).toBe("Дубль 2 (такты 2–2)");
    expect(last.notes.map((x) => x.pitch)).toEqual([60, 62, 60]);
    expect(last.accuracy).toBe(0);
  });

  it("ноты с сеткой дорожки", () => {
    const s = newSong("т", 120, [4, 4], 2);
    const t = { ...newTrack("bass", []), grid: 8, takes: [{ id: "1", name: "Дубль 1", notes: [n(260, 36)], cc: [], accuracy: null, original: false }] };
    expect(placedNotes(s, t)[0].startMs).toBe(250);
    expect(t.program).toBe(33);
  });
});
