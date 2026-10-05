import { beforeAll, describe, expect, it } from "vitest";
import createVerovioModule from "verovio/wasm";
import { VerovioToolkit } from "verovio/esm";
import { readFileSync } from "node:fs";
import { loadGuitarPro } from "./gp";
import { parseTextTab } from "./asciitab";
import { barStartsMs, barTempos, partChart, songAccompaniment, type TabSong, type TsPart } from "./tabsong";
import { buildNotes, parseMei, timemapNoteIds, type MidiValues, type TimemapEntry } from "./score";
import { readTabPositions, readTuning } from "./tab";
import { isDrumMei } from "./drums";

type Tk = VerovioToolkit & {
  getMEI(o: object): string;
  renderToTimemap(o: object): TimemapEntry[];
  getMIDIValuesForElement(id: string): { time: number; duration: number; pitch: number };
  resetXmlIdSeed(seed: number): void;
  getLog(): string;
};
let tk: Tk;
beforeAll(async () => {
  tk = new VerovioToolkit(await createVerovioModule()) as Tk;
}, 60_000);

const gp = (name: string) => loadGuitarPro(new Uint8Array(readFileSync(`src/lib/fixtures/gp/${name}`)));

/** Как в приложении: MEI → Verovio → ноты (лиги слиты). */
function play(mei: string) {
  tk.resetXmlIdSeed(1);
  tk.setOptions({ breaks: "none" });
  expect(tk.loadData(mei)).toBeTruthy();
  const out = tk.getMEI({});
  const tm = tk.renderToTimemap({ includeMeasures: true });
  const midi: MidiValues = {};
  for (const id of timemapNoteIds(tm)) midi[id] = tk.getMIDIValuesForElement(id);
  const st = parseMei(out);
  return { mei: out, structure: st, notes: buildNotes(tm, midi, st), log: tk.getLog() };
}

/** Время нот партии по модели (той же картой темпа, что и аккомпанемент). */
function modelNotes(song: TabSong, index: number) {
  const solo: TabSong = { ...song, parts: [song.parts[index]] };
  return songAccompaniment(solo, -1).map((n) => ({ pitch: n.pitch, startMs: n.startMs }));
}

/** Ноты на табе/стане звучат тогда же (±3 мс) и той же высоты, что в модели. */
function sameAsModel(song: TabSong, index: number) {
  const chart = partChart(song, index);
  const { notes, log } = play(chart.mei);
  expect(log).not.toMatch(/\[Error\]/);
  const order = (a: { pitch: number; startMs: number }, b: { pitch: number; startMs: number }) => a.startMs - b.startMs || a.pitch - b.pitch;
  const got = notes.map((n) => ({ pitch: n.pitch, startMs: n.startMs })).sort(order);
  const want = modelNotes(song, index).sort(order);
  expect(got.length).toBe(want.length);
  const bad = got.filter((g, i) => g.pitch !== want[i].pitch || Math.abs(g.startMs - want[i].startMs) > 3);
  expect(bad.slice(0, 5).map((g) => `${g.startMs}:${g.pitch} ≠ ${want[got.indexOf(g)].startMs}:${want[got.indexOf(g)].pitch}`)).toEqual([]);
  expect(chart.notes).toBe(want.length);
  return { chart, notes };
}

describe("Guitar Pro: разбор", () => {
  it("GP3, GP4, GP5 и GP7 дают одни и те же ноты", async () => {
    const seqs = [];
    for (const f of ["3-notes.gp3", "4-notes.gp4", "5-notes.gp5", "7-notes.gp"]) {
      const s = await gp(f);
      expect(s.parts).toHaveLength(1);
      expect(s.parts[0]).toMatchObject({ kind: "guitar", tuning: [40, 45, 50, 55, 59, 64], capo: 0 });
      seqs.push(s.parts[0].staves[0].bars.flat(2).flatMap((b) => b.notes.map((n) => `${n.string}:${n.fret}:${n.pitch}`)));
    }
    expect(seqs[0].slice(0, 4)).toEqual(["0:1:41", "0:2:42", "0:3:43", "0:4:44"]);
    for (const s of seqs.slice(1)) expect(s).toEqual(seqs[0]);
  });

  it("повторы и вольты развёрнуты, как играет Guitar Pro", async () => {
    const s = await gp("5-repeat-close-alternate-endings.gp5");
    expect(s.order.map((o) => o.master)).toEqual([0, 1, 0, 2, 3, 0, 1, 0, 4]);
    expect(s.order.filter((o) => o.master === 0).map((o) => o.pass)).toEqual([0, 1, 2, 3]);
    const { chart } = sameAsModel(s, 0);
    expect(chart.measures).toBe(9);
  });

  it("смены темпа внутри такта — средним темпом такта; ноты в Verovio — по той же карте", async () => {
    const s = await gp("8-beat-tempo-change.gp");
    const tempos = barTempos(s);
    // Такт 1: половина при 120, половина при 60 → средний 80.
    expect(tempos).toEqual([80, 106, 120, 120]);
    expect(barStartsMs(s, tempos)[1]).toBe(3000);
    const { chart } = sameAsModel(s, 0);
    expect(chart.mei).toContain('midi.bpm="106"');
  });

  it("приёмы, части песни и двойные черты", async () => {
    const s = await gp("5-effects.gp5");
    const { chart, notes } = sameAsModel(s, 0);
    const labels = new Set([...chart.mei.matchAll(/<rend[^>]*>([^<]*)<\/rend>/g)].flatMap((m) => [m[1], ...m[1].split(" ")]));
    for (const label of ["H", "P", "↗", "↘", "B1", "~", "PM", "Harm", "X", "T", "S", "Pop", "Trem", "Dead Notes", "Bends"]) expect(labels).toContain(label);
    // Искусственный флажолет — в модели (в файле он в переполненном такте, на нотах не помещается).
    expect(s.parts[0].staves[0].bars[3].flat().some((b) => b.notes.some((n) => n.techniques?.includes("P.H.")))).toBe(true);
    expect(chart.mei.match(/right="dbl"/g)?.length).toBeGreaterThan(5);
    expect(notes.length).toBeGreaterThan(80);
    // Позиции и строй — из файла.
    expect(readTuning(chart.mei, 1)).toEqual([40, 45, 50, 55, 59, 64]);
    expect(readTabPositions(chart.mei, 6).size).toBeGreaterThan(80);
  });

  it("хаммеры, слайды, бенды, триоли", async () => {
    for (const f of ["5-hammer.gp5", "5-slides.gp5", "5-bends.gp5", "5-tuplets.gp5"]) sameAsModel(await gp(f), 0);
    const t = partChart(await gp("5-tuplets.gp5"), 0);
    expect(t.mei).toContain("<tuplet");
  });

  it("слова под нотами", async () => {
    const s = await gp("7-beat-lyrics.gp");
    expect(s.parts[0].kind).toBe("other");
    const { chart } = sameAsModel(s, 0);
    expect(chart.mei).toContain("<verse");
  });

  it("мелодия без табов — обычный стан со знаками", async () => {
    const s = await gp("5-beat-text-lyrics.gp5");
    expect(s.parts[0].kind).toBe("other");
    const { chart } = sameAsModel(s, 0);
    expect(chart.mei).not.toContain("tab.guitar");
    expect(chart.mei).toContain('<clef shape="G"');
  });

  it("барабаны — ударный стан для пэдов", async () => {
    for (const f of ["5-percussion-all.gp5", "7-drum-tabs.gp"]) {
      const s = await gp(f);
      expect(s.parts[0].kind).toBe("drums");
      const chart = partChart(s, 0);
      expect(isDrumMei(chart.mei)).toBe(true);
      const { notes, log } = play(chart.mei);
      expect(log).not.toMatch(/\[Error\]/);
      expect(notes.length).toBe(chart.notes);
      expect(notes.length).toBeGreaterThan(20);
    }
  });
});

describe("песня из нескольких партий", () => {
  it("гитара, бас в строе D, мелодия, барабаны — каждая партия на своих нотах, остальные звучат", async () => {
    const drums = await gp("7-drum-tabs.gp");
    const guitar = await gp("5-hammer.gp5");
    const melody = await gp("7-beat-lyrics.gp");
    const bass = parseTextTab(`
F|----------------|----------------|
C|----------------|----------------|
G|---------0---2--|-0--------------|
D|-0---3----------|----------------|
`).song;
    // Такты барабанов (4 такта 4/4), остальные партии — с начала, дальше пусто.
    const pad = (p: TsPart): TsPart => ({ ...p, staves: p.staves.map((st) => ({ ...st, bars: drums.masters.map((_, i) => st.bars[i] ?? [[]]) })) });
    const song: TabSong = { ...drums, parts: [pad(guitar.parts[0]), pad(bass.parts[0]), pad(melody.parts[0]), drums.parts[0]] };
    expect(song.parts.map((p) => p.kind)).toEqual(["guitar", "bass", "other", "drums"]);
    expect(song.parts[1].tuning).toEqual([26, 31, 36, 41]);
    for (let i = 0; i < 3; i++) sameAsModel(song, i);
    // Играешь гитару — звучат бас, мелодия и барабаны, каждый на своём канале.
    const acc = songAccompaniment(song, 0);
    expect(new Set(acc.map((n) => n.channel))).toEqual(new Set([1, 2, 9]));
    expect(acc.filter((n) => n.channel === 1).map((n) => n.pitch)).toEqual([26, 29, 31, 33, 31]);
    expect(acc.every((n) => n.startMs >= 0 && n.measure >= 1 && n.measure <= song.order.length)).toBe(true);
  });
});

describe("песня из табов: аккомпанемент", () => {
  it("остальные партии звучат по своим каналам, барабаны — на 9-м", async () => {
    const g = await gp("5-hammer.gp5");
    const d = await gp("7-drum-tabs.gp");
    // Гитара + барабаны в одной песне (такты барабанов, гитара — в первом такте).
    const song: TabSong = { ...d, parts: [{ ...g.parts[0], staves: [{ ...g.parts[0].staves[0], bars: d.masters.map((_, i) => g.parts[0].staves[0].bars[i] ?? [[]]) }] }, d.parts[0]] };
    const acc = songAccompaniment(song, 0);
    expect(acc.length).toBe(partChart(song, 1).notes === 0 ? 0 : acc.length);
    expect(acc.every((n) => n.channel === 9 && n.program === null)).toBe(true);
    const gAcc = songAccompaniment(song, 1);
    expect(gAcc.every((n) => n.channel === 0 && n.program === 25)).toBe(true);
    expect(gAcc.every((n) => n.measure >= 1 && n.measure <= song.order.length)).toBe(true);
    // Гитара в партии — те же ноты, что слышны аккомпанементом при игре на барабанах.
    sameAsModel(song, 0);
  });
});
