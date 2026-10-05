// Бой (страмминг): схемы ударов ↓↑ по клеткам такта и песня из табов с аккордами
// под барабаны. Удар вниз — все струны формы, вверх — верхние 3–4.

import { TPQ, type TabSong, type TsBeat, type TsNote, type TsPart } from "./tabsong";
import { patternPart } from "./drumPattern";
import { chordShape, shapeForTuning, type ChordForm } from "./guitarChords";
import { parseChart, barLen, type LeadSong } from "./songs";

export interface StrumPattern {
  id: string;
  name: string;
  /** Размер: долей и длительность доли. */
  beats: number;
  unit: 4 | 8;
  /** Клетки такта: «D» — вниз, «U» — вверх, «-» — пропуск (рука движется, не задевая струн). */
  slots: string;
  /** Узор барабанов (по шестнадцатым) под этот бой. */
  drums: string[];
  hint: string;
  /** Короткие удары (регги): длительность — одна клетка, дальше пауза. */
  short?: boolean;
}

const ROCK = ["k:x.......x.x.....", "s:....x.......x...", "h:x.x.x.x.x.x.x.x."];
const POP = ["k:x.......x.......", "s:....x.......x...", "h:x.x.x.x.x.x.x.x."];
const REGGAE = ["k:........x.......", "s:........x.......", "h:x.x.x.x.x.x.x.x."];
const WALTZ = ["k:x...........", "s:....x...x...", "h:x.x.x.x.x.x."];
const SIX8 = ["k:x.....x.....", "s:......x.....", "h:x.xx.xx.xx.x"];
const TWO4 = ["k:x.......", "s:....x...", "h:x.x.x.x."];
const SIXTEEN = ["k:x.......x.......", "s:....x.......x...", "h:xxxxxxxxxxxxxxxx"];

export const STRUM_PATTERNS: StrumPattern[] = [
  { id: "quarters", name: "Четверти вниз", beats: 4, unit: 4, slots: "D-D-D-D-", drums: POP, hint: "Четыре удара вниз на каждую долю: рука ходит ровно, как маятник." },
  { id: "eighths", name: "Восьмые ↓↑", beats: 4, unit: 4, slots: "DUDUDUDU", drums: POP, hint: "Вниз на долю, вверх между долями. Рука не останавливается." },
  { id: "folk", name: "Четвёрка", beats: 4, unit: 4, slots: "D-D-DUDU", drums: POP, hint: "Две доли вниз, потом вниз-вверх: рука движется восьмыми, на «и» первых долей проходит мимо струн." },
  { id: "pop", name: "Поп", beats: 4, unit: 4, slots: "D-DU-UDU", drums: POP, hint: "Самый частый бой в песнях. На третьей доле рука идёт вниз мимо струн — и сразу удар вверх." },
  { id: "rock", name: "Рок", beats: 4, unit: 4, slots: "D-DUD-DU", drums: ROCK, hint: "Акцент на 2 и 4 вместе с малым барабаном." },
  { id: "reggae", name: "Регги: на 2 и 4", beats: 4, unit: 4, slots: "--D---D-", short: true, drums: REGGAE, hint: "Короткий удар на вторую и четвёртую долю, сразу приглушить ладонью." },
  { id: "waltz", name: "Вальс (3/4)", beats: 3, unit: 4, slots: "D-DUDU", drums: WALTZ, hint: "Три доли: первая — вниз сильно, дальше вниз-вверх." },
  { id: "six8", name: "Баллада (6/8)", beats: 6, unit: 8, slots: "D-UD-U", drums: SIX8, hint: "Счёт «раз-и-а-два-и-а»: удары вниз на «раз» и «два»." },
  { id: "two4", name: "Марш (2/4)", beats: 2, unit: 4, slots: "D-DU", drums: TWO4, hint: "Бас-аккорд в два счёта: вниз, вниз-вверх." },
  { id: "sixteenths", name: "Шестнадцатые", beats: 4, unit: 4, slots: "DUDUDUDUDUDUDUDU", drums: SIXTEEN, hint: "Медленно и ровно: четыре удара на долю, рука — как в восьмых, только вдвое чаще." },
];

export const STRUM_BY_ID = new Map(STRUM_PATTERNS.map((p) => [p.id, p]));

/** Схема стрелками: «↓ · ↓ ↑ · ↑ ↓ ↑». */
export const patternArrows = (p: StrumPattern) => [...p.slots].map((c) => (c === "D" ? "↓" : c === "U" ? "↑" : "·")).join(" ");

/** Строки, по которым идёт удар: вниз — все, вверх — верхние 3–4 звучащие. */
function strumStrings(frets: number[], up: boolean): number[] {
  const played = frets.map((f, s) => (f >= 0 ? s : -1)).filter((s) => s >= 0);
  if (!up) return played;
  return played.slice(-Math.min(played.length, played.length >= 5 ? 4 : 3));
}

export interface StrumBar {
  /** Аккорды такта: один на весь такт или несколько поровну. */
  chords: { symbol: string; form?: ChordForm }[];
}

/** Песня из табов: бой `pattern` по тактам `bars` (+ барабаны), под открытые струны `tuning`. */
export function strumSong(o: { bars: StrumBar[]; pattern: StrumPattern; bpm: number; tuning: number[]; title: string; drums?: boolean; capo?: number }): TabSong {
  const p = o.pattern;
  const barTicks = (TPQ * 4 * p.beats) / p.unit;
  const n = p.slots.length;
  const slot = barTicks / n;
  // Записанная длительность удара: до следующего удара (четверть, четверть с точкой…), если так пишется одной нотой.
  const noteValue = (ticks: number): { type: number; dots: number } | null => {
    for (const t of [1, 2, 4, 8, 16, 32])
      for (const dots of [0, 1]) if (Math.abs(((TPQ * 4) / t) * (dots ? 1.5 : 1) - ticks) < 1) return { type: t, dots };
    return null;
  };
  const capo = o.capo ?? 0;
  const bars: TsBeat[][] = o.bars.map((bar) => {
    const beats: TsBeat[] = [];
    let lastSymbol = "";
    [...p.slots].forEach((c, i) => {
      if (c !== "D" && c !== "U") return;
      const item = bar.chords[Math.min(bar.chords.length - 1, Math.floor((i * bar.chords.length) / n))];
      const raw = chordShape(item.symbol, item.form);
      if (!raw) return;
      const shape = shapeForTuning(raw, o.tuning);
      const strings = strumStrings(shape.frets, c === "U");
      const notes: TsNote[] = strings.map((s) => ({ pitch: o.tuning[s] + capo + shape.frets[s], string: s, fret: shape.frets[s] }));
      if (!notes.length) return;
      notes[notes.length - 1].techniques = [c === "D" ? "↓" : "↑"];
      // Удар звучит до следующего (или до конца такта); если так одной нотой не записать — короче, с паузой.
      let k = 1;
      while (!p.short && i + k < n && p.slots[i + k] === "-") k++;
      while (k > 1 && !noteValue(k * slot)) k--;
      const v = noteValue(k * slot) ?? { type: Math.round((TPQ * 4) / slot), dots: 0 };
      beats.push({ tick: i * slot, dur: k * slot, type: v.type, dots: v.dots, notes, chord: item.symbol !== lastSymbol ? item.symbol : undefined });
      lastSymbol = item.symbol;
    });
    return beats;
  });
  const masters = bars.map(() => ({ num: p.beats, den: p.unit, ticks: barTicks, key: 0 }));
  const parts: TsPart[] = [
    {
      id: "guitar",
      name: o.title,
      kind: "guitar",
      program: 25,
      tuning: o.tuning,
      capo,
      staves: [{ tab: true, clef: "G8", bars: bars.map((b) => [b]) }],
    },
  ];
  if (o.drums !== false) parts.push(patternPart([p.drums], masters.length, Math.round(barTicks / (TPQ / 4))));
  return { title: o.title, artist: "", album: "", tempo: o.bpm, masters, order: masters.map((_, i) => ({ master: i, tempos: [], pass: 0 })), parts };
}

/** Схемы боя, подходящие к размеру песни. */
export const patternsFor = (s: Pick<LeadSong, "beats" | "unit">) => STRUM_PATTERNS.filter((p) => p.beats === s.beats && p.unit === s.unit);

/** Песня по буквам → такты с аккордами (аккорд держится до следующего; затакт пропускается). */
export function songStrumBars(song: LeadSong, pattern: StrumPattern): StrumBar[] {
  const chart = parseChart(song.chords, song);
  const bl = barLen(song);
  const n = pattern.slots.length;
  const out: StrumBar[] = [];
  let current = chart.chords[0]?.chord.symbol ?? "C";
  for (let b = 0; b < chart.bars; b++) {
    const start = song.pickup + b * bl;
    // Аккорд на каждую клетку боя.
    const perSlot: string[] = [];
    for (let i = 0; i < n; i++) {
      const t = start + (i * bl) / n;
      for (const c of chart.chords) if (c.start <= t + 1e-6) current = c.chord.symbol.replace(/\/.*$/, "");
      perSlot.push(current);
    }
    // Сжимаем в равные части такта: 1, 2 или 4 аккорда.
    const parts = [1, 2, 4].find((k) => n % k === 0 && perSlot.every((sym, i) => sym === perSlot[Math.floor(i / (n / k)) * (n / k)])) ?? n;
    out.push({ chords: Array.from({ length: parts }, (_, k) => ({ symbol: perSlot[k * (n / parts)] })) });
  }
  return out;
}

/** Аккорды песни, для которых нет формы (их не сыграть боем). */
export function missingShapes(bars: StrumBar[]): string[] {
  return [...new Set(bars.flatMap((b) => b.chords.map((c) => c.symbol)))].filter((s) => !chordShape(s));
}
