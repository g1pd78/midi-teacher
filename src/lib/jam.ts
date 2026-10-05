// Импровизация и джем: стили аккомпанемента (барабаны, бас, аккорды) по кругу, гаммы и тональность,
// оценка нот ученика (звук аккорда / гамма / вне гаммы), фразы, правила уроков импровизации и
// «Повтори за мной» — приложение играет фразу, ученик повторяет в следующем такте.

import { bassLine, type BassStyle } from "./bassline";
import { chordPcs, type Chord } from "./chords";
import { patternBar } from "./drumPattern";
import { seeded } from "./exercises";
import { parseChart, type LeadSong } from "./songs";
import { assignPositions } from "./tab";
import { TPQ, writtenDuration, type TabSong, type TsBeat, type TsNote, type TsPart } from "./tabsong";

export type JamInstrument = "piano" | "guitar" | "bass";
export type ScaleId = "minpenta" | "majpenta" | "blues" | "major" | "minor" | "dorian" | "mixolydian";

export const SCALES: Record<ScaleId, { name: string; steps: number[] }> = {
  minpenta: { name: "Минорная пентатоника", steps: [0, 3, 5, 7, 10] },
  majpenta: { name: "Мажорная пентатоника", steps: [0, 2, 4, 7, 9] },
  blues: { name: "Блюзовая гамма", steps: [0, 3, 5, 6, 7, 10] },
  major: { name: "Мажор", steps: [0, 2, 4, 5, 7, 9, 11] },
  minor: { name: "Натуральный минор", steps: [0, 2, 3, 5, 7, 8, 10] },
  dorian: { name: "Дорийский лад", steps: [0, 2, 3, 5, 7, 9, 10] },
  mixolydian: { name: "Миксолидийский лад", steps: [0, 2, 4, 5, 7, 9, 10] },
};
export const SCALE_IDS = Object.keys(SCALES) as ScaleId[];

export type CompStyle = "hold" | "stabs" | "eighths" | "offbeat";

export interface JamStyle {
  id: string;
  name: string;
  description: string;
  /** Аккорды по тактам ступенями от тоники: «I7 | IV7 | …», «i | bVII»; несколько в такте — через пробел. */
  roman: string;
  /** Тональность по умолчанию (класс высоты тоники). */
  tonic: number;
  bpm: number;
  /** Барабаны: 16 клеток (шестнадцатые) или 12 (восьмые триолью). */
  drums: string[];
  triplet?: boolean;
  bass: BassStyle;
  comp: CompStyle;
  /** Инструмент аккордов GM. */
  compProgram: number;
  scale: ScaleId;
}

const ROCK = ["k:x.......x.x.....", "s:....x.......x...", "h:x.x.x.x.x.x.x.x."];
const POP = ["k:x.......x.......", "s:....x.......x...", "h:x.x.x.x.x.x.x.x."];
const FUNK = ["k:x.....x...x.....", "s:....x..x.x..x...", "h:xxxxxxxxxxxxxxxx"];
const BALLAD = ["k:x.........x.....", "s:........x.......", "h:x...x...x...x..."];
const SHUFFLE = ["k:x.....x.....", "s:...x.....x..", "r:x.xx.xx.xx.x"];

export const JAM_STYLES: JamStyle[] = [
  {
    id: "blues",
    name: "Блюз (12 тактов)",
    description: "Классический квадрат: I–IV–V, шаффл. Гамма — блюзовая (минорная пентатоника + «блюзовая нота»).",
    roman: "I7 | IV7 | I7 | I7 | IV7 | IV7 | I7 | I7 | V7 | IV7 | I7 | V7",
    tonic: 9,
    bpm: 90,
    drums: SHUFFLE,
    triplet: true,
    bass: "walking",
    comp: "stabs",
    compProgram: 0,
    scale: "blues",
  },
  {
    id: "rock",
    name: "Рок",
    description: "Минорный рок: i – ♭VII – ♭VI – ♭VII, ровные восьмые. Гамма — минорная пентатоника.",
    roman: "i | bVII | bVI | bVII",
    tonic: 9,
    bpm: 100,
    drums: ROCK,
    bass: "octaves",
    comp: "eighths",
    compProgram: 29,
    scale: "minpenta",
  },
  {
    id: "pop",
    name: "Поп",
    description: "Самая частая последовательность: I – V – vi – IV. Гамма — мажорная пентатоника.",
    roman: "I | V | vi | IV",
    tonic: 0,
    bpm: 95,
    drums: POP,
    bass: "rootfifth",
    comp: "hold",
    compProgram: 0,
    scale: "majpenta",
  },
  {
    id: "funk",
    name: "Фанк",
    description: "Два аккорда на шестнадцатых: i7 – IV7. Гамма — дорийский лад (или минорная пентатоника).",
    roman: "i7 | i7 | IV7 | IV7",
    tonic: 4,
    bpm: 95,
    drums: FUNK,
    bass: "octaves",
    comp: "offbeat",
    compProgram: 28,
    scale: "dorian",
  },
  {
    id: "ballad",
    name: "Баллада",
    description: "Медленно и широко: I – vi – IV – V. Гамма — мажор.",
    roman: "I | vi | IV | V",
    tonic: 7,
    bpm: 70,
    drums: BALLAD,
    bass: "roots",
    comp: "hold",
    compProgram: 0,
    scale: "major",
  },
];
export const JAM_STYLE_BY_ID = new Map(JAM_STYLES.map((s) => [s.id, s]));

const SHARP = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const FLAT = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"];
/** Тоники, в которых пишем бемоли. */
const FLAT_KEYS = new Set([5, 10, 3, 8, 1]);
export const KEY_NAMES = ["C", "C♯/D♭", "D", "E♭", "E", "F", "F♯", "G", "A♭", "A", "B♭", "B"];

const ROMAN = ["I", "II", "III", "IV", "V", "VI", "VII"];
const DEGREE = [0, 2, 4, 5, 7, 9, 11];

/** «bVII» в ля → «G»; «i7» → «Am7»; «IV7» → «D7». */
export function romanToChord(tonic: number, roman: string): string {
  const m = /^([b#]?)([ivIV]+)(.*)$/.exec(roman);
  if (!m) return roman;
  const k = ROMAN.indexOf(m[2].toUpperCase());
  if (k < 0) return roman;
  const pc = (tonic + DEGREE[k] + (m[1] === "b" ? -1 : m[1] === "#" ? 1 : 0) + 12) % 12;
  const minor = m[2] === m[2].toLowerCase();
  const names = FLAT_KEYS.has(tonic) || m[1] === "b" ? FLAT : SHARP;
  const ext = m[3];
  return names[pc] + (minor ? (ext === "7" ? "m7" : "m" + ext) : ext);
}

/** Аккорды стиля в тональности: текст по тактам, как в песнях по буквам. */
export function styleChords(style: JamStyle, tonic: number): string {
  return style.roman
    .split("|")
    .map((bar) =>
      bar
        .trim()
        .split(/\s+/)
        .map((r) => romanToChord(tonic, r))
        .join(" "),
    )
    .join(" | ");
}

/** Настройки джема: стиль, тональность, темп, гамма; своя последовательность заменяет аккорды стиля. */
export interface JamSetup {
  style: string;
  tonic: number;
  bpm: number;
  scale: ScaleId;
  /** Своя последовательность («C | Am | F | G») или пусто. */
  custom: string;
}

export function defaultSetup(styleId = "blues"): JamSetup {
  const s = JAM_STYLE_BY_ID.get(styleId) ?? JAM_STYLES[0];
  return { style: s.id, tonic: s.tonic, bpm: s.bpm, scale: s.scale, custom: "" };
}

/** Громкость партий 0–100; бас выключается сам, когда играешь на басу. */
export interface JamMix {
  drums: boolean;
  bass: boolean;
  chords: boolean;
  drumsVolume: number;
  bassVolume: number;
  chordsVolume: number;
}
export const DEFAULT_MIX: JamMix = { drums: true, bass: true, chords: true, drumsVolume: 80, bassVolume: 75, chordsVolume: 55 };

export interface JamChord {
  /** Начало и длина, мс от первой доли. */
  startMs: number;
  durMs: number;
  symbol: string;
  chord: Chord;
  /** Такт в круге (0…). */
  bar: number;
}

export interface JamPlan {
  chords: JamChord[];
  /** Аккорды одного круга по тактам (для схемы). */
  chart: string[];
  barMs: number;
  beatMs: number;
  loopBars: number;
  loops: number;
}

/** Песня по буквам из настроек: круг аккордов, повторённый `loops` раз. */
export function jamSong(setup: JamSetup, loops: number): LeadSong {
  const style = JAM_STYLE_BY_ID.get(setup.style) ?? JAM_STYLES[0];
  const one = setup.custom.trim() || styleChords(style, setup.tonic);
  return {
    id: "jam",
    title: "Джем",
    bpm: setup.bpm,
    beats: 4,
    unit: 4,
    fifths: 0,
    pickup: 0,
    melody: [],
    chords: Array.from({ length: loops }, () => one).join(" | "),
    style: "block",
  };
}

/** Аккорды во времени: `loops` кругов. Ошибки в своей последовательности — пустой план. */
export function jamPlan(setup: JamSetup, loops: number): JamPlan {
  const song = jamSong(setup, loops);
  const chart = parseChart(song.chords, song);
  const beatMs = 60000 / setup.bpm;
  const sixteenth = beatMs / 4;
  const loopBars = Math.max(1, Math.round(chart.bars / loops));
  const chords: JamChord[] = chart.chords.map((c, i) => {
    const end = chart.chords[i + 1]?.start ?? chart.bars * 16;
    return { startMs: c.start * sixteenth, durMs: (end - c.start) * sixteenth, symbol: c.chord.symbol, chord: c.chord, bar: Math.floor(c.start / 16) % loopBars };
  });
  const oneLoop = (setup.custom.trim() || styleChords(JAM_STYLE_BY_ID.get(setup.style) ?? JAM_STYLES[0], setup.tonic)).split("|").map((b) => b.trim());
  return { chords, chart: oneLoop, barMs: beatMs * 4, beatMs, loopBars, loops };
}

/** Ошибки своей последовательности (непонятные аккорды). */
export function customErrors(text: string): string[] {
  if (!text.trim()) return [];
  return parseChart(text, { beats: 4, unit: 4, pickup: 0 }).errors;
}

export function chordAt(plan: JamPlan, ms: number): JamChord | null {
  let cur: JamChord | null = null;
  for (const c of plan.chords) {
    if (c.startMs <= ms + 1e-6) cur = c;
    else break;
  }
  return cur;
}

export interface PlayNote {
  startMs: number;
  durMs: number;
  pitch: number;
  velocity: number;
  channel?: number;
  program?: number | null;
}

const vel = (v: number) => Math.max(1, Math.min(127, Math.round((v / 100) * 127)));
const voice = (c: Chord) => chordPcs(c).map((pc) => 55 + ((((pc - 55) % 12) + 12) % 12)).sort((a, b) => a - b);

export const COUNT_IN_BEATS = 4;
export const BASS_CHANNEL = 1;
export const CHORDS_CHANNEL = 2;
export const LEAD_CHANNEL = 3;

/**
 * Аккомпанемент джема для `play_notes`: такт отсчёта (хэт), барабаны стиля, бас (линия по
 * аккордам) и аккорды. Время — от начала проигрывания; первая доля — через `COUNT_IN_BEATS`.
 */
export function jamAccompaniment(setup: JamSetup, plan: JamPlan, mix: JamMix, instrument: JamInstrument): PlayNote[] {
  const style = JAM_STYLE_BY_ID.get(setup.style) ?? JAM_STYLES[0];
  const { beatMs, barMs } = plan;
  const off = COUNT_IN_BEATS * beatMs;
  const bars = plan.loopBars * plan.loops;
  const out: PlayNote[] = [];
  for (let k = 0; k < COUNT_IN_BEATS; k++) out.push({ startMs: k * beatMs, durMs: 80, pitch: k === 0 ? 37 : 42, velocity: vel(mix.drumsVolume), channel: 9 });
  if (mix.drums) {
    const cells = style.triplet ? 12 : 16;
    const cellTicks = style.triplet ? TPQ / 3 : TPQ / 4;
    const hits = patternBar(style.drums, cells, cellTicks);
    for (let b = 0; b < bars; b++)
      for (const h of hits) for (const n of h.notes) out.push({ startMs: off + b * barMs + (h.tick / TPQ) * beatMs, durMs: 80, pitch: n.pitch, velocity: vel(mix.drumsVolume), channel: 9 });
  }
  if (mix.bass && instrument !== "bass") {
    const sixteenth = beatMs / 4;
    for (const n of bassLine(jamSong(setup, plan.loops), style.bass, 28))
      out.push({ startMs: off + n.start * sixteenth, durMs: n.len * sixteenth * 0.92, pitch: n.pitch, velocity: vel(mix.bassVolume), channel: BASS_CHANNEL, program: 33 });
  }
  if (mix.chords) {
    for (const c of plan.chords) {
      const ps = voice(c.chord);
      const hits: { at: number; len: number }[] = [];
      const beats = Math.max(1, Math.round(c.durMs / beatMs));
      if (style.comp === "hold") hits.push({ at: 0, len: c.durMs * 0.97 });
      else if (style.comp === "stabs")
        // На 2 и 4 (и на «раз», если аккорд только начался).
        for (let k = 0; k < beats; k++) {
          const absBeat = Math.round((c.startMs + k * beatMs) / beatMs) % 4;
          if (absBeat === 1 || absBeat === 3 || k === 0) hits.push({ at: k * beatMs, len: beatMs * 0.45 });
        }
      else if (style.comp === "eighths") for (let k = 0; k < beats * 2; k++) hits.push({ at: (k * beatMs) / 2, len: beatMs * 0.4 });
      else for (let k = 0; k < beats; k++) hits.push({ at: k * beatMs + beatMs / 2, len: beatMs * 0.2 });
      for (const h of hits) for (const p of ps) out.push({ startMs: off + c.startMs + h.at, durMs: h.len, pitch: p, velocity: vel(mix.chordsVolume), channel: CHORDS_CHANNEL, program: style.compProgram });
    }
  }
  return out.sort((a, b) => a.startMs - b.startMs);
}

// --- Оценка нот ---

export type NoteClass = "chord" | "scale" | "out";

/** Классы высот гаммы от тоники. */
export const scalePcs = (tonic: number, scale: ScaleId) => SCALES[scale].steps.map((s) => (tonic + s) % 12);

/** Гамма под аккорд (урок «смена гаммы»): септаккорд — миксолидийский, минор — дорийский, мажор — мажор. */
export function chordScale(c: Chord): number[] {
  const root = chordPcs(c)[0];
  const id: ScaleId = c.quality === "7" || c.quality === "9" ? "mixolydian" : c.quality.startsWith("m") && c.quality !== "maj7" ? "dorian" : "major";
  return scalePcs(root, id);
}

export function classify(pitch: number, chord: Chord | null, scale: number[]): NoteClass {
  const pc = ((pitch % 12) + 12) % 12;
  if (chord && chordPcs(chord).includes(pc)) return "chord";
  return scale.includes(pc) ? "scale" : "out";
}

/** Нота ученика: время от первой доли (мс), высота, длительность (если отпущена). */
export interface PlayedNote {
  t: number;
  pitch: number;
  dur?: number;
}

export interface JamStats {
  total: number;
  chord: number;
  scale: number;
  out: number;
  phrases: number;
}

export function jamStats(notes: PlayedNote[], plan: JamPlan, scale: number[]): JamStats {
  const s = { total: notes.length, chord: 0, scale: 0, out: 0, phrases: phrases(notes, plan.beatMs).length };
  for (const n of notes) s[classify(n.pitch, chordAt(plan, n.t)?.chord ?? null, scale)]++;
  return s;
}

/** Фразы: ноты, между которыми пауза меньше доли. */
export function phrases(notes: PlayedNote[], beatMs: number): PlayedNote[][] {
  const out: PlayedNote[][] = [];
  const sorted = [...notes].sort((a, b) => a.t - b.t);
  for (const n of sorted) {
    const cur = out[out.length - 1];
    const last = cur?.[cur.length - 1];
    if (cur && last && n.t - last.t < beatMs) cur.push(n);
    else out.push([n]);
  }
  return out;
}

/** Советы по итогу свободного джема. */
export function jamTips(s: JamStats): string[] {
  const tips: string[] = [];
  if (!s.total) return ["Сыграй хоть что-нибудь: начни с двух-трёх нот гаммы и повторяй их в ритме."];
  if (s.out / s.total > 0.2) tips.push("Много нот вне гаммы: держись подсвеченных нот, «чужие» — только как короткие проходящие.");
  if (s.chord / s.total < 0.3) tips.push("Чаще останавливайся на звуках аккорда (зелёные) — так соло «садится» на гармонию.");
  if (s.phrases <= 2 && s.total > 16) tips.push("Дай соло подышать: короткие фразы и паузы между ними звучат музыкальнее сплошного потока.");
  if (s.total / Math.max(1, s.phrases) < 2.5 && s.phrases > 6) tips.push("Фразы очень короткие — попробуй связать 4–6 нот в одну мысль.");
  if (!tips.length) tips.push("Хорошо: ноты в гармонии, есть фразы и паузы. Попробуй другой стиль или тональность.");
  return tips;
}

// --- Уроки импровизации ---

export type LessonRule = "scale" | "land" | "callresponse" | "motif" | "changes";

export interface JamLesson {
  id: number;
  title: string;
  description: string;
  setup: JamSetup;
  rule: LessonRule;
  loops: number;
  /** Доля для зачёта. */
  need: number;
  /** Мотив (интервалы от первой ноты, полутона) — для урока «мотив». */
  motif?: number[];
}

export const JAM_LESSONS: JamLesson[] = [
  {
    id: 1,
    title: "Только ноты гаммы",
    description: "Рок в ля миноре: играй что хочешь, но только ноты минорной пентатоники (подсвечены). Зачёт — 90% нот в гамме.",
    setup: { ...defaultSetup("rock"), bpm: 90 },
    rule: "scale",
    loops: 3,
    need: 0.9,
  },
  {
    id: 2,
    title: "Блюз: блюзовая нота",
    description: "12-тактовый блюз в ля: блюзовая гамма — пентатоника и «блюзовая нота» (ми♭). Зачёт — 90% нот в гамме.",
    setup: defaultSetup("blues"),
    rule: "scale",
    loops: 1,
    need: 0.9,
  },
  {
    id: 3,
    title: "Заканчивай на звуке аккорда",
    description: "Поп в до мажоре: играй короткие фразы с паузами и заканчивай каждую на звуке аккорда (зелёные). Зачёт — 70% фраз.",
    setup: defaultSetup("pop"),
    rule: "land",
    loops: 3,
    need: 0.7,
  },
  {
    id: 4,
    title: "Вопрос — ответ",
    description: "Приложение играет фразу в нечётных тактах — «вопрос». В следующем такте ответь своей фразой из гаммы, а пока звучит вопрос — молчи. Зачёт — 75% ответов.",
    setup: { ...defaultSetup("rock"), bpm: 85 },
    rule: "callresponse",
    loops: 2,
    need: 0.75,
  },
  {
    id: 5,
    title: "Мотив и вариации",
    description: "Начинай каждую фразу с мотива «ля — до — ре» (в любой октаве), а продолжай по-своему. Зачёт — половина фраз с мотивом.",
    setup: { ...defaultSetup("rock"), bpm: 85 },
    rule: "motif",
    loops: 3,
    need: 0.5,
    motif: [0, 3, 5],
  },
  {
    id: 6,
    title: "Смена гаммы под аккорд",
    description: "Блюз: под каждый аккорд — своя гамма (миксолидийская от его основного тона), первая нота после смены — звук нового аккорда. Зачёт — 85% нот в гамме аккорда и половина смен.",
    setup: { ...defaultSetup("blues"), scale: "mixolydian" },
    rule: "changes",
    loops: 1,
    need: 0.85,
  },
];

export const jamLessonId = (instrument: JamInstrument, id: number) => `jam-${instrument}-${id}`;
export const LESSON_MIN_NOTES = 16;

export interface LessonResult {
  score: number;
  passed: boolean;
  /** Что посчитано: «фраз на звуке аккорда: 5 из 7». */
  detail: string;
}

/** Такты «вопроса» (приложение) и «ответа» (ученик) в уроке «вопрос — ответ»: чётные — вопрос. */
export const isCallBar = (bar: number) => bar % 2 === 0;

export function evaluateLesson(lesson: JamLesson, notes: PlayedNote[], plan: JamPlan): LessonResult {
  const scale = scalePcs(lesson.setup.tonic, lesson.setup.scale);
  const pc = (p: number) => ((p % 12) + 12) % 12;
  const fail = (detail: string): LessonResult => ({ score: 0, passed: false, detail });
  if (lesson.rule !== "callresponse" && notes.length < LESSON_MIN_NOTES) return fail(`Сыграно нот: ${notes.length} — нужно хотя бы ${LESSON_MIN_NOTES}.`);
  switch (lesson.rule) {
    case "scale": {
      const inScale = notes.filter((n) => classify(n.pitch, chordAt(plan, n.t)?.chord ?? null, scale) !== "out").length;
      const score = inScale / notes.length;
      return { score, passed: score >= lesson.need, detail: `Нот в гамме: ${inScale} из ${notes.length}.` };
    }
    case "land": {
      const ph = phrases(notes, plan.beatMs).filter((p) => p.length >= 2);
      if (ph.length < 4) return fail(`Фраз: ${ph.length} — нужно хотя бы 4 (паузы между фразами — от доли).`);
      const landed = ph.filter((p) => {
        const last = p[p.length - 1];
        return classify(last.pitch, chordAt(plan, last.t)?.chord ?? null, scale) === "chord";
      }).length;
      const score = landed / ph.length;
      return { score, passed: score >= lesson.need, detail: `Фраз на звуке аккорда: ${landed} из ${ph.length}.` };
    }
    case "callresponse": {
      const bars = plan.loopBars * plan.loops;
      let answers = 0;
      let good = 0;
      for (let b = 1; b < bars; b += 2) {
        answers++;
        const inBar = (bar: number) => notes.filter((n) => n.t >= bar * plan.barMs - 100 && n.t < (bar + 1) * plan.barMs - 100);
        const mine = inBar(b);
        const during = inBar(b - 1);
        const inScale = mine.filter((n) => scale.includes(pc(n.pitch))).length;
        if (mine.length >= 2 && inScale / mine.length >= 0.8 && during.length <= 1) good++;
      }
      const score = answers ? good / answers : 0;
      return { score, passed: score >= lesson.need, detail: `Ответов: ${good} из ${answers}.` };
    }
    case "motif": {
      const ph = phrases(notes, plan.beatMs).filter((p) => p.length >= 3);
      if (ph.length < 4) return fail(`Фраз из трёх нот и больше: ${ph.length} — нужно хотя бы 4.`);
      const m = lesson.motif ?? [0, 3, 5];
      const start = pc(lesson.setup.tonic);
      const withMotif = ph.filter((p) => m.every((iv, i) => pc(p[i].pitch) === (start + iv) % 12)).length;
      const score = withMotif / ph.length;
      return { score, passed: score >= lesson.need, detail: `Фраз с мотивом: ${withMotif} из ${ph.length}.` };
    }
    case "changes": {
      const inScale = notes.filter((n) => {
        const c = chordAt(plan, n.t);
        return c ? chordScale(c.chord).includes(pc(n.pitch)) : true;
      }).length;
      const share = inScale / notes.length;
      // Смены: первая нота в первой доле нового аккорда — его звук.
      const changes = plan.chords.filter((c, i) => i > 0 && plan.chords[i - 1].symbol !== c.symbol);
      let hit = 0;
      for (const c of changes) {
        const first = notes.find((n) => n.t >= c.startMs - 120 && n.t < c.startMs + plan.beatMs);
        if (first && chordPcs(c.chord).includes(pc(first.pitch))) hit++;
      }
      const hitShare = changes.length ? hit / changes.length : 1;
      return {
        score: share,
        passed: share >= lesson.need && hitShare >= 0.5,
        detail: `Нот в гамме аккорда: ${inScale} из ${notes.length}; смен со звуком нового аккорда: ${hit} из ${changes.length}.`,
      };
    }
  }
}

// --- «Повтори за мной» ---

export interface EchoLevel {
  id: number;
  title: string;
  description: string;
  notes: number;
  /** Ритм фразы: четверти, восьмые, смешанный, с синкопами. */
  rhythm: "quarters" | "eighths" | "mixed" | "sync";
  /** Размах по ступеням гаммы. */
  span: number;
  bpm: number;
  scale: ScaleId;
}

export const ECHO_LEVELS: EchoLevel[] = [
  { id: 1, title: "Три ноты четвертями", description: "Соседние ноты пентатоники, ровные четверти.", notes: 3, rhythm: "quarters", span: 3, bpm: 80, scale: "minpenta" },
  { id: 2, title: "Четыре ноты", description: "Четыре четверти, шире по гамме.", notes: 4, rhythm: "quarters", span: 5, bpm: 85, scale: "minpenta" },
  { id: 3, title: "Восьмые", description: "Пять нот: восьмые и четверти.", notes: 5, rhythm: "mixed", span: 5, bpm: 85, scale: "minpenta" },
  { id: 4, title: "Синкопы", description: "Ноты на «и», с паузами — как настоящие рифф-фразы.", notes: 4, rhythm: "sync", span: 5, bpm: 85, scale: "minpenta" },
  { id: 5, title: "Блюзовые фразы", description: "Блюзовая гамма, шесть нот восьмыми.", notes: 6, rhythm: "eighths", span: 6, bpm: 80, scale: "blues" },
];

export interface EchoNote {
  /** Доля от начала такта (0…4). */
  beat: number;
  pitch: number;
}

export interface EchoPhrase {
  notes: EchoNote[];
  chord: string;
}

export const ECHO_SERIES = 8;
export const ECHO_PASS = 0.75;
export const echoLevelId = (instrument: JamInstrument, id: number) => `echo-${instrument}-${id}`;

/** Нижняя граница регистра фраз: тоника — от этой ноты вверх в пределах октавы. */
const REGISTER: Record<JamInstrument, number> = { piano: 57, guitar: 52, bass: 33 };

/** Моменты нот фразы (в долях) по ритму уровня. */
function echoRhythm(level: EchoLevel, rnd: () => number): number[] {
  const n = level.notes;
  switch (level.rhythm) {
    case "quarters":
      return Array.from({ length: n }, (_, i) => i);
    case "eighths":
      return Array.from({ length: n }, (_, i) => i / 2);
    case "mixed": {
      // Восьмые и четверти вперемешку; последняя нота — не позже «и» четвёртой доли.
      const out: number[] = [];
      let t = 0;
      for (let i = 0; i < n; i++) {
        out.push(t);
        let dur = rnd() < 0.5 ? 0.5 : 1;
        if (t + dur + (n - 2 - i) * 0.5 > 3.5) dur = 0.5;
        t += dur;
      }
      return out;
    }
    case "sync": {
      const pool = [
        [0, 1.5, 2.5, 3],
        [0.5, 1, 2.5, 3.5],
        [0, 0.5, 1.5, 3],
        [0, 1.5, 2, 3.5],
      ];
      return pool[Math.floor(rnd() * pool.length)].slice(0, n);
    }
  }
}

/** Серия фраз: от тоники (или звука аккорда) шагами по гамме. */
export function echoSeries(level: EchoLevel, tonic: number, instrument: JamInstrument, seed: number): EchoPhrase[] {
  const rnd = seeded(seed * 97 + level.id * 13 + instrument.length);
  const steps = SCALES[level.scale].steps;
  const base = REGISTER[instrument] + ((((tonic - REGISTER[instrument]) % 12) + 12) % 12);
  // Ступени гаммы на две октавы от тоники.
  const ladder = [...steps.map((s) => base + s), ...steps.map((s) => base + 12 + s)];
  const chords = ["i", "i", "iv", "i", "v", "iv", "i", "v"].map((r) => romanToChord(tonic, r));
  return Array.from({ length: ECHO_SERIES }, (_, k) => {
    const times = echoRhythm(level, rnd);
    let idx = Math.floor(rnd() * 3);
    const notes = times.map((beat, i) => {
      if (i > 0) {
        let move = 0;
        while (move === 0) move = Math.round((rnd() * 2 - 1) * 2);
        idx = Math.max(0, Math.min(Math.min(ladder.length - 1, level.span), idx + move));
      }
      return { beat, pitch: ladder[idx] };
    });
    return { notes, chord: chords[k % chords.length] };
  });
}

/** Окно ответа: ноты такта ответа сверяются по порядку — высота (любая октава) и момент (±0,3 доли). */
export function judgeEcho(phrase: EchoPhrase, played: PlayedNote[], barStartMs: number, beatMs: number): { ok: boolean; pitches: boolean; rhythm: boolean } | null {
  const mine = played.filter((n) => n.t >= barStartMs - 0.3 * beatMs && n.t < barStartMs + 4 * beatMs - 0.2 * beatMs).sort((a, b) => a.t - b.t);
  if (!mine.length) return null;
  const pc = (p: number) => ((p % 12) + 12) % 12;
  const pitches = mine.length >= phrase.notes.length && phrase.notes.every((n, i) => pc(mine[i].pitch) === pc(n.pitch)) && mine.length <= phrase.notes.length + 1;
  const rhythm = phrase.notes.every((n, i) => mine[i] && Math.abs(mine[i].t - barStartMs - n.beat * beatMs) <= 0.3 * beatMs);
  return { ok: pitches && rhythm, pitches, rhythm };
}

/**
 * Проигрывание серии «Повтори за мной»: отсчёт, барабаны и аккорды на всю серию, фразы приложения —
 * в тактах вопроса (0, 2, 4…). Возвращает ноты и начало каждого такта ответа (мс от первой доли).
 */
export function echoPlayback(phrases: EchoPhrase[], bpm: number, mix: JamMix, instrument: JamInstrument): { notes: PlayNote[]; answers: number[] } {
  const setup: JamSetup = { style: "rock", tonic: 0, bpm, scale: "minpenta", custom: phrases.flatMap((p) => [p.chord, p.chord]).join(" | ") };
  const plan = jamPlan(setup, 1);
  const notes = jamAccompaniment({ ...setup, style: "pop" }, plan, mix, instrument);
  const beatMs = 60000 / bpm;
  const off = COUNT_IN_BEATS * beatMs;
  const program = instrument === "piano" ? 0 : instrument === "guitar" ? 27 : 33;
  phrases.forEach((p, k) => {
    for (const n of p.notes) notes.push({ startMs: off + (2 * k * 4 + n.beat) * beatMs, durMs: beatMs * 0.45, pitch: n.pitch, velocity: 110, channel: LEAD_CHANNEL, program });
  });
  return { notes: notes.sort((a, b) => a.startMs - b.startMs), answers: phrases.map((_, k) => (2 * k + 1) * 4 * beatMs) };
}

/** Фразы «вопроса» для урока «вопрос — ответ»: в каждом чётном такте. */
export function callNotes(lesson: JamLesson, plan: JamPlan, instrument: JamInstrument, seed: number): PlayNote[] {
  const bars = plan.loopBars * plan.loops;
  const level = { ...ECHO_LEVELS[2], scale: lesson.setup.scale };
  const series = echoSeries(level, lesson.setup.tonic, instrument, seed);
  const off = COUNT_IN_BEATS * plan.beatMs;
  const program = instrument === "piano" ? 0 : instrument === "guitar" ? 27 : 33;
  const out: PlayNote[] = [];
  for (let b = 0; b < bars; b += 2) {
    const p = series[(b / 2) % series.length];
    for (const n of p.notes) out.push({ startMs: off + b * plan.barMs + n.beat * plan.beatMs, durMs: plan.beatMs * 0.45, pitch: n.pitch, velocity: 110, channel: LEAD_CHANNEL, program });
  }
  return out;
}

/** Ноты гаммы и аккорда для подсветки: класс высоты → «аккорд» / «гамма». */
export function highlightPcs(chord: Chord | null, scale: number[]): Map<number, "chord" | "scale"> {
  const m = new Map<number, "chord" | "scale">();
  for (const pc of scale) m.set(pc, "scale");
  if (chord) for (const pc of chordPcs(chord)) m.set(pc, "chord");
  return m;
}

/** Окно «позиции» пентатоники на грифе: лады от k-й ноты гаммы на нижней струне (+4 лада). */
export function boxWindow(tonic: number, scale: number[], lowString: number, box: number): [number, number] | null {
  if (box <= 0) return null;
  const frets = [...new Set(scale.map((pc) => (((pc - lowString) % 12) + 12) % 12))].sort((a, b) => a - b);
  const rootFret = (((tonic - lowString) % 12) + 12) % 12;
  const start = frets.indexOf(rootFret);
  const f = frets[(start + box - 1) % frets.length];
  const lo = f < rootFret && box > 1 ? f + 12 : f;
  return [lo, lo + 4];
}

// --- Разбор соло ---

/** Длины в шестнадцатых, которые пишутся одной нотой. */
const WRITABLE = [16, 12, 8, 6, 4, 3, 2, 1];

/**
 * Соло нотами: моменты — по сетке шестнадцатых, длина — до следующей ноты (не дальше такта),
 * буква аккорда — над первой нотой при смене. Гитара и бас — табами (раскладка по ладам).
 */
export function soloSong(notes: PlayedNote[], plan: JamPlan, instrument: JamInstrument, tuning: number[]): TabSong | null {
  const six = plan.beatMs / 4;
  const bars = plan.loopBars * plan.loops;
  const q = [...notes]
    .map((n) => ({ s: Math.round(n.t / six), pitch: n.pitch, d: n.dur ? Math.max(1, Math.round(n.dur / six)) : 4 }))
    .filter((n) => n.s >= 0 && n.s < bars * 16)
    .sort((a, b) => a.s - b.s || a.pitch - b.pitch);
  if (!q.length) return null;
  // Одновременные ноты — аккорд.
  const events: { s: number; d: number; pitches: number[] }[] = [];
  for (const n of q) {
    const last = events[events.length - 1];
    if (last && last.s === n.s) last.pitches.push(n.pitch);
    else events.push({ s: n.s, d: n.d, pitches: [n.pitch] });
  }
  const strings = instrument !== "piano";
  const positions = strings ? assignPositions(events.map((e) => ({ pitches: e.pitches })), tuning, 20) : [];
  const usedBars = Math.min(bars, Math.floor(events[events.length - 1].s / 16) + 1);
  const beats: TsBeat[][] = Array.from({ length: usedBars }, () => []);
  let lastChord = "";
  events.forEach((e, i) => {
    const bar = Math.floor(e.s / 16);
    if (bar >= usedBars) return;
    const next = events[i + 1]?.s ?? Infinity;
    // Короткая пауза до следующей ноты (до восьмой) — нота пишется до неё (легато читается легче).
    const gap = next - e.s - e.d;
    const room = Math.min(gap <= 2 ? next - e.s : e.d, next - e.s, (bar + 1) * 16 - e.s);
    const len = WRITABLE.find((w) => w <= room) ?? 1;
    const w = writtenDuration(len * (TPQ / 4)) ?? { type: 16, dots: 0 };
    const chord = chordAt(plan, e.s * six)?.symbol ?? "";
    const tsNotes: TsNote[] = e.pitches.flatMap((pitch, k) => {
      if (!strings) return [{ pitch }];
      const pos = positions[i]?.[k];
      return pos ? [{ pitch, string: pos.string, fret: pos.fret }] : [];
    });
    if (!tsNotes.length) return;
    beats[bar].push({ tick: (e.s - bar * 16) * (TPQ / 4), dur: len * (TPQ / 4), type: w.type, dots: w.dots, notes: tsNotes, chord: chord !== lastChord ? chord : undefined });
    lastChord = chord;
  });
  const masters = beats.map(() => ({ num: 4, den: 4, ticks: TPQ * 4, key: 0 }));
  const low = Math.min(...q.map((n) => n.pitch));
  const part: TsPart = strings
    ? { id: "solo", name: "Соло", kind: instrument === "bass" ? "bass" : "guitar", program: instrument === "bass" ? 33 : 27, tuning, capo: 0, staves: [{ tab: true, clef: instrument === "bass" ? "F8" : "G8", bars: beats.map((b) => [b]) }] }
    : { id: "solo", name: "Соло", kind: "piano", program: 0, capo: 0, staves: [{ tab: false, clef: low < 55 ? "F" : "G", bars: beats.map((b) => [b]) }] };
  return { title: "", artist: "", album: "", tempo: Math.round(60000 / plan.beatMs), masters, order: masters.map((_, i) => ({ master: i, tempos: [], pass: 0 })), parts: [part] };
}
