// Барабаны на пэдах: установка из 8 барабанов, ноты для ударного стана (MEI для Verovio),
// грувы и рудименты по ступеням, оценка силы удара (акценты и тихие ноты).
//
// Барабанная партия — один стан с ударным ключом: руки (тарелки, малый, томы) — штилями
// вверх, бочка — вниз. Место ноты на стане задаёт @loc, звук — @pnum (номер ударного
// General MIDI): по нему Verovio отдаёт высоту, и ожидание, ритм, «Разучить» работают
// с барабанами так же, как с клавишами (удар по пэду приходит той же нотой GM).

import type { ExerciseStatView } from "./exercises";

export type DrumId = "kick" | "snare" | "hhClosed" | "hhOpen" | "tom" | "floorTom" | "crash" | "ride";

export interface DrumDef {
  id: DrumId;
  name: string;
  short: string;
  /** Нота ударных General MIDI. */
  gm: number;
  /** Место на стане: 0 — нижняя линия, 1 — первый промежуток… */
  loc: number;
  cymbal: boolean;
  foot: boolean;
  color: string;
}

/** Порядок — как предлагает мастер пэдов (снизу вверх, слева направо). */
export const DRUMS: DrumDef[] = [
  { id: "kick", name: "Бочка", short: "Б", gm: 36, loc: 1, cymbal: false, foot: true, color: "#ffb454" },
  { id: "snare", name: "Малый барабан", short: "М", gm: 38, loc: 5, cymbal: false, foot: false, color: "#5aa9ff" },
  { id: "hhClosed", name: "Хэт закрытый", short: "Х", gm: 42, loc: 9, cymbal: true, foot: false, color: "#4cc38a" },
  { id: "hhOpen", name: "Хэт открытый", short: "Хо", gm: 46, loc: 9, cymbal: true, foot: false, color: "#8fe0b8" },
  { id: "tom", name: "Том", short: "Т", gm: 48, loc: 7, cymbal: false, foot: false, color: "#c38bff" },
  { id: "floorTom", name: "Напольный том", short: "Н", gm: 43, loc: 3, cymbal: false, foot: false, color: "#9a6cd6" },
  { id: "crash", name: "Крэш", short: "К", gm: 49, loc: 10, cymbal: true, foot: false, color: "#ff7a7a" },
  { id: "ride", name: "Райд", short: "Р", gm: 51, loc: 8, cymbal: true, foot: false, color: "#ffd166" },
];
export const DRUM_BY_ID = new Map(DRUMS.map((d) => [d.id, d]));
export const DRUM_BY_GM = new Map(DRUMS.map((d) => [d.gm, d]));

/** Ноты GM, которые встречаются в MIDI-песнях, — к ближайшему барабану установки. */
const GM_ALIASES: Record<number, DrumId> = {
  35: "kick", 36: "kick",
  37: "snare", 38: "snare", 39: "snare", 40: "snare",
  42: "hhClosed", 44: "hhClosed", 46: "hhOpen",
  41: "floorTom", 43: "floorTom", 45: "floorTom",
  47: "tom", 48: "tom", 50: "tom",
  49: "crash", 52: "crash", 55: "crash", 57: "crash",
  51: "ride", 53: "ride", 59: "ride",
};
export function drumOfGm(gm: number): DrumDef | null {
  const id = GM_ALIASES[gm];
  return id ? DRUM_BY_ID.get(id)! : null;
}

// --- Запись партии ---

/** Удар: барабан, акцент (громче) или тихая («призрачная») нота, рука для подписи П/Л. */
export interface DrumHit {
  drum: DrumId;
  accent?: boolean;
  ghost?: boolean;
  stick?: "R" | "L";
}

/**
 * Такт как сетка клеток: `perBeat` клеток на четверть (4 — шестнадцатые, 3 — триольные
 * восьмые); в каждой клетке — удары, которые звучат одновременно.
 */
export interface DrumBar {
  perBeat: 4 | 3;
  cells: DrumHit[][];
}

export interface DrumScore {
  bpm: number;
  bars: DrumBar[];
  /** Размер такта; по умолчанию 4/4. */
  meter?: [number, number];
}

/**
 * Такт из строк-узоров, по одной на барабан: «x» — удар, «X» — акцент, «g» — тихая нота,
 * «.» — пауза; R/L/r/l — удар с подписью руки (r/l — с акцентом не путать: это просто рука).
 * Пример рок-бита: { hhClosed: "x.x.x.x.x.x.x.x.", snare: "....x.......x...", kick: "x.......x......." }.
 */
export function bar(lines: Partial<Record<DrumId, string>>, grid: 16 | 12 = 16): DrumBar {
  const cells: DrumHit[][] = Array.from({ length: grid }, () => []);
  for (const [drum, line] of Object.entries(lines) as [DrumId, string][]) {
    if (line.length !== grid) throw new Error(`${drum}: ${line.length} клеток вместо ${grid}`);
    [...line].forEach((ch, i) => {
      if (ch === ".") return;
      const hit: DrumHit = { drum };
      if (ch === "X") hit.accent = true;
      if (ch === "g") hit.ghost = true;
      if (ch === "R" || ch === "L") hit.stick = ch;
      if (ch === "r" || ch === "l") {
        hit.stick = ch.toUpperCase() as "R" | "L";
        hit.accent = true;
      }
      cells[i].push(hit);
    });
  }
  return { perBeat: grid === 12 ? 3 : 4, cells };
}

// Длительности в клетках сетки 16: 1 — шестнадцатая… 4 — четверть.
const DUR16: Record<number, [string, number]> = { 1: ["16", 0], 2: ["8", 0], 3: ["8", 1], 4: ["4", 0] };

interface Event {
  start: number;
  len: number;
  hits: DrumHit[];
}

/** События одного голоса в пределах доли: ноты до следующего удара (или конца доли), паузы перед первой. */
function beatEvents(cells: DrumHit[][], from: number, size: number, pick: (h: DrumHit) => boolean): (Event | { rest: number; start: number })[] {
  const out: (Event | { rest: number; start: number })[] = [];
  const onsets: number[] = [];
  for (let i = from; i < from + size; i++) if (cells[i].some(pick)) onsets.push(i);
  if (!onsets.length) return [{ rest: size, start: from }];
  if (onsets[0] > from) out.push({ rest: onsets[0] - from, start: from });
  onsets.forEach((s, k) => {
    const end = onsets[k + 1] ?? from + size;
    out.push({ start: s, len: end - s, hits: cells[s].filter(pick) });
  });
  return out;
}

function noteXml(id: string, h: DrumHit, stem: "up" | "down", attrs: string, withStick: boolean): string {
  const d = DRUM_BY_ID.get(h.drum)!;
  const head = d.cymbal ? ` head.shape="x"` : "";
  const artic = [h.accent ? "acc" : "", h.drum === "hhOpen" ? "open" : ""].filter(Boolean).join(" ");
  const parts = [
    `xml:id="${id}"`,
    `loc="${d.loc}"`,
    `pnum="${d.gm}"`,
    attrs,
    `stem.dir="${stem}"`,
    head.trim(),
    artic ? `artic="${artic}"` : "",
    h.ghost ? `head.mod="paren"` : "",
  ].filter(Boolean);
  const verse = withStick && h.stick ? `<verse><syl>${h.stick === "R" ? "П" : "Л"}</syl></verse>` : "";
  return verse ? `<note ${parts.join(" ")}>${verse}</note>` : `<note ${parts.join(" ")}/>`;
}

/** MEI для Verovio: ударный стан, руки штилями вверх, бочка — вниз. */
export function drumMei(score: DrumScore, opts: { title?: string } = {}): string {
  let seq = 0;
  const measures: string[] = [];
  const voices: { n: number; stem: "up" | "down"; pick: (h: DrumHit) => boolean }[] = [
    { n: 1, stem: "up", pick: (h) => !DRUM_BY_ID.get(h.drum)!.foot },
    { n: 2, stem: "down", pick: (h) => DRUM_BY_ID.get(h.drum)!.foot },
  ];
  // Без бочки во всём упражнении (рудименты) — один голос, без пауз внизу.
  const feet = score.bars.some((b) => b.cells.some((c) => c.some((h) => DRUM_BY_ID.get(h.drum)!.foot)));
  const used = feet ? voices : voices.slice(0, 1);
  score.bars.forEach((b, m) => {
    const triplet = b.perBeat === 3;
    const layers = used.map((v) => {
      const beats: string[] = [];
      // Доли по четвертям; последняя может быть неполной (размеры вроде 3/8).
      for (let from = 0; from < b.cells.length; from += b.perBeat) {
        const size = Math.min(b.perBeat, b.cells.length - from);
        const evs = beatEvents(b.cells, from, size, v.pick);
        // Триольная доля из одного события (удар или пауза на всю долю) — просто четверть, без триоли.
        const whole = triplet && evs.length === 1 && size === 3;
        const items: { xml: string; short: boolean }[] = [];
        for (const ev of evs) {
          const len = "rest" in ev ? ev.rest : ev.len;
          // Сетка 16: по таблице. Триоли: клетка — триольная восьмая, две клетки — четверть в триоли.
          const [dur, dots] = whole ? ["4", 0] : triplet ? [len >= 2 ? "4" : "8", 0] : DUR16[len];
          const dotAttr = dots ? ` dots="${dots}"` : "";
          if ("rest" in ev) {
            // В голосе бочки паузы не рисуем (как принято в барабанных нотах) — только место.
            items.push({ xml: `<${v.n === 2 ? "space" : "rest"} dur="${dur}"${dotAttr}/>`, short: false });
            continue;
          }
          const withStick = v.n === 1;
          const notes = ev.hits.map((h) => noteXml(`d${++seq}`, h, v.stem, ev.hits.length > 1 ? "" : `dur="${dur}"${dotAttr}`, withStick));
          const xml =
            ev.hits.length > 1 ? `<chord xml:id="d${++seq}" dur="${dur}"${dotAttr} stem.dir="${v.stem}">${notes.join("")}</chord>` : notes[0];
          items.push({ xml, short: Number(dur) >= 8 });
        }
        // Восьмые и шестнадцатые одной доли — под общим ребром.
        const body = items.filter((i) => i.short).length >= 2 ? `<beam>${items.map((i) => i.xml).join("")}</beam>` : items.map((i) => i.xml).join("");
        beats.push(triplet && !whole && size === 3 ? `<tuplet num="3" numbase="2" bracket.visible="false">${body}</tuplet>` : body);
      }
      // Пустая доля в голосе бочки — паузы, но такт целиком без бочки — одна пауза на такт.
      const empty = !b.cells.some((c) => c.some(v.pick));
      return `<layer n="${v.n}">${empty ? `<mRest/>` : beats.join("")}</layer>`;
    });
    const right = m === score.bars.length - 1 ? ` right="end"` : "";
    measures.push(`<measure n="${m + 1}"${right}><staff n="1">${layers.join("")}</staff></measure>`);
  });
  const title = opts.title ? `<title>${opts.title}</title>` : "<title/>";
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<mei xmlns="http://www.music-encoding.org/ns/mei" meiversion="5.0">` +
    `<meiHead><fileDesc><titleStmt>${title}</titleStmt><pubStmt/></fileDesc></meiHead>` +
    `<music><body><mdiv><score>` +
    `<scoreDef meter.count="${score.meter?.[0] ?? 4}" meter.unit="${score.meter?.[1] ?? 4}" midi.bpm="${score.bpm}">` +
    `<staffGrp><staffDef n="1" lines="5" clef.shape="perc"/></staffGrp></scoreDef>` +
    `<section>${measures.join("")}</section></score></mdiv></body></music></mei>`
  );
}

/** Барабанная партия из MIDI (такты от конвертера) → партия для нот. */
export function drumPartFromMidi(
  measures: { perBeat: number; cells: number; hits: { cell: number; gm: number; velocity: number }[] }[],
  bpm: number,
  meter: [number, number],
): DrumScore {
  // Акценты и тихие ноты — по силе удара в файле относительно обычной для этой песни.
  const vels = measures.flatMap((m) => m.hits.map((h) => h.velocity));
  const base = median(vels);
  const accentAt = Math.max(base + 20, 100);
  const ghostAt = Math.min(base - 30, 55);
  const bars = measures.map((m): DrumBar => {
    const cells: DrumHit[][] = Array.from({ length: m.cells }, () => []);
    for (const h of m.hits) {
      const d = drumOfGm(h.gm);
      if (!d || cells[h.cell].some((x) => x.drum === d.id)) continue;
      cells[h.cell].push({ drum: d.id, accent: h.velocity >= accentAt || undefined, ghost: h.velocity <= ghostAt || undefined });
    }
    return { perBeat: m.perBeat === 3 ? 3 : 4, cells };
  });
  return { bpm, bars, meter };
}

/** Акценты и тихие ноты партии (по MEI): id ноты → вид. */
export function dynamicsOf(mei: string): Map<string, "accent" | "ghost"> {
  const out = new Map<string, "accent" | "ghost">();
  for (const m of mei.matchAll(/<note\b[^>]*>/g)) {
    const tag = m[0];
    const id = /xml:id="([^"]+)"/.exec(tag)?.[1];
    if (!id) continue;
    if (/artic="[^"]*\bacc\b/.test(tag)) out.set(id, "accent");
    else if (/head\.mod="paren"/.test(tag)) out.set(id, "ghost");
  }
  return out;
}

/** Ударный ли стан у MEI (партия барабанов). */
export function isDrumMei(mei: string): boolean {
  return /clef\.shape="perc"/.test(mei);
}

// --- Оценка силы удара ---

export interface DynamicsEval {
  /** Пэды передают силу удара (иначе оценка пропускается). */
  sensitive: boolean;
  accents: { hit: number; total: number };
  ghosts: { hit: number; total: number };
  /** Доля верно сыгранных акцентов и тихих нот вместе (1 — если их нет). */
  share: number;
}

const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

/**
 * Акцент засчитан, если удар заметно громче обычных (×1,15 от медианы обычных ударов),
 * тихая нота — если заметно тише (×0,75). Сравнение — с самим собой, а не с абсолютной
 * силой: у пэдов разная чувствительность.
 */
export function evaluateDynamics(hits: { id: string; velocity: number }[], dyn: Map<string, "accent" | "ghost">): DynamicsEval {
  const vels = hits.map((h) => h.velocity).filter((v) => v > 0);
  const sensitive = vels.length > 1 && Math.max(...vels) - Math.min(...vels) >= 8;
  const normal = hits.filter((h) => !dyn.has(h.id) && h.velocity > 0).map((h) => h.velocity);
  const base = median(normal.length ? normal : vels);
  const accents = { hit: 0, total: 0 };
  const ghosts = { hit: 0, total: 0 };
  for (const kind of dyn.values()) (kind === "accent" ? accents : ghosts).total++;
  for (const h of hits) {
    const kind = dyn.get(h.id);
    if (kind === "accent" && h.velocity >= base * 1.15) accents.hit++;
    if (kind === "ghost" && h.velocity > 0 && h.velocity <= base * 0.75) ghosts.hit++;
  }
  const total = accents.total + ghosts.total;
  return { sensitive, accents, ghosts, share: total && sensitive ? (accents.hit + ghosts.hit) / total : 1 };
}

/** Порог зачёта по силе удара (если в упражнении есть акценты или тихие ноты и пэды их передают). */
export const PASS_DYNAMICS = 0.75;

// --- Каталог ---

export type DrumCategory = "groove" | "rudiment";

export const DRUM_CATEGORIES: { id: DrumCategory; title: string; description: string }[] = [
  {
    id: "groove",
    title: "Грувы",
    description: "Ритмы для песен — от четвертей на бочке и малом до шестнадцатых, шаффла, акцентов и сбивок по томам.",
  },
  {
    id: "rudiment",
    title: "Рудименты",
    description: "Упражнения для рук на малом барабане: одиночные, двойки, парадидлы, акценты. П/Л под нотами — какой рукой.",
  },
];

export interface DrumExercise {
  id: string;
  category: DrumCategory;
  title: string;
  /** Чему учит — одна строка под названием. */
  hint: string;
  build: () => DrumScore;
}

const rep = (b: DrumBar, n: number) => Array.from({ length: n }, () => b);
const HH8 = "x.x.x.x.x.x.x.x.";
const SN24 = "....x.......x...";

function groove(id: string, title: string, hint: string, bpm: number, bars: () => DrumBar[]): DrumExercise {
  return { id: `drum-groove-${id}`, category: "groove", title, hint, build: () => ({ bpm, bars: bars() }) };
}
function rudiment(id: string, title: string, hint: string, bpm: number, bars: () => DrumBar[]): DrumExercise {
  return { id: `drum-rud-${id}`, category: "rudiment", title, hint, build: () => ({ bpm, bars: bars() }) };
}

/** Строка рудимента на малом: «RLRL…» с подписью рук; заглавные с «>» — акценты (запись «>R»). */
function sticking(pattern: string, grid: 16 | 12 = 16, drum: DrumId = "snare"): DrumBar {
  const cells: string[] = [];
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === ">") {
      cells.push(pattern[++i].toLowerCase());
    } else cells.push(ch);
  }
  return bar({ [drum]: cells.join("") }, grid);
}

/** Рудимент «по кругу» по барабанам: каждой клетке — свой барабан. */
function around(sticks: string, drums: DrumId[]): DrumBar {
  const cells: DrumHit[][] = [...sticks].map((s, i) => [{ drum: drums[i], stick: s as "R" | "L" }]);
  return { perBeat: 4, cells };
}

export const DRUM_EXERCISES: DrumExercise[] = [
  groove("quarters", "Бочка и малый четвертями", "Бочка на 1 и 3, малый на 2 и 4 — основа почти любой песни", 80, () =>
    rep(bar({ kick: "x.......x.......", snare: SN24 }), 4),
  ),
  groove("hh-quarters", "Хэт четвертями", "Правая рука на хэте каждую долю, бочка и малый как раньше", 80, () =>
    rep(bar({ hhClosed: "x...x...x...x...", kick: "x.......x.......", snare: SN24 }), 4),
  ),
  groove("rock", "Рок-бит восьмыми", "Хэт восьмыми — самый частый бит в роке и попе", 80, () =>
    rep(bar({ hhClosed: HH8, kick: "x.......x.......", snare: SN24 }), 4),
  ),
  groove("rock-and", "Рок-бит: бочка на «и»", "Вторая бочка на «и» после третьей доли", 85, () =>
    rep(bar({ hhClosed: HH8, kick: "x.......x.x.....", snare: SN24 }), 4),
  ),
  groove("pop", "Поп-бит", "Бочка на 1, «и» второй и 3 — качает сильнее", 90, () =>
    rep(bar({ hhClosed: HH8, kick: "x.....x.x.......", snare: SN24 }), 4),
  ),
  groove("hh-accents", "Акценты на хэте", "Удары на доли громче, восьмые между ними — тише", 85, () =>
    rep(bar({ hhClosed: "X.x.X.x.X.x.X.x.", kick: "x.......x.......", snare: SN24 }), 4),
  ),
  groove("open-hh", "Открытый хэт", "Открытый хэт на последнюю восьмую, на 1 снова закрытый", 85, () =>
    rep(bar({ hhClosed: "x.x.x.x.x.x.x...", hhOpen: "..............x.", kick: "x.......x.......", snare: SN24 }), 4),
  ),
  groove("ride", "Райд и крэш", "Крэш на первую долю, дальше бит на райде", 90, () => [
    bar({ crash: "x...............", ride: "..x.x.x.x.x.x.x.", kick: "x.......x.......", snare: SN24 }),
    ...rep(bar({ ride: HH8, kick: "x.......x.......", snare: SN24 }), 3),
  ]),
  groove("hh16", "Хэт шестнадцатыми", "Хэт шестнадцатыми двумя руками — для быстрых песен и диско", 70, () =>
    rep(bar({ hhClosed: "xxxxxxxxxxxxxxxx", kick: "x.......x.......", snare: SN24 }), 4),
  ),
  groove("funk", "Фанк: бочка шестнадцатыми", "Бочка на «а» второй доли и «и» третьей — синкопы", 80, () =>
    rep(bar({ hhClosed: HH8, kick: "x......x..x.....", snare: SN24 }), 4),
  ),
  groove("ghosts", "Тихие ноты на малом", "Между громкими ударами на 2 и 4 — едва слышные «призрачные» ноты", 75, () =>
    rep(bar({ hhClosed: HH8, kick: "x.....x...x.....", snare: "...gX..g.g.gX..g" }), 4),
  ),
  groove("shuffle", "Шаффл", "Триольный бит: «та-ди» на хэте, как в блюзе", 85, () =>
    rep(bar({ hhClosed: "x.xx.xx.xx.x", kick: "x.....x.....", snare: "...x.....x.." }, 12), 4),
  ),
  groove("fill-toms", "Сбивка по томам", "Три такта бита, в четвёртом — шестнадцатые по малому и томам", 80, () => [
    ...rep(bar({ hhClosed: HH8, kick: "x.......x.......", snare: SN24 }), 3),
    bar({ snare: "xxxx............", tom: "....xxxx........", floorTom: "........xxxx....", kick: "............x...", crash: "............x..." }),
  ]),
  groove("fill-crash", "Сбивка и крэш", "Сбивка восьмыми в конце фразы и крэш с бочкой на первую долю", 85, () => [
    bar({ crash: "x...............", hhClosed: "..x.x.x.x.x.x.x.", kick: "x.......x.......", snare: SN24 }),
    ...rep(bar({ hhClosed: HH8, kick: "x.......x.......", snare: SN24 }), 2),
    bar({ hhClosed: "x.x.x.x.........", kick: "x.......x.......", snare: "....x...x.x.....", tom: "............x.x.", floorTom: "..............x." }),
  ]),

  rudiment("singles8", "Одиночные восьмыми", "Руки по очереди: П Л П Л — ровно и одинаково громко", 80, () => rep(sticking("R.L.R.L.R.L.R.L."), 4)),
  rudiment("singles16", "Одиночные шестнадцатыми", "То же вдвое чаще — следи, чтобы левая не отставала", 70, () => rep(sticking("RLRLRLRLRLRLRLRL"), 4)),
  rudiment("doubles8", "Двойки восьмыми", "По два удара каждой рукой: П П Л Л", 80, () => rep(sticking("R.R.L.L.R.R.L.L."), 4)),
  rudiment("doubles16", "Двойки шестнадцатыми", "Двойки вдвое чаще — второй удар не тише первого", 65, () => rep(sticking("RRLLRRLLRRLLRRLL"), 4)),
  rudiment("accents", "Одиночные с акцентом", "Одиночные шестнадцатыми, первая в каждой доле — громко", 70, () =>
    rep(sticking(">RLRL>RLRL>RLRL>RLRL"), 4),
  ),
  rudiment("paradiddle", "Парадидл", "П Л П П · Л П Л Л — смена ведущей руки", 65, () => rep(sticking("RLRRLRLLRLRRLRLL"), 4)),
  rudiment("paradiddle-acc", "Парадидл с акцентом", "Первый удар каждой группы — громко, остальные тихо", 65, () =>
    rep(sticking(">RLRR>LRLL>RLRR>LRLL"), 4),
  ),
  rudiment("triplets", "Одиночные триолями", "П Л П · Л П Л — ведущая рука меняется каждую долю", 75, () => rep(sticking("RLRLRLRLRLRL", 12), 4)),
  rudiment("around", "Одиночные по барабанам", "Шестнадцатые по кругу: малый, том, напольный, малый", 65, () =>
    rep(
      around("RLRLRLRLRLRLRLRL", ["snare", "snare", "snare", "snare", "tom", "tom", "tom", "tom", "floorTom", "floorTom", "floorTom", "floorTom", "snare", "snare", "snare", "snare"]),
      4,
    ),
  ),
];
export const DRUM_EXERCISE_BY_ID = new Map(DRUM_EXERCISES.map((e) => [e.id, e]));

/** Открытые: в каждом разделе первое и следующее за пройденным. */
export function drumUnlocked(passed: Set<string>): Set<string> {
  const open = new Set<string>();
  for (const c of DRUM_CATEGORIES) {
    const list = DRUM_EXERCISES.filter((e) => e.category === c.id);
    for (let i = 0; i < list.length; i++) {
      if (i === 0 || passed.has(list[i - 1].id)) open.add(list[i].id);
      else break;
    }
  }
  return open;
}

/** Барабанная статистика из общей статистики упражнений. */
export function drumStats(stats: ExerciseStatView[]): ExerciseStatView[] {
  return stats.filter((s) => s.exercise.startsWith("drum-"));
}
