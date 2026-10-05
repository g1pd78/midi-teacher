// Гитарные аккорды: ступени тренажёра, серия, «минута смен».

import type { ExerciseStatView } from "./exercises";
import { seeded } from "./exercises";
import { chordShape, type ChordForm, type ChordShape } from "./guitarChords";
import { spellPc } from "./chords";

export interface GtrChordItem {
  symbol: string;
  form?: ChordForm;
}

export interface GtrChordLevel {
  id: number;
  title: string;
  description: string;
  pool: GtrChordItem[];
}

const items = (list: string, form?: ChordForm): GtrChordItem[] => list.split(" ").map((symbol) => ({ symbol, form }));

const OPEN_1 = items("Em Am E A");
const OPEN_2 = items("D Dm G C");
const SEVENTH = items("E7 A7 D7 G7 B7 C7");
const COLOR = items("Cmaj7 Fmaj7 Am7 Em7 Dm7 Asus2 Asus4 Dsus2 Dsus4 Esus4 Cadd9");
const POWER = [...items("E5 A5 D5"), ...items("G5 F5 C5 B5", "power")];
const BARRE_1 = items("F Bm F#m Bb B C#m Gm Cm");
const BARRE_6 = items("G A Am Gm A7 F# G7 Am7", "barre6");
const BARRE_5 = items("C D Cm Dm C7 D7 Em Bm7", "barre5");
const JAZZ = [...items("Gmaj7 Am7 G7 Bm7b5 Gdim7", "jazz6"), ...items("Cmaj7 Em7b5 C#dim7 C9 C6 Cm6", "jazz5")];

export const GTR_CHORD_LEVELS: GtrChordLevel[] = [
  { id: 1, title: "Em, Am, E, A", description: "Первые открытые аккорды: два-три пальца у порожка.", pool: OPEN_1 },
  { id: 2, title: "D, Dm, G, C", description: "Ещё четыре открытых аккорда — с ними играется большинство песен.", pool: [...OPEN_1, ...OPEN_2] },
  { id: 3, title: "Септаккорды", description: "E7, A7, D7, G7, B7, C7 — открытые, с малой септимой.", pool: SEVENTH },
  { id: 4, title: "maj7, m7, sus, add9", description: "Мягкие «цветные» аккорды в открытой позиции.", pool: COLOR },
  { id: 5, title: "Пауэр-аккорды", description: "Квинты для рока: основной тон, квинта, октава; остальные струны глушатся.", pool: POWER },
  { id: 6, title: "Баррэ: F, Bm и соседи", description: "Указательный палец прижимает все струны на ладу.", pool: BARRE_1 },
  { id: 7, title: "Баррэ от 6-й струны", description: "Форма ми на любом ладу: мажор, минор, 7, m7.", pool: BARRE_6 },
  { id: 8, title: "Баррэ от 5-й струны", description: "Форма ля на любом ладу: мажор, минор, 7, m7.", pool: BARRE_5 },
  { id: 9, title: "Сложные", description: "maj7, m7♭5, dim7, 9, 6 — подвижные формы от 6-й и 5-й струны.", pool: JAZZ },
  { id: 10, title: "Всё вперемешку", description: "Любые аккорды из всех ступеней.", pool: [...OPEN_2, ...SEVENTH, ...COLOR.slice(0, 5), ...POWER.slice(3), ...BARRE_1, ...JAZZ.slice(0, 5)] },
];

export const GTR_CHORD_SERIES = 10;
export const GTR_CHORD_PASS_ACCURACY = 0.8;
export const GTR_CHORD_PASS_TIME_MS = 8000;

export const gtrChordLevelId = (id: number) => `gchord-${id}`;

export function gtrChordUnlocked(stats: ExerciseStatView[]): number {
  const passed = new Set(stats.filter((s) => s.passed).map((s) => s.exercise));
  let n = 1;
  while (n < GTR_CHORD_LEVELS.length && passed.has(gtrChordLevelId(n))) n++;
  return n;
}

/** Серия: каждый аккорд ступени хотя бы раз, без повторов подряд. */
export function gtrChordSeries(level: GtrChordLevel, seed: number, count = GTR_CHORD_SERIES): { item: GtrChordItem; shape: ChordShape }[] {
  const rnd = seeded(seed);
  const pool = level.pool.filter((it) => chordShape(it.symbol, it.form));
  const out: GtrChordItem[] = [];
  const bag: GtrChordItem[] = [];
  while (out.length < count && pool.length) {
    if (!bag.length) bag.push(...[...pool].sort(() => rnd() - 0.5));
    let it = bag.shift()!;
    if (out.length && it.symbol === out[out.length - 1].symbol && pool.length > 1) {
      bag.push(it);
      it = bag.shift()!;
    }
    out.push(it);
  }
  return out.map((item) => ({ item, shape: chordShape(item.symbol, item.form)! }));
}

// --- Смены аккордов ---

export interface ChangePair {
  a: GtrChordItem;
  b: GtrChordItem;
}

export const CHANGE_PAIRS: ChangePair[] = [
  ["Em", "Am"],
  ["Am", "C"],
  ["A", "D"],
  ["D", "G"],
  ["G", "C"],
  ["E", "A"],
  ["Am", "Dm"],
  ["G", "D7"],
  ["Am", "E"],
  ["C", "F"],
  ["Bm", "G"],
  ["F", "G"],
].map(([a, b]) => ({ a: { symbol: a }, b: { symbol: b } }));

export const CHANGES_SECS = 60;
/** Хороший результат «минуты смен» — от 30 чистых смен. */
export const CHANGES_GOAL = 30;

export const changeId = (p: ChangePair) => `gchange-${p.a.symbol}-${p.b.symbol}`.replace(/#/g, "s");

/** Результат хранится как точность: смен / 100. */
export const changesToAccuracy = (n: number) => Math.min(n, 100) / 100;
export const accuracyToChanges = (a: number) => Math.round(a * 100);

/** Названия звуков по-русски: «соль, си». */
export function pcNames(pcs: number[]): string {
  const SOL: Record<string, string> = { c: "до", d: "ре", e: "ми", f: "фа", g: "соль", a: "ля", b: "си" };
  return pcs
    .map((pc) => {
      const s = spellPc(pc);
      return SOL[s.letter] + (s.alter === 1 ? "♯" : s.alter === -1 ? "♭" : "");
    })
    .join(", ");
}
