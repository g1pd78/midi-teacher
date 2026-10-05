import { describe, expect, it } from "vitest";
import {
  DEFAULT_MIX,
  ECHO_LEVELS,
  JAM_LESSONS,
  JAM_STYLES,
  boxWindow,
  chordAt,
  chordScale,
  classify,
  customErrors,
  defaultSetup,
  echoPlayback,
  echoSeries,
  evaluateLesson,
  jamAccompaniment,
  jamPlan,
  jamStats,
  judgeEcho,
  phrases,
  romanToChord,
  scalePcs,
  soloSong,
  styleChords,
  type PlayedNote,
} from "./jam";
import { chordPcs, parseChord } from "./chords";

describe("джем: стили и аккомпанемент", () => {
  it("ступени → аккорды в тональности", () => {
    expect(["I7", "IV7", "V7", "i", "bVII", "bVI", "i7", "vi"].map((r) => romanToChord(9, r))).toEqual(["A7", "D7", "E7", "Am", "G", "F", "Am7", "F#m"]);
    expect(romanToChord(5, "IV")).toBe("Bb");
    expect(styleChords(JAM_STYLES[0], 9)).toBe("A7 | D7 | A7 | A7 | D7 | D7 | A7 | A7 | E7 | D7 | A7 | E7");
  });

  it("план: аккорды во времени по кругам; своя последовательность", () => {
    const plan = jamPlan(defaultSetup("pop"), 2);
    expect(plan.loopBars).toBe(4);
    expect(plan.chords.map((c) => c.symbol)).toEqual(["C", "G", "Am", "F", "C", "G", "Am", "F"]);
    expect(plan.chords[1].startMs).toBeCloseTo((60000 / 95) * 4);
    expect(chordAt(plan, plan.barMs * 2.5)?.symbol).toBe("Am");
    expect(plan.chords[5].bar).toBe(1);
    const own = jamPlan({ ...defaultSetup("pop"), custom: "Dm G | C" }, 1);
    expect(own.chords.map((c) => [c.symbol, c.durMs / own.beatMs])).toEqual([
      ["Dm", 2],
      ["G", 2],
      ["C", 4],
    ]);
    expect(customErrors("C | Xq")).toEqual(["Xq"]);
  });

  it("аккомпанемент: отсчёт, барабаны, бас (без него — когда играешь на басу), аккорды со своей громкостью", () => {
    for (const style of JAM_STYLES) {
      const setup = defaultSetup(style.id);
      const plan = jamPlan(setup, 1);
      const notes = jamAccompaniment(setup, plan, DEFAULT_MIX, "guitar");
      const off = 4 * plan.beatMs;
      expect(notes.filter((n) => n.startMs < off - 1).every((n) => n.channel === 9), style.id).toBe(true);
      expect(notes.some((n) => n.channel === 1), style.id).toBe(true);
      expect(notes.some((n) => n.channel === 2), style.id).toBe(true);
      expect(Math.max(...notes.map((n) => n.startMs)), style.id).toBeGreaterThan(off + (plan.loopBars - 1) * plan.barMs);
      expect(jamAccompaniment(setup, plan, DEFAULT_MIX, "bass").some((n) => n.channel === 1), style.id).toBe(false);
    }
    const plan = jamPlan(defaultSetup("blues"), 1);
    const quiet = jamAccompaniment(defaultSetup("blues"), plan, { ...DEFAULT_MIX, drums: false, chordsVolume: 50 }, "piano");
    expect(quiet.filter((n) => n.channel === 9)).toHaveLength(4);
    expect(new Set(quiet.filter((n) => n.channel === 2).map((n) => n.velocity))).toEqual(new Set([64]));
  });
});

describe("джем: оценка нот и уроки", () => {
  const am = parseChord("Am")!;
  it("звук аккорда, гамма, вне гаммы; гамма под аккорд", () => {
    const sc = scalePcs(9, "minpenta");
    expect([57, 62, 63].map((p) => classify(p, am, sc))).toEqual(["chord", "scale", "out"]);
    expect(chordScale(parseChord("D7")!)).toEqual(scalePcs(2, "mixolydian"));
    expect(chordScale(parseChord("Am7")!)).toEqual(scalePcs(9, "dorian"));
  });

  it("фразы — по паузам от доли; итог: доли нот", () => {
    const n = (t: number, pitch = 57): PlayedNote => ({ t, pitch });
    expect(phrases([n(0), n(300), n(600), n(2000), n(2200)], 600).map((p) => p.length)).toEqual([3, 2]);
    const plan = jamPlan(defaultSetup("rock"), 1);
    const s = jamStats([n(0, 57), n(300, 62), n(600, 63)], plan, scalePcs(9, "minpenta"));
    expect([s.chord, s.scale, s.out, s.phrases]).toEqual([1, 1, 1, 1]);
  });

  it("урок «только гамма»: 90% нот в гамме", () => {
    const lesson = JAM_LESSONS[0];
    const plan = jamPlan(lesson.setup, lesson.loops);
    const good = Array.from({ length: 20 }, (_, i) => ({ t: i * 300, pitch: [57, 60, 62, 64, 67][i % 5] }));
    expect(evaluateLesson(lesson, good, plan).passed).toBe(true);
    const bad = good.map((n, i) => (i % 4 === 0 ? { ...n, pitch: 58 } : n));
    expect(evaluateLesson(lesson, bad, plan).passed).toBe(false);
    expect(evaluateLesson(lesson, good.slice(0, 5), plan).detail).toMatch(/нужно хотя бы/);
  });

  it("урок «заканчивай на звуке аккорда»: последняя нота фразы — звук аккорда", () => {
    const lesson = JAM_LESSONS[2];
    const plan = jamPlan(lesson.setup, lesson.loops);
    // Фразы по 4 ноты, пауза в такт; последняя — основной тон текущего аккорда.
    const notes: PlayedNote[] = [];
    for (let b = 0; b < 6; b++) {
      const c = chordAt(plan, b * plan.barMs + 10)!;
      [62, 64, 69].forEach((p, i) => notes.push({ t: b * plan.barMs + i * 250, pitch: p }));
      notes.push({ t: b * plan.barMs + 750, pitch: 48 + chordPcs(c.chord)[0] });
    }
    const r = evaluateLesson(lesson, notes, plan);
    expect(r).toMatchObject({ passed: true, detail: "Фраз на звуке аккорда: 6 из 6." });
    // Последняя нота — не звук аккорда (ре над до мажором): не засчитано.
    expect(evaluateLesson(lesson, notes.map((n, i) => (i % 4 === 3 ? { ...n, pitch: 62 + (i % 8 === 3 ? 0 : 12) } : n)), plan).passed).toBe(false);
  });

  it("урок «вопрос — ответ»: молчать в такте вопроса, отвечать в своём", () => {
    const lesson = JAM_LESSONS[3];
    const plan = jamPlan(lesson.setup, lesson.loops);
    const bars = plan.loopBars * plan.loops;
    const notes: PlayedNote[] = [];
    for (let b = 1; b < bars; b += 2) [57, 60, 62].forEach((p, i) => notes.push({ t: b * plan.barMs + i * 400, pitch: p }));
    expect(evaluateLesson(lesson, notes, plan).passed).toBe(true);
    // Играешь поверх вопросов — не засчитывается.
    const over = [...notes, ...notes.map((n) => ({ ...n, t: n.t - plan.barMs }))];
    expect(evaluateLesson(lesson, over, plan).passed).toBe(false);
  });

  it("урок «мотив»: фраза начинается с ля — до — ре", () => {
    const lesson = JAM_LESSONS[4];
    const plan = jamPlan(lesson.setup, lesson.loops);
    const notes: PlayedNote[] = [];
    for (let b = 0; b < 6; b++) [57, 60, 62, 64].forEach((p, i) => notes.push({ t: b * plan.barMs + i * 250, pitch: b % 2 ? p + 12 : p }));
    const r = evaluateLesson(lesson, notes, plan);
    expect(r.passed).toBe(true);
    expect(r.detail).toBe("Фраз с мотивом: 6 из 6.");
  });

  it("урок «смена гаммы»: гамма аккорда и звук нового аккорда на смене", () => {
    const lesson = JAM_LESSONS[5];
    const plan = jamPlan(lesson.setup, lesson.loops);
    const notes: PlayedNote[] = [];
    for (const c of plan.chords) {
      const ps = chordScale(c.chord);
      const base = 57;
      for (let i = 0; i < 4; i++) notes.push({ t: c.startMs + i * plan.beatMs, pitch: base + ((ps[i === 0 ? 0 : (i * 2) % ps.length] - base) % 12 + 12) % 12 });
    }
    expect(evaluateLesson(lesson, notes, plan).passed).toBe(true);
  });
});

describe("«Повтори за мной»", () => {
  it("серия: 8 фраз, ноты гаммы в регистре инструмента, моменты внутри такта", () => {
    for (const level of ECHO_LEVELS)
      for (const inst of ["piano", "guitar", "bass"] as const) {
        const s = echoSeries(level, 9, inst, 5);
        expect(s).toHaveLength(8);
        const sc = scalePcs(9, level.scale);
        for (const p of s) {
          expect(p.notes).toHaveLength(level.notes);
          for (const n of p.notes) {
            expect(sc).toContain(n.pitch % 12);
            expect(n.beat).toBeGreaterThanOrEqual(0);
            expect(n.beat).toBeLessThan(4);
          }
          for (let i = 1; i < p.notes.length; i++) expect(p.notes[i].beat).toBeGreaterThan(p.notes[i - 1].beat);
        }
        if (inst === "bass") expect(Math.max(...s.flatMap((p) => p.notes.map((n) => n.pitch)))).toBeLessThan(57);
      }
  });

  it("ответ: высоты по порядку (любая октава) и моменты ±0,3 доли", () => {
    const phrase = { chord: "Am", notes: [{ beat: 0, pitch: 57 }, { beat: 1, pitch: 60 }, { beat: 2, pitch: 62 }] };
    const at = (beats: number[], ps: number[]) => beats.map((b, i) => ({ t: 4000 + b * 500, pitch: ps[i] }));
    expect(judgeEcho(phrase, at([0, 1, 2], [45, 48, 50]), 4000, 500)).toEqual({ ok: true, pitches: true, rhythm: true });
    expect(judgeEcho(phrase, at([0, 1, 2], [57, 62, 60]), 4000, 500)?.pitches).toBe(false);
    expect(judgeEcho(phrase, at([0, 1.5, 2], [57, 60, 62]), 4000, 500)).toEqual({ ok: false, pitches: true, rhythm: false });
    expect(judgeEcho(phrase, [], 4000, 500)).toBeNull();
  });

  it("проигрывание: фразы в тактах вопроса, ответы — в следующих", () => {
    const s = echoSeries(ECHO_LEVELS[0], 9, "piano", 1);
    const { notes, answers } = echoPlayback(s, 80, DEFAULT_MIX, "piano");
    const beat = 60000 / 80;
    expect(answers[0]).toBeCloseTo(4 * beat);
    expect(answers[1]).toBeCloseTo(12 * beat);
    const lead = notes.filter((n) => n.channel === 3);
    expect(lead).toHaveLength(8 * 3);
    expect(lead[0].startMs).toBeCloseTo(4 * beat);
  });

  it("позиции пентатоники на грифе: окно 5 ладов от ноты гаммы на нижней струне", () => {
    const sc = scalePcs(9, "minpenta");
    expect(boxWindow(9, sc, 40, 1)).toEqual([5, 9]);
    expect(boxWindow(9, sc, 40, 2)).toEqual([8, 12]);
    expect(boxWindow(9, sc, 40, 0)).toBeNull();
  });
});

describe("разбор соло", () => {
  it("ноты по сетке шестнадцатых, длина до следующей, буквы аккордов; гитара — табами, фортепиано — нотами", () => {
    const plan = jamPlan(defaultSetup("pop"), 1);
    const six = plan.beatMs / 4;
    const notes: PlayedNote[] = [
      { t: 3, pitch: 60, dur: plan.beatMs * 0.9 },
      { t: 4 * six + 10, pitch: 64, dur: plan.beatMs * 3 },
      { t: plan.barMs - 5, pitch: 67, dur: plan.beatMs },
    ];
    const g = soloSong(notes, plan, "guitar", [40, 45, 50, 55, 59, 64])!;
    const bar0 = g.parts[0].staves[0].bars[0][0];
    expect(bar0.map((b) => [b.tick / 240, b.type, b.dots])).toEqual([
      [0, 4, 0],
      [4, 2, 1],
    ]);
    expect(bar0[0].chord).toBe("C");
    expect(bar0[0].notes[0].fret).toBeDefined();
    expect(g.parts[0].staves[0].bars[1][0][0].chord).toBe("G");
    const p = soloSong(notes, plan, "piano", [])!;
    expect(p.parts[0].kind).toBe("piano");
    expect(p.parts[0].staves[0].clef).toBe("G");
    expect(soloSong([], plan, "piano", [])).toBeNull();
  });
});
