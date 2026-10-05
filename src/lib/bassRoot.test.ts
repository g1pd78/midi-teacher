import { describe, expect, it } from "vitest";
import { ROOT_LEVELS, checkPitch, romanChord, rootAccompaniment, rootOk, rootSession, rootUnlocked, scoreRoot } from "./bassRoot";
import type { ExerciseStatView } from "./exercises";

const stat = (exercise: string): ExerciseStatView => ({ exercise, attempts: 1, passed: true, bestAccuracy: 1, lastAt: 0, lastTimingSdMs: 0, lastLoudness: 1 });

describe("найди основной тон", () => {
  it("ступени: аккорды тональности по ступеням", () => {
    expect(["I", "V", "vi", "IV", "ii"].map((r) => romanChord(9, r))).toEqual(["A", "E", "F#m", "D", "Bm"]);
    expect(romanChord(5, "IV")).toBe("Bb");
  });

  it("серия: три круга по такту на аккорд; два аккорда в такте — четыре круга по две доли", () => {
    const s1 = rootSession(ROOT_LEVELS[1], 3);
    expect(s1.chords).toHaveLength(12);
    expect(s1.chords.map((c) => c.beat).slice(0, 3)).toEqual([0, 4, 8]);
    expect(s1.checks).toHaveLength(12);
    expect(s1.bars).toBe(12);
    const s4 = rootSession(ROOT_LEVELS[3], 3);
    expect(s4.chords.map((c) => c.beat).slice(0, 3)).toEqual([0, 2, 4]);
    expect(s4.bars).toBe(8);
    // Звуки аккорда: на каждую долю проверка, на «раз» — основной тон.
    const s5 = rootSession(ROOT_LEVELS[4], 3);
    expect(s5.checks).toHaveLength(48);
    expect(s5.checks.slice(0, 4).map((c) => c.kind)).toEqual(["root", "tone", "tone", "tone"]);
  });

  it("проверка: основной тон в любой октаве; у «C/E» — бас E; звук аккорда", () => {
    expect(rootOk({ beat: 0, symbol: "Am", kind: "root" }, 33)).toBe(true);
    expect(rootOk({ beat: 0, symbol: "Am", kind: "root" }, 57)).toBe(true);
    expect(rootOk({ beat: 0, symbol: "Am", kind: "root" }, 36)).toBe(false);
    expect(rootOk({ beat: 0, symbol: "C/E", kind: "root" }, 40)).toBe(true);
    expect(rootOk({ beat: 0, symbol: "Am", kind: "tone" }, 36)).toBe(true);
    expect(rootOk({ beat: 0, symbol: "Am", kind: "tone" }, 38)).toBe(false);
  });

  it("итог: первая нота в окне доли; рано, поздно и мимо", () => {
    const s = { chords: [], key: "C", bars: 1, checks: [0, 1, 2, 3].map((beat) => ({ beat, symbol: "C", kind: "root" as const })) };
    const res = scoreRoot(
      s,
      [
        { t: -100, pitch: 36 }, // чуть раньше — верно
        { t: 1000 + 250, pitch: 38 }, // поздно, но в окне — не та нота
        { t: 1000 + 280, pitch: 36 }, // вторая нота в окне не считается
        { t: 3000 + 400, pitch: 36 }, // за окном
      ],
      1000,
    );
    expect(res).toEqual([true, false, null, null]);
  });

  it("аккомпанемент: отсчёт, барабаны на 9-м канале, аккорды без баса; подсказка — основной тон внизу", () => {
    const s = rootSession(ROOT_LEVELS[0], 1);
    const a = rootAccompaniment(s, 60, { chords: "piano", drums: true, chordsVolume: 50, drumsVolume: 100 });
    expect(a.firstBeatMs).toBe(4000);
    expect(a.notes.filter((n) => n.startMs < 4000).every((n) => n.channel === 9)).toBe(true);
    const chordNotes = a.notes.filter((n) => n.channel === 0);
    expect(Math.min(...chordNotes.map((n) => n.pitch))).toBeGreaterThanOrEqual(55);
    expect(chordNotes.every((n) => n.velocity === 64)).toBe(true);
    expect(Math.max(...a.notes.map((n) => n.startMs))).toBeGreaterThan(4000 + (s.bars - 1) * 4000);
    expect(checkPitch({ beat: 0, symbol: "A", kind: "root" })).toBe(33);
    expect(checkPitch({ beat: 0, symbol: "C", kind: "tone" })).toBe(28 + ((4 - 28 + 48) % 12));
  });

  it("ступени открываются по порядку", () => {
    expect(rootUnlocked([])).toBe(1);
    expect(rootUnlocked([stat("bassroot-1"), stat("bassroot-2")])).toBe(3);
  });
});
