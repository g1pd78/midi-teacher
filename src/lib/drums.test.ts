import { beforeAll, describe, expect, it } from "vitest";
import createVerovioModule from "verovio/wasm";
import { VerovioToolkit } from "verovio/esm";
import { buildNotes, parseMei, timemapNoteIds, type MidiValues, type TimemapEntry } from "./score";
import { DRUM_SONGS, DRUM_SONG_BY_ID, drumSongBars, drumSongTitle, drumSongTs } from "./drumSongs";
import { partChart, songAccompaniment } from "./tabsong";
import {
  DRUM_BY_GM,
  DRUM_BY_ID,
  DRUM_EXERCISES,
  bar,
  drumMei,
  drumOfGm,
  drumUnlocked,
  dynamicsOf,
  evaluateDynamics,
  isDrumMei,
} from "./drums";

type Tk = VerovioToolkit & {
  renderToTimemap(o: object): TimemapEntry[];
  getMIDIValuesForElement(id: string): { time: number; duration: number; pitch: number };
};
let tk: Tk;

beforeAll(async () => {
  tk = new VerovioToolkit(await createVerovioModule()) as Tk;
}, 60_000);

function render(mei: string) {
  tk.setOptions({ breaks: "none" });
  expect(tk.loadData(mei)).toBeTruthy();
  const timemap = tk.renderToTimemap({ includeMeasures: true });
  const midi: MidiValues = {};
  for (const id of timemapNoteIds(timemap)) midi[id] = tk.getMIDIValuesForElement(id);
  return buildNotes(timemap, midi, parseMei(mei));
}

describe("барабанные ноты", () => {
  it("рок-бит: удары на своих местах и нотах GM", () => {
    const mei = drumMei({ bpm: 60, bars: [bar({ hhClosed: "x.x.x.x.x.x.x.x.", snare: "....x.......x...", kick: "x.......x......." })] });
    expect(isDrumMei(mei)).toBe(true);
    const notes = render(mei);
    const at = (gm: number) =>
      notes
        .filter((n) => n.pitch === gm)
        .map((n) => n.startMs)
        .sort((a, b) => a - b);
    // 60 уд/мин: доля — 1000 мс, восьмая — 500.
    expect(at(42)).toEqual([0, 500, 1000, 1500, 2000, 2500, 3000, 3500]);
    expect(at(38)).toEqual([1000, 3000]);
    expect(at(36)).toEqual([0, 2000]);
    expect(notes.every((n) => n.hand === "right")).toBe(true);
  });

  it("шестнадцатые, пауза в начале доли и триоли считаются по времени верно", () => {
    const notes = render(drumMei({ bpm: 60, bars: [bar({ kick: "x......x..x.....", snare: "...gX..g.g.gX..g" })] }));
    const kick = notes.filter((n) => n.pitch === 36).map((n) => n.startMs);
    expect(kick).toEqual([0, 1750, 2500]);
    const sh = render(drumMei({ bpm: 60, bars: [bar({ hhClosed: "x.xx.xx.xx.x" }, 12)] }));
    const hh = sh.map((n) => n.startMs).sort((a, b) => a - b);
    expect(hh.map((t) => Math.round(t / (1000 / 3)))).toEqual([0, 2, 3, 5, 6, 8, 9, 11]);
  });

  it("каждое упражнение каталога строится и длится 4 такта", () => {
    for (const ex of DRUM_EXERCISES) {
      const score = ex.build();
      expect(score.bars.length, ex.id).toBe(4);
      const notes = render(drumMei(score));
      expect(notes.length, ex.id).toBeGreaterThan(0);
      const beat = 60000 / score.bpm;
      const end = Math.max(...notes.map((n) => n.startMs));
      expect(end, ex.id).toBeLessThan(16 * beat);
      expect(end, ex.id).toBeGreaterThan(12 * beat);
      // Все удары — барабаны установки.
      for (const n of notes) expect(drumOfGm(n.pitch), `${ex.id}: ${n.pitch}`).not.toBeNull();
    }
  });

  it("акценты и тихие ноты видны в MEI", () => {
    const mei = drumMei({ bpm: 80, bars: [bar({ snare: "X..g............" })] });
    const dyn = dynamicsOf(mei);
    expect([...dyn.values()].sort()).toEqual(["accent", "ghost"]);
    expect(mei).toContain('artic="acc"');
    expect(mei).toContain('head.mod="paren"');
  });

  it("открытый хэт и тарелки — крестиками", () => {
    const mei = drumMei({ bpm: 80, bars: [bar({ hhOpen: "x...............", crash: "....x..........." })] });
    expect(mei).toMatch(/pnum="46"[^>]*head\.shape="x"[^>]*artic="open"/);
    expect(mei).toMatch(/pnum="49"[^>]*head\.shape="x"/);
    expect(DRUM_BY_ID.get("kick")!.foot).toBe(true);
  });
});

describe("сила удара", () => {
  const dyn = new Map<string, "accent" | "ghost">([
    ["a1", "accent"],
    ["a2", "accent"],
    ["g1", "ghost"],
  ]);
  it("акцент громче обычных, тихая нота — тише", () => {
    const r = evaluateDynamics(
      [
        { id: "n1", velocity: 80 },
        { id: "n2", velocity: 84 },
        { id: "a1", velocity: 110 },
        { id: "a2", velocity: 85 },
        { id: "g1", velocity: 40 },
      ],
      dyn,
    );
    expect(r.sensitive).toBe(true);
    expect(r.accents).toEqual({ hit: 1, total: 2 });
    expect(r.ghosts).toEqual({ hit: 1, total: 1 });
    expect(r.share).toBeCloseTo(2 / 3);
  });
  it("пэды без чувствительности — оценка силы не мешает зачёту", () => {
    const r = evaluateDynamics(
      ["n1", "a1", "a2", "g1"].map((id) => ({ id, velocity: 127 })),
      dyn,
    );
    expect(r.sensitive).toBe(false);
    expect(r.share).toBe(1);
  });
});

describe("ступени", () => {
  it("в каждом разделе открыто первое, дальше — по одному за пройденным", () => {
    const open = drumUnlocked(new Set());
    expect(open.has("drum-groove-quarters")).toBe(true);
    expect(open.has("drum-rud-singles8")).toBe(true);
    expect(open.has("drum-groove-rock")).toBe(false);
    const next = drumUnlocked(new Set(["drum-groove-quarters"]));
    expect(next.has("drum-groove-hh-quarters")).toBe(true);
    expect(next.has("drum-groove-rock")).toBe(false);
  });
});

describe("барабаны к песням", () => {
  it("партия на пэдах: грув, сбивки раз в четыре такта, тарелка в конце; мелодия, бас и аккорды звучат", () => {
    for (const d of DRUM_SONGS) {
      const ts = drumSongTs(d);
      const bars = drumSongBars(d);
      expect(ts.masters.length, d.id).toBe(bars);
      expect(ts.parts.map((p) => p.kind), d.id).toEqual(["drums", "other", "bass", "piano"]);
      const mei = partChart(ts, 0).mei;
      expect(isDrumMei(mei), d.id).toBe(true);
      const notes = render(mei);
      const gms = new Set(notes.map((n) => n.pitch));
      expect(gms.has(36) && gms.has(38) && gms.has(49), d.id).toBe(true);
      if (bars > 4) expect(gms.has(48), d.id).toBe(true);
      // Все ноты партии — барабаны установки (их можно назначить на пэды).
      for (const g of gms) expect(DRUM_BY_GM.has(g), `${d.id}: ${g}`).toBe(true);
      const acc = songAccompaniment(ts, 0);
      expect(acc.filter((n) => n.program === 73).length, d.id).toBeGreaterThan(10);
      expect(acc.some((n) => n.program === 33), d.id).toBe(true);
    }
    expect(drumSongTitle(DRUM_SONG_BY_ID.get("drum-song-birthday")!)).toBe("С днём рождения · вальс");
  });
});
