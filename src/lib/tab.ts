// Табулатура для гитары и баса из MEI Verovio.
//
// Одна партия (стан) превращается в табулатуру: вместо ноты — `<tabGrp>` со значком
// ритма, у ноты — струна (`tab.course`, 1 — самая высокая) и лад (`tab.fret`).
// **id нот сохраняются**, поэтому курсор, оценка игры, «Разучить» и прогресс работают
// как с обычными нотами. Если в файле табы уже есть — берём их как есть.

import { TUNINGS } from "./guitar";

export type StringInstrument = "guitar" | "bass";

/** Сколько ладов учитываем при раскладке. */
export const FRETS: Record<StringInstrument, number> = { guitar: 19, bass: 17 };
/** Удобная середина диапазона (MIDI): к ней тянем партию при выборе октавы. */
const TARGET: Record<StringInstrument, number> = { guitar: 62, bass: 38 };

/** Позиция: струна (0 — самая низкая) и лад. */
export interface TabPos {
  string: number;
  fret: number;
}

// --- Разбор MEI на теги ---

interface Tok {
  kind: "open" | "close" | "self" | "text";
  name: string;
  attrs: string;
  raw: string;
}

const TOKEN = /<\?[\s\S]*?\?>|<!--[\s\S]*?-->|<(\/?)([A-Za-z][\w:.-]*)((?:\s+[^\s=/>]+="[^"]*")*)\s*(\/?)>|[^<]+/g;

function tokenize(s: string): Tok[] {
  const out: Tok[] = [];
  for (const m of s.matchAll(TOKEN)) {
    if (m[2] === undefined) out.push({ kind: "text", name: "", attrs: "", raw: m[0] });
    else out.push({ kind: m[1] ? "close" : m[4] ? "self" : "open", name: m[2], attrs: m[3] ?? "", raw: m[0] });
  }
  return out;
}

function attr(attrs: string, name: string): string | undefined {
  const m = attrs.match(new RegExp(`\\s${name.replace(/\./g, "\\.")}="([^"]*)"`));
  return m?.[1];
}

function setAttr(attrs: string, name: string, value: string): string {
  const re = new RegExp(`\\s${name.replace(/\./g, "\\.")}="[^"]*"`);
  return re.test(attrs) ? attrs.replace(re, ` ${name}="${value}"`) : `${attrs} ${name}="${value}"`;
}

function keep(attrs: string, names: string[]): string {
  return names.map((n) => (attr(attrs, n) !== undefined ? ` ${n}="${attr(attrs, n)}"` : "")).join("");
}

/** Индекс закрывающего тега для открывающего `toks[i]`. */
function matching(toks: Tok[], i: number): number {
  let depth = 0;
  for (let j = i; j < toks.length; j++) {
    if (toks[j].name !== toks[i].name) continue;
    if (toks[j].kind === "open") depth++;
    else if (toks[j].kind === "close" && --depth === 0) return j;
  }
  return toks.length - 1;
}

const PC: Record<string, number> = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };
const ACC: Record<string, number> = { s: 1, f: -1, ss: 2, x: 2, ff: -2, n: 0 };

/** Высота ноты MEI: pname/oct + знак (у ноты, `accid.ges` или вложенный `<accid>`). */
function notePitch(toks: Tok[], i: number): number | null {
  const a = toks[i].attrs;
  const pname = attr(a, "pname");
  const oct = attr(a, "oct");
  if (!pname || oct === undefined) return null;
  let acc = attr(a, "accid") ?? attr(a, "accid.ges");
  if (acc === undefined && toks[i].kind === "open") {
    const end = matching(toks, i);
    for (let j = i + 1; j < end; j++)
      if (toks[j].name === "accid") acc = attr(toks[j].attrs, "accid") ?? attr(toks[j].attrs, "accid.ges") ?? acc;
  }
  return (Number(oct) + 1) * 12 + PC[pname.toLowerCase()] + (acc ? (ACC[acc] ?? 0) : 0);
}

// --- Раскладка по струнам и ладам ---

interface Event {
  ids: string[];
  pitches: number[];
  /** Продолжение лиги: позиция как у предыдущей ноты той же высоты. */
  tied: boolean[];
}

/** Все варианты посадить аккорд на разные струны (для одиночной ноты — все струны). */
function assignments(pitches: number[], tuning: number[], frets: number): (TabPos | null)[][] {
  const opts = pitches.map((p) =>
    tuning.map((open, string) => ({ string, fret: p - open })).filter((o) => o.fret >= 0 && o.fret <= frets),
  );
  const out: (TabPos | null)[][] = [];
  const cur: (TabPos | null)[] = [];
  const used = new Set<number>();
  const walk = (k: number) => {
    if (out.length >= 300) return;
    if (k === pitches.length) {
      out.push([...cur]);
      return;
    }
    if (!opts[k].length) {
      cur.push(null); // вне диапазона — пропускаем ноту
      walk(k + 1);
      cur.pop();
      return;
    }
    for (const o of opts[k]) {
      if (used.has(o.string)) continue;
      used.add(o.string);
      cur.push(o);
      walk(k + 1);
      cur.pop();
      used.delete(o.string);
    }
  };
  walk(0);
  return out.length ? out : [pitches.map(() => null)];
}

/** «Стоимость» самой позиции: растяжка пальцев, высокие лады. */
function shapeCost(a: (TabPos | null)[]): number {
  const fretted = a.filter((p): p is TabPos => !!p && p.fret > 0).map((p) => p.fret);
  let cost = 0;
  if (fretted.length) {
    const span = Math.max(...fretted) - Math.min(...fretted);
    if (span > 3) cost += (span - 3) * 3;
  }
  for (const f of fretted) cost += 0.02 * f + 0.4 * Math.max(0, f - 12);
  cost += 5 * a.filter((p) => p === null).length;
  return cost;
}

/** Положение руки: нижний прижатый лад (только открытые — рука не двигается). */
function handOf(a: (TabPos | null)[]): number | null {
  const fretted = a.filter((p): p is TabPos => !!p && p.fret > 0).map((p) => p.fret);
  return fretted.length ? Math.min(...fretted) : null;
}

/**
 * Раскладка последовательности событий (нота или аккорд) по струнам и ладам:
 * динамическое программирование — меньше переездов руки, растяжек и высоких ладов,
 * открытые струны там, где удобно.
 */
export function assignPositions(events: { pitches: number[] }[], tuning: number[], frets: number): (TabPos | null)[][] {
  if (!events.length) return [];
  const layers = events.map((e) => assignments(e.pitches, tuning, frets));
  // cost[t][k], hand[t][k], back[t][k]
  let cost = layers[0].map((a) => shapeCost(a));
  let hand = layers[0].map((a) => handOf(a) ?? 0);
  const back: number[][] = [layers[0].map(() => -1)];
  for (let t = 1; t < layers.length; t++) {
    const prev = layers[t - 1];
    const nextCost: number[] = [];
    const nextHand: number[] = [];
    const b: number[] = [];
    for (const a of layers[t]) {
      const own = shapeCost(a);
      const h = handOf(a);
      let best = Infinity;
      let bi = 0;
      let bh = 0;
      for (let k = 0; k < prev.length; k++) {
        const ph = hand[k];
        let c = cost[k] + own;
        if (h !== null && ph > 0) {
          const d = Math.abs(h - ph);
          c += 0.5 * d + (d > 4 ? 1.5 : 0);
        } else if (h !== null) c += 0.1 * h; // первая прижатая нота: ниже — удобнее
        // Для одиночных нот — меньше прыжков через струны.
        if (a.length === 1 && prev[k].length === 1 && a[0] && prev[k][0]) c += 0.05 * Math.abs(a[0].string - prev[k][0]!.string);
        if (c < best) {
          best = c;
          bi = k;
          bh = h ?? ph;
        }
      }
      nextCost.push(best);
      nextHand.push(bh);
      b.push(bi);
    }
    cost = nextCost;
    hand = nextHand;
    back.push(b);
  }
  let k = cost.indexOf(Math.min(...cost));
  const out: (TabPos | null)[][] = new Array(layers.length);
  for (let t = layers.length - 1; t >= 0; t--) {
    out[t] = layers[t][k];
    k = back[t][k];
  }
  return out;
}

/** Позиция для высоты, ближайшая к руке (для показа нажатой ноты на грифе). */
export function nearestPosition(pitch: number, tuning: number[], frets: number, hand: number): TabPos | null {
  let best: TabPos | null = null;
  let bestD = Infinity;
  tuning.forEach((open, string) => {
    const fret = pitch - open;
    if (fret < 0 || fret > frets) return;
    const d = fret === 0 ? 1 : Math.abs(fret - hand);
    if (d < bestD) (bestD = d), (best = { string, fret });
  });
  return best;
}

/** Сдвиг на целые октавы, при котором партия лучше всего ложится на гриф. */
export function chooseShift(pitches: number[], instrument: StringInstrument, tuning: number[] = TUNINGS[instrument]): number {
  if (!pitches.length) return 0;
  const low = tuning[0];
  const high = tuning[tuning.length - 1] + 12; // удобно — до 12-го лада
  const sorted = [...pitches].sort((a, b) => a - b);
  const median = sorted[sorted.length >> 1];
  let best = 0;
  let bestScore = -Infinity;
  for (const k of [-36, -24, -12, 0, 12, 24]) {
    const inRange = pitches.filter((p) => p + k >= low && p + k <= high).length;
    const score = inRange * 1000 - Math.abs(median + k - TARGET[instrument]);
    if (score > bestScore) {
      bestScore = score;
      best = k;
    }
  }
  return best;
}

// --- Преобразование MEI ---

/** Номер стана, который уже записан табулатурой (из файла), или `null`. */
export function tabStaff(mei: string): number | null {
  for (const m of mei.matchAll(/<staffDef\b([^>]*)>/g)) {
    if (/notationtype="tab/.test(m[1])) return Number(attr(m[1], "n") ?? 0) || null;
  }
  return null;
}

/** Позиции нот уже готовой табулатуры (по id). */
export function readTabPositions(mei: string, strings: number): Map<string, TabPos> {
  const out = new Map<string, TabPos>();
  for (const m of mei.matchAll(/<note\b([^>]*?)\/?>/g)) {
    const id = attr(m[1], "xml:id");
    const course = attr(m[1], "tab.course");
    const fret = attr(m[1], "tab.fret");
    if (id && course && fret !== undefined) out.set(id, { string: strings - Number(course), fret: Number(fret) });
  }
  return out;
}

const PNAMES = ["c", "c", "d", "d", "e", "f", "f", "g", "g", "a", "a", "b"];

/** Строй табулатуры стана из файла: звучащие открытые струны от низкой (MIDI). */
export function readTuning(mei: string, staff: number): number[] | null {
  for (const m of mei.matchAll(/<staffDef\b([^>]*)>([\s\S]*?)<\/staffDef>/g)) {
    if (Number(attr(m[1], "n")) !== staff) continue;
    const courses = [...m[2].matchAll(/<course\b([^>]*?)\/?>/g)].map((c) => {
      const pname = attr(c[1], "pname");
      const oct = attr(c[1], "oct");
      const acc = attr(c[1], "accid");
      if (!pname || oct === undefined) return null;
      return { n: Number(attr(c[1], "n") ?? 0), midi: (Number(oct) + 1) * 12 + PC[pname.toLowerCase()] + (acc ? (ACC[acc] ?? 0) : 0) };
    });
    if (!courses.length || courses.some((c) => !c)) return null;
    // Струна 1 — самая высокая.
    return courses.map((c) => c!).sort((a, b) => b.n - a.n).map((c) => c.midi);
  }
  return null;
}

function tuningXml(tuning: number[]): string {
  const n = tuning.length;
  return (
    "<tuning>" +
    tuning
      .map((m, i) => {
        const pc = m % 12;
        const acc = PNAMES[pc] === PNAMES[(pc + 11) % 12] ? ' accid="s"' : "";
        return `<course n="${n - i}" pname="${PNAMES[pc]}" oct="${Math.floor(m / 12) - 1}"${acc}/>`;
      })
      .reverse()
      .join("") +
    "</tuning>"
  );
}

export interface TabResult {
  mei: string;
  /** Сдвиг партии в полутонах (целые октавы). */
  shift: number;
  positions: Map<string, TabPos>;
  /** Нот, которые не легли на гриф (заменены паузами). */
  dropped: number;
  /** Нот, перенесённых на октаву, чтобы лечь на гриф. */
  folded: number;
  /** Звучащие открытые струны табулатуры (с каподастром), от низкой. */
  tuning: number[];
  /** Каподастр (лады на табе — от него). */
  capo: number;
}

export interface TabOptions {
  /** Строй (открытые струны от низкой, без каподастра); по умолчанию стандартный. */
  tuning?: number[];
  capo?: number;
  /** Готовую табулатуру из файла разложить заново под этот строй. */
  relayout?: boolean;
}

/** Управляющие элементы такта, привязанные к стану: чужие убираем, свои переносим на стан 1. */
const CONTROL = new Set(["slur", "tie", "dynam", "hairpin", "dir", "pedal", "trill", "mordent", "turn", "fermata", "arpeg", "phrase", "breath", "octave", "harm"]);

/**
 * Превратить стан `staff` в табулатуру для `instrument`. Если стан уже табулатура —
 * оставляем его как есть (убираем только остальные станы).
 */
export function meiToTab(
  mei: string,
  staff: number,
  instrument: StringInstrument,
  meter: { count: number; unit: number },
  opts: TabOptions = {},
): TabResult {
  const base = opts.tuning && opts.tuning.length === TUNINGS[instrument].length ? opts.tuning : TUNINGS[instrument];
  const fromFile = tabStaff(mei) === staff;
  const fileTuning = fromFile ? readTuning(mei, staff) : null;
  // Готовые табы — как в файле (со строем файла), если не просили переложить.
  const already = fromFile && !opts.relayout;
  const capo = already ? 0 : Math.max(0, Math.min(12, opts.capo ?? 0));
  const tuning = already ? (fileTuning ?? base) : base.map((m) => m + capo);
  const frets = FRETS[instrument] - capo;
  const toks = tokenize(mei);
  const filePos = fromFile ? readTabPositions(mei, (fileTuning ?? base).length) : null;

  // 1. События выбранного стана (первый слой).
  const tieEnds = new Set([...mei.matchAll(/<tie\b[^>]*\bendid="#([^"]+)"/g)].map((m) => m[1]));
  const events: Event[] = [];
  {
    let st = 0;
    let layer = 0;
    let chord: Event | null = null;
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i];
      if (t.name === "staff" && t.kind === "open") (st = Number(attr(t.attrs, "n") ?? 0)), (layer = 0);
      else if (t.name === "staff" && t.kind === "close") st = 0;
      else if (t.name === "layer" && t.kind === "open") layer++;
      if (st !== staff || layer !== 1) continue;
      // Аккорд нот или группа таба (ноты одной доли).
      if ((t.name === "chord" || t.name === "tabGrp") && t.kind === "open") chord = { ids: [], pitches: [], tied: [] };
      else if ((t.name === "chord" || t.name === "tabGrp") && t.kind === "close") {
        if (chord?.ids.length) events.push(chord);
        chord = null;
      } else if (t.name === "note" && (t.kind === "open" || t.kind === "self")) {
        const id = attr(t.attrs, "xml:id");
        // Нота табулатуры без высоты — по строю файла и ладу.
        const fp = id ? filePos?.get(id) : undefined;
        const p = notePitch(toks, i) ?? (fp && fileTuning ? fileTuning[fp.string] + fp.fret : null);
        if (!id || p === null) continue;
        const tie = attr(t.attrs, "tie");
        const tied = tie === "t" || tie === "m" || tieEnds.has(id);
        if (chord) chord.ids.push(id), chord.pitches.push(p), chord.tied.push(tied);
        else events.push({ ids: [id], pitches: [p], tied: [tied] });
      }
    }
  }

  // 2. Октава и позиции.
  const positions = new Map<string, TabPos>();
  let shift = 0;
  let dropped = 0;
  let folded = 0;
  if (already) {
    for (const [id, p] of readTabPositions(mei, tuning.length)) positions.set(id, p);
  } else {
    // Табы из файла — настоящие высоты гитары, октаву не сдвигаем.
    shift = fromFile
      ? 0
      : chooseShift(
          events.flatMap((e) => e.pitches),
          instrument,
          tuning,
        );
    // Ноты за краем грифа переносим на октаву внутрь (как при переложении для баса).
    const low = tuning[0];
    const high = tuning[tuning.length - 1] + frets;
    for (const e of events) {
      e.pitches = e.pitches.map((p) => {
        let q = p + shift;
        while (q < low) q += 12;
        while (q > high) q -= 12;
        if (q !== p + shift) folded++;
        return q - shift;
      });
    }
    const free = events.filter((e) => !e.tied.every(Boolean));
    const assigned = assignPositions(
      free.map((e) => ({ pitches: e.pitches.map((p) => p + shift) })),
      tuning,
      frets,
    );
    const last = new Map<number, TabPos>(); // высота → позиция (для продолжений лиг)
    let fi = 0;
    for (const e of events) {
      const a = e.tied.every(Boolean) ? null : assigned[fi++];
      e.ids.forEach((id, k) => {
        const pitch = e.pitches[k] + shift;
        const pos = a ? a[k] : (last.get(pitch) ?? null);
        if (pos) {
          positions.set(id, pos);
          last.set(pitch, pos);
        } else dropped++;
      });
    }
  }

  // 3. Новый MEI.
  const out: string[] = [];
  const staffDef =
    `<staffGrp><staffDef n="1" notationtype="tab.guitar" lines="${tuning.length}">` +
    `<clef shape="TAB" line="5"/>${tuningXml(tuning)}<meterSig count="${meter.count}" unit="${meter.unit}"/></staffDef></staffGrp>`;
  const tabNote = (t: Tok): string => {
    const id = attr(t.attrs, "xml:id")!;
    const pos = positions.get(id)!;
    return `<note xml:id="${id}" tab.course="${tuning.length - pos.string}" tab.fret="${pos.fret}"${keep(t.attrs, ["tie"])}/>`;
  };
  let inScoreDef = 0;
  let st = 0;
  let layer = 0;
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    // Шапка: один стан-табулатура.
    if (t.name === "scoreDef") {
      if (t.kind === "open") inScoreDef++;
      if (t.kind === "close") inScoreDef--;
      out.push(t.kind === "text" ? t.raw : t.raw.replace(/\s(key\.sig|key\.mode)="[^"]*"/g, ""));
      continue;
    }
    if (inScoreDef && (t.name === "staffGrp" || t.name === "staffDef") && t.kind === "open") {
      const end = matching(toks, i);
      if (t.name === "staffGrp" && !out.some((s) => s === staffDef)) out.push(staffDef);
      i = end;
      continue;
    }
    if (inScoreDef && t.name === "keySig") {
      if (t.kind === "open") i = matching(toks, i);
      continue;
    }
    // Станы такта.
    if (t.name === "staff" && t.kind === "open") {
      st = Number(attr(t.attrs, "n") ?? 0);
      layer = 0;
      if (st !== staff) {
        i = matching(toks, i);
        st = 0;
        continue;
      }
      out.push(`<staff${setAttr(t.attrs, "n", "1")}>`);
      continue;
    }
    if (t.name === "staff" && t.kind === "close") {
      if (st === staff) out.push(t.raw);
      st = 0;
      continue;
    }
    if (st === staff && t.name === "layer" && t.kind === "open") {
      layer++;
      if (layer !== 1) {
        i = matching(toks, i);
        continue;
      }
      out.push(`<layer${setAttr(t.attrs, "n", "1")}>`);
      continue;
    }
    if (st === staff && fromFile && !already && t.name === "tabGrp" && t.kind === "open") {
      // Переложение готовой табулатуры: те же длительности, новые позиции.
      const end = matching(toks, i);
      const notes = toks.slice(i + 1, end).filter((n) => n.name === "note" && n.kind !== "close" && positions.has(attr(n.attrs, "xml:id") ?? ""));
      out.push(
        notes.length
          ? `<tabGrp${keep(t.attrs, ["xml:id", "dur", "dots", "dur.ppq", "grace"])}><tabDurSym/>${notes.map(tabNote).join("")}</tabGrp>`
          : `<rest${keep(t.attrs, ["dur", "dots", "dur.ppq"])}/>`,
      );
      i = end;
      continue;
    }
    if (st === staff && !already) {
      if (t.name === "chord" && t.kind === "open") {
        const end = matching(toks, i);
        const notes = toks.slice(i + 1, end).filter((n) => n.name === "note" && n.kind !== "close" && positions.has(attr(n.attrs, "xml:id") ?? ""));
        out.push(
          notes.length
            ? `<tabGrp${keep(t.attrs, ["xml:id", "dur", "dots", "dur.ppq", "grace"])}><tabDurSym/>${notes.map(tabNote).join("")}</tabGrp>`
            : `<rest${keep(t.attrs, ["dur", "dots", "dur.ppq"])}/>`,
        );
        i = end;
        continue;
      }
      if (t.name === "note" && (t.kind === "open" || t.kind === "self")) {
        const id = attr(t.attrs, "xml:id") ?? "";
        out.push(
          positions.has(id)
            ? `<tabGrp${keep(t.attrs, ["dur", "dots", "dur.ppq", "grace"])}><tabDurSym/>${tabNote(t)}</tabGrp>`
            : `<rest${keep(t.attrs, ["dur", "dots", "dur.ppq"])}/>`,
        );
        if (t.kind === "open") i = matching(toks, i);
        continue;
      }
    }
    // Управляющие элементы такта (вне станов).
    if (!st && (t.kind === "open" || t.kind === "self")) {
      if (t.name === "fing") {
        if (t.kind === "open") i = matching(toks, i);
        continue;
      }
      const s = attr(t.attrs, "staff");
      if (s !== undefined && (CONTROL.has(t.name) || t.name === "tempo")) {
        if (t.name !== "tempo" && s.split(" ").map(Number).indexOf(staff) < 0) {
          if (t.kind === "open") i = matching(toks, i);
          continue;
        }
        out.push(t.raw.replace(/\sstaff="[^"]*"/, ' staff="1"'));
        continue;
      }
    }
    out.push(t.raw);
  }
  return { mei: out.join(""), shift, positions, dropped, folded, tuning, capo };
}

/** Суффикс id нот обычного стана над табулатурой: они повторяют ноты таба и в оценке не участвуют. */
export const MIRROR = "~s";

/**
 * Табулатура + обычные ноты над ней (скрипичный ключ с октавой ниже у гитары, басовый — у баса).
 * Ноты стана — копии нот таба с id `<id>~s`; стан таба остаётся первым по номеру.
 */
export function withStaff(tabMei: string, tuning: number[], instrument: StringInstrument): string {
  const toks = tokenize(tabMei);
  const strings = tuning.length;
  const clef = instrument === "bass" ? `<clef shape="F" line="4" dis="8" dis.place="below"/>` : `<clef shape="G" line="2" dis="8" dis.place="below"/>`;
  const mirrorId = (attrs: string) => {
    const id = attr(attrs, "xml:id");
    return id ? setAttr(attrs, "xml:id", id + MIRROR) : attrs;
  };
  const out: string[] = [];
  let inScoreDef = 0;
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.name === "scoreDef") inScoreDef += t.kind === "open" ? 1 : t.kind === "close" ? -1 : 0;
    // Шапка: обычный стан перед табом.
    if (inScoreDef && t.name === "staffDef" && t.kind === "open" && /notationtype="tab/.test(t.attrs)) {
      const end = matching(toks, i);
      const meter = toks.slice(i, end).find((x) => x.name === "meterSig" && x.kind !== "close");
      out.push(`<staffDef n="2" lines="5">${clef}${meter ? meter.raw.replace(/\/?>$/, "/>") : ""}</staffDef>`);
      for (let j = i; j <= end; j++) out.push(toks[j].raw);
      i = end;
      continue;
    }
    // Такт: стан с нотами перед станом таба.
    if (t.name === "staff" && t.kind === "open" && attr(t.attrs, "n") === "1") {
      const end = matching(toks, i);
      const acc = new Map<string, number>(); // нота+октава → знак в такте
      const staff: string[] = [`<staff n="2">`];
      for (let j = i + 1; j < end; j++) {
        const x = toks[j];
        if (x.name === "layer" || x.name === "beam" || x.name === "tuplet") staff.push(x.kind === "close" ? x.raw : `<${x.name}${mirrorId(x.attrs)}${x.kind === "self" ? "/" : ""}>`);
        else if (x.name === "rest" || x.name === "space" || x.name === "mRest") staff.push(`<${x.name}${mirrorId(x.attrs)}/>`);
        else if (x.name === "tabGrp" && x.kind === "open") {
          const gEnd = matching(toks, j);
          const notes = toks.slice(j + 1, gEnd).filter((n) => n.name === "note" && n.kind !== "close");
          const durs = keep(x.attrs, ["dur", "dots", "grace"]);
          const xml = notes.map((n) => {
            const course = Number(attr(n.attrs, "tab.course"));
            const fret = Number(attr(n.attrs, "tab.fret"));
            const midi = tuning[strings - course] + fret;
            const pc = ((midi % 12) + 12) % 12;
            const pname = PNAMES[pc];
            const oct = Math.floor(midi / 12) - 1;
            const sharp = PNAMES[pc] === PNAMES[(pc + 11) % 12] ? 1 : 0;
            const key = pname + oct;
            const tie = attr(n.attrs, "tie");
            let accid = ` accid.ges="${sharp ? "s" : "n"}"`;
            if ((acc.get(key) ?? 0) !== sharp && tie !== "t" && tie !== "m") {
              accid = ` accid="${sharp ? "s" : "n"}"`;
              acc.set(key, sharp);
            }
            const id = attr(n.attrs, "xml:id");
            return `<note${id ? ` xml:id="${id}${MIRROR}"` : ""} pname="${pname}" oct="${oct}"${accid}${tie ? ` tie="${tie}"` : ""}${notes.length === 1 ? durs : ""}/>`;
          });
          const gid = attr(x.attrs, "xml:id");
          staff.push(notes.length === 1 ? xml[0] : `<chord${gid ? ` xml:id="${gid}${MIRROR}"` : ""}${durs}>${xml.join("")}</chord>`);
          j = gEnd;
        }
      }
      staff.push("</staff>");
      out.push(staff.join(""));
      // Ритм показывает стан — штили таба убираем, так строка ниже и ноты крупнее.
      for (let j = i; j <= end; j++) if (toks[j].name !== "tabDurSym") out.push(toks[j].raw);
      i = end;
      continue;
    }
    // Подписи секций (на первой доле) — над верхним станом.
    if (t.name === "dir" && t.kind === "open" && attr(t.attrs, "tstamp") !== undefined && attr(t.attrs, "staff") === "1") {
      out.push(`<dir${setAttr(t.attrs, "staff", "2")}>`);
      continue;
    }
    // Лиги таба — и на стане.
    if (t.name === "tie" && (t.kind === "self" || t.kind === "open")) {
      const s = attr(t.attrs, "startid");
      const e = attr(t.attrs, "endid");
      out.push(t.raw);
      if (s && e) out.push(`<tie staff="2" startid="${s}${MIRROR}" endid="${e}${MIRROR}"/>`);
      if (t.kind === "open") i = matching(toks, i);
      continue;
    }
    out.push(t.raw);
  }
  return out.join("");
}
