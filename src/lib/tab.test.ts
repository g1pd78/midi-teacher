import { beforeAll, describe, expect, it } from "vitest";
import createVerovioModule from "verovio/wasm";
import { VerovioToolkit } from "verovio/esm";
import { readFileSync } from "node:fs";
import { assignPositions, chooseShift, meiToTab, readTabPositions, readTuning, tabStaff, type TabPos } from "./tab";
import { TUNINGS } from "./guitar";
import { parseMei, timemapNoteIds, type TimemapEntry } from "./score";

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

function load(data: string): string {
  tk.resetXmlIdSeed(1);
  tk.setOptions({ breaks: "none" });
  expect(tk.loadData(data)).toBeTruthy();
  return tk.getMEI({});
}

/** Высоты нот стана по временной карте Verovio: id → MIDI. */
function pitches(mei: string, staff?: number): Map<string, number> {
  tk.setOptions({ breaks: "none" });
  expect(tk.loadData(mei)).toBeTruthy();
  const tm = tk.renderToTimemap({ includeMeasures: true });
  const st = parseMei(mei);
  const out = new Map<string, number>();
  for (const id of timemapNoteIds(tm)) if (staff === undefined || st.staffOf.get(id) === staff) out.set(id, tk.getMIDIValuesForElement(id).pitch);
  return out;
}

const played = (pos: (TabPos | null)[][], tuning: number[]) => pos.map((a) => a.map((p) => (p ? tuning[p.string] + p.fret : null)));

describe("раскладка по струнам и ладам", () => {
  const guitar = TUNINGS.guitar;
  it("гамма до мажор — в одной позиции, без высоких ладов", () => {
    const scale = [48, 50, 52, 53, 55, 57, 59, 60];
    const pos = assignPositions(
      scale.map((p) => ({ pitches: [p] })),
      guitar,
      19,
    );
    expect(played(pos, guitar).flat()).toEqual(scale);
    const frets = pos.map((a) => a[0]!.fret);
    expect(Math.max(...frets)).toBeLessThanOrEqual(5);
    // Рука почти не ездит: разброс прижатых ладов в пределах позиции.
    const fretted = frets.filter((f) => f > 0);
    expect(Math.max(...fretted) - Math.min(...fretted)).toBeLessThanOrEqual(4);
  });

  it("бас: ми–ля–ре–соль — открытые струны", () => {
    const pos = assignPositions(
      [28, 33, 38, 43].map((p) => ({ pitches: [p] })),
      TUNINGS.bass,
      17,
    );
    expect(pos.map((a) => a[0]!.fret)).toEqual([0, 0, 0, 0]);
    expect(pos.map((a) => a[0]!.string)).toEqual([0, 1, 2, 3]);
  });

  it("аккорд — на разных струнах, растяжка не больше позиции", () => {
    const [chord] = assignPositions([{ pitches: [48, 52, 55] }], guitar, 19);
    expect(new Set(chord.map((p) => p!.string)).size).toBe(3);
    expect(played([chord], guitar)[0]).toEqual([48, 52, 55]);
    const f = chord.map((p) => p!.fret).filter((x) => x > 0);
    expect(Math.max(...f) - Math.min(...f)).toBeLessThanOrEqual(3);
  });

  it("нота вне грифа пропускается", () => {
    const [a] = assignPositions([{ pitches: [30] }], guitar, 19);
    expect(a).toEqual([null]);
  });

  it("октава: мелодия второй октавы уходит на октаву вниз, бас — на две", () => {
    expect(chooseShift([72, 74, 76, 77, 79], "guitar")).toBe(-12);
    expect(chooseShift([48, 43, 45, 50], "bass")).toBe(-12);
    expect(chooseShift([60, 62, 64, 65, 67], "guitar")).toBe(0);
  });
});

describe("MEI → табулатура (Verovio)", () => {
  it("«Ода к радости», мелодия на гитаре: те же id, высоты с учётом октавы, один стан", () => {
    const mei = load(readFileSync("src/pieces/ode-to-joy.musicxml", "utf8"));
    const st = parseMei(mei);
    const before = pitches(mei, 1);
    const tab = meiToTab(mei, 1, "guitar", st.meter);
    expect(tab.dropped).toBe(0);
    expect(tab.mei).not.toContain("<fing");
    expect(tabStaff(tab.mei)).toBe(1);
    expect(parseMei(tab.mei).staves).toBe(1);
    const after = pitches(tab.mei);
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
    for (const [id, p] of before) expect(after.get(id)).toBe(p + tab.shift);
    // Позиции из MEI совпадают с раскладкой.
    const read = readTabPositions(tab.mei, 6);
    expect(read.size).toBe(before.size);
    for (const [id, p] of tab.positions) expect(read.get(id)).toEqual(p);
    expect(tk.getLog()).not.toMatch(/error/i);
  });

  it("менуэт соль минор, левая рука на басе: низкие ноты ложатся на гриф", () => {
    const mei = load(readFileSync("src/pieces/minuet-gm-anh115.musicxml", "utf8"));
    const st = parseMei(mei);
    const before = pitches(mei, 2);
    const tab = meiToTab(mei, 2, "bass", st.meter);
    const after = pitches(tab.mei);
    expect(tab.dropped).toBe(0);
    expect(after.size).toBe(before.size);
    // Та же нота с точностью до октавы; перенесённых немного.
    let moved = 0;
    for (const [id, p] of after) {
      const d = p - (before.get(id)! + tab.shift);
      expect(d % 12).toBe(0);
      if (d) moved++;
    }
    expect(moved).toBe(tab.folded);
    expect(tab.folded).toBeLessThan(before.size / 10);
    expect(Math.min(...after.values())).toBeGreaterThanOrEqual(28);
  });

  it("менуэт соль мажор на гитаре: аккорды левой руки убраны, мелодия с лигами на месте", () => {
    const mei = load(readFileSync("src/pieces/minuet-g-anh114.musicxml", "utf8"));
    const tab = meiToTab(mei, 1, "guitar", parseMei(mei).meter);
    expect(tab.mei).not.toContain("<fing");
    expect(tab.mei).not.toMatch(/<staff[^>]* n="2"/);
    expect(pitches(tab.mei).size).toBe(pitches(mei, 1).size);
  });

  it("готовая табулатура из файла берётся как есть", () => {
    const note = (step: string, oct: number, s: number, f: number) =>
      `<note><pitch><step>${step}</step><octave>${oct}</octave></pitch><duration>1</duration><voice>1</voice><type>quarter</type><notations><technical><string>${s}</string><fret>${f}</fret></technical></notations></note>`;
    const tun = ["E1", "A1", "D2", "G2"].map((t, i) => `<staff-tuning line="${i + 1}"><tuning-step>${t[0]}</tuning-step><tuning-octave>${t[1]}</tuning-octave></staff-tuning>`).join("");
    const xml = `<?xml version="1.0"?><score-partwise version="4.0"><part-list><score-part id="P1"><part-name>Bass</part-name></score-part></part-list><part id="P1"><measure number="1"><attributes><divisions>1</divisions><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>TAB</sign><line>5</line></clef><staff-details><staff-lines>4</staff-lines>${tun}</staff-details></attributes>${note("E", 1, 4, 0)}${note("G", 1, 4, 3)}${note("A", 1, 3, 0)}${note("C", 2, 3, 3)}</measure></part></score-partwise>`;
    const mei = load(xml);
    expect(tabStaff(mei)).toBe(1);
    // Строй табов из MusicXML (<staff-tuning>) доходит до MEI.
    expect(readTuning(mei, 1)).toEqual([28, 33, 38, 43]);
    const tab = meiToTab(mei, 1, "bass", { count: 4, unit: 4 });
    expect(tab.shift).toBe(0);
    expect(tab.tuning).toEqual([28, 33, 38, 43]);
    expect([...tab.positions.values()]).toEqual([
      { string: 0, fret: 0 },
      { string: 0, fret: 3 },
      { string: 1, fret: 0 },
      { string: 1, fret: 3 },
    ]);
    expect([...pitches(tab.mei).values()]).toEqual([28, 31, 33, 36]);
  });
});
