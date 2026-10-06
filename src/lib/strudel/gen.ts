// Перевод в код Strudel: сыгранный рифф → мини-нотация, и своё из приложения (грувы, песни, джем, упражнения).

import { midiName } from "./sounds";

export interface RiffNote {
  /** Начало в циклах (1 цикл = такт). */
  begin: number;
  /** Длительность в циклах. */
  dur: number;
  midi: number;
}

/** Деления цикла: 8 — восьмые, 16 — шестнадцатые, 12 — триоли восьмыми. */
export type Grid = 8 | 12 | 16;

const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);

/**
 * Рифф → `note("…")`. Ноты квантуются по сетке; в каждом цикле — последовательность с паузами `~`,
 * длительностями `@n` и аккордами `[c4,e4]`; деление укрупняется, если позволяет ритм; одинаковые циклы
 * сворачиваются; разные — через `<…>` (по циклу на каждый).
 */
export function riffToMini(notes: RiffNote[], cycles: number, grid: Grid = 16): string {
  const steps: number = grid;
  const bars: string[] = [];
  for (let c = 0; c < cycles; c++) {
    const inBar = notes.filter((n) => n.begin >= c - 0.5 / steps && n.begin < c + 1 - 0.5 / steps);
    const onsets = new Map<number, { midis: Set<number>; len: number }>();
    for (const n of inBar) {
      const s = Math.min(steps - 1, Math.max(0, Math.round((n.begin - c) * steps)));
      const len = Math.max(1, Math.round(n.dur * steps));
      const o = onsets.get(s) ?? { midis: new Set<number>(), len };
      o.midis.add(n.midi);
      o.len = Math.max(o.len, len);
      onsets.set(s, o);
    }
    if (!onsets.size) {
      bars.push("~");
      continue;
    }
    // События по порядку: длина — до следующего начала или до конца ноты (остаток — пауза).
    const starts = [...onsets.keys()].sort((a, b) => a - b);
    type Ev = { at: number; len: number; text: string };
    const evs: Ev[] = [];
    let pos = 0;
    starts.forEach((s, i) => {
      if (s > pos) evs.push({ at: pos, len: s - pos, text: "~" });
      const next = starts[i + 1] ?? steps;
      const o = onsets.get(s)!;
      const len = Math.min(o.len, next - s);
      const names = [...o.midis].sort((a, b) => a - b).map(midiName);
      evs.push({ at: s, len, text: names.length > 1 ? `[${names.join(",")}]` : names[0] });
      if (len < next - s) evs.push({ at: s + len, len: next - s - len, text: "~" });
      pos = next;
    });
    if (pos < steps) evs.push({ at: pos, len: steps - pos, text: "~" });
    // Укрупнить: общий делитель всех длин.
    const g = evs.reduce((acc: number, e) => gcd(acc, e.len), steps);
    const merged: Ev[] = [];
    for (const e of evs) {
      const last = merged[merged.length - 1];
      if (e.text === "~" && last?.text === "~") last.len += e.len;
      else merged.push({ ...e });
    }
    bars.push(merged.map((e) => (e.len / g === 1 ? e.text : `${e.text}@${e.len / g}`)).join(" "));
  }
  // Повторы подряд → «!», одинаковые циклы целиком → один.
  if (bars.every((b) => b === bars[0])) return `note("${bars[0]}")`;
  const wrapped = bars.map((b) => (b.includes(" ") ? `[${b}]` : b));
  const compact: string[] = [];
  for (const b of wrapped) {
    const last = compact[compact.length - 1];
    const m = last ? /^(.*?)(?:!(\d+))?$/.exec(last) : null;
    if (m && m[1] === b) compact[compact.length - 1] = `${b}!${Number(m[2] ?? 1) + 1}`;
    else compact.push(b);
  }
  return `note("<${compact.join(" ")}>")`;
}

/** Строка песни по буквам («Am F C G») → `chord("<Am F C G>")`. */
export function chordsToMini(chords: string[]): string {
  return `chord("<${chords.join(" ")}>")`;
}

/** Грув в 16 клеток по голосам → мини-нотация `s("bd ~ ~ ~ …")` по каждому голосу, сложенные через «,». */
export function gridToMini(voices: { sound: string; cells: boolean[] }[]): string {
  const lines = voices
    .filter((v) => v.cells.some(Boolean))
    .map((v) => {
      const n = v.cells.length;
      const tokens = v.cells.map((on) => (on ? v.sound : "~"));
      // Укрупнить: если все удары на кратных позициях — короче.
      let g = n;
      v.cells.forEach((on, i) => {
        if (on) g = gcd(g, i);
      });
      const step = g || n;
      const reduced = step > 1 && n % step === 0 ? tokens.filter((_, i) => i % step === 0) : tokens;
      return reduced.join(" ");
    });
  return lines.length ? `s("${lines.join(", ")}")` : `s("~")`;
}
