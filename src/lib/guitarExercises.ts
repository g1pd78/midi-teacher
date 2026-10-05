// Упражнения для гитары и баса: «паучок» и хроматика, пентатоника, гаммы и арпеджио по позициям,
// игра под барабаны. Строятся под строй ученика: узоры заданы ладами и пальцами левой руки,
// звуки — от открытых струн. Запись — та же модель песни из табов (табы + барабаны).

import { TUNINGS } from "./guitar";
import type { ExerciseStatView } from "./exercises";
import { seeded } from "./exercises";
import { TPQ, type TabSong, type TsBeat, type TsNote, type TsPart } from "./tabsong";

export type GtrInstrument = "guitar" | "bass";
export type GtrCategory = "spider" | "pentatonic" | "scales" | "arpeggio" | "groove";

export const GTR_CATEGORIES: Record<GtrInstrument, { id: GtrCategory; title: string; description: string }[]> = {
  guitar: [
    { id: "spider", title: "Паучок и хроматика", description: "Каждый палец — на своём ладу: 1-2-3-4 и перестановки по всем струнам. Сила, растяжка и независимость пальцев левой руки, синхронность рук." },
    { id: "pentatonic", title: "Пентатоника", description: "Минорная пентатоника в позиции — основа рок- и блюз-соло: вверх-вниз и тройками." },
    { id: "scales", title: "Гаммы в позиции", description: "Мажор и натуральный минор, палец на лад: звуки гаммы на всех струнах, не сдвигая руку." },
    { id: "arpeggio", title: "Арпеджио", description: "Звуки мажорного и минорного трезвучия по струнам в позиции." },
    { id: "groove", title: "Игра под барабаны", description: "Простые риффы под бит: рок, буги, фанк, поп. Звучат барабаны — держи ритм вместе с ними." },
  ],
  bass: [
    { id: "spider", title: "Паучок и хроматика", description: "1-2-3-4 и перестановки по четырём струнам: пальцы левой руки и ровное чередование пальцев правой." },
    { id: "pentatonic", title: "Пентатоника", description: "Минорная пентатоника в позиции — из неё строится большинство басовых линий." },
    { id: "scales", title: "Гаммы в позиции", description: "Мажор и натуральный минор, палец на лад." },
    { id: "arpeggio", title: "Арпеджио", description: "Звуки аккорда по струнам: основа басовой линии." },
    { id: "groove", title: "Игра под барабаны", description: "Басовые линии под бит: восьмые по основным тонам, октавы, буги, основной тон — квинта." },
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

/** Нота упражнения: струна от низкой, лад, палец (0 — открытая). */
interface Step {
  string: number;
  fret: number;
  finger?: number;
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
}): TabSong {
  const len = o.triplets ? TPQ / 3 : (TPQ * 4) / o.type;
  const barTicks = TPQ * 4;
  const perBar = Math.round(barTicks / len);
  const bars: TsBeat[][] = [];
  o.steps.forEach((s, i) => {
    const b = Math.floor(i / perBar);
    (bars[b] ??= []);
    if (!s) return;
    const note: TsNote = { pitch: o.tuning[s.string] + s.fret, string: s.string, fret: s.fret };
    if (o.fingers && s.finger) note.techniques = [String(s.finger)];
    bars[b].push({ tick: (i % perBar) * len, dur: len, type: o.triplets ? 8 : o.type, dots: 0, tuplet: o.triplets ? [3, 2] : undefined, notes: [note] });
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
  if (drumBars.length) parts.push(drumPart(drumBars, masters.length));
  return { title: o.title, artist: "", album: "", tempo: o.bpm, masters, order: masters.map((_, i) => ({ master: i, tempos: [], pass: 0 })), parts };
}

// --- Барабаны ---

/** Строки-узоры барабанов по 16 клеток: «x» — удар. Порядок: бочка, малый, хэт (или райд). */
const GM: Record<string, number> = { k: 36, s: 38, h: 42, o: 46, r: 51, c: 49 };

/** Такт из узоров «k:x.......x.......» → удары. */
function drumBar(lines: string[]): TsBeat[] {
  const cells: number[][] = Array.from({ length: 16 }, () => []);
  for (const l of lines) {
    const [d, pat] = l.split(":");
    [...pat].forEach((ch, i) => ch !== "." && cells[i].push(GM[d]));
  }
  return cells.flatMap((c, i) => (c.length ? [{ tick: i * (TPQ / 4), dur: TPQ / 4, type: 16, dots: 0, notes: c.map((p) => ({ pitch: p })) }] : []));
}

function drumPart(bars: string[][], count: number): TsPart {
  return {
    id: "drums",
    name: "Барабаны",
    kind: "drums",
    program: 0,
    capo: 0,
    staves: [{ tab: false, clef: "G", bars: Array.from({ length: count }, (_, i) => [drumBar(bars[i % bars.length])]) }],
  };
}

const BEATS: Record<string, string[]> = {
  //      1   2   3   4   (по 4 клетки на долю)
  rock: ["k:x.......x.x....", "s:....x.......x...", "h:x.x.x.x.x.x.x.x."],
  boogie: ["k:x.....x.x.....x.", "s:....x.......x...", "r:x..xx..xx..xx..x"],
  funk: ["k:x.....x...x....", "s:....x..x.x..x...", "h:xxxxxxxxxxxxxxxx"],
  pop: ["k:x.......x.......", "s:....x.......x...", "h:x.x.x.x.x.x.x.x."],
  disco: ["k:x...x...x...x...", "s:....x.......x...", "o:..x...x...x...x."],
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
            const bar = g.bar.map((x) => (x ? { string: x[0], fret: x[1] } : null));
            const steps = Array.from({ length: g.repeat }, () => bar).flat();
            return seqSong({ steps, type: g.type, bpm, tuning, kind: instrument, title: g.name, drums: Array.from({ length: Math.ceil((steps.length * (g.type === 16 ? 1 : 2)) / 16) }, () => BEATS[g.beat]) });
          },
        });
      }
  }
  return out;
}

/** Риффы под бит: [струна от низкой, лад] на каждую восьмую/шестнадцатую, null — пауза. */
const GROOVES: Record<GtrInstrument, { id: string; name: string; beat: string; type: 8 | 16; bar: ([number, number] | null)[]; repeat: number; tempos: number[]; hint: string }[]> = {
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
  bass: [
    {
      id: "roots",
      name: "Восьмые по основным тонам",
      beat: "rock",
      type: 8,
      bar: [[0, 0], [0, 0], [0, 0], [0, 0], [0, 0], [0, 0], [0, 0], [0, 0], [1, 0], [1, 0], [1, 0], [1, 0], [1, 2], [1, 2], [1, 2], [1, 2]],
      repeat: 2,
      tempos: [90, 110],
      hint: "Ровные восьмые вместе с бочкой и хэтом: ми, ля, си.",
    },
    {
      id: "octaves",
      name: "Октавы (диско)",
      beat: "disco",
      type: 8,
      bar: [[0, 0], [2, 2], [0, 0], [2, 2], [0, 0], [2, 2], [0, 0], [2, 2], [1, 0], [3, 2], [1, 0], [3, 2], [1, 0], [3, 2], [1, 0], [3, 2]],
      repeat: 2,
      tempos: [100, 115],
      hint: "Нижняя нота — указательным, октава через струну — безымянным или мизинцем.",
    },
    {
      id: "boogie",
      name: "Буги на ми",
      beat: "boogie",
      type: 8,
      bar: [[0, 0], [0, 4], [1, 2], [1, 4], [1, 5], [1, 4], [1, 2], [0, 4], [1, 0], [1, 4], [2, 2], [2, 4], [2, 5], [2, 4], [2, 2], [1, 4]],
      repeat: 2,
      tempos: [90, 110],
      hint: "Основной тон — терция — квинта — секста — септима и обратно.",
    },
    {
      id: "rootfifth",
      name: "Основной тон — квинта",
      beat: "pop",
      type: 8,
      bar: [[1, 3], null, [2, 5], null, [1, 3], null, [2, 5], null, [0, 3], null, [1, 5], null, [0, 3], null, [1, 5], null, [0, 5], null, [1, 7], null, [0, 5], null, [1, 7], null, [0, 1], null, [1, 3], null, [0, 1], null, [1, 3], null],
      repeat: 2,
      tempos: [80, 100],
      hint: "Четвертями: основной тон аккорда и квинта над ним — C, G, Am, F.",
    },
  ],
};

export const GTR_EXERCISES: GtrExercise[] = buildCatalog();
export const GTR_EXERCISE_BY_ID = new Map(GTR_EXERCISES.map((e) => [e.id, e]));

/** Упражнение, открывающее раздел (паучок открыт сразу). */
export function gtrGate(instrument: GtrInstrument, category: GtrCategory): string | null {
  const pre = instrument === "guitar" ? "gtr" : "bass";
  switch (category) {
    case "spider":
      return null;
    case "pentatonic":
    case "groove":
      return `${pre}-spider-1234-5-60`;
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

/** Упражнения на сегодня для гитары/баса: паучок + одно из открытых разделов (постоянно в течение дня). */
export function gtrWarmup(stats: ExerciseStatView[], day: string, instrument: GtrInstrument): GtrExercise[] {
  const passed = new Set(stats.filter((s) => s.passed).map((s) => s.exercise));
  const open = gtrUnlocked(passed, instrument);
  const rnd = seeded([...day, instrument].reduce((h, c) => h * 31 + String(c).charCodeAt(0), 11));
  const pick = (cats: GtrCategory[]): GtrExercise | null => {
    const list = GTR_EXERCISES.filter((e) => e.instrument === instrument && cats.includes(e.category) && open.has(e.id));
    if (!list.length) return null;
    const frontier = list.filter((e) => !passed.has(e.id));
    if (frontier.length) return frontier[0];
    return list[Math.floor(rnd() * list.length)];
  };
  const out = [pick(["spider"]), pick(rnd() < 0.5 ? ["pentatonic", "scales", "arpeggio"] : ["groove"]) ?? pick(["groove", "pentatonic"])];
  return out.filter((e, i): e is GtrExercise => !!e && out.indexOf(e) === i);
}

/** Пороги зачёта: распознавание звука добавляет разброс времени — чуть мягче, чем у клавиш. */
export const GTR_PASS = { accuracy: 0.9, timingSdMs: 70 };
