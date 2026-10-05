import { beforeAll, describe, expect, it } from "vitest";
import createVerovioModule from "verovio/wasm";
import { VerovioToolkit } from "verovio/esm";
import { BASS_STYLES, bassAccompaniment, bassLine, bassLineSong, DEFAULT_BASS_ACCOMP, quarterBeats } from "./bassline";
import { BUILTIN_SONGS, newSong, type LeadSong } from "./songs";
import { TUNINGS } from "./guitar";
import { partChart, songAccompaniment } from "./tabsong";
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

const song = (chords: string, extra: Partial<LeadSong> = {}): LeadSong => ({ ...newSong("t"), chords, ...extra });
const pcs = (ps: number[]) => ps.map((p) => p % 12);

describe("басовая линия", () => {
  it("основной тон на каждую долю; у «C/E» — нижняя нота E; бас в нижней октаве", () => {
    const line = bassLine(song("C | G/B | Am | F"), "roots");
    expect(line).toHaveLength(16);
    expect(pcs(line.map((n) => n.pitch))).toEqual([0, 0, 0, 0, 11, 11, 11, 11, 9, 9, 9, 9, 5, 5, 5, 5]);
    expect(Math.min(...line.map((n) => n.pitch))).toBeGreaterThanOrEqual(28);
    expect(Math.max(...line.map((n) => n.pitch))).toBeLessThanOrEqual(42);
    // Буква аккорда — над первой нотой отрезка.
    expect(line.filter((n) => n.chord).map((n) => n.chord)).toEqual(["C", "G/B", "Am", "F"]);
  });

  it("тон — квинта и октавы", () => {
    const rf = bassLine(song("C | G"), "rootfifth").map((n) => n.pitch);
    expect(rf.slice(0, 4)).toEqual([rf[0], rf[0] + 7, rf[0], rf[0] + 7]);
    const oct = bassLine(song("Am"), "octaves");
    expect(oct).toHaveLength(8);
    expect(oct.map((n) => n.pitch - oct[0].pitch)).toEqual([0, 12, 0, 12, 0, 12, 0, 12]);
    expect(oct.every((n) => n.len === 2)).toBe(true);
  });

  it("проходящие и walking: перед сменой — нота на полтона к следующему основному тону", () => {
    for (const style of ["passing", "walking"] as const) {
      const line = bassLine(song("C | F | G | C"), style);
      for (let b = 0; b < 3; b++) {
        const last = line.filter((n) => n.bar === b).at(-1)!;
        const nextRoot = line.find((n) => n.bar === b + 1)!.pitch;
        expect(Math.abs(last.pitch - nextRoot), `${style} такт ${b + 1}`).toBe(1);
      }
      // Walking: каждая доля — новая нота.
      if (style === "walking") line.slice(1).forEach((n, i) => expect(n.pitch, `${i}`).not.toBe(line[i].pitch));
    }
  });

  it("два аккорда в такте и 3/4 с затактом: отрезки по долям", () => {
    const two = bassLine(song("C G | Am"), "roots");
    expect(pcs(two.slice(0, 4).map((n) => n.pitch))).toEqual([0, 0, 7, 7]);
    const birthday = BUILTIN_SONGS.find((s) => s.id === "builtin-birthday")!;
    const line = bassLine(birthday, "roots");
    expect(line.filter((n) => n.bar === 0)).toHaveLength(3);
    expect(quarterBeats(birthday)).toBe(3);
  });

  it("все стили для всех встроенных песен пишутся табами и звучат как модель", () => {
    for (const s of BUILTIN_SONGS)
      for (const st of BASS_STYLES) {
        const ts = bassLineSong(s, st.id, TUNINGS.bass);
        const { notes, log } = play(partChart(ts, 0).mei);
        expect(log, `${s.id} ${st.id}`).not.toMatch(/\[Error\]/);
        const model = songAccompaniment({ ...ts, parts: [ts.parts[0]] }, -1);
        expect(notes.map((n) => n.pitch), `${s.id} ${st.id}`).toEqual(model.map((n) => n.pitch));
        // Лады — в пределах грифа.
        for (const b of ts.parts[0].staves[0].bars.flat(2)) for (const n of b.notes) expect(n.fret!).toBeLessThanOrEqual(15);
      }
  });

  it("аккомпанемент: барабаны и аккорды со своей громкостью; без аккордов — только барабаны", () => {
    const s = BUILTIN_SONGS[0];
    const ts = bassLineSong(s, "roots", TUNINGS.bass);
    expect(ts.parts.map((p) => p.kind)).toEqual(["bass", "drums", "piano"]);
    const acc = bassAccompaniment(ts, { ...DEFAULT_BASS_ACCOMP, drumsVolume: 100, chordsVolume: 50 });
    expect(new Set(acc.filter((n) => n.channel === 9).map((n) => n.velocity))).toEqual(new Set([127]));
    expect(new Set(acc.filter((n) => n.channel !== 9).map((n) => n.velocity))).toEqual(new Set([64]));
    const guitar = bassLineSong(s, "roots", TUNINGS.bass, { ...DEFAULT_BASS_ACCOMP, chords: "guitar" });
    expect(guitar.parts[2].program).toBe(25);
    const bare = bassLineSong(s, "roots", TUNINGS.bass, { ...DEFAULT_BASS_ACCOMP, chords: "none", drums: true });
    expect(bare.parts.map((p) => p.kind)).toEqual(["bass", "drums"]);
  });
});
