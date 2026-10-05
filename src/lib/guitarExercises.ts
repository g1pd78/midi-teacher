// Упражнения для гитары и баса: «паучок» и хроматика, пентатоника, гаммы и арпеджио по позициям,
// игра под барабаны. Строятся под строй ученика: узоры заданы ладами и пальцами левой руки,
// звуки — от открытых струн. Запись — та же модель песни из табов (табы + барабаны).

import { TUNINGS } from "./guitar";
import type { ExerciseStatView } from "./exercises";
import { seeded } from "./exercises";
import { TPQ, writtenDuration, type TabSong, type TsBeat, type TsNote, type TsPart } from "./tabsong";
import { parseChord, rootPc } from "./chords";
import { STRUM_BY_ID, patternArrows, strumSong } from "./strum";
import { patternPart } from "./drumPattern";

export type GtrInstrument = "guitar" | "bass";
export type GtrCategory = "spider" | "strum" | "pentatonic" | "scales" | "arpeggio" | "groove" | "technique" | "shapes";

export const GTR_CATEGORIES: Record<GtrInstrument, { id: GtrCategory; title: string; description: string }[]> = {
  guitar: [
    { id: "spider", title: "Паучок и хроматика", description: "Каждый палец — на своём ладу: 1-2-3-4 и перестановки по всем струнам. Сила, растяжка и независимость пальцев левой руки, синхронность рук." },
    { id: "strum", title: "Бой", description: "Аккорды и ритм правой руки: схемы ↓↑ под барабаны, от четвертей до шестнадцатых. Засчитывается ритм и верно взятые аккорды." },
    { id: "pentatonic", title: "Пентатоника", description: "Минорная пентатоника в позиции — основа рок- и блюз-соло: вверх-вниз и тройками." },
    { id: "scales", title: "Гаммы в позиции", description: "Мажор и натуральный минор, палец на лад: звуки гаммы на всех струнах, не сдвигая руку." },
    { id: "arpeggio", title: "Арпеджио", description: "Звуки мажорного и минорного трезвучия по струнам в позиции." },
    { id: "groove", title: "Игра под барабаны", description: "Простые риффы под бит: рок, буги, фанк, поп. Звучат барабаны — держи ритм вместе с ними." },
  ],
  bass: [
    { id: "spider", title: "Паучок и хроматика", description: "1-2-3-4 и перестановки по четырём струнам: пальцы левой руки и ровное чередование пальцев правой." },
    {
      id: "groove",
      title: "Грув под барабаны",
      description:
        "Басовые линии под бит, ступенями: основные тоны, тон — квинта, вместе с бочкой, октавы, проходящие ноты, буги, шаффл, регги, синкопы, фанк с глушёными нотами. В итоге — раньше или позже бочки ты играешь и насколько ровно.",
    },
    { id: "technique", title: "Приёмы", description: "Чередование пальцев правой руки, короткие ноты и глушение, хаммер и пулл-офф, слайды, слэп и поп. Приём показан над нотой; оцениваются высота и ритм." },
    { id: "shapes", title: "Формы на грифе", description: "Где на грифе квинта, октава, терция и септима от основного тона: одна форма руки переносится на любой аккорд." },
    { id: "pentatonic", title: "Пентатоника", description: "Минорная пентатоника в позиции — из неё строится большинство басовых линий." },
    { id: "scales", title: "Гаммы в позиции", description: "Мажор и натуральный минор, палец на лад." },
    { id: "arpeggio", title: "Арпеджио", description: "Звуки аккорда по струнам: основа басовой линии." },
  ],
};

export interface GtrExercise {
  id: string;
  instrument: GtrInstrument;
  category: GtrCategory;
  group: string;
  variant: string;
  title: string;
  bpm: number;
  /** Подсказка перед игрой: позиция, пальцы. */
  hint: string;
  /** Песня под открытые струны `tuning` (от низкой). */
  build: (tuning: number[]) => TabSong;
}

/** Нота упражнения: струна от низкой, лад, палец (0 — открытая), глушёная нота, подпись приёма. */
interface Step {
  string: number;
  fret: number;
  finger?: number;
  dead?: boolean;
  tech?: string;
}

const STRING_LETTERS = "EADGBe";

/**
 * Рифф строкой: клетка — «A3» (струна по букве, лад), «Ax» — глушёная, «A3/H» — с подписью приёма,
 * «.» — пауза. Буквы — открытые струны стандартного строя от низкой: E A D G (B e у гитары).
 */
export function riff(text: string): (Step | null)[] {
  return text
    .trim()
    .split(/\s+/)
    .map((tok) => {
      if (tok === ".") return null;
      const m = /^([EADGBe])(x|\d+)(?:\/(.+))?$/.exec(tok);
      if (!m) throw new Error(`рифф: «${tok}»`);
      const string = STRING_LETTERS.indexOf(m[1]);
      return m[2] === "x" ? { string, fret: 0, dead: true, tech: m[3] } : { string, fret: Number(m[2]), tech: m[3] };
    });
}

/** Последовательность одинаковых длительностей → такты 4/4 (с паузой до конца последнего такта). */
function seqSong(o: {
  steps: (Step | null)[];
  type: 8 | 16 | 4;
  bpm: number;
  tuning: number[];
  kind: GtrInstrument;
  title: string;
  fingers?: boolean;
  drums?: string[][];
  triplets?: boolean;
  /** Нота звучит до следующей (паузы между ними — часть ноты), если так записывается одной нотой. */
  sustain?: boolean;
}): TabSong {
  const len = o.triplets ? TPQ / 3 : (TPQ * 4) / o.type;
  const barTicks = TPQ * 4;
  const perBar = Math.round(barTicks / len);
  const bars: TsBeat[][] = [];
  // Записанная длительность k клеток: в триолях — восьмая или четверть внутри доли.
  const written = (i: number, k: number): { type: number; dots: number; tuplet?: [number, number] } | null => {
    if (!o.triplets) return writtenDuration(k * len);
    if ((i % 3) + k > 3) return null;
    return k === 1 ? { type: 8, dots: 0, tuplet: [3, 2] } : k === 2 ? { type: 4, dots: 0, tuplet: [3, 2] } : null;
  };
  o.steps.forEach((s, i) => {
    const b = Math.floor(i / perBar);
    (bars[b] ??= []);
    if (!s) return;
    let k = 1;
    if (o.sustain && !s.dead) {
      while ((i + k) % perBar !== 0 && i + k < o.steps.length && !o.steps[i + k]) k++;
      while (k > 1 && !written(i, k)) k--;
    }
    const w = written(i, k) ?? { type: o.triplets ? 8 : o.type, dots: 0, tuplet: o.triplets ? ([3, 2] as [number, number]) : undefined };
    const note: TsNote = { pitch: o.tuning[s.string] + s.fret, string: s.string, fret: s.fret };
    if (s.dead) note.dead = true;
    const labels = [o.fingers && s.finger ? String(s.finger) : "", s.tech ?? ""].filter(Boolean);
    if (labels.length) note.techniques = labels;
    bars[b].push({ tick: (i % perBar) * len, dur: k * len, type: w.type, dots: w.dots, tuplet: w.tuplet, notes: [note] });
  });
  const drumBars = o.drums ?? [];
  const count = Math.max(bars.length, drumBars.length);
  const masters = Array.from({ length: count }, () => ({ num: 4, den: 4, ticks: barTicks, key: 0 }));
  const parts: TsPart[] = [
    {
      id: o.kind,
      name: o.title,
      kind: o.kind,
      program: o.kind === "bass" ? 33 : 27,
      tuning: o.tuning,
      capo: 0,
      staves: [{ tab: true, clef: o.kind === "bass" ? "F8" : "G8", bars: masters.map((_, i) => [bars[i] ?? []]) }],
    },
  ];
  if (drumBars.length) parts.push(o.triplets ? patternPart(drumBars, masters.length, 12, TPQ / 3) : patternPart(drumBars, masters.length));
  return { title: o.title, artist: "", album: "", tempo: o.bpm, masters, order: masters.map((_, i) => ({ master: i, tempos: [], pass: 0 })), parts };
}

// --- Барабаны ---

/** Узоры барабанов по 16 клеток (шестнадцатые): бочка, малый, хэт (или райд); шаффл — 12 клеток триолями. */
const BEATS: Record<string, string[]> = {
  //      1   2   3   4   (по 4 клетки на долю)
  rock: ["k:x.......x.x....", "s:....x.......x...", "h:x.x.x.x.x.x.x.x."],
  boogie: ["k:x.....x.x.....x.", "s:....x.......x...", "r:x..xx..xx..xx..x"],
  funk: ["k:x.....x...x....", "s:....x..x.x..x...", "h:xxxxxxxxxxxxxxxx"],
  pop: ["k:x.......x.......", "s:....x.......x...", "h:x.x.x.x.x.x.x.x."],
  disco: ["k:x...x...x...x...", "s:....x.......x...", "o:..x...x...x...x."],
  reggae: ["k:........x.......", "s:........x.......", "h:x.x.x.x.x.x.x.x."],
  motown: ["k:x.......x.......", "s:....x.......x...", "h:x.x.x.x.x.x.x.x.", "c:x..............."],
  sync: ["k:x..x..x...x.....", "s:....x.......x...", "h:x.x.x.x.x.x.x.x."],
  //        1  2  3  4  (по 3 клетки триолью на долю)
  shuffle: ["k:x.....x.....", "s:...x.....x..", "r:x.xx.xx.xx.x"],
};

// --- Позиции: звуки лада в окне ладов ---

const PC = (m: number) => ((m % 12) + 12) % 12;

/**
 * Звуки (классы высот `pcs`) в позиции: лады от `pos - 1` до `pos + 3` на всех струнах, без повторов
 * одной высоты; от первого основного тона до последнего. Палец — лад − позиция + 1 (растяжка — 1 или 4).
 */
export function positionNotes(tuning: number[], pcs: number[], root: number, pos: number, wide: boolean): Step[] {
  const lo = wide ? Math.max(0, pos - 1) : pos;
  const hi = pos + 3;
  const seen = new Set<number>();
  const out: (Step & { pitch: number })[] = [];
  tuning.forEach((open, string) => {
    for (let fret = lo; fret <= hi; fret++) {
      const pitch = open + fret;
      if (!pcs.includes(PC(pitch)) || seen.has(pitch)) continue;
      seen.add(pitch);
      out.push({ string, fret, finger: fret === 0 ? 0 : Math.min(4, Math.max(1, fret - pos + 1)), pitch });
    }
  });
  out.sort((a, b) => a.pitch - b.pitch);
  const first = out.findIndex((n) => PC(n.pitch) === PC(root));
  let last = -1;
  out.forEach((n, i) => PC(n.pitch) === PC(root) && (last = i));
  return out.slice(Math.max(0, first), last >= first ? last + 1 : out.length).map(({ string, fret, finger }) => ({ string, fret, finger }));
}

const upDown = <T,>(xs: T[]): T[] => [...xs, ...xs.slice(0, -1).reverse()];
/** Тройками: 1-2-3, 2-3-4, … вверх и обратно. */
function threes<T>(xs: T[]): T[] {
  const up: T[] = [];
  for (let i = 0; i + 2 < xs.length; i++) up.push(xs[i], xs[i + 1], xs[i + 2]);
  const r = [...xs].reverse();
  const down: T[] = [];
  for (let i = 0; i + 2 < r.length; i++) down.push(r[i], r[i + 1], r[i + 2]);
  return [...up, ...down];
}

// --- Паучок ---

const SPIDER: { id: string; name: string; fingers: number[]; kind: "per-string" | "diagonal" | "skip" | "walk" }[] = [
  { id: "1234", name: "1-2-3-4", fingers: [1, 2, 3, 4], kind: "per-string" },
  { id: "1324", name: "1-3-2-4", fingers: [1, 3, 2, 4], kind: "per-string" },
  { id: "1243", name: "1-2-4-3", fingers: [1, 2, 4, 3], kind: "per-string" },
  { id: "1432", name: "1-4-3-2", fingers: [1, 4, 3, 2], kind: "per-string" },
  { id: "diag", name: "диагональ", fingers: [1, 2, 3, 4], kind: "diagonal" },
  { id: "skip", name: "через струну", fingers: [1, 2, 3, 4], kind: "skip" },
  { id: "walk", name: "паук (две струны)", fingers: [1, 2, 3, 4], kind: "walk" },
];

function spiderSteps(strings: number, pattern: (typeof SPIDER)[number], pos: number): Step[] {
  const f = (s: number, finger: number, shift = 0): Step => ({ string: s, fret: pos + shift + finger - 1, finger });
  const up: Step[] = [];
  const down: Step[] = [];
  const order = Array.from({ length: strings }, (_, i) => i);
  if (pattern.kind === "per-string") {
    for (const s of order) up.push(...pattern.fingers.map((g) => f(s, g)));
    for (const s of [...order].reverse()) down.push(...[...pattern.fingers].reverse().map((g) => f(s, g)));
  } else if (pattern.kind === "diagonal") {
    // На каждой следующей струне — на лад выше.
    order.forEach((s, k) => up.push(...pattern.fingers.map((g) => f(s, g, k))));
    [...order].reverse().forEach((s, k) => down.push(...[...pattern.fingers].reverse().map((g) => f(s, g, strings - 1 - k))));
  } else if (pattern.kind === "skip") {
    // Через струну: 6-4-5-3-4-2-3-1.
    const seq: number[] = [];
    for (let s = 0; s + 2 < strings; s++) seq.push(s, s + 2);
    for (const s of seq) up.push(...pattern.fingers.map((g) => f(s, g)));
    for (const s of [...seq].reverse()) down.push(...[...pattern.fingers].reverse().map((g) => f(s, g)));
  } else {
    // Паук: пальцы попеременно на двух соседних струнах (1 и 3 — на нижней, 2 и 4 — на верхней).
    for (let s = 0; s + 1 < strings; s++) up.push(f(s, 1), f(s + 1, 2), f(s, 3), f(s + 1, 4));
    for (let s = strings - 1; s - 1 >= 0; s--) down.push(f(s, 4), f(s - 1, 3), f(s, 2), f(s - 1, 1));
  }
  return [...up, ...down];
}

// --- Каталог ---

const MINOR_PENTA = [0, 3, 5, 7, 10];
const MAJOR = [0, 2, 4, 5, 7, 9, 11];
const MINOR = [0, 2, 3, 5, 7, 8, 10];
const NAMES = ["до", "до♯", "ре", "ми♭", "ми", "фа", "фа♯", "соль", "ля♭", "ля", "си♭", "си"];

/** Позиция, где основной тон — на нижней струне стандартного строя (лад `fret`). */
interface KeyPos {
  id: string;
  name: string;
  root: number; // класс высоты
  pos: number;
}

function buildCatalog(): GtrExercise[] {
  const out: GtrExercise[] = [];
  for (const instrument of ["guitar", "bass"] as const) {
    const pre = instrument === "guitar" ? "gtr" : "bass";
    const strings = TUNINGS[instrument].length;
    const kindName = instrument === "guitar" ? "гитара" : "бас";
    // Паучок: 5-я позиция в трёх темпах, затем 1-я.
    for (const p of instrument === "guitar" ? SPIDER : SPIDER.filter((s) => ["1234", "1324", "diag", "walk"].includes(s.id))) {
      for (const [pos, bpm] of [
        [5, 60],
        [5, 80],
        [5, 100],
        [1, 80],
      ] as const) {
        out.push({
          id: `${pre}-spider-${p.id}-${pos}-${bpm}`,
          instrument,
          category: "spider",
          group: p.name[0].toUpperCase() + p.name.slice(1),
          variant: `${pos} лад · ${bpm}`,
          title: `Паучок ${p.name}, ${pos} лад, ${bpm} уд/мин (${kindName})`,
          bpm,
          hint: `Первый палец — на ${pos}-м ладу, каждый следующий — на следующем ладу (палец на лад). Восьмые под метроном; пальцы держи у грифа.`,
          build: (tuning) =>
            seqSong({ steps: spiderSteps(strings, p, pos), type: 8, bpm, tuning, kind: instrument, title: `Паучок ${p.name}`, fingers: true }),
        });
      }
    }
    // Пентатоника.
    const pentaKeys: KeyPos[] = [
      { id: "am", name: "ля минор", root: 9, pos: 5 },
      { id: "em", name: "ми минор", root: 4, pos: 0 },
      { id: "gm", name: "соль минор", root: 7, pos: 3 },
    ];
    for (const k of pentaKeys)
      for (const [vid, vname, bpm, seq] of [
        ["updown", "вверх-вниз", 70, "updown"],
        ["fast", "вверх-вниз, 100", 100, "updown"],
        ["threes", "тройками", 70, "threes"],
      ] as const) {
        out.push({
          id: `${pre}-penta-${k.id}-${vid}`,
          instrument,
          category: "pentatonic",
          group: `Пентатоника ${k.name}`,
          variant: vname,
          title: `Пентатоника ${k.name}: ${vname} (${kindName})`,
          bpm,
          hint: k.pos ? `Позиция — ${k.pos}-й лад: указательный на ${k.pos}-м ладу, мизинец — на ${k.pos + 3}-м.` : "Открытая позиция: открытые струны и лады 1–3.",
          build: (tuning) => {
            const base = positionNotes(tuning, MINOR_PENTA.map((d) => (k.root + d) % 12), k.root, k.pos, false);
            return seqSong({ steps: seq === "threes" ? threes(base) : upDown(base), type: 8, bpm, tuning, kind: instrument, title: `Пентатоника ${k.name}`, fingers: true });
          },
        });
      }
    // Гаммы в позиции.
    const scaleKeys: (KeyPos & { mode: number[]; modeName: string })[] = [
      { id: "g", name: "соль мажор", root: 7, pos: 2, mode: MAJOR, modeName: "мажор" },
      { id: "am", name: "ля минор", root: 9, pos: 4, mode: MINOR, modeName: "минор" },
      { id: "c", name: "до мажор", root: 0, pos: 7, mode: MAJOR, modeName: "мажор" },
      { id: "em", name: "ми минор", root: 4, pos: 0, mode: MINOR, modeName: "минор" },
    ];
    for (const k of scaleKeys)
      for (const [vid, vname, bpm] of [
        ["70", "70", 70],
        ["90", "90", 90],
      ] as const) {
        out.push({
          id: `${pre}-scale-${k.id}-${vid}`,
          instrument,
          category: "scales",
          group: `${NAMES[k.root][0].toUpperCase() + NAMES[k.root].slice(1)} ${k.modeName}`,
          variant: `${vname} уд/мин`,
          title: `Гамма ${k.name}, ${vname} уд/мин (${kindName})`,
          bpm,
          hint: k.pos ? `Позиция ${k.pos + 1}-го лада: палец на лад, указательный иногда тянется на лад ниже.` : "Открытая позиция: открытые струны и лады 1–4.",
          build: (tuning) =>
            seqSong({ steps: upDown(positionNotes(tuning, k.mode.map((d) => (k.root + d) % 12), k.root, k.pos + 1, true)), type: 8, bpm, tuning, kind: instrument, title: `Гамма ${k.name}`, fingers: true }),
        });
      }
    // Арпеджио.
    const arpKeys: (KeyPos & { triad: number[] })[] = [
      { id: "am", name: "ля минор", root: 9, pos: 4, triad: [0, 3, 7] },
      { id: "c", name: "до мажор", root: 0, pos: 7, triad: [0, 4, 7] },
      { id: "g", name: "соль мажор", root: 7, pos: 2, triad: [0, 4, 7] },
      { id: "em", name: "ми минор", root: 4, pos: 0, triad: [0, 3, 7] },
    ];
    for (const k of arpKeys)
      for (const [vid, bpm, trip] of [
        ["8", 70, false],
        ["3", 70, true],
      ] as const) {
        out.push({
          id: `${pre}-arp-${k.id}-${vid}`,
          instrument,
          category: "arpeggio",
          group: `Арпеджио ${k.name}`,
          variant: trip ? "триолями" : "восьмыми",
          title: `Арпеджио ${k.name}, ${trip ? "триолями" : "восьмыми"} (${kindName})`,
          bpm,
          hint: "Только звуки аккорда: основной тон, терция, квинта. Рука — в одной позиции.",
          build: (tuning) =>
            seqSong({
              steps: upDown(positionNotes(tuning, k.triad.map((d) => (k.root + d) % 12), k.root, k.pos + 1, true)),
              type: 8,
              triplets: trip,
              bpm,
              tuning,
              kind: instrument,
              title: `Арпеджио ${k.name}`,
              fingers: true,
            }),
        });
      }
    // Бой (только гитара): схема × последовательность аккордов × темп.
    if (instrument === "guitar")
      for (const [pid, progs] of STRUM_PLAN) {
        const p = STRUM_BY_ID.get(pid)!;
        for (const [prog, bpm] of progs) {
          const chords = prog.split(" ");
          out.push({
            id: `gtr-strum-${pid}-${chords.join("").toLowerCase().replace(/#/g, "s")}-${bpm}`,
            instrument,
            category: "strum",
            group: `${p.name}: ${patternArrows(p)}`,
            variant: `${chords.join("–")} · ${bpm}`,
            title: `Бой «${p.name}»: ${chords.join(" – ")}, ${bpm} уд/мин`,
            bpm,
            hint: `${patternArrows(p)} — ${p.hint}`,
            build: (tuning) => {
              // По такту на аккорд, вся последовательность дважды.
              const bars = [...chords, ...chords].flatMap((c) => (chords.length <= 2 ? [c, c] : [c])).map((symbol) => ({ chords: [{ symbol }] }));
              return strumSong({ bars, pattern: p, bpm, tuning, title: `Бой: ${p.name}` });
            },
          });
        }
      }
    // Приёмы и формы на грифе (бас).
    if (instrument === "bass") {
      for (const t of BASS_TECHNIQUES)
        for (const bpm of t.tempos)
          out.push({
            id: `bass-tech-${t.id}-${bpm}`,
            instrument,
            category: "technique",
            group: t.name,
            variant: `${bpm} уд/мин`,
            title: `${t.name}, ${bpm} уд/мин (бас)`,
            bpm,
            hint: t.hint,
            build: (tuning) => {
              const steps = Array.from({ length: t.repeat }, () => riff(t.riff)).flat();
              return seqSong({ steps, type: t.type, sustain: t.sustain, bpm, tuning, kind: instrument, title: t.name, drums: Array.from({ length: Math.ceil(steps.length / t.type) }, () => BEATS[t.beat]) });
            },
          });
      for (const f of BASS_SHAPES)
        for (const bpm of [70, 90])
          out.push({
            id: `bass-shape-${f.id}-${bpm}`,
            instrument,
            category: "shapes",
            group: f.name,
            variant: `${f.chords.join("–")} · ${bpm}`,
            title: `${f.name}: ${f.chords.join(" – ")}, ${bpm} уд/мин (бас)`,
            bpm,
            hint: f.hint,
            build: (tuning) => {
              const steps = [...f.chords, ...f.chords].flatMap((c) => shapeSteps(c, f.tones, tuning));
              const song = seqSong({ steps, type: 8, bpm, tuning, kind: instrument, title: f.name, drums: Array.from({ length: f.chords.length * 2 }, () => BEATS.pop) });
              // Буква аккорда — над первой нотой такта.
              song.parts[0].staves[0].bars.forEach((voices, b) => {
                const first = voices[0]?.[0];
                if (first) first.chord = f.chords[b % f.chords.length];
              });
              return song;
            },
          });
    }
    // Игра под барабаны.
    for (const g of GROOVES[instrument])
      for (const bpm of g.tempos) {
        out.push({
          id: `${pre}-groove-${g.id}-${bpm}`,
          instrument,
          category: "groove",
          group: g.name,
          variant: `${bpm} уд/мин`,
          title: `${g.name}, ${bpm} уд/мин (${kindName})`,
          bpm,
          hint: g.hint,
          build: (tuning) => {
            const bar = g.riff ? riff(g.riff) : (g.bar ?? []).map((x) => (x ? { string: x[0], fret: x[1] } : null));
            const steps = Array.from({ length: g.repeat }, () => bar).flat();
            const perBar = g.triplets ? 12 : g.type;
            return seqSong({
              steps,
              type: g.type,
              triplets: g.triplets,
              sustain: g.sustain,
              bpm,
              tuning,
              kind: instrument,
              title: g.name,
              drums: Array.from({ length: Math.ceil(steps.length / perBar) }, () => BEATS[g.beat]),
            });
          },
        });
      }
  }
  return out;
}

/** Бой: схема → [аккорды, темп] по возрастанию трудности. */
const STRUM_PLAN: [string, [string, number][]][] = [
  ["quarters", [["Em Am", 70], ["G C D G", 80], ["Am Dm E Am", 90]]],
  ["eighths", [["Em Am", 70], ["G C D G", 80], ["Am F C G", 90]]],
  ["folk", [["Am E", 80], ["C G Am Em", 90], ["Dm A7 Dm Gm", 90]]],
  ["pop", [["G D", 80], ["C G Am F", 90], ["G D Em C", 100]]],
  ["rock", [["E5 A5", 90], ["A5 D5 E5 D5", 110], ["G5 C5 D5 C5", 120]]],
  ["reggae", [["Am Dm", 80], ["C F G F", 90]]],
  ["waltz", [["C G7", 90], ["Am Dm E Am", 100]]],
  ["six8", [["G Em", 60], ["C Am F G", 70]]],
  ["sixteenths", [["Em Am", 60], ["D A Bm G", 70]]],
];

interface Groove {
  id: string;
  name: string;
  beat: string;
  type: 8 | 16;
  /** Клетки: [струна от низкой, лад] (null — пауза) или рифф строкой (см. `riff`). */
  bar?: ([number, number] | null)[];
  riff?: string;
  triplets?: boolean;
  sustain?: boolean;
  repeat: number;
  tempos: number[];
  hint: string;
}

/** Риффы под бит: [струна от низкой, лад] на каждую восьмую/шестнадцатую, null — пауза. */
const GROOVES: Record<GtrInstrument, Groove[]> = {
  guitar: [
    {
      id: "rock",
      name: "Рок: восьмые на басовых струнах",
      beat: "rock",
      type: 8,
      bar: [[0, 0], [0, 0], [0, 0], [0, 0], [0, 3], [0, 3], [0, 5], [0, 5], [0, 0], [0, 0], [0, 0], [0, 0], [1, 0], [1, 0], [0, 3], [0, 3]],
      repeat: 2,
      tempos: [90, 110],
      hint: "Ровные восьмые вниз, ладонь слегка глушит струны у подставки (PM).",
    },
    {
      id: "boogie",
      name: "Буги на ми",
      beat: "boogie",
      type: 8,
      bar: [[0, 0], [0, 4], [1, 2], [1, 4], [1, 5], [1, 4], [1, 2], [0, 4], [1, 0], [1, 4], [2, 2], [2, 4], [2, 5], [2, 4], [2, 2], [1, 4]],
      repeat: 2,
      tempos: [90, 110],
      hint: "Линия буги: основной тон — терция — квинта — секста — септима и обратно, на ми и на ля.",
    },
    {
      id: "funk",
      name: "Фанк: шестнадцатые",
      beat: "funk",
      type: 16,
      bar: [[1, 7], null, [1, 7], null, null, [1, 7], null, [2, 5], [1, 7], null, [1, 5], null, [1, 7], null, null, null],
      repeat: 4,
      tempos: [80, 95],
      hint: "Короткие ноты на шестнадцатые, правая рука двигается всё время, даже в паузах.",
    },
    {
      id: "pop",
      name: "Поп: арпеджио Am–F–C–G",
      beat: "pop",
      type: 8,
      bar: [
        [1, 0], [2, 2], [3, 2], [4, 1], [1, 0], [2, 2], [3, 2], [4, 1],
        [0, 1], [1, 3], [2, 3], [3, 2], [0, 1], [1, 3], [2, 3], [3, 2],
        [1, 3], [2, 2], [3, 0], [4, 1], [1, 3], [2, 2], [3, 0], [4, 1],
        [0, 3], [1, 2], [2, 0], [3, 0], [0, 3], [1, 2], [2, 0], [3, 0],
      ],
      repeat: 2,
      tempos: [80, 100],
      hint: "По звуку аккорда на восьмую: Am, F, C, G — по такту на аккорд.",
    },
  ],
  // Бас: группы по порядку трудности, каждая открывается после первого варианта предыдущей.
  bass: [
    {
      id: "roots",
      name: "Восьмые по основным тонам",
      beat: "rock",
      type: 8,
      riff: "E0 E0 E0 E0 E0 E0 E0 E0 A0 A0 A0 A0 A2 A2 A2 A2",
      repeat: 2,
      tempos: [90, 110],
      hint: "Ровные восьмые вместе с бочкой и хэтом: ми, ля, си.",
    },
    {
      id: "rootfifth",
      name: "Основной тон — квинта",
      beat: "pop",
      type: 8,
      riff: "A3 . D5 . A3 . D5 . E3 . A5 . E3 . A5 . E5 . A7 . E5 . A7 . E1 . A3 . E1 . A3 .",
      sustain: true,
      repeat: 2,
      tempos: [80, 100],
      hint: "Четвертями: основной тон аккорда и квинта над ним (соседняя струна, два лада выше) — C, G, Am, F.",
    },
    {
      id: "kick",
      name: "Вместе с бочкой",
      beat: "rock",
      type: 16,
      riff: "A0 . . . . . . . A0 . A0 . . . . . E1 . . . . . . . E1 . E1 . . . . .",
      sustain: true,
      repeat: 2,
      tempos: [85, 100],
      hint: "Бас звучит ровно вместе с бочкой: на «раз», на «три» и сразу после. Слушай барабаны — бас и бочка должны слиться в один удар.",
    },
    {
      id: "octaves",
      name: "Октавы (диско)",
      beat: "disco",
      type: 8,
      riff: "E0 D2 E0 D2 E0 D2 E0 D2 A0 G2 A0 G2 A0 G2 A0 G2",
      repeat: 2,
      tempos: [100, 115],
      hint: "Нижняя нота — указательным, октава через струну — безымянным или мизинцем.",
    },
    {
      id: "motown",
      name: "Проходящие ноты (мотаун)",
      beat: "motown",
      type: 8,
      riff: "A3 . A3 . D2 . E4 . E5 . E5 . A3 . A4 . A5 . A5 . D3 . D4 . E3 . E3 . D0 . A2 .",
      sustain: true,
      repeat: 2,
      tempos: [90, 105],
      hint: "Основной тон на «раз», звук аккорда — на «три», а в конце такта — проходящая нота, ведущая к следующему аккорду (C – Am – Dm – G).",
    },
    {
      id: "boogie",
      name: "Буги на ми",
      beat: "boogie",
      type: 8,
      riff: "E0 E4 A2 A4 A5 A4 A2 E4 A0 A4 D2 D4 D5 D4 D2 A4",
      repeat: 2,
      tempos: [90, 110],
      hint: "Основной тон — терция — квинта — секста — септима и обратно.",
    },
    {
      id: "shuffle",
      name: "Шаффл",
      beat: "shuffle",
      type: 8,
      triplets: true,
      riff: "E0 . E0 A2 . A2 A4 . A4 A2 . A2 A0 . A0 D2 . D2 D4 . D4 D2 . D2",
      sustain: true,
      repeat: 2,
      tempos: [80, 100],
      hint: "«Длинная — короткая»: восьмые триолью, средняя пропущена. Качай вместе с райдом: та-та, та-та.",
    },
    {
      id: "reggae",
      name: "Регги",
      beat: "reggae",
      type: 16,
      riff: ". . . . E5 . E5 . . . A3 . A2 . . . . . . . A5 . A5 . . . D3 . D2 . . .",
      sustain: true,
      repeat: 2,
      tempos: [75, 90],
      hint: "На «раз» — пауза, бас вступает после неё; бочка и малый — на «три». Ноты глубокие и короткие: Am, Dm.",
    },
    {
      id: "sync",
      name: "Синкопы 3-3-2",
      beat: "sync",
      type: 16,
      riff: "E5 . . E5 . . E5 . . . A3 . A2 . . . E3 . . E3 . . E3 . . . A0 . A2 . . .",
      sustain: true,
      repeat: 2,
      tempos: [85, 100],
      hint: "Удары на «раз», на последнюю шестнадцатую первой доли и на «и» второй: раз-и-и-ИИ-и-ИИ… Бочка играет этот же ритм.",
    },
    {
      id: "funk",
      name: "Фанк с глушёными нотами",
      beat: "funk",
      type: 16,
      riff: "E0 . Ex E0 . . D2 . Ex . E3 . E5 . Ex .",
      sustain: true,
      repeat: 4,
      tempos: [80, 95],
      hint: "X — глушёная нота: пальцы левой руки лежат на струне, не прижимая её; щелчок без высоты держит ритм. Оцениваются остальные ноты.",
    },
  ],
};

/** Приёмы для баса: рифф, бит, темпы. */
const BASS_TECHNIQUES: { id: string; name: string; beat: string; type: 8 | 16; riff: string; sustain?: boolean; repeat: number; tempos: number[]; hint: string }[] = [
  {
    id: "alternate",
    name: "Чередование пальцев (i, m)",
    beat: "pop",
    type: 8,
    riff: "E0/i E0/m E0/i E0/m A0/i A0/m A0/i A0/m D0/i D0/m D0/i D0/m G0/i G0/m G0/i G0/m G0/i G0/m D0/i D0/m A0/i A0/m E0/i E0/m",
    repeat: 1,
    tempos: [70, 90],
    hint: "Указательный (i) и средний (m) — строго по очереди, даже при переходе на другую струну. Большой палец опирается на звукосниматель или на нижнюю струну.",
  },
  {
    id: "short",
    name: "Короткие ноты и глушение",
    beat: "pop",
    type: 8,
    riff: "A3 . A3 . A3 . A3 . E3 . E3 . E3 . E3 . E5 . E5 . E5 . E5 . E1 . E1 . E1 . E1 .",
    repeat: 1,
    tempos: [80, 100],
    hint: "Каждая нота — восьмая, потом пауза: сразу после щипка ослабь палец левой руки, не отрывая его от струны. Свободные струны глуши пальцами правой руки.",
  },
  {
    id: "hammer",
    name: "Хаммер и пулл-офф",
    beat: "pop",
    type: 8,
    riff: "A3/H A5 A5/P A3 D3/H D5 D5/P D3 E3/H E5 E5/P E3 A2/H A3 A3/P A2",
    repeat: 2,
    tempos: [70, 85],
    hint: "H — второй палец ударяет по ладу без щипка, P — палец срывается со струны, и звучит нота ниже. Щипок — только на первой ноте пары.",
  },
  {
    id: "slide",
    name: "Слайды",
    beat: "pop",
    type: 8,
    riff: "E3/↗ E5 . . A3/↗ A5 . . A5/↘ A3 . . E5/↘ E3 . .",
    sustain: true,
    repeat: 2,
    tempos: [70, 85],
    hint: "↗ — проведи палец по струне вверх на два лада, не отпуская; ↘ — обратно. Щипок только на первой ноте, вторая звучит от скольжения.",
  },
  {
    id: "slap",
    name: "Слэп и поп",
    beat: "funk",
    type: 16,
    riff: "E0/T . Ex/T . D2/P . . . E0/T . Ex/T . D2/P . E0/T . A0/T . Ax/T . G2/P . . . A0/T . Ax/T . G2/P . A0/T .",
    sustain: true,
    repeat: 2,
    tempos: [75, 90],
    hint: "T — удар косточкой большого пальца по струне у конца грифа (палец отскакивает), P — поддеть струну указательным и отпустить, чтобы она щёлкнула о лады. X — глушёный удар большим.",
  },
];

/** Формы на грифе: интервалы от основного тона по восьмым и аккорды по тактам. */
const BASS_SHAPES: { id: string; name: string; tones: number[]; chords: string[]; hint: string }[] = [
  {
    id: "r58",
    name: "Тон — квинта — октава",
    tones: [0, 7, 12, 7, 0, 7, 12, 7],
    chords: ["C", "F", "G", "C"],
    hint: "Квинта — на соседней струне на два лада выше, октава — через струну на два лада выше. Форма одна, двигается вместе с аккордом.",
  },
  {
    id: "major",
    name: "Мажорное трезвучие",
    tones: [0, 4, 7, 12, 12, 7, 4, 0],
    chords: ["C", "F", "G", "C"],
    hint: "Большая терция — на соседней струне на лад ниже основного тона, квинта — на два лада выше, октава — через струну.",
  },
  {
    id: "minor",
    name: "Минорное трезвучие",
    tones: [0, 3, 7, 12, 12, 7, 3, 0],
    chords: ["Am", "Dm", "Em", "Am"],
    hint: "Малая терция — на соседней струне на два лада ниже основного тона (или на 3-м ладу выше на той же).",
  },
  {
    id: "seventh",
    name: "Септаккорд (7)",
    tones: [0, 4, 7, 10, 12, 10, 7, 4],
    chords: ["A7", "D7", "E7", "A7"],
    hint: "Малая септима — через струну на том же ладу, что и основной тон; октава — на два лада выше неё.",
  },
  {
    id: "fifthbelow",
    name: "Квинта снизу",
    tones: [0, -5, 0, 7, 12, 7, 0, -5],
    chords: ["A", "D", "E", "A"],
    hint: "Та же квинта, но на струне ниже на том же ладу: основной тон — на ля или ре, квинта — под ним.",
  },
];

/**
 * Форма на грифе: основной тон на струне, где он ложится на лады 1–9 (с запасом струн для формы),
 * остальные звуки — на струнах по формуле интервала (кварта между струнами).
 */
function shapeSteps(symbol: string, tones: number[], tuning: number[]): Step[] {
  const c = parseChord(symbol)!;
  const pc = rootPc(c);
  const lowOff = Math.min(0, ...tones.map((t) => Math.round(t / 5)));
  const highOff = Math.max(0, ...tones.map((t) => Math.round(t / 5)));
  let best: { string: number; fret: number } | null = null;
  for (let st = -lowOff; st + highOff < tuning.length; st++) {
    const fret = (((pc - tuning[st]) % 12) + 12) % 12;
    if (fret < 1 || fret > 9) continue;
    if (!best || fret < best.fret) best = { string: st, fret };
  }
  const root = best ?? { string: -lowOff, fret: (((pc - tuning[-lowOff]) % 12) + 12) % 12 };
  const rootPitch = tuning[root.string] + root.fret;
  return tones.map((t) => {
    const string = root.string + Math.round(t / 5);
    return { string, fret: rootPitch + t - tuning[string] };
  });
}

export const GTR_EXERCISES: GtrExercise[] = buildCatalog();
export const GTR_EXERCISE_BY_ID = new Map(GTR_EXERCISES.map((e) => [e.id, e]));

/** Упражнение, открывающее раздел (паучок открыт сразу). */
export function gtrGate(instrument: GtrInstrument, category: GtrCategory): string | null {
  const pre = instrument === "guitar" ? "gtr" : "bass";
  switch (category) {
    case "spider":
    case "strum":
      return null;
    case "pentatonic":
    case "groove":
    case "technique":
      return `${pre}-spider-1234-5-60`;
    case "shapes":
      return "bass-groove-roots-90";
    case "scales":
      return `${pre}-penta-am-updown`;
    case "arpeggio":
      return instrument === "guitar" ? "gtr-scale-g-70" : "bass-scale-g-70";
  }
}

/** Открытые упражнения: первое в разделе — когда пройдено упражнение-ключ, дальше — по порядку внутри группы. */
export function gtrUnlocked(passed: Set<string>, instrument: GtrInstrument): Set<string> {
  const open = new Set<string>();
  for (const c of GTR_CATEGORIES[instrument]) {
    const gate = gtrGate(instrument, c.id);
    if (gate && !passed.has(gate)) continue;
    const list = GTR_EXERCISES.filter((e) => e.instrument === instrument && e.category === c.id);
    const groups = [...new Set(list.map((e) => e.group))];
    groups.forEach((g, gi) => {
      const inGroup = list.filter((e) => e.group === g);
      // Группа открыта, если пройдено первое упражнение предыдущей группы.
      if (gi > 0 && !passed.has(list.filter((e) => e.group === groups[gi - 1])[0].id)) return;
      for (let i = 0; i < inGroup.length; i++) {
        if (i === 0 || passed.has(inGroup[i - 1].id)) open.add(inGroup[i].id);
        else break;
      }
    });
  }
  return open;
}

/**
 * Упражнения на сегодня для гитары/баса (постоянны в течение дня):
 * - отмеченные «★ каждый день» (если открыты);
 * - паучок по кругу: каждый день другой из уже засчитанных вариантов;
 * - следующий новый паучок (первый незасчитанный);
 * - одно упражнение из других разделов.
 */
export function gtrWarmup(stats: ExerciseStatView[], day: string, instrument: GtrInstrument, daily: string[] = []): GtrExercise[] {
  const passed = new Set(stats.filter((s) => s.passed).map((s) => s.exercise));
  const open = gtrUnlocked(passed, instrument);
  const rnd = seeded([...day, instrument].reduce((h, c) => h * 31 + String(c).charCodeAt(0), 11));
  const mine = (e: GtrExercise | undefined): e is GtrExercise => !!e && e.instrument === instrument && open.has(e.id);
  const pick = (cats: GtrCategory[]): GtrExercise | null => {
    const list = GTR_EXERCISES.filter((e) => cats.includes(e.category) && mine(e));
    if (!list.length) return null;
    const frontier = list.filter((e) => !passed.has(e.id));
    if (frontier.length) return frontier[0];
    return list[Math.floor(rnd() * list.length)];
  };
  const pinned = daily.map((id) => GTR_EXERCISE_BY_ID.get(id)).filter(mine);
  const spiders = GTR_EXERCISES.filter((e) => e.category === "spider" && mine(e));
  const spiderDone = spiders.filter((e) => passed.has(e.id));
  const dayNo = Math.floor(Date.parse(`${day}T00:00:00Z`) / 86_400_000) || 0;
  const rotation = spiderDone.length ? spiderDone[dayNo % spiderDone.length] : null;
  const nextSpider = spiders.find((e) => !passed.has(e.id)) ?? null;
  const other = pick(rnd() < 0.5 ? ["strum", "pentatonic", "scales", "arpeggio", "shapes"] : ["groove", "strum", "technique"]) ?? pick(["groove", "pentatonic"]);
  const out = [...pinned, rotation, nextSpider, other];
  return out.filter((e, i): e is GtrExercise => !!e && out.indexOf(e) === i);
}

/** Пороги зачёта: распознавание звука добавляет разброс времени — чуть мягче, чем у клавиш. */
export const GTR_PASS = { accuracy: 0.9, timingSdMs: 70 };
