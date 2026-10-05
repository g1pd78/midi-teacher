// Тренажёр грифа: где какая нота на гитаре и басе.
//
// Режимы: «найди ноту на струне» (ля на 3-й струне), «нота на стане → гриф» (сыграть в нужной
// октаве), «место на грифе → нота» (точка на грифе — сыграть и узнать имя), «все места одной ноты»
// (до на каждой струне по очереди). Ответ — сыгранная высота: звук не говорит, на какой струне
// играли, поэтому засчитывается нужная высота.

import { seeded } from "./exercises";
import type { ExerciseStatView } from "./exercises";
import type { GtrInstrument } from "./guitarExercises";

export type FretMode = "find" | "staff" | "place" | "all";

export interface FretLevel {
  id: number;
  title: string;
  description: string;
  mode: FretMode;
  /** Струны (0 — нижняя). */
  strings: number[];
  frets: [number, number];
  /** Только натуральные ноты (без диезов и бемолей). */
  naturals: boolean;
}

const all = (n: number) => Array.from({ length: n }, (_, i) => i);

function levels(n: number): FretLevel[] {
  const low = 0;
  const second = 1;
  return [
    { id: 1, title: "Открытые струны", description: "Точка на открытой струне — сыграй её и запомни имя.", mode: "place", strings: all(n), frets: [0, 0], naturals: true },
    { id: 2, title: `${n}-я струна, лады 0–5`, description: "Найди ноту на самой толстой струне.", mode: "find", strings: [low], frets: [0, 5], naturals: true },
    { id: 3, title: `${n - 1}-я струна, лады 0–5`, description: "Найди ноту на соседней струне.", mode: "find", strings: [second], frets: [0, 5], naturals: true },
    { id: 4, title: "Две нижние струны, лады 0–12", description: "Ноты на двух басовых струнах — от них строятся аккорды и позиции.", mode: "find", strings: [low, second], frets: [0, 12], naturals: true },
    { id: 5, title: "Точка → нота, лады 0–5", description: "На грифе — точка: сыграй её, имя появится после.", mode: "place", strings: all(n), frets: [0, 5], naturals: true },
    { id: 6, title: "Нота на стане → гриф, первая позиция", description: "Сыграй ноту со стана в той же октаве (ключ с «8»: звучит на октаву ниже записи).", mode: "staff", strings: all(n), frets: [0, 4], naturals: true },
    { id: 7, title: "Все места одной ноты, лады 0–12", description: "Одна нота — на каждой струне по очереди.", mode: "all", strings: all(n), frets: [0, 12], naturals: true },
    { id: 8, title: "Все струны, лады 0–12, со знаками", description: "Любая нота, включая диезы и бемоли.", mode: "find", strings: all(n), frets: [0, 12], naturals: false },
    { id: 9, title: "Нота на стане → гриф, лады 0–12", description: "Чтение нот по всему грифу, со знаками.", mode: "staff", strings: all(n), frets: [0, 12], naturals: false },
    { id: 10, title: "Все места любой ноты", description: "Со знаками, на каждой струне по очереди.", mode: "all", strings: all(n), frets: [0, 12], naturals: false },
  ];
}

export const FRET_LEVELS: Record<GtrInstrument, FretLevel[]> = { guitar: levels(6), bass: levels(4) };

export const FRET_SERIES = 12;
export const FRET_PASS_ACCURACY = 0.85;
export const FRET_PASS_TIME_MS = 6000;

export const fretLevelId = (instrument: GtrInstrument, level: number) => `fret-${instrument}-${level}`;

export interface FretPos {
  string: number;
  fret: number;
}

export interface FretPrompt {
  mode: FretMode;
  /** Класс высоты ноты (0 — до). */
  pc: number;
  /** Цели по порядку (в «все места» — по одной на струну); засчитываются высоты целей. */
  targets: (FretPos & { pitch: number })[];
}

const NATURAL = new Set([0, 2, 4, 5, 7, 9, 11]);
const PC = (m: number) => ((m % 12) + 12) % 12;

/** Серия заданий ступени под строй `tuning` (открытые струны от низкой). */
export function fretSeries(level: FretLevel, tuning: number[], seed: number, count = FRET_SERIES): FretPrompt[] {
  const rnd = seeded(seed);
  const strings = level.strings.filter((s) => s < tuning.length);
  const positions: (FretPos & { pitch: number })[] = [];
  for (const string of strings)
    for (let fret = level.frets[0]; fret <= level.frets[1]; fret++) {
      const pitch = tuning[string] + fret;
      if (level.naturals && !NATURAL.has(PC(pitch))) continue;
      positions.push({ string, fret, pitch });
    }
  const out: FretPrompt[] = [];
  let prev = -1;
  for (let i = 0; i < count && positions.length; i++) {
    if (level.mode === "all") {
      // Нота — и все её места по струнам снизу вверх (на каждой — самое низкое место в пределах ладов).
      const pcs = [...new Set(positions.map((p) => PC(p.pitch)))];
      let pc = pcs[Math.floor(rnd() * pcs.length)];
      if (pc === prev && pcs.length > 1) pc = pcs[(pcs.indexOf(pc) + 1) % pcs.length];
      prev = pc;
      const targets = strings
        .map((s) => positions.filter((p) => p.string === s && PC(p.pitch) === pc).sort((a, b) => a.fret - b.fret)[0])
        .filter((p): p is FretPos & { pitch: number } => !!p);
      out.push({ mode: "all", pc, targets });
      continue;
    }
    let k = Math.floor(rnd() * positions.length);
    // Без повторов подряд одной и той же высоты.
    if (positions[k].pitch === prev && positions.length > 1) k = (k + 1) % positions.length;
    const p = positions[k];
    prev = p.pitch;
    out.push({ mode: level.mode, pc: PC(p.pitch), targets: [p] });
  }
  return out;
}

/**
 * Сыгранная высота против текущей цели. «Найди на струне» — та же нота на этой струне в пределах ладов ступени
 * (ля на 5-й струне — открытая или на 12-м ладу); остальное — точная высота.
 */
export function judgeFret(prompt: FretPrompt, target: number, played: number, level: FretLevel, tuning: number[]): boolean {
  const t = prompt.targets[target];
  if (!t) return false;
  if (played === t.pitch) return true;
  if (prompt.mode === "find") {
    const fret = played - tuning[t.string];
    return PC(played) === prompt.pc && fret >= level.frets[0] && fret <= level.frets[1];
  }
  return false;
}

/** Сколько ступеней открыто: следующая — когда засчитана предыдущая. */
export function fretUnlocked(stats: ExerciseStatView[], instrument: GtrInstrument): number {
  const passed = new Set(stats.filter((s) => s.passed).map((s) => s.exercise));
  let n = 1;
  while (n < FRET_LEVELS[instrument].length && passed.has(fretLevelId(instrument, n))) n++;
  return n;
}

/** Номер струны по-гитарному: 1 — самая тонкая. */
export const stringNumber = (string: number, strings: number) => strings - string;
