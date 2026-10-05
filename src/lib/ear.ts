// Тренажёр слуха: интервалы, аккорды, ступени в тональности, мелодический и ритмический диктант.
// Задание — что прозвучит (ноты во времени) и что считать верным ответом: кнопкой (название)
// или игрой на инструменте (высоты). Серии и ступени — как у остальных тренажёров.

import type { ExerciseStatView } from "./exercises";
import { seeded } from "./exercises";
import { QUALITY_STEPS, type Quality } from "./chords";
import { rhythmScore, onsets as rhythmOnsets, type RhythmLevel, type RhythmScore } from "./rhythm";

export type EarKind = "interval" | "chord" | "degree" | "melody" | "rhythm";

export const EAR_KINDS: { id: EarKind; title: string; description: string }[] = [
  { id: "interval", title: "Интервалы", description: "Две ноты по очереди или вместе — какое между ними расстояние. Подсказка — начало известной мелодии." },
  { id: "chord", title: "Аккорды", description: "Мажор или минор, потом уменьшённые, увеличенные, sus и септаккорды." },
  { id: "degree", title: "Ступени в тональности", description: "Сначала звучит каденция (тоника), потом нота или аккорд — какая это ступень. Так подбирают песни на слух." },
  { id: "melody", title: "Мелодический диктант", description: "Короткая мелодия — сыграй её на инструменте. Первая нота — тоника, её покажут." },
  { id: "rhythm", title: "Ритмический диктант", description: "Прозвучит ритм — простучи его любой клавишей или пэдом после отсчёта." },
];

// --- Интервалы ---

export interface IntervalDef {
  semis: number;
  short: string;
  name: string;
  /** Подсказка: начало мелодии с этим интервалом вверх. */
  song: string;
}

export const INTERVALS: IntervalDef[] = [
  { semis: 1, short: "м2", name: "малая секунда", song: "«Челюсти», «К Элизе» (вниз)" },
  { semis: 2, short: "б2", name: "большая секунда", song: "«С днём рожденья» (2-я и 3-я ноты)" },
  { semis: 3, short: "м3", name: "малая терция", song: "«Колыбельная» Брамса" },
  { semis: 4, short: "б3", name: "большая терция", song: "«Когда святые маршируют»" },
  { semis: 5, short: "ч4", name: "чистая кварта", song: "Гимн России («Рос-си-я»)" },
  { semis: 6, short: "тритон", name: "тритон (ув. кварта)", song: "«Симпсоны», «Мария» из «Вестсайдской истории»" },
  { semis: 7, short: "ч5", name: "чистая квинта", song: "«Ах, скажу я вам, мама», «Звёздные войны»" },
  { semis: 8, short: "м6", name: "малая секста", song: "«История любви» (Love Story)" },
  { semis: 9, short: "б6", name: "большая секста", song: "«В лесу родилась ёлочка»" },
  { semis: 10, short: "м7", name: "малая септима", song: "Тема «Звёздного пути»" },
  { semis: 11, short: "б7", name: "большая септима", song: "«Take On Me» (припев)" },
  { semis: 12, short: "ч8", name: "октава", song: "«Над радугой» (Somewhere Over the Rainbow)" },
];
export const INTERVAL_BY_SEMIS = new Map(INTERVALS.map((i) => [i.semis, i]));

// --- Аккорды ---

export const CHORD_KINDS: { q: Quality; name: string }[] = [
  { q: "", name: "мажор" },
  { q: "m", name: "минор" },
  { q: "dim", name: "уменьшённый" },
  { q: "aug", name: "увеличенный" },
  { q: "sus2", name: "sus2" },
  { q: "sus4", name: "sus4" },
  { q: "7", name: "7 (доминантсепт)" },
  { q: "maj7", name: "maj7" },
  { q: "m7", name: "m7" },
];
export const CHORD_KIND_NAME = new Map(CHORD_KINDS.map((c) => [c.q, c.name]));

// --- Ступени ---

const MAJOR = [0, 2, 4, 5, 7, 9, 11];
export const DEGREE_NAMES = ["I", "II", "III", "IV", "V", "VI", "VII"];
/** Аккорды ступеней мажора: римская цифра (минорные — строчными) и вид. */
export const DEGREE_CHORDS: { roman: string; degree: number; q: Quality }[] = [
  { roman: "I", degree: 0, q: "" },
  { roman: "ii", degree: 1, q: "m" },
  { roman: "iii", degree: 2, q: "m" },
  { roman: "IV", degree: 3, q: "" },
  { roman: "V", degree: 4, q: "" },
  { roman: "vi", degree: 5, q: "m" },
];
/** Частые последовательности аккордов (для ступени «последовательности»). */
export const PROGRESSIONS: string[][] = [
  ["I", "V", "vi", "IV"],
  ["I", "vi", "IV", "V"],
  ["I", "IV", "V", "I"],
  ["vi", "IV", "I", "V"],
  ["I", "IV", "vi", "V"],
  ["ii", "V", "I", "I"],
];

// --- Ступени тренажёра ---

export interface EarLevel {
  kind: EarKind;
  id: number;
  title: string;
  description: string;
  /** Интервалы: полутоны и направление. */
  semis?: number[];
  direction?: "up" | "down" | "harmonic";
  /** Аккорды: виды и обращения. */
  qualities?: Quality[];
  inversions?: boolean;
  /** Ступени: ноты (номера ступеней) или аккорды (римские), или последовательности. */
  degrees?: number[];
  romans?: string[];
  progressions?: boolean;
  /** Диктант: длина, наибольший скачок (ступеней гаммы), случайная тональность. */
  length?: number;
  leap?: number;
  anyKey?: boolean;
  /** Ритм: кубики и число тактов. */
  blocks?: string[];
  measures?: number;
}

export const EAR_LEVELS: EarLevel[] = [
  { kind: "interval", id: 1, title: "Кварта, квинта, октава", description: "Чистые интервалы вверх — самые устойчивые на слух.", semis: [5, 7, 12], direction: "up" },
  { kind: "interval", id: 2, title: "+ терции", description: "Малая и большая терция: «грустная» и «светлая».", semis: [3, 4, 5, 7, 12], direction: "up" },
  { kind: "interval", id: 3, title: "+ секунды", description: "Соседние ноты: полтона и тон.", semis: [1, 2, 3, 4, 5, 7, 12], direction: "up" },
  { kind: "interval", id: 4, title: "+ сексты", description: "Широкие интервалы: «История любви», «Ёлочка».", semis: [1, 2, 3, 4, 5, 7, 8, 9, 12], direction: "up" },
  { kind: "interval", id: 5, title: "Все вверх", description: "Добавляются тритон и септимы.", semis: INTERVALS.map((i) => i.semis), direction: "up" },
  { kind: "interval", id: 6, title: "Все вниз", description: "Вторая нота ниже первой.", semis: INTERVALS.map((i) => i.semis), direction: "down" },
  { kind: "interval", id: 7, title: "Все вместе", description: "Обе ноты звучат одновременно (гармонический интервал).", semis: INTERVALS.map((i) => i.semis), direction: "harmonic" },
  { kind: "chord", id: 1, title: "Мажор или минор", description: "Светлый или грустный.", qualities: ["", "m"] },
  { kind: "chord", id: 2, title: "+ уменьшённый и увеличенный", description: "Напряжённый (dim) и «подвешенный» (aug).", qualities: ["", "m", "dim", "aug"] },
  { kind: "chord", id: 3, title: "+ sus2 и sus4", description: "Без терции: вместо неё секунда или кварта.", qualities: ["", "m", "sus2", "sus4"] },
  { kind: "chord", id: 4, title: "Септаккорды", description: "7, maj7 и m7 рядом с мажором и минором.", qualities: ["", "m", "7", "maj7", "m7"] },
  { kind: "chord", id: 5, title: "Все, в обращениях", description: "Любой вид, нижняя нота — не обязательно основной тон.", qualities: CHORD_KINDS.map((c) => c.q), inversions: true },
  { kind: "degree", id: 1, title: "Ступени I, III, V", description: "Ноты тонического трезвучия после каденции.", degrees: [0, 2, 4] },
  { kind: "degree", id: 2, title: "Все ступени мажора", description: "Любая нота гаммы: I–VII.", degrees: [0, 1, 2, 3, 4, 5, 6] },
  { kind: "degree", id: 3, title: "Аккорды I, IV, V", description: "Три главных аккорда — на них держится большинство песен.", romans: ["I", "IV", "V"] },
  { kind: "degree", id: 4, title: "Аккорды I, ii, IV, V, vi", description: "Добавляются минорные ii и vi.", romans: ["I", "ii", "IV", "V", "vi"] },
  { kind: "degree", id: 5, title: "Последовательности", description: "Четыре аккорда подряд — какая последовательность прозвучала.", progressions: true },
  { kind: "melody", id: 1, title: "Три ноты", description: "Соседние ноты от тоники (до–ре–ми–фа–соль).", length: 3, leap: 1 },
  { kind: "melody", id: 2, title: "Четыре ноты", description: "Ступени и терции в пределах пяти нот.", length: 4, leap: 2 },
  { kind: "melody", id: 3, title: "Пять нот в октаве", description: "Вся гамма, скачки до терции.", length: 5, leap: 2 },
  { kind: "melody", id: 4, title: "Шесть нот, скачки", description: "Скачки до квинты.", length: 6, leap: 4 },
  { kind: "melody", id: 5, title: "Разные тональности", description: "Шесть нот, любая мажорная тональность, скачки до октавы.", length: 6, leap: 7, anyKey: true },
  { kind: "rhythm", id: 1, title: "Четверти и половинные", description: "Два такта по четыре счёта.", blocks: ["q", "q", "h"], measures: 2 },
  { kind: "rhythm", id: 2, title: "+ восьмые и паузы", description: "«Раз-и» и счёт без удара.", blocks: ["q", "h", "ee", "ee", "qr"], measures: 2 },
  { kind: "rhythm", id: 3, title: "+ четверть с точкой", description: "Длинно-коротко на два счёта.", blocks: ["q", "h", "ee", "qde", "qr"], measures: 2 },
  { kind: "rhythm", id: 4, title: "Синкопы", description: "Удар на «и» после паузы, восьмая — четверть — восьмая.", blocks: ["q", "ee", "eqe", "ere", "qde", "qr"], measures: 2 },
];

export const earLevelId = (l: Pick<EarLevel, "kind" | "id">) => `ear-${l.kind}-${l.id}`;
export const EAR_SERIES = 10;
export const EAR_DICTATION_SERIES = 5;
export const EAR_PASS_ACCURACY = 0.8;
export const EAR_RHYTHM_BPM = 80;

export const levelsOf = (kind: EarKind) => EAR_LEVELS.filter((l) => l.kind === kind);

export function earUnlocked(stats: ExerciseStatView[], kind: EarKind): number {
  const passed = new Set(stats.filter((s) => s.passed).map((s) => s.exercise));
  const list = levelsOf(kind);
  let n = 1;
  while (n < list.length && passed.has(earLevelId(list[n - 1]))) n++;
  return n;
}

// --- Задания ---

/** Нота задания: высота, начало и длительность, мс. */
export interface EarNote {
  pitch: number;
  startMs: number;
  durMs: number;
}

export interface EarQuestion {
  /** Что прозвучит. */
  notes: EarNote[];
  /** Варианты кнопок и верный. */
  options: string[];
  answer: string;
  /** Ответ игрой: ожидаемые высоты (интервал — вторая нота; аккорд — звуки; диктант — мелодия по порядку). */
  expected: number[];
  /** Ответ игрой засчитывается по названию звука (любая октава). */
  byClass: boolean;
  /** Подсказка после ответа (мелодия-подсказка, названия звуков). */
  explain: string;
  /** Опорная нота, которую можно показать (первая нота интервала, тоника). */
  given?: number;
  /** Ритм: моменты ударов (мс от первой доли) и ноты для показа. */
  rhythm?: { onsetsMs: number[]; score: RhythmScore };
}

const NOTE_NAMES = ["до", "до♯", "ре", "ми♭", "ми", "фа", "фа♯", "соль", "ля♭", "ля", "си♭", "си"];
export const pcName = (p: number) => NOTE_NAMES[((p % 12) + 12) % 12];

const NOTE_MS = 650;

/** Звуки аккорда от баса в удобном регистре (тесное расположение, обращение по `inv`). */
export function voiceChord(root: number, q: Quality, inv = 0): number[] {
  const steps = QUALITY_STEPS[q].map((s) => root + s);
  for (let i = 0; i < inv; i++) steps.push((steps.shift() as number) + 12);
  return steps;
}

const chord = (pitches: number[], at: number, dur: number, strum = 0): EarNote[] =>
  pitches.map((pitch, i) => ({ pitch, startMs: at + i * strum, durMs: dur - i * strum }));

/** Каденция I–IV–V–I в тональности `tonic` (MIDI основного тона около 60). */
export function cadence(tonic: number, strum = 0): EarNote[] {
  const t = tonic;
  return [
    ...chord([t, t + 4, t + 7], 0, 600, strum),
    ...chord([t, t + 5, t + 9], 650, 600, strum),
    ...chord([t - 1, t + 2, t + 7], 1300, 600, strum),
    ...chord([t, t + 4, t + 7], 1950, 900, strum),
  ];
}
export const CADENCE_MS = 3100;

/** Серия заданий ступени. `guitar` — гитарный регистр и удар по струнам у аккордов. */
export function earSeries(level: EarLevel, seed: number, guitar = false, count?: number): EarQuestion[] {
  const rnd = seeded(seed * 7919 + level.id * 101 + level.kind.length * 13);
  const pick = <T,>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)];
  const n = count ?? (level.kind === "melody" || level.kind === "rhythm" ? EAR_DICTATION_SERIES : EAR_SERIES);
  const low = guitar ? 45 : 52;
  const strum = guitar ? 28 : 0;
  const out: EarQuestion[] = [];
  let prev = "";
  for (let k = 0; k < n; k++) {
    let q: EarQuestion;
    let tries = 0;
    do {
      q = makeQuestion(level, rnd, pick, low, strum);
      tries++;
    } while (q.answer === prev && tries < 5 && !["melody", "rhythm"].includes(level.kind));
    prev = q.answer;
    out.push(q);
  }
  return out;
}

function makeQuestion(level: EarLevel, rnd: () => number, pick: <T>(xs: T[]) => T, low: number, strum: number): EarQuestion {
  switch (level.kind) {
    case "interval": {
      const semis = pick(level.semis!);
      const def = INTERVAL_BY_SEMIS.get(semis)!;
      const dir = level.direction ?? "up";
      const a = dir === "down" ? low + 12 + Math.floor(rnd() * 8) : low + Math.floor(rnd() * 10);
      const b = dir === "down" ? a - semis : a + semis;
      const notes: EarNote[] =
        dir === "harmonic"
          ? [
              { pitch: a, startMs: 0, durMs: 1400 },
              { pitch: b, startMs: strum, durMs: 1400 - strum },
            ]
          : [
              { pitch: a, startMs: 0, durMs: NOTE_MS },
              { pitch: b, startMs: NOTE_MS + 50, durMs: NOTE_MS + 250 },
            ];
      return {
        notes,
        options: level.semis!.map((s) => INTERVAL_BY_SEMIS.get(s)!.short),
        answer: def.short,
        expected: [b],
        byClass: true,
        explain: `${def.name}: ${pcName(a)} → ${pcName(b)}. Вверх: ${def.song}`,
        given: a,
      };
    }
    case "chord": {
      const quality = pick(level.qualities!);
      const root = low + 3 + Math.floor(rnd() * 8);
      const size = QUALITY_STEPS[quality].length;
      const inv = level.inversions ? Math.floor(rnd() * size) : 0;
      const pitches = voiceChord(root, quality, inv);
      return {
        notes: chord(pitches, 0, 1600, strum),
        options: level.qualities!.map((x) => CHORD_KIND_NAME.get(x)!),
        answer: CHORD_KIND_NAME.get(quality)!,
        expected: pitches,
        byClass: true,
        explain: `${CHORD_KIND_NAME.get(quality)}: ${pitches.map(pcName).join(" · ")}`,
        given: inv ? undefined : root,
      };
    }
    case "degree": {
      const tonic = low + 6 + Math.floor(rnd() * 6);
      const lead = cadence(tonic, strum);
      const at = CADENCE_MS + 500;
      if (level.degrees) {
        const d = pick(level.degrees);
        const pitch = tonic + MAJOR[d];
        return {
          notes: [...lead, { pitch, startMs: at, durMs: 1000 }],
          options: level.degrees.map((x) => DEGREE_NAMES[x]),
          answer: DEGREE_NAMES[d],
          expected: [pitch],
          byClass: true,
          explain: `Ступень ${DEGREE_NAMES[d]}: тоника ${pcName(tonic)}, нота ${pcName(pitch)}`,
          given: tonic,
        };
      }
      if (level.romans) {
        const roman = pick(level.romans);
        const c = DEGREE_CHORDS.find((x) => x.roman === roman)!;
        const pitches = voiceChord(tonic + MAJOR[c.degree], c.q);
        return {
          notes: [...lead, ...chord(pitches, at, 1400, strum)],
          options: level.romans,
          answer: roman,
          expected: pitches,
          byClass: true,
          explain: `${roman}: ${pitches.map(pcName).join(" · ")} (тоника ${pcName(tonic)})`,
          given: tonic,
        };
      }
      // Последовательность из четырёх аккордов (без каденции — она сама задаёт тональность).
      const prog = pick(PROGRESSIONS);
      const notes = prog.flatMap((roman, i) => {
        const c = DEGREE_CHORDS.find((x) => x.roman === roman)!;
        return chord(voiceChord(tonic + MAJOR[c.degree], c.q), i * 900, 850, strum);
      });
      const label = (p: string[]) => p.join("–");
      return {
        notes,
        options: PROGRESSIONS.map(label),
        answer: label(prog),
        expected: [],
        byClass: true,
        explain: `${label(prog)} в тональности ${pcName(tonic)} мажор`,
        given: tonic,
      };
    }
    case "melody": {
      const tonic = level.anyKey ? low + 3 + Math.floor(rnd() * 8) : low + 8;
      const leap = level.leap ?? 1;
      const range = level.length! <= 4 && leap <= 2 ? 4 : 7;
      const degs = [0];
      while (degs.length < level.length!) {
        const last = degs[degs.length - 1];
        const options: number[] = [];
        for (let d = -leap; d <= leap; d++) if (d !== 0 && last + d >= 0 && last + d <= range) options.push(last + d);
        degs.push(pick(options));
      }
      const pitchOf = (d: number) => tonic + Math.floor(d / 7) * 12 + MAJOR[d % 7];
      const pitches = degs.map(pitchOf);
      return {
        notes: pitches.map((pitch, i) => ({ pitch, startMs: i * NOTE_MS, durMs: NOTE_MS - 40 })),
        options: [],
        answer: pitches.join(","),
        expected: pitches,
        byClass: true,
        explain: pitches.map(pcName).join(" – "),
        given: tonic,
      };
    }
    case "rhythm": {
      const lvl: RhythmLevel = { id: level.id, track: "line", title: "", description: "", beats: 4, right: level.blocks!, measures: level.measures ?? 2, bpm: EAR_RHYTHM_BPM };
      const score = rhythmScore(lvl, Math.floor(rnd() * 1_000_000));
      const sixteenth = 60_000 / EAR_RHYTHM_BPM / 4;
      const onsetsMs = rhythmOnsets(score.right, 4).map((s) => s * sixteenth);
      return {
        notes: onsetsMs.map((t) => ({ pitch: 76, startMs: t, durMs: 120 })),
        options: [],
        answer: onsetsMs.join(","),
        expected: [],
        byClass: false,
        explain: "",
        rhythm: { onsetsMs, score },
      };
    }
  }
}

// --- Проверка ответов игрой ---

/** Интервал/ступень: верна ли сыгранная нота (по названию звука; октава любая, кроме октавы от данной ноты). */
export function judgeNote(q: EarQuestion, played: number): boolean {
  const target = q.expected[0];
  if (target === undefined) return false;
  if (q.given !== undefined && target - q.given === 12) return played % 12 === target % 12 && played !== q.given;
  return played % 12 === target % 12;
}

/** Аккорд: сыграны ровно звуки аккорда (любая октава и расположение). */
export function judgeChordPlay(q: EarQuestion, played: number[]): boolean {
  const want = new Set(q.expected.map((p) => p % 12));
  const got = new Set(played.map((p) => p % 12));
  return want.size === got.size && [...want].every((pc) => got.has(pc));
}

/**
 * Мелодический диктант: сколько первых нот сыграно верно (по названию звука, по порядку).
 * Возвращает длину верного начала; полный ответ — когда она равна длине мелодии.
 */
export function melodyPrefix(q: EarQuestion, played: number[]): number {
  let k = 0;
  while (k < played.length && k < q.expected.length && played[k] % 12 === q.expected[k] % 12) k++;
  return k;
}

/**
 * Ритмический диктант: удары ученика (мс, свои часы) против образца. Первый удар совмещается
 * с первым ударом образца; дальше каждый удар — в пределах допуска (доля от четверти).
 * Возвращает долю верных ударов (лишние и пропущенные — ошибки).
 */
export function judgeRhythm(q: EarQuestion, taps: number[], tolerance = 0.22): { accuracy: number; hits: number; total: number } {
  const ref = q.rhythm?.onsetsMs ?? [];
  if (!ref.length || !taps.length) return { accuracy: 0, hits: 0, total: ref.length };
  const beat = 60_000 / EAR_RHYTHM_BPM;
  const shift = taps[0] - ref[0];
  const used = new Set<number>();
  let hits = 0;
  for (const t of taps) {
    const at = t - shift;
    let best = -1;
    for (let i = 0; i < ref.length; i++)
      if (!used.has(i) && Math.abs(ref[i] - at) <= beat * tolerance && (best < 0 || Math.abs(ref[i] - at) < Math.abs(ref[best] - at))) best = i;
    if (best >= 0) {
      used.add(best);
      hits++;
    }
  }
  const extras = taps.length - hits;
  const accuracy = Math.max(0, (hits - extras) / ref.length);
  return { accuracy, hits, total: ref.length };
}

/** GM-программа тембра заданий: фортепиано — звук приложения, гитара — акустическая гитара. */
export const EAR_TIMBRE_PROGRAM: Record<"piano" | "guitar", number | null> = { piano: null, guitar: 25 };
