import { beforeAll, describe, expect, it } from "vitest";
import createVerovioModule from "verovio/wasm";
import { VerovioToolkit } from "verovio/esm";
import { readFileSync } from "node:fs";
import {
  addNoteNames,
  buildBeats,
  buildNotes,
  initialTempo,
  loopRangeMs,
  measureStarts,
  parseMei,
  timemapNoteIds,
  type MidiValues,
  type TimemapEntry,
} from "./score";
import { phraseEnds } from "./practice";
import { fingerNotes, injectFingering, parseFinger } from "./fingering";

// Тесты используют тулкит напрямую (в приложении то же делает воркер).
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

function load(file: string) {
  tk.resetXmlIdSeed(1);
  tk.setOptions({ breaks: "none" });
  expect(tk.loadData(readFileSync(file, "utf8"))).toBeTruthy();
  const mei = tk.getMEI({});
  const timemap = tk.renderToTimemap({ includeMeasures: true });
  const midi: MidiValues = {};
  for (const id of timemapNoteIds(timemap)) midi[id] = tk.getMIDIValuesForElement(id);
  const structure = parseMei(mei);
  return { mei, structure, timemap, notes: buildNotes(timemap, midi, structure) };
}

describe("встроенные пьесы", () => {
  it("Ода к радости: 16 тактов, мелодия в правой, бас в левой, аппликатура", () => {
    const { notes, structure } = load("src/pieces/ode-to-joy.musicxml");
    expect(structure.measures).toBe(16);
    expect(structure.staves).toBe(2);
    const right = notes.filter((n) => n.hand === "right");
    const left = notes.filter((n) => n.hand === "left");
    // Первые ноты мелодии: ми ми фа соль соль фа ми ре.
    expect(right.slice(0, 8).map((n) => n.pitch)).toEqual([64, 64, 65, 67, 67, 65, 64, 62]);
    expect(right).toHaveLength(62);
    expect(left[0]).toMatchObject({ pitch: 48, startMs: 0, measure: 1 });
    // Аппликатура первой ноты — 3.
    expect(structure.fingerOf.get(right[0].id)).toBe("3");
    // Время растёт, при 100 уд/мин четверть = 600 мс.
    expect(right[1].startMs).toBe(600);
    expect(right.every((n, i) => i === 0 || n.startMs >= right[i - 1].startMs)).toBe(true);
  });

  it("Менуэт: знаки при ключе, аккорды, лиги не требуют повторного нажатия", () => {
    const { notes, structure } = load("src/pieces/minuet-g-anh114.musicxml");
    expect(structure.measures).toBe(32);
    const right = notes.filter((n) => n.hand === "right");
    // Такт 3: ми до ре ми фа-диез (фа-диез из знака при ключе).
    const m3 = right.filter((n) => n.measure === 3).map((n) => n.pitch);
    expect(m3).toEqual([76, 72, 74, 76, 78]);
    // Первая доля: ре второй октавы и аккорд соль–си–ре в левой.
    const first = notes.filter((n) => n.startMs === 0).map((n) => n.pitch).sort((a, b) => a - b);
    expect(first).toEqual([55, 59, 62, 74]);
    // Такт 25, левая: си (лига) + аккорд си–ре. Продолжение лиги не отдельная нота.
    const m25left = notes.filter((n) => n.measure === 25 && n.hand === "left");
    expect(m25left.map((n) => n.pitch)).toEqual([59, 62]);
    const tiedB = m25left.find((n) => n.pitch === 59)!;
    expect(Math.abs(tiedB.durMs - 1800)).toBeLessThan(5); // целый такт 3/4 при 100 уд/мин
    // До-диез в т. 20 и бекар в т. 24.
    expect(right.filter((n) => n.measure === 20).map((n) => n.pitch)).toContain(73);
    expect(notes.filter((n) => n.measure === 24 && n.hand === "left").map((n) => n.pitch)).toEqual([62, 50, 60]);
  });

  it("размер, ключи, такты и доли метронома", () => {
    const { structure, timemap, notes } = load("src/pieces/minuet-g-anh114.musicxml");
    expect(structure.meter).toEqual({ count: 3, unit: 4 });
    expect(structure.clefOf.get(1)).toBe("G");
    expect(structure.clefOf.get(2)).toBe("F");
    expect(structure.measureIds).toHaveLength(32);
    const starts = measureStarts(timemap, structure);
    expect(starts.slice(0, 3)).toEqual([0, 1800, 3600]);
    const tempo = initialTempo(timemap);
    expect(tempo).toBe(100);
    const end = Math.max(...notes.map((n) => n.startMs + n.durMs));
    const beats = buildBeats(starts, end, structure.meter, tempo);
    expect(beats).toHaveLength(32 * 3);
    expect(beats.slice(0, 4)).toEqual([
      { ms: 0, accent: true },
      { ms: 600, accent: false },
      { ms: 1200, accent: false },
      { ms: 1800, accent: true },
    ]);
    expect(loopRangeMs(starts, end, 2, 3)).toEqual([1800, 5400]);
    expect(loopRangeMs(starts, end, 31, 32)).toEqual([54000, end]);
  });

  it("концы фраз для фрагментов: «Ода» по 4 такта, Менуэт по 8", () => {
    const ode = load("src/pieces/ode-to-joy.musicxml");
    const odeEnd = Math.max(...ode.notes.map((n) => n.startMs + n.durMs));
    const odeEnds = phraseEnds(ode.notes, ode.structure, measureStarts(ode.timemap, ode.structure), odeEnd);
    for (const m of [4, 8, 12, 16]) expect(odeEnds).toContain(m);
    const min = load("src/pieces/minuet-g-anh114.musicxml");
    expect(min.structure.sectionEnds).toContain(32);
    const minEnd = Math.max(...min.notes.map((n) => n.startMs + n.durMs));
    const minEnds = phraseEnds(min.notes, min.structure, measureStarts(min.timemap, min.structure), minEnd);
    // Долгие ноты мелодии в тактах 8, 16, 24 и финальная черта.
    expect(minEnds).toEqual([8, 16, 24, 32]);
  });

  it("аппликатура вставляется в MEI: у каждой ноты цифра, подобранные — серые", () => {
    const { mei, notes, structure } = load("src/pieces/ode-to-joy.musicxml");
    const input = fingerNotes(notes, structure);
    const first = notes.find((n) => n.hand === "right")!;
    expect(input.find((n) => n.id === first.id)!.file).toBe(3);
    // Условная аппликатура: у первой ноты — из файла, у второй — ручная, остальные — подбор.
    const fingers = notes.map((n, i) => ({
      id: n.id,
      finger: (i % 5) + 1,
      source: n.id === first.id ? ("file" as const) : i === 1 ? ("manual" as const) : ("auto" as const),
    }));
    const out = injectFingering(mei, fingers, notes);
    expect((out.match(/<fing\b/g) ?? []).length).toBe(notes.length);
    tk.setOptions({ breaks: "none" });
    expect(tk.loadData(out)).toBeTruthy();
    const svg = tk.renderToSVG(1);
    const all = svg.match(/class="fing[^"]*"/g) ?? [];
    expect(all.length).toBe(notes.length);
    expect(all.filter((c) => c.includes("auto")).length).toBe(notes.length - 2);
    expect(all.filter((c) => c.includes("manual")).length).toBe(1);
    // Структура пьесы после вставки не меняется.
    expect(parseMei(out).measures).toBe(16);
    expect(parseFinger("3-4")).toBe(3);
    expect(parseFinger("")).toBeNull();
  });

  it.each([
    // файл, тактов, первые ноты правой руки, есть левая рука
    ["twinkle", 12, [60, 60, 67, 67, 69, 69, 67]],
    ["frere-jacques", 8, [60, 62, 64, 60, 60, 62, 64, 60]],
    ["au-clair-de-la-lune", 16, [72, 72, 72, 74, 76, 74]],
    ["vo-pole-bereza", 12, [76, 76, 76, 76, 74, 72, 72, 71, 69]],
    ["jingle-bells", 16, [64, 64, 64, 64, 64, 64, 64, 67, 60, 62, 64]],
    ["kalinka", 17, [69, 67, 64, 65, 67, 64, 65]],
    ["brahms-lullaby", 17, [64, 64, 67, 64, 64, 67]],
    ["old-french-song", 33, [62, 67, 69, 70, 72, 74]],
    ["minuet-gm-anh115", 32, [82, 81, 79, 81, 74, 74, 79, 67, 69, 70, 72, 74]],
  ])("встроенная пьеса %s: такты, мелодия, обе руки", (file, measures, head) => {
    const { notes, structure } = load(`src/pieces/${file}.musicxml`);
    expect(structure.measures).toBe(measures);
    const right = notes.filter((n) => n.hand === "right").sort((a, b) => a.startMs - b.startMs || b.pitch - a.pitch);
    const left = notes.filter((n) => n.hand === "left");
    expect(right.slice(0, head.length).map((n) => n.pitch)).toEqual(head);
    expect(left.length).toBeGreaterThan(3);
    // Все ноты в пределах клавиатуры 61 клавиши (до большой — до пятой октавы).
    for (const n of notes) expect(n.pitch).toBeGreaterThanOrEqual(36);
  });

  it("подписи нот добавляются в MEI и отображаются", () => {
    const { mei } = load("src/pieces/ode-to-joy.musicxml");
    const named = addNoteNames(mei, (p) => p.toUpperCase());
    tk.setOptions({ breaks: "none" });
    expect(tk.loadData(named)).toBeTruthy();
    const svg = tk.renderToSVG(1);
    expect(svg).toContain(">E<");
    expect((named.match(/<verse n="9">/g) ?? []).length).toBeGreaterThan(70);
  });
});

describe("транспонирование MusicXML (опция Verovio transpose)", () => {
  const read = (t: string) => {
    tk.resetXmlIdSeed(1);
    tk.setOptions({ breaks: "none", transpose: t });
    expect(tk.loadData(readFileSync("src/pieces/ode-to-joy.musicxml", "utf8"))).toBeTruthy();
    const mei = tk.getMEI({});
    tk.setOptions({ transpose: "" });
    return mei;
  };
  const ids = (m: string) => [...m.matchAll(/<note [^>]*xml:id="([^"]+)"/g)].map((x) => x[1]);

  it("сохраняет id нот и меняет тональность", () => {
    const plain = read("");
    const up = read("+2");
    expect(ids(up)).toEqual(ids(plain));
    expect(up).toContain('sig="2s"');
    expect(plain.match(/<note [^>]*>/)![0]).toContain('pname="e"');
    expect(up.match(/<note [^>]*>/)![0]).toContain('pname="f"');
    expect(read("")).toBe(plain);
  });
});
