import { beforeAll, describe, expect, it } from "vitest";
import createVerovioModule from "verovio/wasm";
import { VerovioToolkit } from "verovio/esm";
import { parseTextTab, textTabHeader, textTabHeaderLine } from "./asciitab";
import { partChart, TPQ } from "./tabsong";
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
  return buildNotes(tm, midi, parseMei(out));
}

const SCALE = `
Гамма до мажор, Темп: 120

e|-----------------|-----------------|
B|-----------------|---------0---1---|
G|-----------------|-0---2-----------|
D|-----0---2---3---|-----------------|
A|-3---------------|-----------------|
E|-----------------|-----------------|
`;

describe("текстовые табы", () => {
  it("гамма: строй, темп, такты по чертам, ритм по расстоянию — четвертями", () => {
    const t = parseTextTab(SCALE, { title: "Гамма" });
    expect(t).toMatchObject({ strings: 6, bars: 2, notes: 8, tempo: 120, meter: [4, 4], rhythm: "spacing" });
    const part = t.song.parts[0];
    expect(part).toMatchObject({ kind: "guitar", tuning: [40, 45, 50, 55, 59, 64] });
    const beats = part.staves[0].bars.map((b) => b[0]);
    expect(beats[0].map((b) => b.tick)).toEqual([0, TPQ, 2 * TPQ, 3 * TPQ]);
    expect(beats.flat().map((b) => b.notes[0].pitch)).toEqual([48, 50, 52, 53, 55, 57, 59, 60]);
    const notes = play(partChart(t.song, 0).mei);
    expect(notes.map((n) => n.pitch)).toEqual([48, 50, 52, 53, 55, 57, 59, 60]);
    expect(notes.map((n) => n.startMs)).toEqual([0, 500, 1000, 1500, 2000, 2500, 3000, 3500]);
  });

  it("Drop D по меткам, аккорды, двузначные лады, приёмы", () => {
    const t = parseTextTab(`
e|-------------12--|
B|---------3h5-----|
G|-------2---------|
D|-0-----0---------|
A|-0-----x---------|
D|-0---7b9~--------|
`);
    expect(t.song.parts[0].tuning).toEqual([38, 45, 50, 55, 59, 64]);
    const beats = t.song.parts[0].staves[0].bars[0][0];
    // Пауэр-аккорд D5 на открытых, затем 7 с бендом, аккорд с глушёной, хаммер 3→5, 12-й лад.
    expect(beats[0].notes.map((n) => n.pitch).sort()).toEqual([38, 45, 50]);
    expect(beats[1].notes[0]).toMatchObject({ pitch: 45, fret: 7, techniques: ["B1", "~"] });
    expect(beats[2].notes.some((n) => n.dead)).toBe(true);
    expect(beats.find((b) => b.notes.some((n) => n.fret === 3))!.notes[0].techniques).toEqual(["H"]);
    expect(beats[beats.length - 1].notes[0]).toMatchObject({ fret: 12, pitch: 76 });
    const mei = partChart(t.song, 0).mei;
    expect(mei).toContain(">B1 ~<");
    expect(mei).toContain(">H<");
  });

  it("бас (4 струны) и «ровно восьмыми»", () => {
    const tab = `
G|----------------|
D|----------------|
A|----------0--2--|
E|-0--3--5--------|
`;
    const t = parseTextTab(tab, { rhythm: 8 });
    expect(t.song.parts[0]).toMatchObject({ kind: "bass", tuning: [28, 33, 38, 43] });
    const beats = t.song.parts[0].staves[0].bars[0][0];
    expect(beats.map((b) => [b.tick, b.type])).toEqual([
      [0, 8],
      [480, 8],
      [960, 8],
      [1440, 8],
      [1920, 8],
    ]);
    const notes = play(partChart(t.song, 0).mei);
    expect(notes.map((n) => n.pitch)).toEqual([28, 31, 33, 33, 35]);
  });

  it("заголовок: темп, размер, каподастр, ритм", () => {
    expect(textTabHeader("Capo 2\nTempo: 96\nTime: 3/4\n")).toEqual({ capo: 2, tempo: 96, meter: [3, 4] });
    const line = textTabHeaderLine({ tempo: 80, meter: [3, 4], rhythm: 16 });
    expect(textTabHeader(line)).toEqual({ tempo: 80, meter: [3, 4], rhythm: 16 });
    const t = parseTextTab(`Capo 2\n${SCALE}`);
    expect(t.capo).toBe(2);
    expect(t.song.parts[0].staves[0].bars[0][0][0].notes[0].pitch).toBe(50); // до на 3-м ладу + каподастр 2
  });

  it("не таб — понятная ошибка", () => {
    expect(() => parseTextTab("просто текст\nбез табов")).toThrow(/не нашёл строк таба/);
  });
});
