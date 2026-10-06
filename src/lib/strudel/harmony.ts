// Гармония для импровизации поверх кода: аккорд в данный момент и лад. Источник — панель или harmony() в коде,
// иначе — звучащие ноты (аккорд по нотам цикла, лад — по всем нотам).

import { identify, parseChord, type Chord } from "../chords";
import { SCALES, type ScaleId } from "../jam";
import type { CodeNote } from "./haps";
import { noteNameToMidi } from "./haps";

export interface Key {
  tonic: number;
  scale: ScaleId;
}

const SCALE_ALIASES: Record<string, ScaleId> = {
  major: "major",
  ionian: "major",
  minor: "minor",
  aeolian: "minor",
  dorian: "dorian",
  mixolydian: "mixolydian",
  "minor pentatonic": "minpenta",
  "major pentatonic": "majpenta",
  pentatonic: "majpenta",
  blues: "blues",
  "minor blues": "blues",
};

/** «A:minor», «C:major», «E:minor:pentatonic», «D dorian» → тоника и лад. */
export function parseScale(text: string): Key | null {
  const m = /^\s*([A-Ga-g][#b]?)\d*[:\s]+(.+?)\s*$/.exec(text);
  if (!m) return null;
  const tonic = noteNameToMidi(m[1] + "4");
  const name = m[2].replace(/:/g, " ").toLowerCase();
  const scale = SCALE_ALIASES[name];
  return tonic === null || !scale ? null : { tonic: tonic % 12, scale };
}

export const keyPcs = (k: Key) => SCALES[k.scale].steps.map((s) => (k.tonic + s) % 12);

/** Лад по нотам: мажор или минор с тоникой, лучше всего покрывающий ноты (с весом по длительности). */
export function estimateKey(notes: CodeNote[]): Key | null {
  const hist = new Array(12).fill(0);
  for (const n of notes) if (n.midi !== null && !n.drum) hist[n.midi % 12] += Math.max(0.05, n.dur);
  if (!hist.some((x) => x > 0)) return null;
  let best: Key | null = null;
  let bestScore = -1;
  for (let t = 0; t < 12; t++)
    for (const scale of ["major", "minor"] as const) {
      const pcs = SCALES[scale].steps.map((s) => (t + s) % 12);
      // Тоника и квинта — с небольшим бонусом, чтобы ля минор не путался с до мажором без причины.
      const score = pcs.reduce((a, pc) => a + hist[pc], 0) + hist[t] * 0.5 + hist[(t + 7) % 12] * 0.25;
      if (score > bestScore + 1e-9) {
        bestScore = score;
        best = { tonic: t, scale };
      }
    }
  return best;
}

/** Аккорд по звучащим нотам (без ударных и без «моей партии»). */
export function chordFromNotes(notes: CodeNote[]): Chord | null {
  const pitches = notes.filter((n) => n.midi !== null && !n.drum && !n.you).map((n) => n.midi!);
  if (pitches.length < 3) return null;
  return identify([...new Set(pitches)]);
}

/** Аккорд из значения паттерна гармонии («Am», «F», «G7»). */
export function chordFromValue(v: unknown): Chord | null {
  const text = typeof v === "string" ? v : v && typeof v === "object" ? String((v as { value?: unknown; chord?: unknown }).chord ?? (v as { value?: unknown }).value ?? "") : "";
  return text ? parseChord(text) : null;
}
