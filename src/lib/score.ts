// Разбор пьесы, загруженной в Verovio: какие ноты, когда, какой рукой.
//
// Verovio даёт MEI (с xml:id у каждой ноты), временную карту (timemap) и
// MIDI-значения нот. Отсюда строится список нот для движка в Rust. Разбор MEI
// сделан регулярными выражениями, чтобы работать и в тестах под Node (без DOMParser).

export type Hand = "right" | "left";

export interface ScoreNote {
  id: string;
  pitch: number;
  startMs: number;
  durMs: number;
  hand: Hand;
  measure: number;
  staff: number;
}

export interface TimemapEntry {
  tstamp: number;
  qstamp: number;
  on?: string[];
  off?: string[];
  tempo?: number;
  measureOn?: string;
}

export type MidiValues = Record<string, { time: number; duration: number; pitch: number }>;

export interface MeiStructure {
  staffOf: Map<string, number>;
  measureOf: Map<string, number>;
  /** Аппликатура: id ноты → палец. */
  fingerOf: Map<string, string>;
  /** id ноты-продолжения лиги → id начала лиги. */
  tieEndToStart: Map<string, string>;
  staves: number;
  /** Ключ стана: номер → "G" | "F" | "C". */
  clefOf: Map<number, string>;
  measures: number;
  /** xml:id тактов по порядку (номер такта = индекс + 1). */
  measureIds: string[];
  /** Размер: долей в такте и длительность доли (4 — четверть, 8 — восьмая). */
  meter: { count: number; unit: number };
}

const TAG = /<(\/?)(measure|staff|note|fing|tie|staffDef|clef|meterSig|scoreDef)\b([^>]*?)(\/?)>/g;

function attr(attrs: string, name: string): string | undefined {
  const m = new RegExp(`(?:^|\\s)${name.replace(":", "\\:")}="([^"]*)"`).exec(attrs);
  return m?.[1];
}

export function parseMei(mei: string): MeiStructure {
  const staffOf = new Map<string, number>();
  const measureOf = new Map<string, number>();
  const fingerOf = new Map<string, string>();
  const tieEndToStart = new Map<string, string>();
  const clefOf = new Map<number, string>();
  const measureIds: string[] = [];
  let meter = { count: 4, unit: 4 };
  let meterFound = false;
  let staffDefN = 0;
  let staves = 0;
  let measure = 0;
  let staff = 0;

  for (const m of mei.matchAll(TAG)) {
    const [whole, closing, tag, attrs] = m;
    if (closing) {
      if (tag === "staffDef") staffDefN = 0;
      continue;
    }
    switch (tag) {
      case "staffDef": {
        const n = Number(attr(attrs, "n") ?? 0);
        staves = Math.max(staves, n);
        const shape = attr(attrs, "clef.shape");
        if (shape && !clefOf.has(n)) clefOf.set(n, shape);
        const count = Number(attr(attrs, "meter.count") ?? 0);
        const unit = Number(attr(attrs, "meter.unit") ?? 0);
        if (!meterFound && count && unit) (meter = { count, unit }), (meterFound = true);
        // Самозакрытый staffDef не содержит вложенных clef/meterSig.
        staffDefN = m[4] ? 0 : n;
        break;
      }
      case "scoreDef": {
        const count = Number(attr(attrs, "meter.count") ?? 0);
        const unit = Number(attr(attrs, "meter.unit") ?? 0);
        if (!meterFound && count && unit) (meter = { count, unit }), (meterFound = true);
        break;
      }
      case "clef": {
        const shape = attr(attrs, "shape");
        if (shape && staffDefN && !clefOf.has(staffDefN)) clefOf.set(staffDefN, shape);
        break;
      }
      case "meterSig": {
        const count = Number(attr(attrs, "count") ?? 0);
        const unit = Number(attr(attrs, "unit") ?? 0);
        if (!meterFound && count && unit) (meter = { count, unit }), (meterFound = true);
        break;
      }
      case "measure": {
        measure += 1;
        const id = attr(attrs, "xml:id");
        if (id) measureIds.push(id);
        break;
      }
      case "staff":
        staff = Number(attr(attrs, "n") ?? 0);
        break;
      case "note": {
        const id = attr(attrs, "xml:id");
        if (id) {
          staffOf.set(id, staff);
          measureOf.set(id, measure);
        }
        break;
      }
      case "fing": {
        const start = attr(attrs, "startid")?.replace(/^#/, "");
        const end = mei.indexOf("</fing>", m.index!);
        if (start && end > 0) {
          const text = mei.slice(m.index! + whole.length, end).replace(/<[^>]*>/g, "").trim();
          if (text) fingerOf.set(start, text);
        }
        break;
      }
      case "tie": {
        const s = attr(attrs, "startid")?.replace(/^#/, "");
        const e = attr(attrs, "endid")?.replace(/^#/, "");
        if (s && e) tieEndToStart.set(e, s);
        break;
      }
    }
  }
  return { staffOf, measureOf, fingerOf, tieEndToStart, staves, clefOf, measures: measure, measureIds, meter };
}

/** Рука по стану: первый (верхний) — правая, второй — левая. Один стан в басовом ключе — левая. */
function handOf(staff: number, s: MeiStructure): Hand {
  if (s.staves <= 1) return s.clefOf.get(staff) === "F" ? "left" : "right";
  return staff >= 2 ? "left" : "right";
}

/**
 * Ноты пьесы по порядку. Продолжения лиг не считаются отдельными нотами
 * (их не нужно нажимать заново), а продлевают начальную ноту.
 */
export function buildNotes(timemap: TimemapEntry[], midi: MidiValues, s: MeiStructure): ScoreNote[] {
  const notes: ScoreNote[] = [];
  const byId = new Map<string, ScoreNote>();
  for (const entry of timemap) {
    for (const id of entry.on ?? []) {
      const v = midi[id];
      if (!v || byId.has(id)) continue;
      const tieStart = s.tieEndToStart.get(id);
      if (tieStart) {
        // Цепочка лиг: продлеваем самую первую ноту.
        let root = tieStart;
        while (s.tieEndToStart.has(root)) root = s.tieEndToStart.get(root)!;
        const first = byId.get(root);
        if (first) first.durMs = Math.max(first.durMs, v.time + v.duration - first.startMs);
        continue;
      }
      const staff = s.staffOf.get(id) ?? 1;
      const note: ScoreNote = {
        id,
        pitch: v.pitch,
        startMs: Math.round(v.time),
        durMs: Math.round(v.duration),
        hand: handOf(staff, s),
        measure: s.measureOf.get(id) ?? 0,
        staff,
      };
      notes.push(note);
      byId.set(id, note);
    }
  }
  return notes;
}

/** Все id нот, которые Verovio включил во временную карту. */
export function timemapNoteIds(timemap: TimemapEntry[]): string[] {
  const ids = new Set<string>();
  for (const e of timemap) for (const id of e.on ?? []) ids.add(id);
  return [...ids];
}

/**
 * Подписи нот (до-ре-ми) слогами под нотами: добавляет <verse> в каждую ноту MEI.
 * `name(pname, accid)` возвращает текст подписи.
 */
export function addNoteNames(mei: string, name: (pname: string, accid: string | undefined) => string): string {
  return mei.replace(/<note\b([^>]*?)(\/?)>/g, (whole, attrs: string, selfClose: string) => {
    const pname = attr(attrs, "pname");
    if (!pname || attr(attrs, "grace")) return whole;
    const accid = attr(attrs, "accid") ?? attr(attrs, "accid.ges");
    const verse = `<verse n="9"><syl>${name(pname, accid)}</syl></verse>`;
    return selfClose ? `<note${attrs}>${verse}</note>` : `<note${attrs}>${verse}`;
  });
}

/** Начало каждого такта (мс) по временной карте; такты без записи — по соседним. */
export function measureStarts(timemap: TimemapEntry[], s: MeiStructure): number[] {
  const byId = new Map<string, number>();
  for (const e of timemap) if (e.measureOn) byId.set(e.measureOn, e.tstamp);
  const starts = s.measureIds.map((id) => byId.get(id) ?? NaN);
  for (let i = 0; i < starts.length; i++) if (Number.isNaN(starts[i])) starts[i] = i > 0 ? starts[i - 1] : 0;
  return starts;
}

/** Темп (четвертей в минуту) в начале пьесы. */
export function initialTempo(timemap: TimemapEntry[]): number {
  return timemap.find((e) => e.tempo)?.tempo ?? 120;
}

export interface Beat {
  ms: number;
  accent: boolean;
}

/** Доли метронома: по размеру и темпу внутри каждого такта (сильная — первая). */
export function buildBeats(starts: number[], endMs: number, meter: { count: number; unit: number }, tempo: number): Beat[] {
  const beatMs = beatDuration(meter, tempo);
  const beats: Beat[] = [];
  starts.forEach((start, i) => {
    const next = i + 1 < starts.length ? starts[i + 1] : endMs;
    for (let k = 0; k < meter.count; k++) {
      const t = Math.round(start + k * beatMs);
      if (t >= next - 1) break;
      beats.push({ ms: t, accent: k === 0 });
    }
  });
  return beats;
}

export function beatDuration(meter: { unit: number }, tempo: number): number {
  return (60000 / tempo) * (4 / meter.unit);
}

/** Отрезок цикла в мс для тактов [from, to] (номера с 1). */
export function loopRangeMs(starts: number[], endMs: number, from: number, to: number): [number, number] {
  const a = starts[Math.max(0, from - 1)] ?? 0;
  const b = to < starts.length ? starts[to] : endMs;
  return [Math.round(a), Math.round(b)];
}
