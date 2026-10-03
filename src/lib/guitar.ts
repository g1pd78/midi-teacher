// Гитара и бас: строи и подсказки тюнера.

import type { Instrument } from "../api";

/** Стандартные строи, от низкой струны к высокой (MIDI). */
export const TUNINGS: Record<Instrument, number[]> = {
  bass: [28, 33, 38, 43],
  guitar: [40, 45, 50, 55, 59, 64],
};

/** Ближайшая открытая струна к частоте и отклонение от неё в центах. */
export function nearestString(hz: number, tuning: number[]): { index: number; cents: number } {
  const midi = 69 + 12 * Math.log2(hz / 440);
  let index = 0;
  for (let k = 1; k < tuning.length; k++) if (Math.abs(tuning[k] - midi) < Math.abs(tuning[index] - midi)) index = k;
  return { index, cents: (midi - tuning[index]) * 100 };
}

/** Строй: ноты открытых струн (MIDI, от низкой к высокой). */
export interface TuningPreset {
  id: string;
  name: string;
  notes: number[];
}

const off = (base: number[], d: number[]) => base.map((m, i) => m + (d[i] ?? 0));

/** Готовые строи гитары и баса. */
export const TUNING_PRESETS: Record<Instrument, TuningPreset[]> = {
  guitar: [
    { id: "std", name: "Стандарт (E)", notes: TUNINGS.guitar },
    { id: "eb", name: "Полтона вниз (E♭)", notes: off(TUNINGS.guitar, [-1, -1, -1, -1, -1, -1]) },
    { id: "d", name: "Тон вниз (D)", notes: off(TUNINGS.guitar, [-2, -2, -2, -2, -2, -2]) },
    { id: "dropd", name: "Drop D", notes: off(TUNINGS.guitar, [-2]) },
    { id: "dropcs", name: "Drop C♯", notes: off(TUNINGS.guitar, [-3, -1, -1, -1, -1, -1]) },
    { id: "dropc", name: "Drop C", notes: off(TUNINGS.guitar, [-4, -2, -2, -2, -2, -2]) },
    { id: "dadgad", name: "DADGAD", notes: off(TUNINGS.guitar, [-2, 0, 0, 0, -2, -2]) },
    { id: "openg", name: "Открытый G", notes: off(TUNINGS.guitar, [-2, -2, 0, 0, 0, -2]) },
    { id: "opend", name: "Открытый D", notes: off(TUNINGS.guitar, [-2, 0, 0, -1, -2, -2]) },
    { id: "opene", name: "Открытый E", notes: off(TUNINGS.guitar, [0, 2, 2, 1, 0, 0]) },
  ],
  bass: [
    { id: "std", name: "Стандарт (E)", notes: TUNINGS.bass },
    { id: "eb", name: "Полтона вниз (E♭)", notes: off(TUNINGS.bass, [-1, -1, -1, -1]) },
    { id: "d", name: "Тон вниз (D)", notes: off(TUNINGS.bass, [-2, -2, -2, -2]) },
    { id: "dropd", name: "Drop D", notes: off(TUNINGS.bass, [-2]) },
    { id: "dropc", name: "Drop C", notes: off(TUNINGS.bass, [-4, -2, -2, -2]) },
  ],
};

const NOTE_NAMES = ["C", "C♯", "D", "E♭", "E", "F", "F♯", "G", "A♭", "A", "B♭", "B"];

/** Ноты строя буквами от низкой струны: «D-A-D-G-B-E». */
export function tuningLetters(notes: number[]): string {
  return notes.map((m) => NOTE_NAMES[((m % 12) + 12) % 12]).join("-");
}

/** Название строя: готовое, если совпадает, иначе буквы. */
export function tuningName(notes: number[], instrument: Instrument): string {
  const p = TUNING_PRESETS[instrument].find((t) => t.notes.length === notes.length && t.notes.every((m, i) => m === notes[i]));
  return p ? p.name : tuningLetters(notes);
}

export function sameTuning(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((m, i) => m === b[i]);
}

/** Открытые струны инструмента по настройкам: свой строй (если подходит по числу струн) или стандартный. */
export function openTuning(c: { instrument: Instrument; tuning: number[] | null }): number[] {
  const base = TUNINGS[c.instrument];
  return c.tuning && c.tuning.length === base.length ? c.tuning : base;
}

/** «Drop D, каподастр 2». */
export function tuningLabel(notes: number[], capo: number, instrument: Instrument): string {
  return tuningName(notes, instrument) + (capo ? `, каподастр ${capo}` : "");
}

/** Какие ноты можно поставить на струну в своём строе: от −5 до +3 полутонов от стандарта. */
export function stringChoices(instrument: Instrument, string: number): number[] {
  const m = TUNINGS[instrument][string];
  return Array.from({ length: 9 }, (_, k) => m - 5 + k);
}
