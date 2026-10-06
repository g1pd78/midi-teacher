import { describe, expect, it } from "vitest";
import { DRUM_EXERCISE_BY_ID, DRUM_EXERCISES } from "../drums";
import { EXERCISES, midiOf } from "../exercises";
import { JAM_STYLES } from "../jam";
import { BUILTIN_SONGS } from "../songs";
import { evalCode } from "./evaluate";
import { drumScoreToCode, exerciseToCode, jamStyleToCode, leadSongToCode, strudelChord } from "./fromApp";
import { patternNotes } from "./haps";
import { evalInfo } from "./mt";

describe("своё из приложения → код", () => {
  it("аккорды — как понимает voicing()", () => {
    expect(strudelChord("Cmaj7")).toBe("C^7");
    expect(strudelChord("Bdim")).toBe("Bo");
    expect(strudelChord("Dsus4")).toBe("Dsus");
    expect(strudelChord("Am7")).toBe("Am7");
  });

  it("рок-бит: бочка, малый и хэт на своих местах", async () => {
    const ex = DRUM_EXERCISE_BY_ID.get("drum-groove-rock")!;
    const code = drumScoreToCode(ex.build(), ex.title);
    const r = await evalCode(code);
    expect(r.cps).toBeCloseTo(80 / 60 / 4);
    const ns = patternNotes(r.pattern, 0, 1);
    expect(ns.filter((n) => n.s === "bd").map((n) => n.begin)).toEqual([0, 0.5]);
    expect(ns.filter((n) => n.s === "sd").map((n) => n.begin)).toEqual([0.25, 0.75]);
    expect(ns.filter((n) => n.s === "hh")).toHaveLength(8);
  });

  it("все грувы и рудименты выполняются и дают удары", async () => {
    for (const ex of DRUM_EXERCISES) {
      const r = await evalCode(drumScoreToCode(ex.build(), ex.title));
      expect(patternNotes(r.pattern, 0, 1).length, ex.id).toBeGreaterThan(0);
    }
  });

  it("песни по буквам: мелодия — те же ноты, аккорды звучат", async () => {
    for (const song of BUILTIN_SONGS) {
      const code = leadSongToCode(song);
      const r = await evalCode(code);
      const cycles = 64;
      const melody = patternNotes(r.parts.melody, 0, cycles).filter((n) => n.begin < cycles);
      const expected = song.melody.length;
      // Мелодия занимает меньше 64 тактов — паттерн повторяется; берём первые ноты.
      expect(melody.slice(0, expected).map((n) => n.midi), song.id).toEqual(song.melody.map((n) => n.pitch));
      expect(patternNotes(r.parts.chords, 0, 2).length, song.id).toBeGreaterThan(0);
    }
  });

  it("стили джема: партии и гармония для импровизации", async () => {
    for (const st of JAM_STYLES) {
      const r = await evalCode(jamStyleToCode(st, st.tonic));
      expect(Object.keys(r.parts), st.id).toEqual(["drums", "bass", "comp"]);
      expect(evalInfo().harmony?.scale, st.id).toBeTruthy();
      expect(patternNotes(r.parts.comp, 0, 2).length, st.id).toBeGreaterThan(0);
    }
  });

  it("упражнение: руки — мои партии с нотами упражнения", async () => {
    const ex = EXERCISES.find((e) => e.id.includes("five") || e.category === "five")!;
    const score = ex.build();
    const r = await evalCode(exerciseToCode(score, ex.title));
    const hand = score.right ? "right" : "left";
    const want = (score.right ?? score.left)!.map((n) => midiOf(n.pitch));
    const got = patternNotes(r.parts[hand], 0, 64).map((n) => n.midi).slice(0, want.length);
    expect(got).toEqual(want);
    expect(patternNotes(r.pattern, 0, 1).filter((n) => n.part === hand).every((n) => n.you)).toBe(true);
  });
});
