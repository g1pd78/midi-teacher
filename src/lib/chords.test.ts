import { beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import createVerovioModule from "verovio/wasm";
import { VerovioToolkit } from "verovio/esm";
import { buildNotes, parseMei, timemapNoteIds, type MidiValues, type TimemapEntry } from "./score";
import { chordName, chordNotesText, chordPcs, detectChord, identify, parseChord, voiceLead, voicings } from "./chords";
import { CHORD_LEVELS, chordKeys, chordSeries, chordUnlocked, judgeChord } from "./chordDrill";
import { BUILTIN_SONGS, arrange, barLen, harmsFromMei, parseChart, parseMelody, songFromScore, songMei, splitLen, type LeadSong, type Style } from "./songs";

type Tk = VerovioToolkit & {
  getMEI(o: object): string;
  renderToTimemap(o: object): TimemapEntry[];
  getMIDIValuesForElement(id: string): { time: number; duration: number; pitch: number };
  resetXmlIdSeed(seed: number): void;
};
let tk: Tk;

beforeAll(async () => {
  tk = new VerovioToolkit(await createVerovioModule()) as Tk;
}, 60_000);

function load(data: string) {
  tk.resetXmlIdSeed(1);
  tk.setOptions({ breaks: "none" });
  expect(tk.loadData(data)).toBeTruthy();
  const mei = tk.getMEI({});
  const timemap = tk.renderToTimemap({ includeMeasures: true });
  const midi: MidiValues = {};
  for (const tid of timemapNoteIds(timemap)) midi[tid] = tk.getMIDIValuesForElement(tid);
  const structure = parseMei(mei);
  const notes = buildNotes(timemap, midi, structure);
  return { notes, structure, mei, timemap };
}

describe("аккорды", () => {
  it("разбор обозначений и состав", () => {
    expect(chordPcs(parseChord("C")!)).toEqual([0, 4, 7]);
    expect(chordPcs(parseChord("Am")!)).toEqual([9, 0, 4]);
    expect(chordPcs(parseChord("G7")!)).toEqual([7, 11, 2, 5]);
    expect(chordPcs(parseChord("Fmaj7")!)).toEqual([5, 9, 0, 4]);
    expect(chordPcs(parseChord("Bdim")!)).toEqual([11, 2, 5]);
    expect(chordPcs(parseChord("Caug")!)).toEqual([0, 4, 8]);
    expect(chordPcs(parseChord("Dsus4")!)).toEqual([2, 7, 9]);
    expect(chordPcs(parseChord("Ebm7")!)).toEqual([3, 6, 10, 1]);
    expect(parseChord("C/E")!.bass).toEqual({ letter: "e", alter: 0 });
    expect(parseChord("H7")!.letter).toBe("b");
    expect(parseChord("Xm")).toBeNull();
    expect(parseChord("Cfoo")).toBeNull();
  });

  it("названия и написание звуков", () => {
    expect(chordName(parseChord("Am")!)).toBe("ля минор");
    expect(chordName(parseChord("F#")!)).toBe("фа-диез мажор");
    expect(chordName(parseChord("G7")!)).toBe("соль: доминантсептаккорд");
    expect(chordNotesText(parseChord("Cm")!)).toBe("до · ми♭ · соль");
    expect(chordNotesText(parseChord("F#m")!)).toBe("фа♯ · ля · до♯");
    expect(chordNotesText(parseChord("Bdim")!)).toBe("си · ре · фа");
  });

  it("расположения и плавное голосоведение: C → F → G без скачков", () => {
    const all = voicings([0, 4, 7], 48, 62);
    expect(all).toContainEqual([48, 52, 55]);
    expect(all).toContainEqual([52, 55, 60]);
    const c = voiceLead([0, 4, 7], null, 48, 62);
    const f = voiceLead([5, 9, 0], c, 48, 62);
    const g = voiceLead([7, 11, 2], f, 48, 62);
    const move = (a: number[], b: number[]) => a.reduce((s, p, i) => s + Math.abs(p - b[i]), 0);
    expect(move(c, f)).toBeLessThanOrEqual(3);
    expect(move(f, g)).toBeLessThanOrEqual(6);
  });

  it("распознавание: точный набор и по нотам отрезка", () => {
    expect(identify([60, 64, 67])!.symbol).toBe("C");
    expect(identify([64, 67, 72])!.symbol).toBe("C/E");
    expect(identify([57, 60, 64])!.symbol).toBe("Am");
    expect(identify([55, 59, 62, 65])!.symbol).toBe("G7");
    expect(identify([60, 61, 62])).toBeNull();
    const notes = [
      { pitch: 48, durMs: 2000 },
      { pitch: 64, durMs: 500 },
      { pitch: 67, durMs: 500 },
      { pitch: 65, durMs: 250 },
      { pitch: 60, durMs: 500 },
    ];
    expect(detectChord(notes)!.symbol).toBe("C");
    expect(detectChord([{ pitch: 45, durMs: 2000 }, { pitch: 60, durMs: 500 }, { pitch: 64, durMs: 500 }, { pitch: 69, durMs: 500 }])!.symbol).toBe("Am");
  });

  it("проверка нажатого аккорда", () => {
    const c = parseChord("C")!;
    expect(judgeChord(c, [60, 64], false)).toBe("partial");
    expect(judgeChord(c, [60, 64, 67], false)).toBe("ok");
    expect(judgeChord(c, [52, 55, 60], false)).toBe("ok"); // обращение — тоже верно
    expect(judgeChord(c, [60, 63, 67], false)).toBe("wrong"); // до минор
    expect(judgeChord(c, [48, 60, 64, 67], false)).toBe("ok"); // удвоение
    const ce = parseChord("C/E")!;
    expect(judgeChord(ce, [52, 55, 60], true)).toBe("ok");
    expect(judgeChord(ce, [48, 52, 55], true)).toBe("wrong");
    const g7 = parseChord("G7")!;
    expect(judgeChord(g7, [55, 59, 62], false)).toBe("partial");
    expect(judgeChord(g7, [55, 59, 62, 65], false)).toBe("ok");
    expect(chordKeys(c)).toEqual([60, 64, 67]);
    expect(chordKeys(parseChord("A")!)).toEqual([57, 61, 64]);
  });

  it("серия ступени: без повторов подряд, обращения с басом", () => {
    const s = chordSeries(CHORD_LEVELS[0], 3);
    expect(s).toHaveLength(10);
    for (let i = 1; i < s.length; i++) expect(s[i].symbol).not.toBe(s[i - 1].symbol);
    const inv = chordSeries(CHORD_LEVELS.find((l) => l.inversions)!, 7, 30);
    expect(inv.some((c) => c.bass)).toBe(true);
    for (const c of inv.filter((x) => x.bass)) {
      const pcs = chordPcs(c);
      const bpc = ({ c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 }[c.bass!.letter]! + c.bass!.alter + 12) % 12;
      expect(pcs).toContain(bpc);
      expect(bpc).not.toBe(pcs[0]);
    }
    expect(chordUnlocked([])).toBe(1);
  });
});

describe("песни по буквам", () => {
  it("мелодия мини-записью и аккорды по тактам", () => {
    const m = parseMelody("c4q d4e e4e f4h | g4w | r q c5q.");
    expect(m.errors).toEqual(["r", "q"]);
    expect(m.notes.map((n) => [n.pitch, n.start, n.len])).toEqual([
      [60, 0, 4],
      [62, 4, 2],
      [64, 6, 2],
      [65, 8, 8],
      [67, 16, 16],
      [72, 32, 6],
    ]);
    const c = parseChart("C | G7 | Am F | C - G - | Xq", { beats: 4, unit: 4, pickup: 0 });
    expect(c.errors).toEqual(["Xq"]);
    expect(c.bars).toBe(5);
    expect(c.chords.map((x) => [x.chord.symbol, x.start])).toEqual([
      ["C", 0],
      ["G7", 16],
      ["Am", 32],
      ["F", 40],
      ["C", 48],
      ["G", 56],
    ]);
    // 3/4: два аккорда — 2 + 1 доли; затакт сдвигает такты.
    const w = parseChart("C G", { beats: 3, unit: 4, pickup: 4 });
    expect(w.chords.map((x) => x.start)).toEqual([4, 12]);
  });

  it("длительности разбиваются на записываемые с долей", () => {
    expect(splitLen(0, 16)).toEqual([16]);
    expect(splitLen(0, 6)).toEqual([6]);
    expect(splitLen(2, 6)).toEqual([2, 4]);
    expect(splitLen(4, 10)).toEqual([8, 2]);
    expect(splitLen(1, 3)).toEqual([1, 2]);
  });

  const styles: Style[] = ["block", "oompah", "alberti"];
  it("встроенные песни во всех фактурах читаются Verovio: мелодия на месте, аккомпанемент в каждом такте, буквы над нотами", () => {
    for (const song of BUILTIN_SONGS)
      for (const style of styles) {
        const { notes, mei, structure } = load(songMei(song, style));
        const right = notes.filter((n) => n.hand === "right").sort((a, b) => a.startMs - b.startMs);
        expect(right.map((n) => n.pitch), `${song.id}/${style}`).toEqual(song.melody.map((n) => n.pitch));
        const left = notes.filter((n) => n.hand === "left");
        const bars = parseChart(song.chords, song).bars;
        const ms16 = 60000 / song.bpm / 4;
        const leftBars = new Set(left.map((n) => Math.floor((Math.round(n.startMs / ms16) - song.pickup) / barLen(song))));
        expect(leftBars.size, `${song.id}/${style}`).toBe(bars);
        expect((mei.match(/<harm\b/g) ?? []).length).toBe(parseChart(song.chords, song).chords.length);
        expect(structure.measures).toBe(bars + (song.pickup ? 1 : 0));
      }
  });

  it("без мелодии: правая — аккорды, левая — бас", () => {
    const song: LeadSong = { id: "t", title: "т", bpm: 90, beats: 4, unit: 4, fifths: 0, pickup: 0, melody: [], chords: "C | Am | F | G7", style: "block" };
    const a = arrange(song);
    expect(a.right).toHaveLength(4);
    expect(a.right[3].pitches).toHaveLength(4);
    expect(a.left.map((e) => e.pitches.length)).toEqual([1, 1, 1, 1]);
    const { notes } = load(songMei(song, "oompah"));
    expect(notes.filter((n) => n.hand === "left").length).toBe(8); // бас на 1 и 3
  });

  it("песня из пьесы: мелодия и буквы возвращаются как были", () => {
    const src = BUILTIN_SONGS.find((s) => s.id === "builtin-mary")!;
    const { notes, mei, structure } = load(songMei(src, "block"));
    expect(harmsFromMei(mei).map((h) => h.chord.symbol)).toEqual(["C", "C", "G", "C", "C", "C", "G", "C"]);
    const ms16 = 60000 / src.bpm / 4;
    const starts = Array.from({ length: structure.measures }, (_, i) => i * 16 * ms16);
    const song = songFromScore(
      { notes, starts, tempoBpm: src.bpm, endMs: structure.measures * 16 * ms16, meter: { count: 4, unit: 4 } },
      mei,
      "Мэри",
      "x",
    );
    expect(song.melody.map((n) => n.pitch)).toEqual(src.melody.map((n) => n.pitch));
    expect(song.chords).toBe("C | C | G | C | C | C | G | C");
  });

  it("песня из пьесы без букв: аккорды распознаются по нотам", () => {
    const src = BUILTIN_SONGS.find((s) => s.id === "builtin-ode")!;
    const { notes, structure } = load(songMei(src, "block"));
    const ms16 = 60000 / src.bpm / 4;
    const starts = Array.from({ length: structure.measures }, (_, i) => i * 16 * ms16);
    const song = songFromScore(
      { notes, starts, tempoBpm: src.bpm, endMs: structure.measures * 16 * ms16, meter: { count: 4, unit: 4 } },
      "<mei/>",
      "Ода",
      "y",
    );
    const bars = song.chords.split("|").map((b) => b.trim());
    expect(bars).toHaveLength(8);
    expect(bars[0]).toBe("C");
    expect(bars[1]).toBe("G");
  });

  it("встроенная «Ода к радости» (MusicXML): аккорды по мелодии и басу", () => {
    const { notes, structure, mei, timemap } = load(readFileSync("src/pieces/ode-to-joy.musicxml", "utf8"));
    const starts = (timemap as { tstamp: number; measureOn?: string }[]).filter((e) => e.measureOn).map((e) => e.tstamp);
    const end = Math.max(...notes.map((n) => n.startMs + n.durMs));
    const song = songFromScore({ notes, starts, tempoBpm: 100, endMs: end, meter: structure.meter }, mei, "Ода", "z");
    expect(song.chords.split("|").map((b) => b.trim()).slice(0, 7)).toEqual(["C", "G", "C", "G", "C", "G", "C"]);
    expect(song.melody.slice(0, 4).map((n) => [n.pitch, n.start, n.len])).toEqual([
      [64, 0, 4],
      [64, 4, 4],
      [65, 8, 4],
      [67, 12, 4],
    ]);
  });
});
