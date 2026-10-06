import { beforeAll, describe, expect, it } from "vitest";
import createVerovioModule from "verovio/wasm";
import { VerovioToolkit } from "verovio/esm";
import { STRUM_BY_ID, STRUM_PATTERNS, missingShapes, patternsFor, songStrumBars, strumSong } from "./strum";
import { BUILTIN_SONGS } from "./songs";
import { partChart, songAccompaniment, type TabSong } from "./tabsong";
import { TUNINGS } from "./guitar";
import { buildNotes, parseMei, timemapNoteIds, type MidiValues, type TimemapEntry } from "./score";

type Tk = VerovioToolkit & {
  getMEI(o: object): string;
  renderToTimemap(o: object): TimemapEntry[];
  getMIDIValuesForElement(id: string): { time: number; duration: number; pitch: number };
  getLog(): string;
};
let tk: Tk;
beforeAll(async () => {
  tk = new VerovioToolkit(await createVerovioModule()) as Tk;
}, 60_000);

function play(mei: string) {
  tk.setOptions({ breaks: "none" });
  expect(tk.loadData(mei)).toBeTruthy();
  const out = tk.getMEI({});
  const tm = tk.renderToTimemap({ includeMeasures: true });
  const midi: MidiValues = {};
  for (const id of timemapNoteIds(tm)) midi[id] = tk.getMIDIValuesForElement(id);
  return { notes: buildNotes(tm, midi, parseMei(out)), log: tk.getLog() };
}

const STD = TUNINGS.guitar;
const beatsOf = (s: TabSong) => s.parts[0].staves[0].bars.flat(2);

describe("бой", () => {
  it("четверти вниз по Em: 4 удара в такте, вниз — все 6 струн, стрелка над верхней, длительность — четверть", () => {
    const s = strumSong({ bars: [{ chords: [{ symbol: "Em" }] }], pattern: STRUM_BY_ID.get("quarters")!, bpm: 80, tuning: STD, title: "t" });
    const beats = beatsOf(s);
    expect(beats).toHaveLength(4);
    expect(beats[0].notes.map((n) => n.pitch)).toEqual([40, 47, 52, 55, 59, 64]);
    expect(beats[0].notes[5].techniques).toEqual(["↓"]);
    expect(beats[0]).toMatchObject({ type: 4, dots: 0, chord: "Em" });
    expect(beats[1].chord).toBeUndefined();
    expect(s.parts.map((p) => p.kind)).toEqual(["guitar", "drums"]);
  });

  it("поп ↓ ↓↑ ↑↓↑: удар вверх — верхние 4 струны, длительности по месту", () => {
    const s = strumSong({ bars: [{ chords: [{ symbol: "G" }] }], pattern: STRUM_BY_ID.get("pop")!, bpm: 90, tuning: STD, title: "t" });
    const beats = beatsOf(s);
    expect(beats.map((b) => b.notes[b.notes.length - 1].techniques![0]).join("")).toBe("↓↓↑↑↓↑");
    expect(beats[2].notes.map((n) => n.pitch)).toEqual([50, 55, 59, 67]);
    expect(beats.map((b) => [b.type, b.dots])).toEqual([[4, 0], [8, 0], [4, 0], [8, 0], [8, 0], [8, 0]]);
  });

  it("каждая схема пишется в табы, Verovio играет то же, что модель (ноты и барабаны)", () => {
    for (const p of STRUM_PATTERNS) {
      const s = strumSong({ bars: [{ chords: [{ symbol: "Am" }] }, { chords: [{ symbol: "C" }, { symbol: "G" }] }], pattern: p, bpm: 90, tuning: STD, title: p.name });
      const { notes, log } = play(partChart(s, 0).mei);
      expect(log, p.id).not.toMatch(/\[Error\]/);
      const model = songAccompaniment({ ...s, parts: [s.parts[0]] }, -1);
      expect(notes.length, p.id).toBe(model.length);
      expect([...notes.map((n) => n.pitch)].sort(), p.id).toEqual([...model.map((n) => n.pitch)].sort());
      const drums = songAccompaniment(s, 0);
      expect(drums.every((n) => n.channel === 9) && drums.length > 4, p.id).toBe(true);
    }
  });

  it("песни по буквам боем: аккорды по тактам, схема под размер", () => {
    for (const song of BUILTIN_SONGS) {
      const list = patternsFor(song);
      if (!list.length) continue;
      const bars = songStrumBars(song, list[0]);
      expect(bars.length, song.title).toBeGreaterThan(1);
      expect(missingShapes(bars), song.title).toEqual([]);
      const s = strumSong({ bars, pattern: list[0], bpm: song.bpm, tuning: STD, title: song.title });
      const { log } = play(partChart(s, 0).mei);
      expect(log, song.title).not.toMatch(/\[Error\]/);
    }
    const song = { ...BUILTIN_SONGS[0], chords: "C | Am | F G | C", pickup: 0, beats: 4, unit: 4 as const };
    const bars = songStrumBars(song, STRUM_BY_ID.get("eighths")!);
    expect(bars.map((b) => b.chords.map((c) => c.symbol).join(" "))).toEqual(["C", "Am", "F G", "C"]);
  });
});
