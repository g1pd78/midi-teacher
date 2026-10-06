import { describe, expect, it } from "vitest";
import { evalCode } from "./evaluate";
import { riffToMini, gridToMini, type RiffNote } from "./gen";
import { drumMidi, noteNameToMidi, notesToSong, patternNotes } from "./haps";
import { chordFromNotes, estimateKey, parseScale } from "./harmony";
import { YouJudge } from "./judge";
import { feedLive, liveCc, liveKb, resetLive } from "./live";
import { evalInfo, setPanel } from "./mt";
import { portableCode } from "./portable";
import { base64url, builtinSampleMap, GM_NAMES, gmProgram, midiName, proxiedMap } from "./sounds";

const notesOf = async (code: string, cycles = 1) => {
  const r = await evalCode(code);
  return patternNotes(r.pattern, 0, cycles);
};

describe("звуки", () => {
  it("имена GM как у Strudel и программы GM", () => {
    expect(GM_NAMES).toHaveLength(125);
    expect(gmProgram(GM_NAMES.indexOf("piano"))).toBe(0);
    expect(gmProgram(GM_NAMES.indexOf("epiano1"))).toBe(4);
    expect(gmProgram(GM_NAMES.indexOf("acoustic_bass"))).toBe(32);
    expect(gmProgram(GM_NAMES.indexOf("gunshot"))).toBe(127);
    expect(midiName(60)).toBe("c4");
    const map = builtinSampleMap((p) => `mt:${p}`);
    expect(map.bd).toEqual(["mt:drum/36.wav", "mt:drum/35.wav"]);
    expect((map.gm_acoustic_bass as Record<string, string[]>).c2).toEqual(["mt:gm/32/36.wav"]);
    expect(Object.keys(map.piano)).toContain("a0");
  });

  it("стандартные наборы — через кэш приложения", () => {
    const m = proxiedMap({ _base: "https://x.org/s/", bd: ["bd/1.wav"], piano: { c4: "p/c4.wav" } }, "https://x.org/map.json", (p) => p);
    expect(m.bd).toEqual([`net/${base64url("https://x.org/s/bd/1.wav")}`]);
    expect((m.piano as Record<string, string[]>).c4).toEqual([`net/${base64url("https://x.org/s/p/c4.wav")}`]);
  });
});

describe("выполнение кода и ноты", () => {
  it("партии собираются и помечаются; темп из setcps", async () => {
    const r = await evalCode(`setcps(0.75)\ndrums: s("bd sd")\nmelody: note("c4 e4")`);
    expect(Object.keys(r.parts)).toEqual(["drums", "melody"]);
    expect(r.cps).toBe(0.75);
    const ns = patternNotes(r.pattern, 0, 1);
    expect(ns.map((n) => [n.part, n.midi, n.drum])).toEqual([
      ["drums", 36, true],
      ["melody", 60, false],
      ["drums", 38, true],
      ["melody", 64, false],
    ]);
  });

  it("названия нот, частоты и ударные", () => {
    expect(noteNameToMidi("c4")).toBe(60);
    expect(noteNameToMidi("Eb3")).toBe(51);
    expect(noteNameToMidi("f#5")).toBe(78);
    expect(noteNameToMidi("a")).toBe(57);
    expect(drumMidi({ s: "sd:1" })).toBe(40);
    expect(drumMidi({ s: "RolandTR909_hh" })).toBe(42);
    expect(drumMidi({ s: "piano" })).toBeNull();
  });

  it("лад из scale() даёт высоты", async () => {
    const ns = await notesOf(`$: n("0 2 4").scale("A:minor")`);
    expect(ns.map((n) => n.midi)).toEqual([57, 60, 64]);
  });

  it("партия в трек Студии: такт = цикл", async () => {
    const r = await evalCode(`setcps(0.5)\nbass: note("a1 e2")`);
    const song = notesToSong(patternNotes(r.pattern, 0, 2), "Бас", r.cps, 2);
    expect(song.bpm).toBe(120);
    expect(song.bars).toBe(2);
    expect(song.tracks).toHaveLength(1);
    const notes = song.tracks[0].takes[0].notes;
    expect(notes.map((n) => [n.pitch, n.startMs])).toEqual([
      [33, 0],
      [40, 1000],
      [33, 2000],
      [40, 3000],
    ]);
  });
});

describe("рифф → код", () => {
  const roundTrip = async (notes: RiffNote[], cycles: number) => {
    const code = riffToMini(notes, cycles);
    const back = await notesOf(`$: ${code}`, cycles);
    return { code, back: back.map((n) => [Math.round(n.begin * 16) / 16, n.midi]) };
  };

  it("простой рифф: паузы и длительности, звучит так же", async () => {
    const notes: RiffNote[] = [
      { begin: 0, dur: 0.25, midi: 60 },
      { begin: 0.5, dur: 0.5, midi: 64 },
    ];
    const { code, back } = await roundTrip(notes, 1);
    expect(code).toBe('note("c4 ~ e4@2")');
    expect(back).toEqual([
      [0, 60],
      [0.5, 64],
    ]);
  });

  it("неровное нажатие выравнивается по сетке, аккорд — в скобках", async () => {
    const { code, back } = await roundTrip(
      [
        { begin: 0.01, dur: 0.24, midi: 60 },
        { begin: 0.0, dur: 0.24, midi: 64 },
        { begin: 0.26, dur: 0.2, midi: 67 },
      ],
      1,
    );
    expect(code).toBe('note("[c4,e4]@4 g4@3 ~@9")');
    expect(back).toEqual([
      [0, 60],
      [0, 64],
      [0.25, 67],
    ]);
  });

  it("разные такты — через <…>, повтор сворачивается", async () => {
    const notes: RiffNote[] = [
      { begin: 0, dur: 1, midi: 45 },
      { begin: 1, dur: 1, midi: 45 },
      { begin: 2, dur: 0.5, midi: 41 },
      { begin: 2.5, dur: 0.5, midi: 43 },
    ];
    const { code, back } = await roundTrip(notes, 3);
    expect(code).toBe('note("<a2!2 [f2 g2]>")');
    expect(back).toEqual([
      [0, 45],
      [1, 45],
      [2, 41],
      [2.5, 43],
    ]);
  });

  it("грув по клеткам → s()", async () => {
    const cells = (on: number[]) => Array.from({ length: 16 }, (_, i) => on.includes(i));
    const code = gridToMini([
      { sound: "bd", cells: cells([0, 8]) },
      { sound: "sd", cells: cells([4, 12]) },
      { sound: "hh", cells: cells([0, 2, 4, 6, 8, 10, 12, 14]) },
    ]);
    expect(code).toBe('s("bd bd, ~ sd ~ sd, hh hh hh hh hh hh hh hh")');
    const ns = await notesOf(`$: ${code}`);
    expect(ns.filter((n) => n.s === "sd").map((n) => n.begin)).toEqual([0.25, 0.75]);
  });
});

describe("моя партия и «Повтори за мной»", () => {
  it("панель: партия становится моей (не звучит, оценивается)", async () => {
    setPanel({ myPart: "melody" });
    try {
      const ns = await notesOf(`drums: s("bd")\nmelody: note("c4 e4")`);
      expect(ns.filter((n) => n.you).map((n) => n.midi)).toEqual([60, 64]);
      expect(ns.find((n) => n.drum)?.you).toBe(false);
      expect(evalInfo().parts).toEqual(["drums", "melody"]);
    } finally {
      setPanel({});
    }
  });

  it("echo(): фраза на чётном цикле, мой повтор — на нечётном", async () => {
    const ns = await notesOf(`$: echo(note("<c4 d4>"))`, 4);
    expect(ns.map((n) => [n.begin, n.midi, n.you])).toEqual([
      [0, 60, false],
      [1, 60, true],
      [2, 62, false],
      [3, 62, true],
    ]);
    expect(evalInfo().hasYou).toBe(true);
  });

  it(".you() в коде", async () => {
    const ns = await notesOf(`$: note("c4 e4").you()`);
    expect(ns.every((n) => n.you)).toBe(true);
  });

  it("harmony() — аккорды и лад для импровизации, сам не звучит", async () => {
    const ns = await notesOf(`harmony("<A7 D7>", "A:minor:pentatonic")\n$: s("bd")`);
    expect(ns).toHaveLength(1);
    const h = evalInfo().harmony!;
    expect(h.scale).toBe("A:minor:pentatonic");
    expect(h.chords.queryArc(1, 1.5)[0].value).toBe("D7");
  });
});

describe("оценка игры поверх кода", () => {
  it("вовремя, близко, лишние, пропуски", () => {
    const j = new YouJudge();
    const cps = 0.5; // цикл = 2 с
    j.expect(
      [
        { begin: 0, midi: 60 },
        { begin: 0.25, midi: 62 },
        { begin: 0.5, midi: 64 },
      ],
      cps,
    );
    expect(j.play(60, 0.01, cps).kind).toBe("good"); // +20 мс
    expect(j.play(62, 0.25 + 0.04, cps).kind).toBe("ok"); // +80 мс
    expect(j.play(70, 0.3, cps).kind).toBe("extra");
    expect(j.tick(0.5 + 0.07)).toEqual([{ begin: 0.5, midi: 64 }]); // окно 120 мс прошло
    const s = j.summary();
    expect([s.good, s.ok, s.misses, s.extras]).toEqual([1, 1, 1, 1]);
    expect(s.meanDeltaMs).toBe(50);
  });

  it("в любой октаве", () => {
    const j = new YouJudge(true);
    j.expect([{ begin: 0, midi: 60 }], 0.5);
    expect(j.play(72, 0, 0.5).kind).toBe("good");
  });
});

describe("гармония", () => {
  it("лад из текста и по нотам", async () => {
    expect(parseScale("A:minor")).toEqual({ tonic: 9, scale: "minor" });
    expect(parseScale("E minor pentatonic")).toEqual({ tonic: 4, scale: "minpenta" });
    expect(parseScale("C:lydian")).toBeNull();
    const ns = await notesOf(`$: note("<[a3 c4 e4] [d4 f4 a4] [e4 g#4 b4] [a3 c4 e4]>")`, 4);
    expect(estimateKey(ns)).toEqual({ tonic: 9, scale: "minor" });
  });

  it("аккорд по звучащим нотам", async () => {
    const ns = await notesOf(`$: chord("Am").voicing()`);
    expect(chordFromNotes(ns)?.symbol).toBe("Am");
  });
});

describe("живые данные с клавиатуры", () => {
  it("kb() и CC по устройствам", () => {
    resetLive();
    feedLive({ device: "Arturia KeyStep", channel: 0, timeUs: 0, type: "noteOn", note: 65, velocity: 100 });
    feedLive({ device: "NPK", channel: 0, timeUs: 0, type: "controlChange", controller: 74, value: 127 });
    expect(liveKb().note).toBe(65);
    expect(liveKb("arturia").gate).toBe(true);
    expect(liveKb("NPK").note).toBe(60);
    expect(liveCc(undefined, 74)).toBe(1);
    expect(liveCc("npk", 74, 1)).toBe(1);
    expect(liveCc("arturia", 74)).toBe(0);
  });
});

describe("Для strudel.cc", () => {
  it("наши функции убраны, свои сэмплы — через samples()", async () => {
    const code = `harmony("<Am F>", "A:minor")
$: s("whatUneed:1 bd")
$: echo(note("c4 e4").s("piano"))
$: note("a2").add(kb().note.sub(60)).you()
`;
    const out = portableCode(code, { panel: { myPart: "$0" }, userSamples: { whatUneed: ["whatUneed/1.wav"], other: ["o.wav"] } });
    expect(out).not.toMatch(/echo\(|\.you\(|kb\(|^harmony/m);
    expect(out).toContain('note("c4 e4").s("piano")');
    expect(out).toContain("pure(60).sub(60)");
    expect(out).toContain('whatUneed: ["whatUneed/1.wav"]');
    expect(out).not.toContain("o.wav");
    expect(out).toContain("Партия 1");
    // И это по-прежнему код Strudel (без наших функций): выполняется.
    const ns = await notesOf(out.replace(/^samples\([\s\S]*?\)\n/m, ""));
    expect(ns.some((n) => n.midi === 60)).toBe(true);
  });
});
