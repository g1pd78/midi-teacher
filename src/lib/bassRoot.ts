// Тренажёр «Найди основной тон» (бас): звучат барабаны и аккорды без баса, ученик играет линию
// сам. На смене аккорда должен прозвучать его основной тон (на старших ступенях — ещё звуки
// аккорда на остальных долях, а буквы скрыты — только по слуху).

import type { BassAccomp } from "./bassline";
import type { ExerciseStatView } from "./exercises";
import { seeded } from "./exercises";
import { bassPc, chordPcs, parseChord } from "./chords";
import { patternBar } from "./drumPattern";
import { TPQ } from "./tabsong";

export interface RootLevel {
  id: number;
  title: string;
  description: string;
  /** Готовые последовательности (буквы) или из набора в случайной тональности. */
  progressions: string[][] | "pool";
  /** Аккордов в такте. */
  perBar: 1 | 2;
  /** Кроме основного тона на смене — звуки аккорда на остальных долях. */
  tones: boolean;
  /** Подсказка: гриф с основными тонами, только буквы или только тоника (по слуху). */
  hint: "board" | "letters" | "ear";
  bpm: number;
}

export const ROOT_LEVELS: RootLevel[] = [
  {
    id: 1,
    title: "Два аккорда, гриф подсказывает",
    description: "По такту на аккорд: на «раз» сыграй его основной тон. На грифе отмечены все места этой ноты.",
    progressions: [["E", "A"], ["A", "D"], ["E", "D"], ["G", "C"]],
    perBar: 1,
    tones: false,
    hint: "board",
    bpm: 70,
  },
  {
    id: 2,
    title: "Четыре аккорда, гриф подсказывает",
    description: "Частые последовательности из четырёх аккордов. Гриф показывает, где основной тон.",
    progressions: [["C", "G", "Am", "F"], ["G", "D", "Em", "C"], ["A", "E", "F#m", "D"], ["D", "A", "Bm", "G"]],
    perBar: 1,
    tones: false,
    hint: "board",
    bpm: 75,
  },
  {
    id: 3,
    title: "Только буквы",
    description: "Гриф больше не подсказывает: по букве аккорда найди основной тон сам.",
    progressions: "pool",
    perBar: 1,
    tones: false,
    hint: "letters",
    bpm: 80,
  },
  {
    id: 4,
    title: "Два аккорда в такте",
    description: "Аккорды меняются каждые две доли: основной тон — на «раз» и на «три».",
    progressions: "pool",
    perBar: 2,
    tones: false,
    hint: "letters",
    bpm: 80,
  },
  {
    id: 5,
    title: "Основной тон и звуки аккорда",
    description: "Четверти: на «раз» — основной тон, на остальные доли — любой звук аккорда (терция, квинта, октава).",
    progressions: "pool",
    perBar: 1,
    tones: true,
    hint: "letters",
    bpm: 80,
  },
  {
    id: 6,
    title: "По слуху",
    description: "Буквы скрыты: известна только тональность. Слушай, как меняется гармония, и найди основной тон каждого аккорда.",
    progressions: "pool",
    perBar: 1,
    tones: false,
    hint: "ear",
    bpm: 70,
  },
];

/** Набор последовательностей ступенями мажора. */
const POOL: string[][] = [
  ["I", "V", "vi", "IV"],
  ["vi", "IV", "I", "V"],
  ["I", "IV", "V", "IV"],
  ["I", "vi", "IV", "V"],
  ["ii", "V", "I", "I"],
  ["I", "IV", "I", "V"],
];
const KEYS = [4, 9, 2, 7, 0, 5]; // E, A, D, G, C, F — удобные для баса
const DEGREE = [0, 2, 4, 5, 7, 9, 11];
const ROMAN = ["I", "II", "III", "IV", "V", "VI", "VII"];
const NAME = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];

export function romanChord(tonic: number, roman: string): string {
  const k = ROMAN.indexOf(roman.toUpperCase());
  const pc = (tonic + DEGREE[k]) % 12;
  return NAME[pc] + (roman === roman.toLowerCase() ? "m" : "");
}

export const rootLevelId = (id: number) => `bassroot-${id}`;
export const ROOT_PASS = 0.8;

export interface RootCheck {
  /** Доля от начала (после отсчёта). */
  beat: number;
  symbol: string;
  kind: "root" | "tone";
}

export interface RootSession {
  /** Аккорды по долям: начало, длина в долях. */
  chords: { symbol: string; beat: number; beats: number }[];
  checks: RootCheck[];
  /** Тональность (для «по слуху»): тоника. */
  key: string;
  bars: number;
}

/** Серия: последовательность × повторы (3 круга; два аккорда в такте — 4). */
export function rootSession(level: RootLevel, seed: number): RootSession {
  const rnd = seeded(seed * 131 + level.id * 7);
  let prog: string[];
  let key: string;
  if (level.progressions === "pool") {
    const tonic = KEYS[Math.floor(rnd() * KEYS.length)];
    prog = POOL[Math.floor(rnd() * POOL.length)].map((r) => romanChord(tonic, r));
    key = NAME[tonic];
  } else {
    prog = level.progressions[Math.floor(rnd() * level.progressions.length)];
    key = prog[0];
  }
  const each = 4 / level.perBar;
  const loops = level.perBar === 2 ? 4 : 3;
  const chords: RootSession["chords"] = [];
  for (let l = 0; l < loops; l++) prog.forEach((symbol) => chords.push({ symbol, beat: chords.length * each, beats: each }));
  const checks: RootCheck[] = [];
  for (const c of chords) {
    checks.push({ beat: c.beat, symbol: c.symbol, kind: "root" });
    if (level.tones) for (let k = 1; k < c.beats; k++) checks.push({ beat: c.beat + k, symbol: c.symbol, kind: "tone" });
  }
  return { chords, checks, key, bars: (chords.length * each) / 4 };
}

/** Верна ли нота для проверки (любая октава). */
export function rootOk(check: RootCheck, pitch: number): boolean {
  const c = parseChord(check.symbol);
  if (!c) return false;
  const pc = ((pitch % 12) + 12) % 12;
  return check.kind === "root" ? pc === bassPc(c) : chordPcs(c).includes(pc);
}

/** Окно ноты вокруг доли: раньше — до 180 мс, позже — до 300 мс (звук баса распознаётся с задержкой). */
export const ROOT_WINDOW = { early: 180, late: 300 };

/**
 * Итог по нотам ученика (время от первой доли, мс): у каждой проверки — первая нота в её окне.
 * `null` — нота не прозвучала.
 */
export function scoreRoot(session: RootSession, onsets: { t: number; pitch: number }[], beatMs: number): (boolean | null)[] {
  return session.checks.map((c) => {
    const at = c.beat * beatMs;
    const first = onsets.find((o) => o.t >= at - ROOT_WINDOW.early && o.t <= at + ROOT_WINDOW.late);
    return first ? rootOk(c, first.pitch) : null;
  });
}

/** Нота для подсказки и сквозных тестов: основной тон (или терция) в нижней октаве баса. */
export function checkPitch(check: RootCheck, low = 28): number {
  const c = parseChord(check.symbol)!;
  const pc = check.kind === "root" ? bassPc(c) : chordPcs(c)[1];
  return low + ((((pc - low) % 12) + 12) % 12);
}

const POP = ["k:x.......x.......", "s:....x.......x...", "h:x.x.x.x.x.x.x.x."];
const vel = (v: number) => Math.max(1, Math.min(127, Math.round((v / 100) * 127)));

/**
 * Ноты аккомпанемента: такт отсчёта (хэт на каждую долю), потом барабаны и аккорды.
 * Время — от начала проигрывания; первая доля серии — через 4 доли.
 */
export function rootAccompaniment(session: RootSession, bpm: number, a: BassAccomp) {
  const beatMs = 60000 / bpm;
  const out: { startMs: number; durMs: number; pitch: number; velocity: number; channel: number; program?: number | null }[] = [];
  for (let k = 0; k < 4; k++) out.push({ startMs: k * beatMs, durMs: 80, pitch: k === 0 ? 37 : 42, velocity: vel(a.drumsVolume), channel: 9 });
  const off = 4 * beatMs;
  if (a.drums)
    for (let b = 0; b < session.bars; b++)
      for (const hit of patternBar(POP))
        for (const n of hit.notes) out.push({ startMs: off + b * 4 * beatMs + (hit.tick / TPQ) * beatMs, durMs: 80, pitch: n.pitch, velocity: vel(a.drumsVolume), channel: 9 });
  if (a.chords !== "none")
    for (const c of session.chords) {
      const ch = parseChord(c.symbol);
      if (!ch) continue;
      for (const pc of chordPcs(ch))
        out.push({
          startMs: off + c.beat * beatMs,
          durMs: c.beats * beatMs * 0.95,
          pitch: 55 + ((((pc - 55) % 12) + 12) % 12),
          velocity: vel(a.chordsVolume),
          channel: 0,
          program: a.chords === "piano" ? 0 : 25,
        });
    }
  return { notes: out.sort((x, y) => x.startMs - y.startMs), firstBeatMs: off, beatMs };
}

/** Открытая ступень: следующая после последней засчитанной по порядку. */
export function rootUnlocked(stats: ExerciseStatView[]): number {
  const passed = new Set(stats.filter((s) => s.passed).map((s) => s.exercise));
  let n = 1;
  while (n < ROOT_LEVELS.length && passed.has(rootLevelId(n))) n++;
  return n;
}
