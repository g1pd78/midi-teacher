// Оценка грува: раньше или позже барабанов в среднем, разброс и отклонения по местам в такте
// (доли, «и», шестнадцатые и триоли).

import type { HitRecord } from "./exercises";
import type { ScoreNote } from "./score";

/** Мест в доле: 12 — делится и на шестнадцатые (по 3), и на восьмые триолью (по 4). */
const SUB = 12;

export interface GrooveSlot {
  /** Место в такте: 0 … beats·12 − 1. */
  slot: number;
  /** «1», «и», «·» (шестнадцатая или триоль). */
  label: string;
  meanMs: number;
  count: number;
}

export interface GrooveStats {
  /** Среднее отклонение со знаком: плюс — позже барабанов, минус — раньше. */
  meanMs: number;
  sdMs: number;
  slots: GrooveSlot[];
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

export function slotLabel(slot: number): string {
  const inBeat = slot % SUB;
  if (inBeat === 0) return String(slot / SUB + 1);
  if (inBeat === SUB / 2) return "и";
  return "·";
}

/**
 * Грув по попаданиям: `beatMs` — длительность доли при исходном темпе (время нот партитуры),
 * `beats` — долей в такте. Ноты считаются от начала первого такта.
 */
export function grooveStats(hits: HitRecord[], notes: ScoreNote[], beatMs: number, beats: number): GrooveStats | null {
  if (!hits.length || beatMs <= 0) return null;
  const startOf = new Map(notes.map((n) => [n.id, n.startMs]));
  const barSlots = beats * SUB;
  const bySlot = new Map<number, number[]>();
  const deltas: number[] = [];
  for (const h of hits) {
    const start = startOf.get(h.id);
    if (start === undefined) continue;
    deltas.push(h.deltaMs);
    const slot = ((Math.round((start / beatMs) * SUB) % barSlots) + barSlots) % barSlots;
    bySlot.set(slot, [...(bySlot.get(slot) ?? []), h.deltaMs]);
  }
  if (!deltas.length) return null;
  const m = mean(deltas);
  const sd = deltas.length > 1 ? Math.sqrt(mean(deltas.map((d) => (d - m) ** 2))) : 0;
  return {
    meanMs: Math.round(m),
    sdMs: Math.round(sd),
    slots: [...bySlot]
      .sort((a, b) => a[0] - b[0])
      .map(([slot, ds]) => ({ slot, label: slotLabel(slot), meanMs: Math.round(mean(ds)), count: ds.length })),
  };
}

/** Порог «вместе с барабанами», мс. */
export const GROOVE_TIGHT_MS = 12;

/** «В среднем на 18 мс позже барабанов» / «раньше» / «вместе с барабанами» (или метрономом). */
export function grooveTendency(g: GrooveStats, drums = true): string {
  const ref = drums ? "барабанов" : "метронома";
  if (Math.abs(g.meanMs) <= GROOVE_TIGHT_MS) return `Вместе с ${drums ? "барабанами" : "метрономом"}: в среднем без спешки и опозданий.`;
  return g.meanMs > 0 ? `В среднем на ${g.meanMs} мс позже ${ref}.` : `В среднем на ${-g.meanMs} мс раньше ${ref}.`;
}

/** Место в такте, где отклонение заметно больше остальных (для подсказки). */
export function worstSlot(g: GrooveStats): GrooveSlot | null {
  const worst = [...g.slots].filter((s) => s.count >= 2).sort((a, b) => Math.abs(b.meanMs - g.meanMs) - Math.abs(a.meanMs - g.meanMs))[0];
  return worst && Math.abs(worst.meanMs - g.meanMs) >= 25 ? worst : null;
}
