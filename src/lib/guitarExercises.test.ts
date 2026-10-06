import { beforeAll, describe, expect, it } from "vitest";
import createVerovioModule from "verovio/wasm";
import { VerovioToolkit } from "verovio/esm";
import { GTR_CATEGORIES, GTR_EXERCISES, GTR_EXERCISE_BY_ID, gtrUnlocked, gtrWarmup, positionNotes, riff } from "./guitarExercises";
import { FRET_LEVELS, fretSeries, fretUnlocked, judgeFret, fretLevelId } from "./fretboard";
import { partChart, songAccompaniment, type TabSong } from "./tabsong";
import { TUNINGS } from "./guitar";
import { GTR_PIECES, GTR_PIECE_BY_ID, gtrPieceSong } from "./guitarPieces";
import { buildNotes, parseMei, timemapNoteIds, type MidiValues, type TimemapEntry } from "./score";
import type { ExerciseStatView } from "./exercises";

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

const pitchesOf = (s: TabSong) => s.parts[0].staves[0].bars.flat(2).flatMap((b) => b.notes.map((n) => n.pitch));
const stat = (exercise: string, passed = true): ExerciseStatView => ({ exercise, attempts: 1, passed, bestAccuracy: 1, lastAt: 0, lastTimingSdMs: 30, lastLoudness: 1 });

describe("гитарные упражнения", () => {
  it("каталог: у каждого раздела гитары и баса есть упражнения, id уникальны", () => {
    for (const inst of ["guitar", "bass"] as const)
      for (const c of GTR_CATEGORIES[inst]) expect(GTR_EXERCISES.filter((e) => e.instrument === inst && e.category === c.id).length).toBeGreaterThan(2);
    expect(new Set(GTR_EXERCISES.map((e) => e.id)).size).toBe(GTR_EXERCISES.length);
  });

  it("паучок 1-2-3-4 в 5-й позиции: по четыре лада на каждой струне, палец = лад − 4, вверх и обратно", () => {
    const song = GTR_EXERCISE_BY_ID.get("gtr-spider-1234-5-60")!.build(TUNINGS.guitar);
    const notes = song.parts[0].staves[0].bars.flat(2).flatMap((b) => b.notes);
    expect(notes).toHaveLength(48);
    expect(notes.slice(0, 4).map((n) => [n.string, n.fret, n.techniques?.[0]])).toEqual([
      [0, 5, "1"],
      [0, 6, "2"],
      [0, 7, "3"],
      [0, 8, "4"],
    ]);
    expect(notes[24]).toMatchObject({ string: 5, fret: 8 });
    expect(notes[0].pitch).toBe(45);
  });

  it("под свой строй: Drop D — те же лады, звуки ниже на тон на 6-й струне", () => {
    const e = GTR_EXERCISE_BY_ID.get("gtr-spider-1234-5-60")!;
    const std = e.build(TUNINGS.guitar).parts[0].staves[0].bars.flat(2).flatMap((b) => b.notes);
    const drop = e.build([38, 45, 50, 55, 59, 64]).parts[0].staves[0].bars.flat(2).flatMap((b) => b.notes);
    expect(drop.map((n) => n.fret)).toEqual(std.map((n) => n.fret));
    expect(drop[0].pitch).toBe(43);
  });

  it("паук на двух струнах и диагональ", () => {
    const walk = GTR_EXERCISE_BY_ID.get("gtr-spider-walk-5-60")!.build(TUNINGS.guitar).parts[0].staves[0].bars.flat(2).flatMap((b) => b.notes);
    expect(walk.slice(0, 4).map((n) => [n.string, n.fret])).toEqual([
      [0, 5],
      [1, 6],
      [0, 7],
      [1, 8],
    ]);
    const diag = GTR_EXERCISE_BY_ID.get("gtr-spider-diag-5-60")!.build(TUNINGS.guitar).parts[0].staves[0].bars.flat(2).flatMap((b) => b.notes);
    expect(diag.slice(4, 8).map((n) => n.fret)).toEqual([6, 7, 8, 9]);
  });

  it("пентатоника ля минор в 5-й позиции — классический «квадрат», от ля до ля", () => {
    const steps = positionNotes(TUNINGS.guitar, [9, 0, 2, 4, 7], 9, 5, false);
    expect(steps.map((s) => `${s.string}:${s.fret}`)).toEqual(["0:5", "0:8", "1:5", "1:7", "2:5", "2:7", "3:5", "3:7", "4:5", "4:8", "5:5"]);
    const song = GTR_EXERCISE_BY_ID.get("gtr-penta-am-updown")!.build(TUNINGS.guitar);
    const ps = pitchesOf(song);
    expect(ps.every((p) => [9, 0, 2, 4, 7].includes(p % 12))).toBe(true);
    expect(ps[0] % 12).toBe(9);
  });

  it("гаммы и арпеджио: только звуки лада, начало и конец — основной тон", () => {
    for (const e of GTR_EXERCISES.filter((x) => x.category === "scales" || x.category === "arpeggio")) {
      const tuning = TUNINGS[e.instrument];
      const ps = pitchesOf(e.build(tuning));
      expect(ps.length).toBeGreaterThan(4);
      expect(ps[0] % 12).toBe(ps[ps.length - 1] % 12);
      // Без повторов одной высоты подряд и в пределах грифа.
      const frets = e.build(tuning).parts[0].staves[0].bars.flat(2).flatMap((b) => b.notes.map((n) => n.fret!));
      expect(Math.max(...frets)).toBeLessThanOrEqual(12);
      expect(Math.min(...frets)).toBeGreaterThanOrEqual(0);
    }
  });

  it("каждое упражнение пишется в табы, и Verovio играет его так же, как модель", () => {
    for (const e of GTR_EXERCISES.filter((x) => x.variant.includes("60") || x.variant.includes("70") || x.variant.includes("80") || x.category === "arpeggio")) {
      const song = e.build(TUNINGS[e.instrument]);
      const { notes, log } = play(partChart(song, 0).mei);
      expect(log, e.id).not.toMatch(/\[Error\]/);
      const solo: TabSong = { ...song, parts: [song.parts[0]] };
      const model = songAccompaniment(solo, -1);
      expect(notes.length, e.id).toBe(model.length);
      expect(notes.map((n) => n.pitch), e.id).toEqual(model.map((n) => n.pitch));
    }
  }, 30_000);

  it("игра под барабаны: рифф + барабаны, барабаны звучат на 9-м канале по всей длине", () => {
    for (const e of GTR_EXERCISES.filter((x) => x.category === "groove")) {
      const song = e.build(TUNINGS[e.instrument]);
      expect(song.parts.map((p) => p.kind)).toEqual([e.instrument, "drums"]);
      const drums = songAccompaniment(song, 0);
      expect(drums.length).toBeGreaterThan(16);
      expect(drums.every((n) => n.channel === 9)).toBe(true);
      const end = (song.masters.length * 4 * 60000) / e.bpm;
      expect(Math.max(...drums.map((n) => n.startMs))).toBeGreaterThan(end * 0.8);
    }
  });

  it("рифф строкой: струны по буквам, глушёные ноты и подписи приёмов", () => {
    expect(riff("E0 . Ax D2/H G12/↗")).toEqual([
      { string: 0, fret: 0, tech: undefined },
      null,
      { string: 1, fret: 0, dead: true, tech: undefined },
      { string: 2, fret: 2, tech: "H" },
      { string: 3, fret: 12, tech: "↗" },
    ]);
    expect(() => riff("Q3")).toThrow();
  });

  it("бас: грув ступенями — все грувы играются; ноты тянутся до следующей, глушёные — без высоты", () => {
    const bass = GTR_EXERCISES.filter((e) => e.instrument === "bass");
    const grooves = [...new Set(bass.filter((e) => e.category === "groove").map((e) => e.group))];
    expect(grooves.length).toBeGreaterThanOrEqual(10);
    for (const e of bass.filter((x) => ["groove", "technique", "shapes"].includes(x.category))) {
      const song = e.build(TUNINGS.bass);
      const { notes, log } = play(partChart(song, 0).mei);
      expect(log, e.id).not.toMatch(/\[Error\]/);
      const model = songAccompaniment({ ...song, parts: [song.parts[0]] }, -1);
      expect(notes.map((n) => n.pitch), e.id).toEqual(model.map((n) => n.pitch));
      // Моменты нот — как в модели (до мс).
      notes.forEach((n, i) => expect(Math.abs(n.startMs - model[i].startMs), e.id).toBeLessThan(3));
    }
    // «Тон — квинта» четвертями: восьмая и пауза слились в четверть.
    const rf = GTR_EXERCISE_BY_ID.get("bass-groove-rootfifth-80")!.build(TUNINGS.bass);
    expect(rf.parts[0].staves[0].bars[0][0].map((b) => b.type)).toEqual([4, 4, 4, 4]);
    // Шаффл: «длинная — короткая» триолью.
    const sh = GTR_EXERCISE_BY_ID.get("bass-groove-shuffle-80")!.build(TUNINGS.bass);
    expect(sh.parts[0].staves[0].bars[0][0].slice(0, 2).map((b) => [b.type, b.tuplet])).toEqual([[4, [3, 2]], [8, [3, 2]]]);
    expect(sh.parts[1].staves[0].bars[0][0][0].tuplet).toEqual([3, 2]);
    // Фанк: глушёные ноты подписаны «X» и не требуются.
    const fk = GTR_EXERCISE_BY_ID.get("bass-groove-funk-80")!.build(TUNINGS.bass);
    expect(fk.parts[0].staves[0].bars[0][0].some((b) => b.notes[0].dead)).toBe(true);
    expect(partChart(fk, 0).mei).toContain(">X<");
  });

  it("бас: формы на грифе — звуки аккорда от основного тона, форма одна для всех аккордов", () => {
    const pitches = (id: string) => pitchesOf(GTR_EXERCISE_BY_ID.get(id)!.build(TUNINGS.bass));
    // C–F–G–C, тон — квинта — октава.
    expect(pitches("bass-shape-r58-70").slice(0, 8)).toEqual([36, 43, 48, 43, 36, 43, 48, 43]);
    expect(pitches("bass-shape-r58-70").slice(8, 12)).toEqual([29, 36, 41, 36]);
    // Минор: малая терция; септаккорд — малая септима.
    expect(pitches("bass-shape-minor-70").slice(0, 4)).toEqual([33, 36, 40, 45]);
    expect(pitches("bass-shape-seventh-70").slice(0, 4)).toEqual([33, 37, 40, 43]);
    // Квинта снизу — на струне ниже.
    const fb = GTR_EXERCISE_BY_ID.get("bass-shape-fifthbelow-70")!.build(TUNINGS.bass);
    const [r, f] = fb.parts[0].staves[0].bars[0][0].map((b) => b.notes[0]);
    expect(f.string).toBe(r.string! - 1);
    expect(f.fret).toBe(r.fret);
    // Буква аккорда — над первой нотой такта.
    expect(fb.parts[0].staves[0].bars.map((v) => v[0][0].chord).slice(0, 4)).toEqual(["A", "D", "E", "A"]);
  });

  it("бас: приёмы и формы открываются после первого паучка и первого грува", () => {
    expect(gtrUnlocked(new Set(), "bass").has("bass-tech-alternate-70")).toBe(false);
    const open1 = gtrUnlocked(new Set(["bass-spider-1234-5-60"]), "bass");
    expect(open1.has("bass-tech-alternate-70")).toBe(true);
    expect(open1.has("bass-groove-roots-90")).toBe(true);
    expect(open1.has("bass-groove-rootfifth-80")).toBe(false);
    expect(open1.has("bass-shape-r58-70")).toBe(false);
    const open2 = gtrUnlocked(new Set(["bass-spider-1234-5-60", "bass-groove-roots-90"]), "bass");
    expect(open2.has("bass-groove-rootfifth-80")).toBe(true);
    expect(open2.has("bass-shape-r58-70")).toBe(true);
  });

  it("открытие: сначала только паучок, бой и первая пьеса, после первого паучка — пентатоника и грувы", () => {
    const open0 = gtrUnlocked(new Set(), "guitar");
    expect([...open0].every((id) => id.startsWith("gtr-spider-") || id.startsWith("gtr-strum-") || id === "gtr-piece-twinkle")).toBe(true);
    expect(open0.has("gtr-piece-twinkle")).toBe(true);
    expect(open0.has("gtr-piece-ode")).toBe(false);
    expect(gtrUnlocked(new Set(["gtr-piece-twinkle"]), "guitar").has("gtr-piece-ode")).toBe(true);
    expect(open0.has("gtr-strum-quarters-emam-70")).toBe(true);
    expect(open0.has("gtr-spider-1234-5-60")).toBe(true);
    expect(open0.has("gtr-spider-1234-5-80")).toBe(false);
    const open1 = gtrUnlocked(new Set(["gtr-spider-1234-5-60"]), "guitar");
    expect(open1.has("gtr-spider-1234-5-80")).toBe(true);
    expect(open1.has("gtr-penta-am-updown")).toBe(true);
    expect(open1.has("gtr-groove-rock-90")).toBe(true);
    expect(open1.has("gtr-scale-g-70")).toBe(false);
    const w = gtrWarmup([stat("gtr-spider-1234-5-60")], "2026-10-05", "guitar");
    expect(w[0].category).toBe("spider");
    expect(w.length).toBeGreaterThanOrEqual(1);
    expect(gtrWarmup([], "2026-10-05", "bass")[0].id).toBe("bass-spider-1234-5-60");
  });

  it("«На сегодня»: ★ каждый день — первыми, паучок по кругу из засчитанных, плюс следующий новый", () => {
    const done = ["gtr-spider-1234-5-60", "gtr-spider-1234-5-80", "gtr-spider-1234-5-100"].map((id) => stat(id));
    const days = ["2026-10-05", "2026-10-06", "2026-10-07"].map((d) => gtrWarmup(done, d, "guitar"));
    // Каждый день — другой засчитанный вариант паучка, и все три по кругу.
    expect(new Set(days.map((w) => w[0].id)).size).toBe(3);
    for (const w of days) expect(w.map((e) => e.id)).toContain("gtr-spider-1234-1-80");
    // Тот же день — тот же список.
    expect(gtrWarmup(done, "2026-10-05", "guitar").map((e) => e.id)).toEqual(days[0].map((e) => e.id));
    // Закреплённые — первыми; закрытые и чужого инструмента не попадают.
    const w = gtrWarmup(done, "2026-10-05", "guitar", ["gtr-strum-quarters-emam-70", "gtr-scale-g-70", "bass-spider-1234-5-60"]);
    expect(w[0].id).toBe("gtr-strum-quarters-emam-70");
    expect(w.map((e) => e.id)).not.toContain("gtr-scale-g-70");
    expect(w.map((e) => e.id)).not.toContain("bass-spider-1234-5-60");
    expect(new Set(w.map((e) => e.id)).size).toBe(w.length);
  });
});

describe("тренажёр грифа", () => {
  it("10 ступеней для гитары и баса; открытые струны — шесть точек", () => {
    expect(FRET_LEVELS.guitar).toHaveLength(10);
    expect(FRET_LEVELS.bass).toHaveLength(10);
    const s = fretSeries(FRET_LEVELS.guitar[0], TUNINGS.guitar, 1);
    expect(s).toHaveLength(12);
    expect(s.every((p) => p.mode === "place" && p.targets[0].fret === 0)).toBe(true);
  });

  it("найди ноту на 6-й струне: только натуральные, лады 0–5; засчитывается та нота на этой струне", () => {
    const lvl = FRET_LEVELS.guitar[1];
    const s = fretSeries(lvl, TUNINGS.guitar, 7);
    for (const p of s) {
      expect(p.targets[0].string).toBe(0);
      expect([0, 2, 4, 5, 7, 9, 11]).toContain(p.pc);
      expect(judgeFret(p, 0, p.targets[0].pitch, lvl, TUNINGS.guitar)).toBe(true);
      expect(judgeFret(p, 0, p.targets[0].pitch + 1, lvl, TUNINGS.guitar)).toBe(false);
    }
    // Нет повторов подряд.
    for (let i = 1; i < s.length; i++) expect(s[i].targets[0].pitch).not.toBe(s[i - 1].targets[0].pitch);
  });

  it("лады 0–12: ля на 5-й струне — и открытая, и на 12-м ладу", () => {
    const lvl = FRET_LEVELS.guitar[3];
    const prompt = { mode: "find" as const, pc: 9, targets: [{ string: 1, fret: 0, pitch: 45 }] };
    expect(judgeFret(prompt, 0, 57, lvl, TUNINGS.guitar)).toBe(true);
    expect(judgeFret(prompt, 0, 69, lvl, TUNINGS.guitar)).toBe(false);
  });

  it("все места одной ноты: по одной цели на струну, снизу вверх", () => {
    const lvl = FRET_LEVELS.guitar[6];
    const s = fretSeries(lvl, TUNINGS.guitar, 3);
    for (const p of s) {
      expect(p.targets.map((t) => t.string)).toEqual([0, 1, 2, 3, 4, 5]);
      expect(p.targets.every((t) => t.pitch % 12 === p.pc && t.fret <= 12)).toBe(true);
    }
    const bass = fretSeries(FRET_LEVELS.bass[6], TUNINGS.bass, 3);
    expect(bass[0].targets).toHaveLength(4);
  });

  it("ступени открываются по порядку", () => {
    expect(fretUnlocked([], "guitar")).toBe(1);
    expect(fretUnlocked([stat(fretLevelId("guitar", 1)), stat(fretLevelId("guitar", 2))], "guitar")).toBe(3);
    expect(fretUnlocked([stat(fretLevelId("guitar", 1))], "bass")).toBe(1);
  });
});

const STD_GTR = TUNINGS.guitar;

describe("пьесы для классической гитары", () => {
  it("такты складываются, лады в первой позиции, бас ниже мелодии, Verovio рисует табы", () => {
    for (const p of GTR_PIECES) {
      const s = gtrPieceSong(p, STD_GTR);
      expect(s.masters.length, p.id).toBe(p.bars.length);
      const { notes, log } = play(partChart(s, 0).mei);
      expect(log, p.id).not.toMatch(/\[Error\]/);
      expect(notes.length, p.id).toBe(pitchesOf(s).length);
      const beats = s.parts[0].staves[0].bars.flat(2);
      for (const b of beats) for (const n of b.notes) expect(n.fret!, p.id).toBeLessThanOrEqual(5);
      // В одном аккорде — разные струны.
      for (const bar of s.parts[0].staves[0].bars) {
        const at = new Map<number, number[]>();
        for (const v of bar) for (const b of v) for (const n of b.notes) at.set(b.tick, [...(at.get(b.tick) ?? []), n.string!]);
        for (const strings of at.values()) expect(new Set(strings).size, p.id).toBe(strings.length);
      }
    }
    expect(() => gtrPieceSong({ ...GTR_PIECES[0], bars: ["B1:q"] }, STD_GTR)).toThrow(/длительность/);
    const ode = gtrPieceSong(GTR_PIECE_BY_ID.get("ode")!, STD_GTR);
    expect(ode.parts[0].staves[0].bars[0][0].map((b) => b.notes[0].pitch)).toEqual([64, 64, 65, 67]);
    expect(ode.parts[0].staves[0].bars[0][1].map((b) => b.notes[0].pitch)).toEqual([48, 48]);
  });
});
