import { beforeAll, describe, expect, it } from "vitest";
import createVerovioModule from "verovio/wasm";
import { VerovioToolkit } from "verovio/esm";
import song from "./fixtures/rocksmith-test.json";
import { arrangementTitle, rsAccompaniment, rsChart, rsTuning, sectionTitle, splitTicks, type RsArrangement, type RsSong } from "./rocksmith";
import { MIRROR, meiToTab, readTabPositions, readTuning, withStaff } from "./tab";
import { buildNotes, parseMei, timemapNoteIds, type MidiValues, type TimemapEntry } from "./score";
import { TUNING_PRESETS, sameTuning, tuningName } from "./guitar";

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

const rs = song as RsSong;

/** Загрузить MEI в Verovio: id ноты → (MIDI, время мс). */
function play(mei: string) {
  tk.resetXmlIdSeed(1);
  tk.setOptions({ breaks: "none" });
  expect(tk.loadData(mei)).toBeTruthy();
  const out = tk.getMEI({});
  const tm = tk.renderToTimemap({ includeMeasures: true });
  const midi: MidiValues = {};
  for (const id of timemapNoteIds(tm)) midi[id] = tk.getMIDIValuesForElement(id);
  // Как в приложении: части нот под лигой сливаются.
  const notes = buildNotes(tm, midi, parseMei(out)).map((n) => ({ id: n.id, pitch: n.pitch, time: n.startMs, duration: n.durMs }));
  return { mei: out, notes };
}

function arr(over: Partial<RsArrangement>): RsArrangement {
  const beats = Array.from({ length: 16 }, (_, i) => ({ time: 1 + i * 0.5, downbeat: i % 4 === 0 }));
  return { id: "x", name: "Lead", bass: false, tuning: [0, 0, 0, 0, 0, 0], capo: 0, centOffset: 0, songLength: 9, beats, notes: [], chords: [], sections: [], ...over };
}
const note = (time: number, string: number, fret: number, extra: Partial<RsArrangement["notes"][number]> = {}) => ({
  time,
  string,
  fret,
  sustain: 0,
  techniques: 0,
  slideTo: null,
  bend: 0,
  chord: null,
  ...extra,
});

describe("Rocksmith: партия → табулатура", () => {
  it("тестовая песня: соло-гитара — 2 такта, аккорды D, A5, строй E", () => {
    const lead = rs.arrangements[0];
    expect(arrangementTitle(lead)).toBe("Соло-гитара");
    expect(arrangementTitle(rs.arrangements[1])).toBe("Ритм-гитара");
    const chart = rsChart(rs, lead);
    expect(chart.bpm).toBe(120);
    expect(chart.measures).toBe(2);
    expect(chart.notes).toBe(19);
    expect(chart.tuning).toEqual([40, 45, 50, 55, 59, 64]);
    const { mei, notes } = play(chart.mei);
    expect(tk.getLog()).not.toMatch(/error/i);
    expect(notes).toHaveLength(19);
    // Первый аккорд D (ре-фа#-ля) на второй доле: 500 мс при 120 уд/мин.
    const first = notes.filter((n) => n.time === notes[0].time);
    expect(first.map((n) => n.pitch).sort()).toEqual([50, 54, 57]);
    expect(notes[0].time).toBe(500);
    // A5 (ля-ми-ля) на третьей доле второго такта, звучит полторы доли.
    const a5 = notes.filter((n) => n.time === 3000);
    expect(a5.map((n) => n.pitch).sort()).toEqual([57, 64, 69]);
    expect(a5[0].duration).toBe(750);
    // Позиции на табе — из файла.
    const st = parseMei(mei);
    const pos = readTabPositions(mei, 1);
    expect(pos.get(first[0].id)).toBeTruthy();
    expect([...pos.values()].some((p) => p.fret === 10)).toBe(true);
    // Подпись секции.
    expect(chart.mei).toContain(">Вступление<");
    expect(st.measures).toBe(2);
  });

  it("ритм-гитара тоже читается", () => {
    const chart = rsChart(rs, rs.arrangements[1]);
    const { notes } = play(chart.mei);
    expect(notes.length).toBe(chart.notes);
    expect(notes.length).toBeGreaterThan(0);
  });

  it("строй, каподастр и бас", () => {
    const dropD = arr({ tuning: [-2, 0, 0, 0, 0, 0], notes: [note(1, 0, 0), note(1.5, 0, 2)] });
    expect(rsTuning(dropD)).toEqual([38, 45, 50, 55, 59, 64]);
    const c = rsChart({ title: "t" }, dropD);
    expect(play(c.mei).notes.map((n) => n.pitch)).toEqual([38, 40]);
    expect(c.mei).toMatch(/<course n="6" pname="d" oct="2"/);
    // Каподастр на 2: лад 4 → на табе «2», звучит как лад 4.
    const capo = arr({ capo: 2, notes: [note(1, 1, 4)] });
    const cc = rsChart({ title: "t" }, capo);
    expect(cc.tuning[0]).toBe(42);
    expect(cc.mei).toContain('tab.fret="2"');
    expect(play(cc.mei).notes[0].pitch).toBe(49);
    // Бас — 4 струны.
    const bass = arr({ name: "Bass", bass: true, notes: [note(1, 0, 3), note(1.5, 3, 0)] });
    expect(rsTuning(bass)).toEqual([28, 33, 38, 43]);
    const bc = rsChart({ title: "t" }, bass);
    expect(bc.mei).toContain('lines="4"');
    expect(play(bc.mei).notes.map((n) => n.pitch)).toEqual([31, 43]);
  });

  it("приёмы, триоли и секции с двойной чертой", () => {
    const a = arr({
      notes: [
        note(1, 2, 5, { techniques: 0x200 }),
        note(1 + 1 / 6, 2, 7, { techniques: 0x400 }),
        note(1 + 2 / 6, 2, 5),
        note(1.5, 3, 7, { techniques: 0x800, slideTo: 9 }),
        note(3, 1, 5, { techniques: 0x1000, bend: 1, sustain: 1 }),
        note(4, 0, 0, { techniques: 0x40 }),
      ],
      sections: [
        { name: "intro", start: 1, end: 3 },
        { name: "chorus", start: 3, end: 9 },
      ],
    });
    const c = rsChart({ title: "t" }, a);
    expect(c.mei).toContain("<tuplet");
    for (const label of [">H<", ">P<", ">↗<", ">B1<", ">PM<", ">Вступление<", ">Припев<"]) expect(c.mei).toContain(label);
    const { mei, notes } = play(c.mei);
    expect(notes.map((n) => n.time)).toEqual([0, 166, 333, 500, 2000, 3000]);
    // Граница секции — конец первого такта.
    expect(c.mei).toMatch(/<measure xml:id="m1" n="1" right="dbl"/);
    expect(parseMei(mei).sectionEnds).toContain(1);
    expect(sectionTitle("verse2")).toBe("Куплет");
  });

  it("длительности внутри такта", () => {
    const g = () => 4;
    expect(splitTicks(0, 48, g)).toEqual([48]);
    expect(splitTicks(0, 18, g)).toEqual([18]);
    expect(splitTicks(6, 18, g)).toEqual([6, 12]);
    expect(splitTicks(3, 9, g)).toEqual([3, 6]);
    expect(splitTicks(0, 8, () => 3)).toEqual([8]);
  });

  it("остальные партии — аккомпанемент", () => {
    const lead = rs.arrangements[0];
    const chart = rsChart(rs, lead);
    const acc = rsAccompaniment(rs, lead, chart.barBeats);
    expect(acc.length).toBeGreaterThan(0);
    expect(acc.every((n) => n.channel === 2 && n.program === 27 && n.startMs >= 0)).toBe(true);
    expect(acc.every((n) => n.measure >= 1 && n.measure <= chart.measures)).toBe(true);
    // Такт 2 начинается через 4 доли (2 с при 120 уд/мин).
    expect(acc.filter((n) => n.measure === 2).every((n) => n.startMs >= 2000)).toBe(true);
  });
});

describe("табы под строй", () => {
  it("табы из файла — как есть, со строем файла; переложение под Drop D и каподастр сохраняет высоты", () => {
    const dropD = rs.arrangements[0];
    const a = { ...dropD, tuning: [-2, 0, 0, 0, 0, 0] };
    const { mei, notes } = play(rsChart(rs, a).mei);
    expect(readTuning(mei, 1)).toEqual([38, 45, 50, 55, 59, 64]);
    const meter = parseMei(mei).meter;
    const pitchOf = (m: string) => play(m).notes.map((n) => n.pitch);
    // Как есть.
    const keep = meiToTab(mei, 1, "guitar", meter);
    expect(keep.tuning).toEqual([38, 45, 50, 55, 59, 64]);
    expect(keep.positions).toEqual(readTabPositions(mei, 6));
    expect(pitchOf(keep.mei)).toEqual(notes.map((n) => n.pitch));
    // Под стандартный строй — другие позиции, те же звуки.
    const std = meiToTab(mei, 1, "guitar", meter, { tuning: [40, 45, 50, 55, 59, 64], relayout: true });
    expect(std.tuning).toEqual([40, 45, 50, 55, 59, 64]);
    expect(std.dropped).toBe(0);
    // Ноты аккорда — на разных струнах.
    const groups = [...std.mei.matchAll(/<tabGrp\b[^>]*>([\s\S]*?)<\/tabGrp>/g)].map((g) => [...g[1].matchAll(/tab\.course="(\d+)"/g)].map((c) => c[1]));
    expect(groups.some((g) => g.length === 3)).toBe(true);
    for (const g of groups) expect(new Set(g).size).toBe(g.length);
    expect(pitchOf(std.mei)).toEqual(notes.map((n) => n.pitch));
    // С каподастром на 2: лады от каподастра, звучит так же.
    const capo = meiToTab(mei, 1, "guitar", meter, { tuning: [40, 45, 50, 55, 59, 64], capo: 2, relayout: true });
    expect(capo.tuning[0]).toBe(42);
    expect(pitchOf(capo.mei)).toEqual(notes.map((n) => n.pitch));
  });

  it("ноты из MusicXML раскладываются под свой строй", () => {
    const melody = rsChart({ title: "t" }, arr({ notes: [note(1, 0, 0), note(1.5, 0, 2), note(2, 1, 0)] }));
    // Строй файла теряем: делаем обычные ноты без табулатуры — через высоты (E2, F#2, A2).
    const { mei } = play(melody.mei);
    const dropD = meiToTab(mei, 1, "guitar", parseMei(mei).meter, { tuning: [38, 45, 50, 55, 59, 64], relayout: true });
    expect([...dropD.positions.values()].map((p) => [p.string, p.fret])).toEqual([
      [0, 2],
      [0, 4],
      [1, 0],
    ]);
  });
});

describe("ноты на стане над табом", () => {
  it("копии нот таба с теми же высотами и временем; таб остаётся станом 1", () => {
    const { mei } = play(rsChart(rs, rs.arrangements[0]).mei);
    const tab = meiToTab(mei, 1, "guitar", parseMei(mei).meter);
    const both = withStaff(tab.mei, tab.tuning, "guitar");
    tk.resetXmlIdSeed(1);
    tk.setOptions({ breaks: "none" });
    expect(tk.loadData(both)).toBeTruthy();
    expect(tk.getLog()).not.toMatch(/error/i);
    const tm = tk.renderToTimemap({ includeMeasures: true });
    const ids = timemapNoteIds(tm);
    const tabIds = ids.filter((id) => !id.endsWith(MIRROR));
    expect(tabIds).toHaveLength(ids.length / 2);
    for (const id of tabIds) {
      const a = tk.getMIDIValuesForElement(id);
      const b = tk.getMIDIValuesForElement(id + MIRROR);
      expect([b.pitch, b.time]).toEqual([a.pitch, a.time]);
    }
    const st = parseMei(both);
    expect(st.staves).toBe(2);
    expect(st.staffOf.get(tabIds[0])).toBe(1);
    expect(both).toContain('accid="s"'); // фа-диез в аккорде D
  });
});

describe("строи", () => {
  it("названия и сравнение", () => {
    expect(tuningName([40, 45, 50, 55, 59, 64], "guitar")).toBe(TUNING_PRESETS.guitar[0].name);
    expect(tuningName([38, 45, 50, 55, 59, 64], "guitar")).toMatch(/Drop D/);
    expect(sameTuning([38, 45, 50, 55, 59, 64], [38, 45, 50, 55, 59, 64])).toBe(true);
    expect(sameTuning([38, 45, 50, 55, 59, 64], [40, 45, 50, 55, 59, 64])).toBe(false);
  });
});
