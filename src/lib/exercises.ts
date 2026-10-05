// Упражнения: генерация нот (MEI для Verovio) со стандартной аппликатурой,
// ступени (что открыто), разминка дня и оценка ровности ритма и громкости.
//
// Упражнения играются на том же экране, что и пьесы: MEI загружается в Verovio,
// а ноты, падающие ноты и оценка работают как обычно. Пальцы записаны в MEI
// элементами <fing>, поэтому показываются как аппликатура «из файла».

import type { ScoreNote } from "./score";

// --- Тональности и гаммы ---

export const LETTERS = ["c", "d", "e", "f", "g", "a", "b"];
const LETTER_SEMI: Record<string, number> = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };
const SHARP_ORDER = "fcgdaeb";
const FLAT_ORDER = "beadgcf";

export interface Pitch {
  letter: string;
  alter: number;
  oct: number;
}

export function midiOf(p: Pitch): number {
  return (p.oct + 1) * 12 + LETTER_SEMI[p.letter] + p.alter;
}

export interface KeyDef {
  id: string;
  name: string;
  tonic: Pitch;
  /** Знаки при ключе: > 0 — диезы, < 0 — бемоли. */
  fifths: number;
  minor: boolean;
  /** Аппликатура гаммы на одну октаву вверх от тоники (8 пальцев). */
  rh: number[];
  lh: number[];
  /** Аппликатура арпеджио на одну октаву вверх (4 пальца). */
  arpRh?: number[];
  arpLh?: number[];
}

const f = (s: string) => s.split("").map(Number);
/** Тоника правой руки — в первой октаве (до–соль), ля и си — в малой. */
const t = (letter: string, alter = 0): Pitch => {
  const semi = LETTER_SEMI[letter] + alter;
  return { letter, alter, oct: semi > 7 ? 3 : 4 };
};

export const MAJOR_KEYS: KeyDef[] = [
  { id: "C", name: "до мажор", tonic: t("c"), fifths: 0, minor: false, rh: f("12312345"), lh: f("54321321"), arpRh: f("1235"), arpLh: f("5421") },
  { id: "G", name: "соль мажор", tonic: t("g"), fifths: 1, minor: false, rh: f("12312345"), lh: f("54321321"), arpRh: f("1235"), arpLh: f("5421") },
  { id: "F", name: "фа мажор", tonic: t("f"), fifths: -1, minor: false, rh: f("12341234"), lh: f("54321321"), arpRh: f("1235"), arpLh: f("5421") },
  { id: "D", name: "ре мажор", tonic: t("d"), fifths: 2, minor: false, rh: f("12312345"), lh: f("54321321"), arpRh: f("1235"), arpLh: f("5321") },
  { id: "A", name: "ля мажор", tonic: t("a"), fifths: 3, minor: false, rh: f("12312345"), lh: f("54321321"), arpRh: f("1235"), arpLh: f("5321") },
  { id: "Bb", name: "си-бемоль мажор", tonic: t("b", -1), fifths: -2, minor: false, rh: f("41231234"), lh: f("32143213") },
  { id: "Eb", name: "ми-бемоль мажор", tonic: t("e", -1), fifths: -3, minor: false, rh: f("31234123"), lh: f("32143213") },
];

export const MINOR_KEYS: KeyDef[] = [
  { id: "a", name: "ля минор", tonic: t("a"), fifths: 0, minor: true, rh: f("12312345"), lh: f("54321321"), arpRh: f("1235"), arpLh: f("5421") },
  { id: "e", name: "ми минор", tonic: t("e"), fifths: 1, minor: true, rh: f("12312345"), lh: f("54321321"), arpRh: f("1235"), arpLh: f("5421") },
  { id: "d", name: "ре минор", tonic: t("d"), fifths: -1, minor: true, rh: f("12312345"), lh: f("54321321"), arpRh: f("1235"), arpLh: f("5421") },
  { id: "g", name: "соль минор", tonic: t("g"), fifths: -2, minor: true, rh: f("12312345"), lh: f("54321321"), arpRh: f("1235"), arpLh: f("5321") },
  { id: "b", name: "си минор", tonic: t("b"), fifths: 2, minor: true, rh: f("12312345"), lh: f("43214321") },
  { id: "c", name: "до минор", tonic: t("c"), fifths: -3, minor: true, rh: f("12312345"), lh: f("54321321") },
  { id: "fs", name: "фа-диез минор", tonic: t("f", 1), fifths: 3, minor: true, rh: f("34123123"), lh: f("43213214") },
];

export type ScaleMode = "major" | "natural" | "harmonic" | "melodic";
const STEPS: Record<ScaleMode, number[]> = {
  major: [2, 2, 1, 2, 2, 2, 1],
  natural: [2, 1, 2, 2, 1, 2, 2],
  harmonic: [2, 1, 2, 2, 1, 3, 1],
  melodic: [2, 1, 2, 2, 2, 2, 1],
};

/** Гамма вверх от тоники на `octaves` октав (с верхней тоникой), с правильными названиями нот. */
export function scaleUp(tonic: Pitch, mode: ScaleMode, octaves: number): Pitch[] {
  const out: Pitch[] = [tonic];
  let midi = midiOf(tonic);
  let li = LETTERS.indexOf(tonic.letter);
  let oct = tonic.oct;
  for (let o = 0; o < octaves; o++) {
    for (const step of STEPS[mode]) {
      midi += step;
      li += 1;
      if (li === 7) {
        li = 0;
        oct += 1;
      }
      const letter = LETTERS[li];
      const natural = (oct + 1) * 12 + LETTER_SEMI[letter];
      out.push({ letter, alter: midi - natural, oct });
    }
  }
  return out;
}

function shift(p: Pitch, octaves: number): Pitch {
  return { ...p, oct: p.oct + octaves };
}

/** Аппликатура гаммы на 1–2 октавы вверх из таблицы на одну октаву. */
export function scaleFingers(one: number[], octaves: number, hand: "right" | "left"): number[] {
  if (octaves === 1) return one;
  // Правая: в середине снова палец тоники; левая: палец верхней тоники (первый), дальше — как со второй ступени.
  return hand === "right" ? [...one.slice(0, 7), ...one.slice(0, 7), one[7]] : [...one.slice(0, 7), one[7], ...one.slice(1, 7), one[7]];
}

// --- Запись упражнения ---

export interface ExNote {
  pitch: Pitch;
  finger: number;
  /** Длительность в восьмых (2 — четверть). */
  eighths: number;
}

export interface ExerciseScore {
  fifths: number;
  bpm: number;
  right?: ExNote[];
  left?: ExNote[];
  /** Нотоносцы: фортепианная система (по умолчанию) или один стан — скрипичный (правая) или басовый (левая). */
  staves?: "grand" | "treble" | "bass";
}

/** Последовательность нот одной длительности; последняя растягивается до конца такта. */
function line(pitches: Pitch[], fingers: number[], eighths: number): ExNote[] {
  const notes = pitches.map((pitch, i) => ({ pitch, finger: fingers[i], eighths }));
  const total = notes.reduce((s, n) => s + n.eighths, 0);
  const rest = (8 - (total % 8)) % 8;
  if (notes.length) notes[notes.length - 1].eighths += rest;
  return notes;
}

/** Вверх и обратно: верхняя нота не повторяется. */
function upDown<T>(up: T[]): T[] {
  return [...up, ...up.slice(0, -1).reverse()];
}

const DUR: Record<number, [string, number]> = { 1: ["8", 0], 2: ["4", 0], 3: ["4", 1], 4: ["2", 0], 6: ["2", 1], 8: ["1", 0] };

function keyAlters(fifths: number): Record<string, number> {
  const out: Record<string, number> = {};
  if (fifths > 0) for (const l of SHARP_ORDER.slice(0, fifths)) out[l] = 1;
  else for (const l of FLAT_ORDER.slice(0, -fifths)) out[l] = -1;
  return out;
}

/** Разбить ноты по тактам 4/4 (8 восьмых). Длинная нота через такт не переходит. */
function measures(notes: ExNote[]): ExNote[][] {
  const out: ExNote[][] = [];
  let cur: ExNote[] = [];
  let used = 0;
  for (const n of notes) {
    cur.push(n);
    used += n.eighths;
    if (used >= 8) {
      out.push(cur);
      cur = [];
      used = 0;
    }
  }
  if (cur.length) out.push(cur);
  return out;
}

/** MEI упражнения: фортепианная система, 4/4, знаки при ключе, пальцы. */
export function exerciseMei(score: ExerciseScore): string {
  const alters = keyAlters(score.fifths);
  const layout = score.staves ?? "grand";
  const staves: { n: number; hand: "right" | "left"; ms: ExNote[][] }[] =
    layout === "treble"
      ? [{ n: 1, hand: "right", ms: measures(score.right ?? []) }]
      : layout === "bass"
        ? [{ n: 1, hand: "left", ms: measures(score.left ?? []) }]
        : [
            { n: 1, hand: "right", ms: measures(score.right ?? []) },
            { n: 2, hand: "left", ms: measures(score.left ?? []) },
          ];
  const count = Math.max(...staves.map((s) => s.ms.length));
  let id = 0;
  const body: string[] = [];
  for (let m = 0; m < count; m++) {
    const fings: string[] = [];
    const staffXml = staves.map((s) => {
      const notes = s.ms[m];
      if (!notes) return `<staff n="${s.n}"><layer n="1"><mRest/></layer></staff>`;
      const seen = new Map<string, number>();
      const parts: string[] = [];
      let beam: string[] | null = null;
      let pos = 0;
      for (const n of notes) {
        const { letter, alter, oct } = n.pitch;
        const key = `${letter}${oct}`;
        const implied = seen.get(key) ?? alters[letter] ?? 0;
        let acc = "";
        if (alter !== implied) {
          acc = ` accid="${alter === 1 ? "s" : alter === -1 ? "f" : "n"}"`;
          seen.set(key, alter);
        } else if (alter) acc = ` accid.ges="${alter === 1 ? "s" : "f"}"`;
        const [dur, dots] = DUR[n.eighths] ?? ["4", 0];
        const nid = `x${++id}`;
        const xml = `<note xml:id="${nid}" pname="${letter}" oct="${oct}" dur="${dur}"${dots ? ` dots="${dots}"` : ""}${acc}/>`;
        if (n.finger) fings.push(`<fing startid="#${nid}" staff="${s.n}" place="${s.hand === "right" ? "above" : "below"}">${n.finger}</fing>`);
        // Восьмые — группами по четыре (полтакта) под одним ребром.
        if (n.eighths === 1) {
          if (!beam || pos % 4 === 0) {
            if (beam) parts.push(`<beam>${beam.join("")}</beam>`);
            beam = [];
          }
          beam.push(xml);
        } else {
          if (beam) parts.push(`<beam>${beam.join("")}</beam>`);
          beam = null;
          parts.push(xml);
        }
        pos += n.eighths;
      }
      if (beam) parts.push(`<beam>${beam.join("")}</beam>`);
      return `<staff n="${s.n}"><layer n="1">${parts.join("")}</layer></staff>`;
    });
    const right = m === count - 1 ? ` right="end"` : "";
    body.push(`<measure n="${m + 1}"${right}>${staffXml.join("")}${fings.join("")}</measure>`);
  }
  const sig = score.fifths === 0 ? "0" : `${Math.abs(score.fifths)}${score.fifths > 0 ? "s" : "f"}`;
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<mei xmlns="http://www.music-encoding.org/ns/mei" meiversion="5.0"><music><body><mdiv><score>` +
    `<scoreDef key.sig="${sig}" meter.count="4" meter.unit="4" midi.bpm="${score.bpm}">` +
    (layout === "treble"
      ? `<staffGrp><staffDef n="1" lines="5" clef.shape="G" clef.line="2"/></staffGrp>`
      : layout === "bass"
        ? `<staffGrp><staffDef n="1" lines="5" clef.shape="F" clef.line="4"/></staffGrp>`
        : `<staffGrp symbol="brace" bar.thru="true">` +
          `<staffDef n="1" lines="5" clef.shape="G" clef.line="2"/>` +
          `<staffDef n="2" lines="5" clef.shape="F" clef.line="4"/>` +
          `</staffGrp>`) +
    `</scoreDef><section>${body.join("")}</section></score></mdiv></body></music></mei>`
  );
}

// --- Каталог ---

export type Category = "five" | "hanon" | "major" | "minor" | "arpeggio";

export const CATEGORIES: { id: Category; title: string; description: string }[] = [
  { id: "five", title: "Пять пальцев", description: "Каждый палец на своей клавише: позиции «до», «соль», «фа», «ре»." },
  { id: "hanon", title: "Упражнения в духе Ганона", description: "Узоры по белым клавишам вверх и вниз — независимость и сила пальцев." },
  { id: "major", title: "Мажорные гаммы", description: "До 3 знаков: каждой рукой, расходящиеся, параллельно, в две октавы." },
  { id: "minor", title: "Минорные гаммы", description: "Гармонический и мелодический минор до 3 знаков." },
  { id: "arpeggio", title: "Арпеджио", description: "Трезвучия по звукам вверх и вниз." },
];

export interface Exercise {
  id: string;
  category: Category;
  /** Группа внутри раздела (тональность, позиция, номер узора). */
  group: string;
  /** Короткая подпись варианта: «правая», «обе, 2 октавы»… */
  variant: string;
  title: string;
  build: () => ExerciseScore;
}

const HANDS_LABEL = { right: "правая", left: "левая", both: "обе" } as const;
type Hands = keyof typeof HANDS_LABEL;

function withHands(hands: Hands, right: () => ExNote[], left: () => ExNote[]): Pick<ExerciseScore, "right" | "left"> {
  return {
    right: hands === "left" ? undefined : right(),
    left: hands === "right" ? undefined : left(),
  };
}

// Пять пальцев: ступени позиции (1–5) и пальцы правой = ступень, левой = 6 − ступень.
const FIVE_POSITIONS: KeyDef[] = [MAJOR_KEYS[0], MAJOR_KEYS[1], MAJOR_KEYS[2], MAJOR_KEYS[3]];
const FIVE_PATTERNS: { id: string; name: string; degrees: number[] }[] = [
  { id: "updown", name: "вверх-вниз", degrees: [1, 2, 3, 4, 5, 4, 3, 2, 1] },
  { id: "thirds", name: "терции", degrees: [1, 3, 2, 4, 3, 5, 5, 3, 4, 2, 3, 1] },
  { id: "turns", name: "повторы", degrees: [1, 2, 3, 2, 1, 2, 3, 4, 3, 2, 3, 4, 5, 4, 3, 5, 4, 3, 2, 1] },
];

function fiveExercise(key: KeyDef, pattern: (typeof FIVE_PATTERNS)[number], hands: Hands): Exercise {
  const scale = scaleUp(key.tonic, "major", 1);
  const build = (): ExerciseScore => ({
    fifths: key.fifths,
    bpm: 72,
    ...withHands(
      hands,
      () => line(pattern.degrees.map((d) => scale[d - 1]), pattern.degrees, 2),
      () => line(pattern.degrees.map((d) => shift(scale[d - 1], -1)), pattern.degrees.map((d) => 6 - d), 2),
    ),
  });
  const pos = `позиция «${key.name.split(" ")[0]}»`;
  return {
    id: `five-${key.id}-${pattern.id}-${hands}`,
    category: "five",
    group: pos[0].toUpperCase() + pos.slice(1),
    variant: `${pattern.name}, ${HANDS_LABEL[hands]}`,
    title: `Пять пальцев, ${pos}: ${pattern.name} (${HANDS_LABEL[hands]})`,
    build,
  };
}

type ScaleVariant = "rh" | "lh" | "contrary" | "parallel" | "parallel2";
const SCALE_VARIANT_LABEL: Record<ScaleVariant, string> = {
  rh: "правая",
  lh: "левая",
  contrary: "расходящаяся",
  parallel: "обе руки",
  parallel2: "обе, 2 октавы",
};

function scaleExercise(key: KeyDef, variant: ScaleVariant, mode: ScaleMode, idPrefix: string): Exercise {
  const octaves = variant === "parallel2" ? 2 : 1;
  const build = (): ExerciseScore => {
    // Мелодический минор вверх — с повышенными VI и VII, вниз — натуральный.
    const upMode = mode;
    const downMode: ScaleMode = mode === "melodic" ? "natural" : mode;
    const hand = (h: "right" | "left", octShift: number): ExNote[] => {
      const up = scaleUp(shift(key.tonic, octShift), upMode, octaves);
      const down = scaleUp(shift(key.tonic, octShift), downMode, octaves).reverse();
      const fing = scaleFingers(h === "right" ? key.rh : key.lh, octaves, h);
      return line([...up, ...down.slice(1)], [...fing, ...fing.slice(0, -1).reverse()], 2);
    };
    if (variant === "contrary") {
      // Правая вверх от тоники, левая вниз от тоники октавой ниже (пальцы зеркально), и обратно.
      const up = scaleUp(key.tonic, upMode, 1);
      const rightDown = scaleUp(key.tonic, downMode, 1).reverse();
      const lhAsc = scaleUp(shift(key.tonic, -2), upMode, 1); // от тоники на две октавы ниже вверх
      const lhAscDown = scaleUp(shift(key.tonic, -2), downMode, 1);
      const lhDown = [...lhAsc].reverse(); // от тоники малой октавы вниз
      const lhBack = lhAscDown; // обратно вверх
      return {
        fifths: key.fifths,
        bpm: 66,
        right: line([...up, ...rightDown.slice(1)], [...key.rh, ...key.rh.slice(0, -1).reverse()], 2),
        left: line([...lhDown, ...lhBack.slice(1)], [...[...key.lh].reverse(), ...key.lh.slice(1)], 2),
      };
    }
    return {
      fifths: key.fifths,
      bpm: octaves === 2 ? 80 : 66,
      right: variant === "lh" ? undefined : hand("right", 0),
      left: variant === "rh" ? undefined : hand("left", -1),
    };
  };
  const modeName = mode === "harmonic" ? " (гармонический)" : mode === "melodic" ? " (мелодический)" : "";
  const name = key.name[0].toUpperCase() + key.name.slice(1);
  return {
    id: `${idPrefix}-${key.id}-${variant}`,
    category: key.minor ? "minor" : "major",
    group: name,
    variant: `${SCALE_VARIANT_LABEL[variant]}${mode === "melodic" ? ", мелодич." : ""}`,
    title: `Гамма ${key.name}${modeName}: ${SCALE_VARIANT_LABEL[variant]}`,
    build,
  };
}

function arpeggioExercise(key: KeyDef, variant: "rh" | "lh" | "parallel2"): Exercise {
  const octaves = variant === "parallel2" ? 2 : 1;
  const build = (): ExerciseScore => {
    const hand = (h: "right" | "left", octShift: number): ExNote[] => {
      const scale = scaleUp(shift(key.tonic, octShift), key.minor ? "natural" : "major", octaves);
      const chord = scale.filter((_, i) => i % 7 === 0 || i % 7 === 2 || i % 7 === 4);
      const one = h === "right" ? key.arpRh! : key.arpLh!;
      const fing = octaves === 1 ? one : h === "right" ? [one[0], one[1], one[2], one[0], one[1], one[2], one[3]] : [one[0], one[1], one[2], one[3], one[1], one[2], one[3]];
      return line(upDown(chord), upDown(fing), 2);
    };
    return {
      fifths: key.fifths,
      bpm: 66,
      right: variant === "lh" ? undefined : hand("right", 0),
      left: variant === "rh" ? undefined : hand("left", -1),
    };
  };
  const name = key.name[0].toUpperCase() + key.name.slice(1);
  const label = variant === "rh" ? "правая" : variant === "lh" ? "левая" : "обе, 2 октавы";
  return {
    id: `arp-${key.id}-${variant}`,
    category: "arpeggio",
    group: name,
    variant: label,
    title: `Арпеджио ${key.name}: ${label}`,
    build,
  };
}

// Узоры в духе Ганона: смещения по белым клавишам и пальцы (вверх; вниз — зеркально).
const HANON: { id: string; name: string; steps: number[]; rh: number[]; lh: number[] }[] = [
  { id: "1", name: "Узор 1", steps: [0, 2, 3, 4, 5, 4, 3, 2], rh: [1, 2, 3, 4, 5, 4, 3, 2], lh: [5, 4, 3, 2, 1, 2, 3, 4] },
  { id: "2", name: "Узор 2", steps: [0, 2, 5, 4, 3, 4, 3, 2], rh: [1, 2, 5, 4, 3, 4, 3, 2], lh: [5, 4, 1, 2, 3, 2, 3, 4] },
  { id: "3", name: "Узор 3", steps: [0, 2, 5, 4, 3, 2, 3, 4], rh: [1, 2, 5, 4, 3, 2, 3, 4], lh: [5, 4, 1, 2, 3, 4, 3, 2] },
];

function hanonExercise(p: (typeof HANON)[number], hands: Hands): Exercise {
  const build = (): ExerciseScore => {
    const hand = (h: "right" | "left"): ExNote[] => {
      const white = (i: number): Pitch => ({ letter: LETTERS[((i % 7) + 7) % 7], alter: 0, oct: (h === "right" ? 4 : 3) + Math.floor(i / 7) });
      const up = h === "right" ? p.rh : p.lh;
      const down = h === "right" ? p.lh : p.rh; // зеркальный узор играется зеркальными пальцами
      const pitches: Pitch[] = [];
      const fingers: number[] = [];
      for (let base = 0; base < 7; base++) for (let k = 0; k < 8; k++) (pitches.push(white(base + p.steps[k])), fingers.push(up[k]));
      for (let top = 11; top > 4; top--) for (let k = 0; k < 8; k++) (pitches.push(white(top - p.steps[k])), fingers.push(down[k]));
      pitches.push(white(0));
      fingers.push(h === "right" ? 1 : 5);
      return line(pitches, fingers, 1);
    };
    return { fifths: 0, bpm: 60, ...withHands(hands, () => hand("right"), () => hand("left")) };
  };
  return {
    id: `hanon-${p.id}-${hands}`,
    category: "hanon",
    group: p.name,
    variant: HANDS_LABEL[hands],
    title: `В духе Ганона, ${p.name.toLowerCase()} (${HANDS_LABEL[hands]})`,
    build,
  };
}

function buildCatalog(): Exercise[] {
  const out: Exercise[] = [];
  for (const key of FIVE_POSITIONS) {
    for (const hands of ["right", "left", "both"] as Hands[]) out.push(fiveExercise(key, FIVE_PATTERNS[0], hands));
    out.push(fiveExercise(key, FIVE_PATTERNS[1], "both"));
    out.push(fiveExercise(key, FIVE_PATTERNS[2], "both"));
  }
  for (const p of HANON) for (const hands of ["right", "left", "both"] as Hands[]) out.push(hanonExercise(p, hands));
  for (const key of MAJOR_KEYS)
    for (const v of ["rh", "lh", "contrary", "parallel", "parallel2"] as ScaleVariant[]) out.push(scaleExercise(key, v, "major", "major"));
  for (const key of MINOR_KEYS) {
    for (const v of ["rh", "lh", "parallel"] as ScaleVariant[]) out.push(scaleExercise(key, v, "harmonic", "minor"));
    out.push(scaleExercise(key, "parallel", "melodic", "minor-mel"));
  }
  for (const key of [...MAJOR_KEYS, ...MINOR_KEYS].filter((k) => k.arpRh))
    for (const v of ["rh", "lh", "parallel2"] as const) out.push(arpeggioExercise(key, v));
  return out;
}

export const EXERCISES: Exercise[] = buildCatalog();
export const EXERCISE_BY_ID = new Map(EXERCISES.map((e) => [e.id, e]));

/** Упражнение, открывающее раздел (раздел «Пять пальцев» открыт сразу). */
export const CATEGORY_GATE: Record<Category, string | null> = {
  five: null,
  hanon: "five-C-updown-both",
  major: "five-C-updown-both",
  minor: "major-C-parallel",
  arpeggio: "major-C-parallel",
};

/** Открытые упражнения: первое в разделе — когда пройдено упражнение-ключ, дальше — по порядку. */
export function unlockedSet(passed: Set<string>): Set<string> {
  const open = new Set<string>();
  for (const c of CATEGORIES) {
    const gate = CATEGORY_GATE[c.id];
    if (gate && !passed.has(gate)) continue;
    const list = EXERCISES.filter((e) => e.category === c.id);
    for (let i = 0; i < list.length; i++) {
      if (i === 0 || passed.has(list[i - 1].id)) open.add(list[i].id);
      else break;
    }
  }
  return open;
}

// --- Разминка дня ---

export interface ExerciseStatView {
  exercise: string;
  attempts: number;
  passed: boolean;
  /** Сколько попыток засчитано. */
  passes?: number;
  bestAccuracy: number;
  lastAt: number;
  lastTimingSdMs: number;
  lastLoudness: number;
}

export function seeded(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

/**
 * Разминка на ~5 минут: пять пальцев, текущая гамма, минор или арпеджио, Ганон —
 * из открытого. Сначала непройденные «на переднем крае», иначе пройденные,
 * которые давно не играли или играли неровно. Выбор постоянен в течение дня.
 */
export function warmup(stats: ExerciseStatView[], day: string): Exercise[] {
  const passed = new Set(stats.filter((s) => s.passed).map((s) => s.exercise));
  const open = unlockedSet(passed);
  const statOf = new Map(stats.map((s) => [s.exercise, s]));
  const rnd = seeded([...day].reduce((h, c) => h * 31 + c.charCodeAt(0), 7));
  const pick = (cats: Category[]): Exercise | null => {
    const list = EXERCISES.filter((e) => cats.includes(e.category) && open.has(e.id));
    if (!list.length) return null;
    const frontier = list.filter((e) => !passed.has(e.id));
    if (frontier.length) return frontier[0];
    // Пройденное: чем давнее и неровнее, тем вероятнее.
    const weight = (e: Exercise) => {
      const s = statOf.get(e.id);
      if (!s) return 1;
      return 1 + Math.min(10, (Date.now() / 1000 - s.lastAt) / 86400) + s.lastTimingSdMs / 20 + (1 - s.lastLoudness) * 5;
    };
    const total = list.reduce((sum, e) => sum + weight(e), 0);
    let r = rnd() * total;
    for (const e of list) if ((r -= weight(e)) <= 0) return e;
    return list[list.length - 1];
  };
  const chosen = [pick(["five"]), pick(["major"]), pick(rnd() < 0.5 ? ["minor", "arpeggio"] : ["arpeggio", "minor"]), pick(["hanon"])];
  const out: Exercise[] = [];
  for (const e of chosen) if (e && !out.includes(e)) out.push(e);
  // В самом начале открыт только раздел «Пять пальцев»: добавим ещё одно упражнение оттуда.
  if (out.length < 2) {
    const extra = EXERCISES.find((e) => open.has(e.id) && !out.includes(e));
    if (extra) out.push(extra);
  }
  return out;
}

// --- Оценка ровности ---

export interface HitRecord {
  id: string;
  deltaMs: number;
  velocity: number;
}

export interface Evaluation {
  accuracy: number;
  /** Разброс отклонений от ритма (стандартное отклонение), мс. */
  timingSdMs: number;
  meanAbsMs: number;
  /** Ровность громкости 0–1 (1 − коэффициент вариации силы нажатия). */
  loudness: number;
  byFinger: { finger: number; velocity: number; count: number }[];
  /** Самый слабый палец (если заметно тише остальных). */
  weakFinger: { finger: number; ratio: number } | null;
  /** Среднее отклонение на подкладывании/перекладывании пальцев и на остальных нотах. */
  crossingMs: number | null;
  otherMs: number | null;
  /** Ноты с самым большим отклонением: id и сдвиг. */
  worst: { id: string; deltaMs: number }[];
  passed: boolean;
  /** Барабаны: акценты и тихие ноты. */
  dynamics?: import("./drums").DynamicsEval;
  /** Бас: раньше или позже барабанов, по местам в такте. */
  groove?: import("./groove").GrooveStats;
}

export const PASS_ACCURACY = 0.95;
export const PASS_TIMING_SD_MS = 60;

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const sd = (xs: number[]) => {
  const m = mean(xs);
  return xs.length > 1 ? Math.sqrt(mean(xs.map((x) => (x - m) ** 2))) : 0;
};

/** Ноты, где рука меняет позицию: первый палец подкладывается или палец перекладывается через первый. */
export function crossingNotes(notes: ScoreNote[], fingerOf: Map<string, number>): Set<string> {
  const out = new Set<string>();
  for (const hand of ["right", "left"] as const) {
    const seq = notes.filter((n) => n.hand === hand && fingerOf.has(n.id)).sort((a, b) => a.startMs - b.startMs);
    for (let i = 1; i < seq.length; i++) {
      const a = seq[i - 1];
      const b = seq[i];
      const fa = fingerOf.get(a.id)!;
      const fb = fingerOf.get(b.id)!;
      const outward = hand === "right" ? b.pitch > a.pitch : b.pitch < a.pitch;
      if ((fb === 1 && fa > 1 && outward) || (fa === 1 && fb > 2 && !outward && b.pitch !== a.pitch)) out.add(b.id);
    }
  }
  return out;
}

export function evaluate(
  hits: HitRecord[],
  required: number,
  extras: number,
  notes: ScoreNote[],
  fingerOf: Map<string, number>,
  tempo: number,
): Evaluation {
  const accuracy = required === 0 ? 1 : hits.length / (required + extras);
  const deltas = hits.map((h) => h.deltaMs);
  const velocities = hits.map((h) => h.velocity).filter((v) => v > 0);
  const vMean = mean(velocities);
  const loudness = velocities.length > 1 && vMean > 0 ? Math.max(0, 1 - sd(velocities) / vMean) : 1;
  const perFinger = new Map<number, number[]>();
  for (const h of hits) {
    const fg = fingerOf.get(h.id);
    if (fg && h.velocity > 0) perFinger.set(fg, [...(perFinger.get(fg) ?? []), h.velocity]);
  }
  const byFinger = [...perFinger]
    .map(([finger, vs]) => ({ finger, velocity: Math.round(mean(vs)), count: vs.length }))
    .sort((a, b) => a.finger - b.finger);
  const weakest = byFinger.filter((b) => b.count >= 2).sort((a, b) => a.velocity - b.velocity)[0];
  const weakFinger = weakest && vMean > 0 && weakest.velocity / vMean < 0.88 ? { finger: weakest.finger, ratio: weakest.velocity / vMean } : null;
  const crossing = crossingNotes(notes, fingerOf);
  const cross = hits.filter((h) => crossing.has(h.id)).map((h) => Math.abs(h.deltaMs));
  const other = hits.filter((h) => !crossing.has(h.id)).map((h) => Math.abs(h.deltaMs));
  const timingSdMs = Math.round(sd(deltas));
  return {
    accuracy,
    timingSdMs,
    meanAbsMs: Math.round(mean(deltas.map(Math.abs))),
    loudness,
    byFinger,
    weakFinger,
    crossingMs: cross.length ? Math.round(mean(cross)) : null,
    otherMs: other.length ? Math.round(mean(other)) : null,
    worst: [...hits]
      .sort((a, b) => Math.abs(b.deltaMs) - Math.abs(a.deltaMs))
      .slice(0, 3)
      .filter((h) => Math.abs(h.deltaMs) > 50)
      .map((h) => ({ id: h.id, deltaMs: h.deltaMs })),
    passed: accuracy >= PASS_ACCURACY && timingSdMs <= PASS_TIMING_SD_MS && tempo >= 0.999,
  };
}
