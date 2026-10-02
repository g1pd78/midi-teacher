// Тренажёр аккордов: ступени, серия, проверка нажатого аккорда.

import type { ExerciseStatView } from "./exercises";
import { bassPc, chordPcs, parseChord, rootPc, type Chord } from "./chords";
import { seeded } from "./exercises";

export interface ChordLevel {
  id: number;
  title: string;
  description: string;
  pool: string[];
  /** Обращения: бас задан («C/E»), нижняя нота должна быть им. */
  inversions?: boolean;
}

const WHITE_MAJ = ["C", "D", "E", "F", "G", "A", "B"];
const WHITE_MIN = ["Cm", "Dm", "Em", "Fm", "Gm", "Am", "Bm"];

export const CHORD_LEVELS: ChordLevel[] = [
  { id: 1, title: "До, фа, соль мажор", description: "C, F, G — только белые клавиши: основной тон, через одну, ещё через одну.", pool: ["C", "F", "G"] },
  { id: 2, title: "Ля, ре, ми минор", description: "Am, Dm, Em и C, F, G — минор: средний звук на полтона ниже.", pool: ["Am", "Dm", "Em", "C", "F", "G"] },
  { id: 3, title: "Мажор от белых клавиш", description: "D, E, A, B — появляются чёрные клавиши.", pool: WHITE_MAJ },
  { id: 4, title: "Минор от белых клавиш", description: "Cm, Fm, Gm, Bm и остальные.", pool: WHITE_MIN },
  { id: 5, title: "От чёрных клавиш", description: "B♭, E♭, A♭, D♭, F♯ мажор и минор.", pool: ["Bb", "Eb", "Ab", "Db", "F#", "Bbm", "Ebm", "C#m", "F#m", "G#m"] },
  { id: 6, title: "Обращения", description: "C/E, Am/C… — нижней должна быть указанная нота (терция или квинта).", pool: ["C", "F", "G", "Am", "Dm", "Em", "D", "A", "E"], inversions: true },
  { id: 7, title: "Септаккорды (7)", description: "G7, C7, D7… — к мажорному трезвучию малая септима.", pool: ["G7", "C7", "D7", "A7", "E7", "F7", "B7"] },
  { id: 8, title: "maj7 и m7", description: "Cmaj7, Fmaj7, Dm7, Am7… — большой мажорный и малый минорный.", pool: ["Cmaj7", "Fmaj7", "Gmaj7", "Dmaj7", "Dm7", "Em7", "Am7", "Bm7"] },
  { id: 9, title: "dim, aug, sus", description: "Уменьшённые, увеличенные и с задержанием: Bdim, Caug, Csus4, Dsus2…", pool: ["Bdim", "C#dim", "F#dim", "Caug", "Faug", "Gaug", "Csus4", "Gsus4", "Dsus4", "Csus2", "Dsus2", "Asus2"] },
  {
    id: 10,
    title: "Всё вместе",
    description: "Любые аккорды из прежних ступеней вперемешку.",
    pool: ["C", "G", "Am", "F", "Dm", "E", "Bb", "F#m", "G7", "D7", "Cmaj7", "Am7", "Bdim", "Csus4", "Eb", "Abmaj7"],
  },
];

export const CHORD_SERIES = 10;
/** Зачёт серии: доля аккордов с первой попытки и среднее время, мс. */
export const CHORD_PASS_ACCURACY = 0.9;
export const CHORD_PASS_TIME_MS = 6000;

export const chordLevelId = (id: number) => `chord-${id}`;

function passesOf(stats: ExerciseStatView[], id: string): number {
  const s = stats.find((x) => x.exercise === id);
  return s ? (s.passes ?? (s.passed ? 1 : 0)) : 0;
}

export function chordLevelPassed(stats: ExerciseStatView[], id: number): boolean {
  return passesOf(stats, chordLevelId(id)) >= 1;
}

/** Открытые ступени: следующая — после зачёта предыдущей. */
export function chordUnlocked(stats: ExerciseStatView[]): number {
  let open = 1;
  while (open < CHORD_LEVELS.length && chordLevelPassed(stats, open)) open++;
  return open;
}

/** Серия аккордов ступени: без повторов подряд; для обращений — случайный бас. */
export function chordSeries(level: ChordLevel, seed: number, count = CHORD_SERIES): Chord[] {
  const rnd = seeded(seed * 2654435761 + level.id);
  const out: Chord[] = [];
  let prev = "";
  for (let i = 0; i < count; i++) {
    let sym = level.pool[Math.floor(rnd() * level.pool.length)];
    for (let t = 0; t < 5 && sym === prev && level.pool.length > 1; t++) sym = level.pool[Math.floor(rnd() * level.pool.length)];
    prev = sym;
    let chord = parseChord(sym)!;
    if (level.inversions) {
      // Основной вид, первое (терция в басу) или второе обращение (квинта в басу).
      const inv = Math.floor(rnd() * 3);
      if (inv > 0) {
        const pcs = chordPcs(chord);
        const LETTERS = ["c", "d", "e", "f", "g", "a", "b"];
        const li = LETTERS.indexOf(chord.letter);
        const letter = LETTERS[(li + (inv === 1 ? 2 : 4)) % 7];
        const natural = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 }[letter]!;
        let alter = pcs[inv] - natural;
        if (alter > 6) alter -= 12;
        if (alter < -6) alter += 12;
        const bass = { letter, alter };
        const accTxt = alter === 1 ? "#" : alter === -1 ? "b" : "";
        chord = { ...chord, bass, symbol: `${sym}/${letter.toUpperCase()}${accTxt}` };
      }
    }
    out.push(chord);
  }
  return out;
}

export type ChordVerdict = "ok" | "wrong" | "partial";

/**
 * Проверка нажатых клавиш: верно — те же звуки в любой октаве и обращении (с обращениями —
 * нижняя нота — указанный бас); неверно — нажато столько звуков, сколько нужно (или больше),
 * но не те, или есть чужой звук; иначе — ещё набирается.
 */
export function judgeChord(target: Chord, held: number[], requireBass: boolean): ChordVerdict {
  if (!held.length) return "partial";
  const pcs = new Set(chordPcs(target));
  const got = new Set(held.map((p) => ((p % 12) + 12) % 12));
  const foreign = [...got].some((pc) => !pcs.has(pc));
  const same = !foreign && got.size === pcs.size;
  if (same) {
    if (!requireBass) return "ok";
    const low = ((Math.min(...held) % 12) + 12) % 12;
    return low === bassPc(target) ? "ok" : held.length >= pcs.size ? "wrong" : "partial";
  }
  if (foreign && held.length >= Math.min(3, pcs.size)) return "wrong";
  if (held.length > pcs.size + 1) return "wrong";
  return "partial";
}

/** Подсказка: клавиши аккорда около до первой октавы (основной вид или с басом). */
export function chordKeys(target: Chord): number[] {
  const pcs = chordPcs(target);
  const start = target.bass ? bassPc(target) : rootPc(target);
  const order = [start, ...pcs.filter((p) => p !== start)].sort((a, b) => ((a - start + 12) % 12) - ((b - start + 12) % 12));
  const base = 60 + ((start - 60) % 12 + 12) % 12 - (start > 7 ? 12 : 0);
  const out = [base];
  for (const pc of order.slice(1)) {
    let p = out[out.length - 1] + 1;
    while (((p % 12) + 12) % 12 !== pc) p++;
    out.push(p);
  }
  return out;
}
