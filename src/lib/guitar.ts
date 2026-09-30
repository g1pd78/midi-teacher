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
