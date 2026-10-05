// Аппликатуры гитарных аккордов: открытые формы, пауэр-аккорды, баррэ от 6-й и 5-й
// струны и подвижные «сложные» формы. Формы записаны для стандартного строя
// (лады от 6-й струны к 1-й, −1 — струна глушится); под другой строй форма
// пересчитывается так, чтобы звучали те же ноты.

import { parseChord, chordPcs, type Chord } from "./chords";
import { TUNINGS } from "./guitar";

export interface ChordShape {
  symbol: string;
  /** Лады от 6-й струны к 1-й (−1 — не играть). */
  frets: number[];
  /** Пальцы (1–4, 0 — открытая или не играется). */
  fingers: number[];
  /** Баррэ: лад и струны (индексы от 6-й) первой и последней. */
  barre?: { fret: number; from: number; to: number };
  form: ChordForm;
}

export type ChordForm = "open" | "power" | "barre6" | "barre5" | "jazz6" | "jazz5";

export const FORM_NAME: Record<ChordForm, string> = {
  open: "открытый",
  power: "пауэр-аккорд",
  barre6: "баррэ от 6-й струны",
  barre5: "баррэ от 5-й струны",
  jazz6: "подвижная форма от 6-й струны",
  jazz5: "подвижная форма от 5-й струны",
};

/** Струна не играется (в таблицах; −1 — смещение лада в подвижных формах, поэтому не −1). */
const X = -100;
const mute = (frets: number[]) => frets.map((f) => (f === X ? -1 : f));

/** Открытые аккорды: лады и пальцы. */
const OPEN: Record<string, [number[], number[]]> = {
  C: [[X, 3, 2, 0, 1, 0], [0, 3, 2, 0, 1, 0]],
  A: [[X, 0, 2, 2, 2, 0], [0, 0, 1, 2, 3, 0]],
  Am: [[X, 0, 2, 2, 1, 0], [0, 0, 2, 3, 1, 0]],
  D: [[X, X, 0, 2, 3, 2], [0, 0, 0, 1, 3, 2]],
  Dm: [[X, X, 0, 2, 3, 1], [0, 0, 0, 2, 3, 1]],
  E: [[0, 2, 2, 1, 0, 0], [0, 2, 3, 1, 0, 0]],
  Em: [[0, 2, 2, 0, 0, 0], [0, 2, 3, 0, 0, 0]],
  G: [[3, 2, 0, 0, 0, 3], [2, 1, 0, 0, 0, 3]],
  E7: [[0, 2, 0, 1, 0, 0], [0, 2, 0, 1, 0, 0]],
  A7: [[X, 0, 2, 0, 2, 0], [0, 0, 2, 0, 3, 0]],
  D7: [[X, X, 0, 2, 1, 2], [0, 0, 0, 2, 1, 3]],
  G7: [[3, 2, 0, 0, 0, 1], [3, 2, 0, 0, 0, 1]],
  B7: [[X, 2, 1, 2, 0, 2], [0, 2, 1, 3, 0, 4]],
  C7: [[X, 3, 2, 3, 1, 0], [0, 3, 2, 4, 1, 0]],
  Cmaj7: [[X, 3, 2, 0, 0, 0], [0, 3, 2, 0, 0, 0]],
  Fmaj7: [[X, X, 3, 2, 1, 0], [0, 0, 3, 2, 1, 0]],
  Amaj7: [[X, 0, 2, 1, 2, 0], [0, 0, 2, 1, 3, 0]],
  Dmaj7: [[X, X, 0, 2, 2, 2], [0, 0, 0, 1, 1, 1]],
  Am7: [[X, 0, 2, 0, 1, 0], [0, 0, 2, 0, 1, 0]],
  Em7: [[0, 2, 0, 0, 0, 0], [0, 2, 0, 0, 0, 0]],
  Dm7: [[X, X, 0, 2, 1, 1], [0, 0, 0, 2, 1, 1]],
  Asus2: [[X, 0, 2, 2, 0, 0], [0, 0, 1, 2, 0, 0]],
  Asus4: [[X, 0, 2, 2, 3, 0], [0, 0, 1, 2, 3, 0]],
  Dsus2: [[X, X, 0, 2, 3, 0], [0, 0, 0, 1, 3, 0]],
  Dsus4: [[X, X, 0, 2, 3, 3], [0, 0, 0, 1, 3, 4]],
  Esus4: [[0, 2, 2, 2, 0, 0], [0, 2, 3, 4, 0, 0]],
  Cadd9: [[X, 3, 2, 0, 3, 0], [0, 2, 1, 0, 3, 0]],
  C6: [[X, 3, 2, 2, 1, 0], [0, 4, 2, 3, 1, 0]],
  E5: [[0, 2, 2, X, X, X], [0, 1, 2, 0, 0, 0]],
  A5: [[X, 0, 2, 2, X, X], [0, 0, 1, 2, 0, 0]],
  D5: [[X, X, 0, 2, 3, X], [0, 0, 0, 1, 2, 0]],
};

/** Подвижные формы: смещения ладов от лада основного тона (основной тон — на 6-й или 5-й струне). */
const MOVABLE: { form: ChordForm; quality: string; offs: number[]; fingers: number[]; barre?: [number, number] }[] = [
  // Пауэр-аккорды: основной тон, квинта, октава.
  { form: "power", quality: "5", offs: [0, 2, 2, X, X, X], fingers: [1, 3, 4, 0, 0, 0] },
  { form: "power", quality: "5", offs: [X, 0, 2, 2, X, X], fingers: [0, 1, 3, 4, 0, 0] },
  // Баррэ от 6-й струны (форма ми).
  { form: "barre6", quality: "", offs: [0, 2, 2, 1, 0, 0], fingers: [1, 3, 4, 2, 1, 1], barre: [0, 5] },
  { form: "barre6", quality: "m", offs: [0, 2, 2, 0, 0, 0], fingers: [1, 3, 4, 1, 1, 1], barre: [0, 5] },
  { form: "barre6", quality: "7", offs: [0, 2, 0, 1, 0, 0], fingers: [1, 3, 1, 2, 1, 1], barre: [0, 5] },
  { form: "barre6", quality: "m7", offs: [0, 2, 0, 0, 0, 0], fingers: [1, 3, 1, 1, 1, 1], barre: [0, 5] },
  // Баррэ от 5-й струны (форма ля).
  { form: "barre5", quality: "", offs: [X, 0, 2, 2, 2, 0], fingers: [0, 1, 2, 3, 4, 1], barre: [1, 5] },
  { form: "barre5", quality: "m", offs: [X, 0, 2, 2, 1, 0], fingers: [0, 1, 3, 4, 2, 1], barre: [1, 5] },
  { form: "barre5", quality: "7", offs: [X, 0, 2, 0, 2, 0], fingers: [0, 1, 3, 1, 4, 1], barre: [1, 5] },
  { form: "barre5", quality: "m7", offs: [X, 0, 2, 0, 1, 0], fingers: [0, 1, 3, 1, 2, 1], barre: [1, 5] },
  // Сложные подвижные формы.
  { form: "jazz6", quality: "maj7", offs: [0, X, 1, 1, 0, X], fingers: [2, 0, 3, 4, 1, 0] },
  { form: "jazz6", quality: "m7", offs: [0, X, 0, 0, 0, X], fingers: [1, 0, 1, 1, 1, 0], barre: [0, 4] },
  { form: "jazz6", quality: "7", offs: [0, X, 0, 1, 0, X], fingers: [1, 0, 1, 2, 1, 0], barre: [0, 4] },
  { form: "jazz6", quality: "m7b5", offs: [0, X, 0, 0, -1, X], fingers: [2, 0, 3, 4, 1, 0] },
  { form: "jazz6", quality: "dim7", offs: [0, X, -1, 0, -1, X], fingers: [2, 0, 1, 3, 1, 0] },
  { form: "jazz5", quality: "maj7", offs: [X, 0, 2, 1, 2, 0], fingers: [0, 1, 3, 2, 4, 1], barre: [1, 5] },
  { form: "jazz5", quality: "m7b5", offs: [X, 0, 1, 0, 1, X], fingers: [0, 1, 3, 2, 4, 0] },
  { form: "jazz5", quality: "dim7", offs: [X, 0, 1, -1, 1, X], fingers: [0, 2, 3, 1, 4, 0] },
  { form: "jazz5", quality: "9", offs: [X, 0, -1, 0, 0, 0], fingers: [0, 2, 1, 3, 3, 3] },
  { form: "jazz5", quality: "add9", offs: [X, 0, -1, -3, 0, X], fingers: [0, 3, 2, 0, 4, 0] },
  { form: "jazz5", quality: "6", offs: [X, 0, 2, 2, 2, 2], fingers: [0, 1, 3, 3, 3, 3], barre: [2, 5] },
  { form: "jazz5", quality: "m6", offs: [X, 0, 2, -1, 1, X], fingers: [0, 2, 4, 1, 3, 0] },
];

const STD = TUNINGS.guitar;

/**
 * Форма аккорда в стандартном строе: открытая (если есть и `form` не задана), иначе подвижная
 * (`form` — какая; без неё — первая подходящая, с ладом основного тона от 1 до 10).
 */
export function chordShape(symbol: string, form?: ChordForm): ChordShape | null {
  const chord = parseChord(symbol);
  if (!chord || chord.bass) return null;
  const key = normalize(chord);
  if ((!form || form === "open") && OPEN[key]) {
    const [frets, fingers] = OPEN[key];
    return { symbol, frets: mute(frets), fingers: [...fingers], form: "open" };
  }
  if (form === "open") return null;
  const root = chordPcs(chord)[0];
  let best: ChordShape | null = null;
  let bestBase = Infinity;
  for (const m of MOVABLE) {
    if (m.quality !== chord.quality || (form && m.form !== form)) continue;
    const rootString = m.offs[0] === X ? 1 : 0;
    let base = (((root - STD[rootString]) % 12) + 12) % 12;
    // Лад основного тона: не на открытой (0 — это открытая форма), не выше 10-го.
    const low = Math.min(...m.offs.filter((o) => o !== X));
    while (base + low < 1) base += 12;
    if (base > 10 || base >= bestBase) continue;
    bestBase = base;
    best = {
      symbol,
      frets: m.offs.map((o) => (o === X ? -1 : base + o)),
      fingers: [...m.fingers],
      barre: m.barre ? { fret: base + Math.min(...m.barre.map((i) => m.offs[i])), from: m.barre[0], to: m.barre[1] } : undefined,
      form: m.form,
    };
  }
  return best;
}

/** Имя для таблицы открытых аккордов: «A#m» → «Bbm» не ищем, только как записано, без лишнего. */
function normalize(c: Chord): string {
  return c.letter.toUpperCase() + (c.alter === 1 ? "#" : c.alter === -1 ? "b" : "") + c.quality;
}

/** Есть ли у аккорда такая форма. */
export const hasShape = (symbol: string, form?: ChordForm) => !!chordShape(symbol, form);

/**
 * Форма под строй: лады пересчитаны так, чтобы звучали те же ноты, что в стандартном
 * (струна ниже — лад больше). Струна, которой не дотянуться (лад < 0), глушится.
 */
export function shapeForTuning(shape: ChordShape, tuning: number[]): ChordShape {
  if (tuning.length !== 6 || tuning.every((t, i) => t === STD[i])) return shape;
  const frets = shape.frets.map((f, i) => (f < 0 ? -1 : f + STD[i] - tuning[i] >= 0 ? f + STD[i] - tuning[i] : -1));
  const fingers = shape.fingers.map((g, i) => (frets[i] === shape.frets[i] ? g : 0));
  const same = shape.barre && frets.slice(shape.barre.from, shape.barre.to + 1).every((f, k) => f === shape.frets[shape.barre!.from + k]);
  return { ...shape, frets, fingers, barre: same ? shape.barre : undefined };
}

/** Звучащие ноты формы (от низкой струны), с каподастром. */
export function shapePitches(shape: ChordShape, tuning: number[], capo = 0): number[] {
  return shape.frets.flatMap((f, i) => (f < 0 || i >= tuning.length ? [] : [tuning[i] + capo + f]));
}

/** Струны для удара вверх: верхние звучащие (3 или 4). */
export function upstrokePitches(pitches: number[]): number[] {
  return pitches.slice(-Math.min(pitches.length, pitches.length >= 5 ? 4 : 3));
}

/** Правильно ли собран аккорд: звучат все звуки аккорда и нет чужих (октава любая; квинту септаккорда можно пропустить). */
export function judgeGuitarChord(symbol: string, played: number[]): { ok: boolean; missing: number[]; foreign: number[] } {
  const c = parseChord(symbol);
  if (!c) return { ok: false, missing: [], foreign: [] };
  const pcs = chordPcs(c);
  const have = new Set(played.map((p) => p % 12));
  // В септ- и нонаккордах чистую квинту часто пропускают (C7 x32310).
  const fifth = (pcs[0] + 7) % 12;
  const missing = pcs.filter((pc) => !have.has(pc) && !(pcs.length >= 4 && pc === fifth));
  const foreign = [...new Set(played.filter((p) => !pcs.includes(p % 12)))].sort((a, b) => a - b);
  return { ok: played.length > 0 && !missing.length && !foreign.length, missing, foreign };
}

/** Лад, с которого рисовать диаграмму (первый лад окна из 5). */
export function diagramBase(shape: ChordShape): number {
  const played = shape.frets.filter((f) => f > 0);
  if (!played.length) return 1;
  const max = Math.max(...played);
  return max <= 4 ? 1 : Math.min(...played);
}
