// Названия нот и геометрия клавиатуры.

export type NoteNaming = "solfege" | "latin";

export const PIANO_LOWEST = 21; // A0
export const PIANO_HIGHEST = 108; // C8

const SOLFEGE = ["До", "До♯", "Ре", "Ре♯", "Ми", "Фа", "Фа♯", "Соль", "Соль♯", "Ля", "Ля♯", "Си"];
const LATIN = ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"];

// Русские названия октав: C4 (MIDI 60) — «первая октава».
const OCTAVES_RU = [
  "субконтроктавы",
  "контроктавы",
  "большой октавы",
  "малой октавы",
  "первой октавы",
  "второй октавы",
  "третьей октавы",
  "четвёртой октавы",
  "пятой октавы",
];

export function isBlack(note: number): boolean {
  return [1, 3, 6, 8, 10].includes(((note % 12) + 12) % 12);
}

/** Научная октава: C4 = 60. */
export function octaveOf(note: number): number {
  return Math.floor(note / 12) - 1;
}

/** Короткое имя: «До», «Фа♯» или «C», «F♯». */
export function pitchName(note: number, naming: NoteNaming): string {
  const names = naming === "solfege" ? SOLFEGE : LATIN;
  return names[((note % 12) + 12) % 12];
}

/** Имя с октавой: «До первой октавы» или «C4». */
export function fullName(note: number, naming: NoteNaming): string {
  if (naming === "latin") return `${pitchName(note, naming)}${octaveOf(note)}`;
  const octave = OCTAVES_RU[octaveOf(note)];
  return octave ? `${pitchName(note, naming)} ${octave}` : pitchName(note, naming);
}

/** Имя для подписи на клавише: «До4» / «C4». */
export function keyLabel(note: number, naming: NoteNaming): string {
  return `${pitchName(note, naming)}${octaveOf(note)}`;
}

export interface KeyGeometry {
  note: number;
  black: boolean;
  /** Левый край и ширина в долях ширины клавиатуры (0..1). */
  x: number;
  width: number;
}

/** Смещение чёрной клавиши относительно стыка белых (как на настоящем рояле). */
const BLACK_OFFSET: Record<number, number> = { 1: -0.15, 3: 0.15, 6: -0.2, 8: 0, 10: 0.2 };
const BLACK_WIDTH = 0.6; // от ширины белой

/**
 * Раскладка клавиш для диапазона [low, high]. Края диапазона расширяются
 * до белых клавиш, чтобы клавиатура не начиналась с «обрубка».
 */
export function keyboardLayout(low: number, high: number): KeyGeometry[] {
  let lo = Math.max(PIANO_LOWEST, Math.min(low, high));
  let hi = Math.min(PIANO_HIGHEST, Math.max(low, high));
  if (isBlack(lo)) lo -= 1;
  if (isBlack(hi)) hi += 1;

  const whites: number[] = [];
  for (let n = lo; n <= hi; n++) if (!isBlack(n)) whites.push(n);
  const w = 1 / whites.length;

  const keys: KeyGeometry[] = [];
  whites.forEach((note, i) => keys.push({ note, black: false, x: i * w, width: w }));
  for (let n = lo; n <= hi; n++) {
    if (!isBlack(n)) continue;
    // Чёрная клавиша стоит на стыке предыдущей белой и следующей.
    const leftWhite = whites.indexOf(n - 1);
    const seam = (leftWhite + 1) * w;
    const bw = w * BLACK_WIDTH;
    const offset = (BLACK_OFFSET[n % 12] ?? 0) * bw;
    keys.push({ note: n, black: true, x: seam - bw / 2 + offset, width: bw });
  }
  return keys;
}
