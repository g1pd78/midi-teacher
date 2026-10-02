// Чтение с листа: ступени и генератор коротких мелодий.
//
// Каждая попытка — новая мелодия (выучить наизусть не получится). Мелодия строится
// по простой гармонии (I–IV–V–I): первая нота такта — звук аккорда, дальше —
// шаги и небольшие скачки по гамме, в конце — тоника. Мелодии играются на общем
// экране игры как упражнение: в режиме ожидания или в темпе с метрономом.

import { midiOf, scaleUp, seeded, type ExerciseScore, type ExNote, type Pitch } from "./exercises";
import type { ExerciseStatView } from "./exercises";

export interface Hints {
  names: boolean;
  keyHints: boolean;
  waterfall: boolean;
  fingering: boolean;
}

export interface ReadLevel {
  id: number;
  title: string;
  description: string;
  staves: "treble" | "bass" | "grand";
  /** Тоника и знаки тональности. */
  tonic: Pitch;
  fifths: number;
  /** Диапазон мелодии (MIDI, включительно). */
  low: number;
  high: number;
  /** Мелодия в левой руке (басовый ключ), а не в правой. */
  melodyLeft?: boolean;
  /** Левая рука: целые (whole) или половинные (half) ноты на басу аккорда. */
  bass?: "whole" | "half";
  /** Самый большой ход мелодии в ступенях гаммы (1 — только соседние ноты). */
  maxLeap: number;
  /** Ритмы такта в восьмых (сумма 8). */
  patterns: number[][];
  measures: number;
  bpm: number;
  hints: Hints;
  /** Пальцы: у всех нот (пятипальцевая позиция), только у первой или нигде. */
  fingers: "all" | "first" | "none";
}

const C4: Pitch = { letter: "c", alter: 0, oct: 4 };
const G4: Pitch = { letter: "g", alter: 0, oct: 4 };
const F4: Pitch = { letter: "f", alter: 0, oct: 4 };

const BASIC = [
  [2, 2, 2, 2],
  [4, 2, 2],
  [2, 2, 4],
  [4, 4],
  [2, 4, 2],
];
const WITH_WHOLE = [...BASIC, [8]];
const EIGHTHS = [
  ...BASIC,
  [1, 1, 2, 2, 2],
  [2, 1, 1, 2, 2],
  [2, 2, 1, 1, 2],
  [1, 1, 1, 1, 2, 2],
  [3, 1, 2, 2],
  [2, 2, 3, 1],
  [3, 1, 4],
];

const ALL: Hints = { names: true, keyHints: true, waterfall: true, fingering: true };
const KEYS: Hints = { names: false, keyHints: true, waterfall: false, fingering: true };
const NONE: Hints = { names: false, keyHints: false, waterfall: false, fingering: false };

export const READ_LEVELS: ReadLevel[] = [
  {
    id: 1,
    title: "Позиция «до», правая: соседние ноты",
    description: "До–соль первой октавы, только шаги. Подсказки: названия нот и подсветка клавиш.",
    staves: "treble",
    tonic: C4,
    fifths: 0,
    low: 60,
    high: 67,
    maxLeap: 1,
    patterns: BASIC,
    measures: 4,
    bpm: 60,
    hints: ALL,
    fingers: "all",
  },
  {
    id: 2,
    title: "Позиция «до», правая: через ноту",
    description: "Добавляются ходы через ноту (терции). Подсказка — только подсветка клавиш.",
    staves: "treble",
    tonic: C4,
    fifths: 0,
    low: 60,
    high: 67,
    maxLeap: 2,
    patterns: WITH_WHOLE,
    measures: 4,
    bpm: 60,
    hints: KEYS,
    fingers: "first",
  },
  {
    id: 3,
    title: "Первая октава, правая",
    description: "До первой — до второй октавы, ходы до кварты. Без подсказок — только ноты.",
    staves: "treble",
    tonic: C4,
    fifths: 0,
    low: 60,
    high: 72,
    maxLeap: 3,
    patterns: WITH_WHOLE,
    measures: 4,
    bpm: 60,
    hints: NONE,
    fingers: "none",
  },
  {
    id: 4,
    title: "Позиция «до», левая: басовый ключ",
    description: "До–соль малой октавы в басовом ключе. Подсказка — подсветка клавиш.",
    staves: "bass",
    tonic: { letter: "c", alter: 0, oct: 3 },
    fifths: 0,
    low: 48,
    high: 55,
    melodyLeft: true,
    maxLeap: 2,
    patterns: BASIC,
    measures: 4,
    bpm: 60,
    hints: KEYS,
    fingers: "all",
  },
  {
    id: 5,
    title: "Малая октава, левая",
    description: "До малой — до первой октавы в басовом ключе, без подсказок.",
    staves: "bass",
    tonic: { letter: "c", alter: 0, oct: 3 },
    fifths: 0,
    low: 48,
    high: 60,
    melodyLeft: true,
    maxLeap: 3,
    patterns: WITH_WHOLE,
    measures: 4,
    bpm: 60,
    hints: NONE,
    fingers: "none",
  },
  {
    id: 6,
    title: "Обе руки: мелодия и бас",
    description: "Правая — мелодия в позиции «до», левая — целые ноты (до, фа, соль малой октавы).",
    staves: "grand",
    tonic: C4,
    fifths: 0,
    low: 60,
    high: 67,
    bass: "whole",
    maxLeap: 2,
    patterns: BASIC,
    measures: 4,
    bpm: 60,
    hints: KEYS,
    fingers: "first",
  },
  {
    id: 7,
    title: "Восьмые и четверть с точкой",
    description: "Правая рука, первая октава: восьмые и пунктирный ритм.",
    staves: "treble",
    tonic: C4,
    fifths: 0,
    low: 60,
    high: 72,
    maxLeap: 2,
    patterns: EIGHTHS,
    measures: 4,
    bpm: 60,
    hints: NONE,
    fingers: "none",
  },
  {
    id: 8,
    title: "Соль мажор",
    description: "Фа-диез при ключе: ре первой — ре второй октавы.",
    staves: "treble",
    tonic: G4,
    fifths: 1,
    low: 62,
    high: 74,
    maxLeap: 3,
    patterns: WITH_WHOLE,
    measures: 4,
    bpm: 60,
    hints: NONE,
    fingers: "none",
  },
  {
    id: 9,
    title: "Фа мажор",
    description: "Си-бемоль при ключе: до первой — до второй октавы.",
    staves: "treble",
    tonic: F4,
    fifths: -1,
    low: 60,
    high: 72,
    maxLeap: 3,
    patterns: WITH_WHOLE,
    measures: 4,
    bpm: 60,
    hints: NONE,
    fingers: "none",
  },
  {
    id: 10,
    title: "Обе руки, восемь тактов",
    description: "Мелодия с восьмыми в первой октаве, левая — половинные на басу аккордов.",
    staves: "grand",
    tonic: C4,
    fifths: 0,
    low: 60,
    high: 72,
    bass: "half",
    maxLeap: 3,
    patterns: EIGHTHS,
    measures: 8,
    bpm: 60,
    hints: NONE,
    fingers: "none",
  },
];

export const READ_LEVEL_BY_ID = new Map(READ_LEVELS.map((l) => [l.id, l]));

// --- Зачёт ---

/** Мелодия засчитана: доля верных нот (ожидание — без ошибок нажатий; в темпе — верные / (ноты + лишние)). */
export const READ_PASS_ACCURACY = 0.9;
/** В темпе: разброс отклонений от ритма, мс (мягче, чем в упражнениях — читаем впервые). */
export const READ_PASS_TIMING_SD_MS = 90;
/** Ступень пройдена: засчитано мелодий (из них хотя бы одна в темпе). */
export const READ_LEVEL_PASSES = 3;

export const readId = (level: number) => `read-${level}`;
export const readWaitId = (level: number) => `read-${level}-wait`;

/** Засчитано мелодий на ступени: в темпе и в режиме ожидания. */
export function readPasses(stats: ExerciseStatView[], level: number): { tempo: number; wait: number } {
  const of = (id: string) => stats.find((s) => s.exercise === id)?.passes ?? (stats.find((s) => s.exercise === id)?.passed ? 1 : 0);
  return { tempo: of(readId(level)), wait: of(readWaitId(level)) };
}

export function readLevelPassed(stats: ExerciseStatView[], level: number): boolean {
  const p = readPasses(stats, level);
  return p.tempo >= 1 && p.tempo + p.wait >= READ_LEVEL_PASSES;
}

/** Открытые ступени: первая — сразу, следующая — когда пройдена предыдущая. */
export function readUnlocked(stats: ExerciseStatView[]): number {
  let open = 1;
  while (open < READ_LEVELS.length && readLevelPassed(stats, open)) open++;
  return open;
}

// --- Генератор ---

interface PoolNote {
  pitch: Pitch;
  midi: number;
  /** Ступень гаммы 0–6 (0 — тоника). */
  degree: number;
}

/** Ноты мажорной гаммы от `tonic` в диапазоне [low, high]. */
export function scalePool(tonic: Pitch, low: number, high: number): PoolNote[] {
  const start = { ...tonic, oct: tonic.oct - 2 };
  return scaleUp(start, "major", 5)
    .map((pitch, i) => ({ pitch, midi: midiOf(pitch), degree: i % 7 }))
    .filter((n) => n.midi >= low && n.midi <= high);
}

/** Гармония по тактам: ступени баса (0 — I, 3 — IV, 4 — V). */
const PROGRESSIONS: Record<number, number[][]> = {
  4: [
    [0, 3, 4, 0],
    [0, 4, 4, 0],
    [0, 0, 4, 0],
    [0, 3, 0, 4],
  ],
  8: [
    [0, 3, 4, 0, 0, 3, 4, 0],
    [0, 0, 3, 4, 0, 3, 4, 0],
    [0, 4, 0, 3, 0, 3, 4, 0],
  ],
};
const CHORD: Record<number, number[]> = { 0: [0, 2, 4], 3: [3, 5, 0], 4: [4, 6, 1] };

function progression(rnd: () => number, measures: number): number[] {
  const list = PROGRESSIONS[measures] ?? PROGRESSIONS[4];
  const p = list[Math.floor(rnd() * list.length)];
  // Короче или длиннее шаблона: повторяем, последний такт — тоника.
  const out = Array.from({ length: measures }, (_, i) => p[i % p.length]);
  out[measures - 1] = 0;
  return out;
}

/** Ход по гамме: шаги чаще скачков. */
function pickStep(rnd: () => number, maxLeap: number): number {
  const weights = [0, 6, 3, 1.5, 1].slice(0, maxLeap + 1);
  const total = weights.reduce((a, b) => a + b, 0);
  let r = rnd() * total;
  for (let s = 1; s < weights.length; s++) if ((r -= weights[s]) <= 0) return s;
  return 1;
}

export interface Melody {
  score: ExerciseScore;
  /** Высоты нот мелодии по порядку (для тестов и бота). */
  pitches: number[];
}

/** Мелодия для чтения с листа: одна и та же для одного `seed`. */
export function readingMelody(level: ReadLevel, seed: number): Melody {
  const rnd = seeded(seed * 7919 + level.id);
  const pool = scalePool(level.tonic, level.low, level.high);
  const harmony = progression(rnd, level.measures);
  const tonics = pool.filter((n) => n.degree === 0);
  // Начало: самая низкая тоника, на поздних ступенях — иногда терция или квинта.
  const starts = level.maxLeap >= 3 ? pool.filter((n) => [0, 2, 4].includes(n.degree) && n.midi <= tonics[0].midi + 7) : [tonics[0]];
  let idx = pool.indexOf(starts[Math.floor(rnd() * starts.length)]);
  let repeats = 0;
  const notes: ExNote[] = [];
  for (let m = 0; m < level.measures; m++) {
    const last = m === level.measures - 1;
    const rhythm = last ? (level.patterns.some((p) => p.length === 1) ? [8] : [4, 4]) : level.patterns[Math.floor(rnd() * level.patterns.length)];
    rhythm.forEach((eighths, k) => {
      if (notes.length) {
        let next: number;
        const chordTones = CHORD[harmony[m]];
        if (last && k === rhythm.length - 1) {
          // Последняя нота — ближайшая тоника.
          next = pool.reduce((best, n, i) => (n.degree === 0 && Math.abs(i - idx) < Math.abs(best - idx) ? i : best), pool.findIndex((n) => n.degree === 0));
        } else {
          const near = (i: number) => i >= 0 && i < pool.length && Math.abs(i - idx) <= level.maxLeap;
          const chordNear = pool.map((_, i) => i).filter((i) => near(i) && i !== idx && chordTones.includes(pool[i].degree));
          if (k === 0 && chordNear.length) next = chordNear[Math.floor(rnd() * chordNear.length)];
          else {
            const step = pickStep(rnd, level.maxLeap);
            let dir = rnd() < 0.5 ? -1 : 1;
            if (idx + dir * step < 0 || idx + dir * step >= pool.length) dir = -dir;
            next = Math.max(0, Math.min(pool.length - 1, idx + dir * step));
          }
        }
        // Не больше двух одинаковых нот подряд.
        repeats = next === idx ? repeats + 1 : 0;
        if (repeats >= 2) {
          next = idx + (idx + 1 < pool.length ? 1 : -1);
          repeats = 0;
        }
        idx = next;
      }
      notes.push({ pitch: pool[idx].pitch, finger: 0, eighths });
    });
  }
  // Пальцы: в пятипальцевой позиции палец = место ноты в позиции.
  const left = !!level.melodyLeft;
  if (level.fingers !== "none") {
    const base = pool[0].midi;
    const posIdx = (p: Pitch) => pool.findIndex((n) => n.midi === midiOf(p));
    const fingerOf = (p: Pitch) => (left ? 5 - posIdx(p) : posIdx(p) + 1);
    const five = pool.length <= 5 && pool[pool.length - 1].midi - base <= 7;
    if (five) notes.forEach((n, i) => (level.fingers === "all" || i === 0) && (n.finger = fingerOf(n.pitch)));
  }

  // Левая рука: бас аккорда — целой или двумя половинными (бас и квинта).
  let bassLine: ExNote[] | undefined;
  if (level.bass) {
    // Басы — в октаве ниже тоники мелодии: до, фа, соль малой октавы; квинта — выше баса, если помещается, иначе ниже.
    const t = midiOf(level.tonic);
    const bassPool = scalePool(level.tonic, t - 17, t);
    const root = (deg: number) => bassPool.find((n) => n.degree === deg && n.midi >= t - 12) ?? bassPool[0];
    bassLine = harmony.flatMap((deg, m) => {
      const r = root(deg);
      if (level.bass === "whole" || m === harmony.length - 1) return [{ pitch: r.pitch, finger: m === 0 ? 5 : 0, eighths: 8 }];
      const fifths = bassPool.filter((n) => n.degree === (deg + 4) % 7);
      const fifth = fifths.find((n) => n.midi > r.midi) ?? fifths.find((n) => n.midi < r.midi) ?? r;
      return [
        { pitch: r.pitch, finger: m === 0 ? 5 : 0, eighths: 4 },
        { pitch: fifth.pitch, finger: 0, eighths: 4 },
      ];
    });
  }
  const score: ExerciseScore = {
    fifths: level.fifths,
    bpm: level.bpm,
    staves: level.staves,
    right: left ? undefined : notes,
    left: left ? notes : bassLine,
  };
  return { score, pitches: notes.map((n) => midiOf(n.pitch)) };
}
