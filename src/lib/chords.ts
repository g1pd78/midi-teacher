// Аккорды: буквенные обозначения, состав, названия, расположение (голосоведение)
// и распознавание аккорда по нотам.

import type { Pitch } from "./exercises";

export type Quality = "" | "m" | "7" | "maj7" | "m7" | "dim" | "aug" | "sus2" | "sus4" | "dim7" | "m7b5" | "6" | "m6" | "5" | "add9" | "9";

/** Интервалы от основного тона (полутона). */
export const QUALITY_STEPS: Record<Quality, number[]> = {
  "": [0, 4, 7],
  m: [0, 3, 7],
  "7": [0, 4, 7, 10],
  maj7: [0, 4, 7, 11],
  m7: [0, 3, 7, 10],
  dim: [0, 3, 6],
  aug: [0, 4, 8],
  sus2: [0, 2, 7],
  sus4: [0, 5, 7],
  dim7: [0, 3, 6, 9],
  m7b5: [0, 3, 6, 10],
  "6": [0, 4, 7, 9],
  m6: [0, 3, 7, 9],
  "5": [0, 7],
  add9: [0, 4, 7, 14],
  "9": [0, 4, 7, 10, 14],
};

/** Ступени гаммы (буквы) звуков аккорда — для правильного написания нот. */
const QUALITY_DEGREES: Record<Quality, number[]> = {
  "": [0, 2, 4],
  m: [0, 2, 4],
  "7": [0, 2, 4, 6],
  maj7: [0, 2, 4, 6],
  m7: [0, 2, 4, 6],
  dim: [0, 2, 4],
  aug: [0, 2, 4],
  sus2: [0, 1, 4],
  sus4: [0, 3, 4],
  dim7: [0, 2, 4, 6],
  m7b5: [0, 2, 4, 6],
  "6": [0, 2, 4, 5],
  m6: [0, 2, 4, 5],
  "5": [0, 4],
  add9: [0, 2, 4, 1],
  "9": [0, 2, 4, 6, 1],
};

export const QUALITY_NAME: Record<Quality, string> = {
  "": "мажорное трезвучие",
  m: "минорное трезвучие",
  "7": "доминантсептаккорд",
  maj7: "большой мажорный септаккорд",
  m7: "малый минорный септаккорд",
  dim: "уменьшённое трезвучие",
  aug: "увеличенное трезвучие",
  sus2: "трезвучие с секундой (sus2)",
  sus4: "трезвучие с квартой (sus4)",
  dim7: "уменьшённый септаккорд",
  m7b5: "полууменьшённый септаккорд",
  "6": "мажорный секстаккорд с секстой",
  m6: "минорный с секстой",
  "5": "квинта (пауэр-аккорд)",
  add9: "мажорное трезвучие с ноной (add9)",
  "9": "доминантовый нонаккорд",
};

const LETTERS = ["c", "d", "e", "f", "g", "a", "b"];
const LETTER_SEMI: Record<string, number> = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };
const SOLFEGE: Record<string, string> = { c: "до", d: "ре", e: "ми", f: "фа", g: "соль", a: "ля", b: "си" };

export interface Chord {
  /** Основной тон: буква и знак (−1 бемоль, 1 диез). */
  letter: string;
  alter: number;
  quality: Quality;
  /** Бас другой ноты («C/E»): буква и знак. */
  bass?: { letter: string; alter: number };
  /** Как записано. */
  symbol: string;
}

const QUALITY_ALIASES: [RegExp, Quality][] = [
  [/^(maj7|M7|Δ7?|ma7)$/, "maj7"],
  [/^(m7b5|ø7?|min7b5|-7b5)$/, "m7b5"],
  [/^(dim7|°7|o7)$/, "dim7"],
  [/^(m7|min7|-7)$/, "m7"],
  [/^(m6|min6|-6)$/, "m6"],
  [/^(m|min|-)$/, "m"],
  [/^(dim|°|o)$/, "dim"],
  [/^(aug|\+)$/, "aug"],
  [/^(sus2)$/, "sus2"],
  [/^(sus4|sus)$/, "sus4"],
  [/^(7|dom7)$/, "7"],
  [/^5$/, "5"],
  [/^add9$/, "add9"],
  [/^9$/, "9"],
  [/^6$/, "6"],
  [/^(maj|M)?$/, ""],
];

function parseRoot(s: string): { letter: string; alter: number; rest: string } | null {
  const m = /^([A-Ga-g])([#♯b♭]?)(.*)$/.exec(s);
  if (!m) return null;
  const acc = m[2];
  return { letter: m[1].toLowerCase(), alter: acc === "#" || acc === "♯" ? 1 : acc === "b" || acc === "♭" ? -1 : 0, rest: m[3] };
}

/** Разобрать обозначение: «C», «Am», «G7», «Fmaj7», «Bdim», «Csus4», «C/E», «H» (си). Иначе null. */
export function parseChord(text: string): Chord | null {
  const symbol = text.trim();
  if (!symbol) return null;
  // Немецкое H — си.
  const src = symbol.replace(/^H/, "B");
  const [head, slash] = src.split("/");
  const root = parseRoot(head);
  if (!root) return null;
  const q = QUALITY_ALIASES.find(([re]) => re.test(root.rest));
  if (!q) return null;
  let bass: Chord["bass"];
  if (slash !== undefined) {
    const b = parseRoot(slash);
    if (!b || b.rest) return null;
    bass = { letter: b.letter, alter: b.alter };
  }
  return { letter: root.letter, alter: root.alter, quality: q[1], bass, symbol };
}

export const rootPc = (c: Pick<Chord, "letter" | "alter">) => (((LETTER_SEMI[c.letter] + c.alter) % 12) + 12) % 12;

/** Высотные классы звуков аккорда (основной тон первым). */
export function chordPcs(c: Chord): number[] {
  const r = rootPc(c);
  return QUALITY_STEPS[c.quality].map((s) => (r + s) % 12);
}

/** Высотный класс баса: «/E» или основной тон. */
export function bassPc(c: Chord): number {
  return c.bass ? rootPc(c.bass) : rootPc(c);
}

/** Звуки аккорда с правильными названиями (для нот): «до-ми♭-соль». */
export function chordSpelling(c: Chord): { letter: string; alter: number }[] {
  const li = LETTERS.indexOf(c.letter);
  const r = rootPc(c);
  return QUALITY_DEGREES[c.quality].map((deg, k) => {
    const letter = LETTERS[(li + deg) % 7];
    const pc = (r + QUALITY_STEPS[c.quality][k]) % 12;
    let alter = pc - LETTER_SEMI[letter];
    if (alter > 6) alter -= 12;
    if (alter < -6) alter += 12;
    return { letter, alter };
  });
}

function accName(alter: number): string {
  return alter === 1 ? "-диез" : alter === -1 ? "-бемоль" : alter === 2 ? "-дубль-диез" : alter === -2 ? "-дубль-бемоль" : "";
}

/** «до мажор», «ля минор», «соль: доминантсептаккорд». */
export function chordName(c: Chord): string {
  const root = SOLFEGE[c.letter] + accName(c.alter);
  const base = c.quality === "" ? `${root} мажор` : c.quality === "m" ? `${root} минор` : `${root}: ${QUALITY_NAME[c.quality]}`;
  return c.bass ? `${base}, в басу ${SOLFEGE[c.bass.letter]}${accName(c.bass.alter)}` : base;
}

/** Названия звуков аккорда: «до · ми · соль». */
export function chordNotesText(c: Chord): string {
  return chordSpelling(c)
    .map((n) => SOLFEGE[n.letter] + (n.alter === 1 ? "♯" : n.alter === -1 ? "♭" : n.alter === 2 ? "𝄪" : n.alter === -2 ? "𝄫" : ""))
    .join(" · ");
}

// --- Расположение ---

/** Все расположения звуков `pcs` (основной вид и обращения, тесное) в диапазоне [low, high]. */
export function voicings(pcs: number[], low: number, high: number): number[][] {
  const out: number[][] = [];
  const n = pcs.length;
  for (let inv = 0; inv < n; inv++) {
    const order = [...pcs.slice(inv), ...pcs.slice(0, inv)];
    for (let base = low - 12; base <= high; base++) {
      if (((base % 12) + 12) % 12 !== order[0]) continue;
      const v = [base];
      for (let k = 1; k < n; k++) {
        let p = v[k - 1] + 1;
        while (((p % 12) + 12) % 12 !== order[k]) p++;
        v.push(p);
      }
      if (v[0] >= low && v[n - 1] <= high) out.push(v);
    }
  }
  return out;
}

/** Расположение аккорда, ближайшее к предыдущему (плавное голосоведение); без предыдущего — к центру диапазона. */
export function voiceLead(pcs: number[], prev: number[] | null, low: number, high: number): number[] {
  const all = voicings(pcs, low, high);
  if (!all.length) return pcs.map((pc) => low + ((pc - low) % 12 + 12) % 12).sort((a, b) => a - b);
  const center = (low + high) / 2;
  const cost = (v: number[]) => {
    if (!prev || !prev.length) return Math.abs(v.reduce((a, b) => a + b, 0) / v.length - center) + (v[0] % 12 === pcs[0] ? 0 : 1.5);
    // Сумма движения голосов: каждый звук — к ближайшему звуку прежнего аккорда.
    return v.reduce((s, p) => s + Math.min(...prev.map((q) => Math.abs(p - q))), 0) + Math.abs(v.length - prev.length);
  };
  return all.reduce((best, v) => (cost(v) < cost(best) ? v : best));
}

/** Нота высотного класса `pc` в диапазоне [low, low + 11]. */
export function pcIn(pc: number, low: number): number {
  return low + ((((pc - low) % 12) + 12) % 12);
}

// --- Распознавание ---

/** Аккорд из набора нот: основной тон и вид (точное совпадение звуков). Бас — самая низкая нота. */
export function identify(pitches: number[]): Chord | null {
  if (pitches.length < 3) return null;
  const set = new Set(pitches.map((p) => ((p % 12) + 12) % 12));
  const low = ((Math.min(...pitches) % 12) + 12) % 12;
  const order: Quality[] = ["", "m", "7", "maj7", "m7", "dim", "aug", "sus4", "sus2", "dim7", "m7b5", "6", "m6"];
  // Сначала — с басом на основном тоне.
  const roots = [low, ...[...set].filter((r) => r !== low)];
  for (const r of roots)
    for (const q of order) {
      const pcs = QUALITY_STEPS[q].map((s) => (r + s) % 12);
      if (pcs.length === set.size && pcs.every((pc) => set.has(pc))) {
        const name = spellPc(r);
        const chord: Chord = { letter: name.letter, alter: name.alter, quality: q, symbol: "" };
        if (r !== low) chord.bass = spellPc(low);
        chord.symbol = symbolOf(chord);
        return chord;
      }
    }
  return null;
}

/** Нота высотного класса по-простому: белые — как есть, чёрные — диез (ми♭ и си♭ — бемолем). */
export function spellPc(pc: number, flats = false): { letter: string; alter: number } {
  const table: [string, number][] = flats
    ? [["c", 0], ["d", -1], ["d", 0], ["e", -1], ["e", 0], ["f", 0], ["g", -1], ["g", 0], ["a", -1], ["a", 0], ["b", -1], ["b", 0]]
    : [["c", 0], ["c", 1], ["d", 0], ["e", -1], ["e", 0], ["f", 0], ["f", 1], ["g", 0], ["g", 1], ["a", 0], ["b", -1], ["b", 0]];
  const [letter, alter] = table[((pc % 12) + 12) % 12];
  return { letter, alter };
}

const letterText = (n: { letter: string; alter: number }) => n.letter.toUpperCase() + (n.alter === 1 ? "#" : n.alter === -1 ? "b" : "");

export function symbolOf(c: Omit<Chord, "symbol">): string {
  return letterText(c) + c.quality + (c.bass ? `/${letterText(c.bass)}` : "");
}

/**
 * Аккорд по нотам отрезка (распознавание из MIDI): вес звука — длительность (бас весомее),
 * выбирается шаблон с наибольшим совпадением минус «чужие» звуки. Только частые виды аккордов.
 */
export function detectChord(notes: { pitch: number; durMs: number }[], fifths = 0): Chord | null {
  return detectChordFit(notes, fifths)?.chord ?? null;
}

/** То же с мерой совпадения: доля звучания, попавшая в звуки аккорда (0–1). */
export function detectChordFit(notes: { pitch: number; durMs: number }[], fifths = 0): { chord: Chord; fit: number } | null {
  if (!notes.length) return null;
  const w = new Array(12).fill(0);
  const lowest = Math.min(...notes.map((n) => n.pitch));
  for (const n of notes) w[n.pitch % 12] += n.durMs * (n.pitch === lowest ? 1.5 : 1);
  const total = w.reduce((a, b) => a + b, 0);
  if (!total) return null;
  const kinds: Quality[] = ["", "m", "7", "m7", "maj7", "dim"];
  let best: { score: number; r: number; q: Quality; inside: number } | null = null;
  for (let r = 0; r < 12; r++)
    for (const q of kinds) {
      const pcs = QUALITY_STEPS[q].map((s) => (r + s) % 12);
      // Септаккорд — только если септима звучит заметно (не проходящая нота).
      if (pcs.length > 3 && w[pcs[3]] < total * 0.2) continue;
      // Основной тон должен звучать заметно — иначе это проходящая нота мелодии.
      if (w[r] < total * 0.2) continue;
      const inside = pcs.reduce((s, pc) => s + w[pc], 0);
      const outside = total - inside;
      const missing = pcs.filter((pc) => w[pc] === 0).length;
      const score = inside - outside * 1.2 - missing * total * 0.25 - (pcs.length > 3 ? total * 0.15 : 0) + (lowest % 12 === r ? total * 0.2 : 0);
      if (!best || score > best.score) best = { score, r, q, inside };
    }
  if (!best || best.score <= 0) return null;
  const root = spellPc(best.r, fifths < 0);
  const chord = { letter: root.letter, alter: root.alter, quality: best.q };
  return { chord: { ...chord, symbol: symbolOf(chord) }, fit: best.inside / total };
}

/** Буква и знак → Pitch в октаве (для MEI). */
export function pitchOf(midi: number, spelled: { letter: string; alter: number }): Pitch {
  const natural = LETTER_SEMI[spelled.letter] + spelled.alter;
  const oct = Math.round((midi - natural) / 12) - 1;
  return { letter: spelled.letter, alter: spelled.alter, oct };
}
