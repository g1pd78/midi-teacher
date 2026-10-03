// Песни Rocksmith (CDLC): партия → табулатура MEI с настоящими ладами, строем,
// каподастром, приёмами и секциями; остальные партии — аккомпанемент.
//
// Время в файле — секунды по сетке долей записи. В нотах темп постоянный (средний):
// позиция ноты — номер доли + доля внутри неё, квантованная к шестнадцатым или триолям.

import type { AccompNote } from "../api";
import { TUNINGS } from "./guitar";

export interface RsBeat {
  time: number;
  downbeat: boolean;
}
export interface RsNote {
  time: number;
  string: number;
  fret: number;
  sustain: number;
  techniques: number;
  slideTo: number | null;
  bend: number;
  chord: number | null;
}
export interface RsSection {
  name: string;
  start: number;
  end: number;
}
export interface RsArrangement {
  id: string;
  name: string;
  bass: boolean;
  tuning: number[];
  capo: number;
  centOffset: number;
  songLength: number;
  beats: RsBeat[];
  notes: RsNote[];
  chords: { name: string; frets: number[] }[];
  sections: RsSection[];
}
export interface RsSong {
  title: string;
  artist: string;
  album: string;
  year: number | null;
  arrangements: RsArrangement[];
}

/** Маски приёмов (как в игре). */
export const T = {
  FRET_HAND_MUTE: 0x8,
  TREMOLO: 0x10,
  HARMONIC: 0x20,
  PALM_MUTE: 0x40,
  SLAP: 0x80,
  PLUCK: 0x100,
  HAMMER_ON: 0x200,
  PULL_OFF: 0x400,
  SLIDE: 0x800,
  BEND: 0x1000,
  TAP: 0x4000,
  PINCH_HARMONIC: 0x8000,
  VIBRATO: 0x10000,
  MUTE: 0x20000,
  UNPITCHED_SLIDE: 0x400000,
  ACCENT: 0x4000000,
} as const;

export const ARRANGEMENT_NAME: Record<string, string> = {
  lead: "Соло-гитара",
  rhythm: "Ритм-гитара",
  combo: "Гитара",
  bass: "Бас",
};
export const arrangementTitle = (a: Pick<RsArrangement, "name">) => ARRANGEMENT_NAME[a.name.toLowerCase()] ?? a.name;

const SECTION_NAME: Record<string, string> = {
  intro: "Вступление",
  verse: "Куплет",
  modverse: "Куплет",
  prechorus: "Предприпев",
  chorus: "Припев",
  modchorus: "Припев",
  postchorus: "После припева",
  bridge: "Бридж",
  solo: "Соло",
  outro: "Кода",
  riff: "Рифф",
  hook: "Хук",
  interlude: "Проигрыш",
  breakdown: "Брейкдаун",
  transition: "Переход",
  melody: "Мелодия",
  buildup: "Нарастание",
  fadein: "Нарастание",
  fadeout: "Затухание",
  tapping: "Тэппинг",
  noguitar: "Без гитары",
  silence: "Тишина",
  head: "Тема",
  vamp: "Вамп",
  variation: "Вариация",
  ambient: "Эмбиент",
};
export const sectionTitle = (name: string) => SECTION_NAME[name.toLowerCase().replace(/\d+$/, "")] ?? name;

/** Ноты открытых струн партии (MIDI, от низкой). У баса — 4 струны. */
export function rsTuning(a: Pick<RsArrangement, "bass" | "tuning">): number[] {
  const base = a.bass ? TUNINGS.bass : TUNINGS.guitar;
  return base.map((m, i) => m + (a.tuning[i] ?? 0));
}

// --- Сетка долей ---

const TICKS = 12; // на долю: делится и на 4 (шестнадцатые), и на 3 (триоли)

interface Grid {
  beats: number[];
  /** Средняя длительность доли, с. */
  beatSec: number;
  bpm: number;
  /** Номера долей — начала тактов. */
  measureStarts: number[];
}

/** Индекс последнего элемента ≤ x (−1, если нет). */
function lastAtMost(xs: number[], x: number): number {
  let i = -1;
  xs.forEach((v, k) => {
    if (v <= x) i = k;
  });
  return i;
}

function grid(beats: RsBeat[]): Grid {
  const times = beats.map((b) => b.time);
  const gaps = times
    .slice(1)
    .map((t, i) => t - times[i])
    .filter((g) => g > 0.05)
    .sort((a, b) => a - b);
  const beatSec = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 0.5;
  const measureStarts = beats.map((b, i) => (b.downbeat ? i : -1)).filter((i) => i >= 0);
  if (!measureStarts.length || measureStarts[0] !== 0) measureStarts.unshift(0);
  return { beats: times, beatSec, bpm: Math.max(30, Math.min(300, Math.round(60 / beatSec))), measureStarts };
}

/** Позиция момента в долях (дробная), за краями сетки — по средней доле. */
function beatPos(g: Grid, t: number): number {
  const b = g.beats;
  if (!b.length) return t / g.beatSec;
  if (t <= b[0]) return (t - b[0]) / g.beatSec;
  if (t >= b[b.length - 1]) return b.length - 1 + (t - b[b.length - 1]) / g.beatSec;
  let lo = 0;
  let hi = b.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (b[mid] <= t) lo = mid;
    else hi = mid;
  }
  return lo + (t - b[lo]) / (b[hi] - b[lo]);
}

/** Квантовать позиции: в каждой доле — шестнадцатые или триоли, что точнее. Возвращает тики и сетку долей (4 или 3). */
function quantize(positions: number[]): { ticks: number[]; beatGrid: Map<number, number> } {
  const byBeat = new Map<number, number[]>();
  for (const p of positions) {
    const b = Math.floor(p + 1e-6);
    byBeat.set(b, [...(byBeat.get(b) ?? []), p - b]);
  }
  const beatGrid = new Map<number, number>();
  for (const [b, fracs] of byBeat) {
    const err = (g: number) => fracs.reduce((s, f) => s + Math.abs(f * g - Math.round(f * g)) / g, 0);
    const triplet = fracs.some((f) => Math.abs(f * 3 - Math.round(f * 3)) < 0.08 && Math.round(f * 3) % 3 !== 0);
    beatGrid.set(b, triplet && err(3) < err(4) * 0.6 ? 3 : 4);
  }
  const ticks = positions.map((p) => {
    const b = Math.floor(p + 1e-6);
    const g = beatGrid.get(b) ?? 4;
    return b * TICKS + Math.round((p - b) * g) * (TICKS / g);
  });
  return { ticks, beatGrid };
}

// --- Запись ---

const PNAMES = ["c", "c", "d", "d", "e", "f", "f", "g", "g", "a", "a", "b"];
const SHARP = [false, true, false, true, false, false, true, false, true, false, true, false];

/** Длительности в тиках → MEI (длительность, точки, триоль). */
const DUR: Record<number, [string, number, boolean]> = {
  48: ["1", 0, false],
  36: ["2", 1, false],
  24: ["2", 0, false],
  18: ["4", 1, false],
  12: ["4", 0, false],
  9: ["8", 1, false],
  6: ["8", 0, false],
  3: ["16", 0, false],
  8: ["4", 0, true],
  4: ["8", 0, true],
};

/** Разбить отрезок [t, t+len) внутри такта на записываемые длительности. */
export function splitTicks(t: number, len: number, beatGrid: (beat: number) => number): number[] {
  const out: number[] = [];
  while (len > 0) {
    const beat = Math.floor(t / TICKS);
    const inBeat = t - beat * TICKS;
    let d: number;
    if (inBeat === 0 && len >= TICKS) {
      // Целые доли: самая длинная из целых, что помещается.
      d = [48, 36, 24, 18, 12].find((x) => x <= len)!;
    } else {
      const g = beatGrid(beat);
      const rest = Math.min(TICKS - inBeat, len);
      if (g === 3) d = inBeat % 8 === 0 && rest >= 8 ? 8 : 4;
      else d = inBeat === 0 && rest >= 9 ? 9 : inBeat % 6 === 0 && rest >= 6 ? 6 : 3;
      d = Math.min(d, rest);
      if (!DUR[d]) d = g === 3 ? 4 : 3;
    }
    out.push(d);
    t += d;
    len -= d;
  }
  return out;
}

interface Ev {
  tick: number;
  len: number;
  notes: RsNote[];
}

export interface RsChart {
  mei: string;
  bpm: number;
  /** Звучащие ноты строя (с каподастром). */
  tuning: number[];
  capo: number;
  measures: number;
  notes: number;
  /** Начала тактов в долях сетки записи (для аккомпанемента). */
  barBeats: number[];
}

function techniqueLabel(n: RsNote): string[] {
  const t = n.techniques;
  const out: string[] = [];
  if (t & T.HAMMER_ON) out.push("H");
  if (t & T.PULL_OFF) out.push("P");
  if (t & T.TAP) out.push("T");
  if ((t & (T.SLIDE | T.UNPITCHED_SLIDE)) && n.slideTo !== null) out.push(n.slideTo > n.fret ? "↗" : "↘");
  if (t & T.BEND && n.bend > 0) out.push(n.bend === 0.5 ? "B½" : `B${n.bend}`);
  if (t & T.VIBRATO) out.push("~");
  if (t & T.PALM_MUTE) out.push("PM");
  if (t & (T.MUTE | T.FRET_HAND_MUTE)) out.push("X");
  if (t & T.HARMONIC) out.push("Harm");
  if (t & T.PINCH_HARMONIC) out.push("P.H.");
  if (t & T.SLAP) out.push("S");
  if (t & T.PLUCK) out.push("Pop");
  if (t & T.TREMOLO) out.push("Trem");
  if (t & T.ACCENT) out.push(">");
  return out;
}

const SPAN_LABELS = new Set(["PM", "~", "Trem"]);

function esc(s: string): string {
  return s.replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" })[c]!);
}

/** Партия → MEI: однострочная табулатура (строй файла, каподастр), ноты с высотой, подписи приёмов и секций. */
export function rsChart(song: Pick<RsSong, "title">, a: RsArrangement): RsChart {
  const g = grid(a.beats);
  const open = rsTuning(a);
  const strings = open.length;
  const capo = a.capo;
  const sounding = open.map((m) => m + capo);
  // Только струны инструмента.
  const notes = a.notes.filter((n) => n.string < strings);
  const pos = notes.map((n) => beatPos(g, n.time));
  const { ticks, beatGrid } = quantize(pos);
  // События: ноты с одним тиком — аккорд (на одной струне — последняя).
  const byTick = new Map<number, Map<number, RsNote>>();
  notes.forEach((n, i) => {
    const m = byTick.get(ticks[i]) ?? new Map<number, RsNote>();
    m.set(n.string, n);
    byTick.set(ticks[i], m);
  });
  const evTicks = [...byTick.keys()].sort((x, y) => x - y);
  // Начало нот — с первого такта, в котором они есть (лишние пустые такты отсчёта отбрасываем).
  const ms = g.measureStarts.map((b) => b * TICKS);
  const lastNoteTick = evTicks.length ? evTicks[evTicks.length - 1] : 0;
  const songEnd = Math.max(lastNoteTick + TICKS, Math.ceil(beatPos(g, a.songLength)) * TICKS);
  const startIdx = Math.max(0, lastAtMost(ms, evTicks[0] ?? 0));
  const bars: [number, number][] = [];
  for (let i = startIdx; i < ms.length; i++) {
    const s = ms[i];
    const e = ms[i + 1] ?? s + 4 * TICKS;
    if (s > lastNoteTick && bars.length) break;
    if (e - s >= TICKS) bars.push([s, e]);
    if (e > songEnd) break;
  }
  const evs: Ev[] = evTicks.map((tick, k) => {
    const ns = [...byTick.get(tick)!.values()].sort((x, y) => x.string - y.string);
    const next = evTicks[k + 1] ?? tick + TICKS * 4;
    const sustainTicks = Math.max(...ns.map((n) => Math.round((n.sustain / g.beatSec) * 4) * 3));
    // Без протяжки — до следующей ноты, но не дальше конца доли (дальше — пауза).
    const beatEnd = (Math.floor(tick / TICKS) + 1) * TICKS;
    const len = Math.max(1, Math.min(next - tick, sustainTicks > 0 ? Math.max(sustainTicks, 3) : beatEnd - tick));
    return { tick, len, notes: ns };
  });
  const gridOf = (beat: number) => beatGrid.get(beat) ?? 4;

  // Секции: такт начала каждой секции.
  const sectionAt = new Map<number, string>();
  for (const s of a.sections) {
    const t = Math.round(beatPos(g, s.start) * TICKS);
    const bi = bars.findIndex(([bs, be]) => t >= bs - TICKS / 2 && t < be - TICKS / 2);
    if (bi >= 0 && !sectionAt.has(bi)) sectionAt.set(bi, sectionTitle(s.name));
  }

  let id = 0;
  let prevLabels = new Set<string>();
  let meter = -1;
  let noteCount = 0;
  const body: string[] = [];
  // Лиги — элементами в такте, где начинается нота (id последней части ноты по событию).
  const ties: string[][] = bars.map(() => []);
  const lastPart = new Map<Ev, { bar: number; ids: string[] }>();
  bars.forEach(([bs, be], bi) => {
    const count = Math.round((be - bs) / TICKS);
    if (count !== meter) {
      if (meter !== -1) body.push(`<scoreDef meter.count="${count}" meter.unit="4"/>`);
      meter = count;
    }
    const parts: string[] = [];
    const dirs: string[] = [];
    let t = bs;
    let tuplet: string[] = [];
    let tupletBeat = -1;
    let beam: string[] = [];
    let beamBeat = -1;
    const flushBeam = () => {
      if (beam.length >= 2) parts.push(`<beam>${beam.join("")}</beam>`);
      else parts.push(...beam);
      beam = [];
    };
    const flushTuplet = () => {
      if (tuplet.length) parts.push(`<tuplet num="3" numbase="2" bracket.visible="false">${tuplet.join("")}</tuplet>`);
      tuplet = [];
    };
    const emit = (start: number, d: number, xml: string, short: boolean) => {
      const beat = Math.floor(start / TICKS);
      const trip = DUR[d][2];
      if (trip) {
        flushBeam();
        if (tupletBeat !== beat) flushTuplet();
        tuplet.push(xml);
        tupletBeat = beat;
        return;
      }
      flushTuplet();
      if (short && (beam.length === 0 || beamBeat === beat)) {
        beam.push(xml);
        beamBeat = beat;
      } else {
        flushBeam();
        if (short) {
          beam.push(xml);
          beamBeat = beat;
        } else parts.push(xml);
      }
    };
    const rest = (from: number, to: number) => {
      let s = from;
      for (const d of splitTicks(from - bs, to - from, (b) => gridOf(Math.floor(bs / TICKS) + b))) {
        const [dur, dots] = DUR[d];
        emit(s, d, `<rest dur="${dur}"${dots ? ` dots="${dots}"` : ""}/>`, false);
        s += d;
      }
    };
    for (const ev of evs) {
      const end = ev.tick + ev.len;
      if (end <= bs || ev.tick >= be) continue;
      const s = Math.max(ev.tick, bs);
      const e = Math.min(end, be);
      if (s > t) rest(t, s);
      if (s < t) continue; // перекрытие — пропускаем
      const pieces = splitTicks(s - bs, e - s, (b) => gridOf(Math.floor(bs / TICKS) + b));
      let p = s;
      pieces.forEach((d, k) => {
        const into = k > 0 || ev.tick < bs;
        const [dur, dots] = DUR[d];
        const gid = `rs${++id}`;
        const ids: string[] = [];
        const notesXml = ev.notes
          .map((n) => {
            const midi = open[n.string] + n.fret;
            const pc = ((midi % 12) + 12) % 12;
            const nid = `rs${++id}`;
            ids.push(nid);
            if (!into) noteCount++;
            return `<note xml:id="${nid}" pname="${PNAMES[pc]}" oct="${Math.floor(midi / 12) - 1}"${SHARP[pc] ? ' accid.ges="s"' : ""} tab.course="${strings - n.string}" tab.fret="${Math.max(0, n.fret - capo)}"/>`;
          })
          .join("");
        const prev = lastPart.get(ev);
        if (into && prev) prev.ids.forEach((pid, j) => ties[prev.bar].push(`<tie staff="1" startid="#${pid}" endid="#${ids[j]}"/>`));
        lastPart.set(ev, { bar: bi, ids });
        emit(p, d, `<tabGrp xml:id="${gid}" dur="${dur}"${dots ? ` dots="${dots}"` : ""}><tabDurSym/>${notesXml}</tabGrp>`, Number(dur) >= 8);
        if (k === 0 && !into) {
          // Глушение ладонью, вибрато, тремоло подряд — одна подпись на группу.
          const all = [...new Set(ev.notes.flatMap(techniqueLabel))];
          const labels = all.filter((l) => !(SPAN_LABELS.has(l) && prevLabels.has(l)));
          prevLabels = new Set(all);
          if (labels.length) dirs.push(`<dir xml:id="rs${++id}" staff="1" startid="#${gid}" place="above"><rend fontsize="x-small">${esc(labels.join(" "))}</rend></dir>`);
        }
        p += d;
      });
      t = e;
    }
    if (t < be) rest(t, be);
    flushBeam();
    flushTuplet();
    const label = sectionAt.get(bi);
    if (label) dirs.push(`<dir xml:id="rs${++id}" staff="1" tstamp="1" place="above"><rend fontweight="bold">${esc(label)}</rend></dir>`);
    // Перед новой секцией — двойная черта (граница фрагмента для разучивания).
    const right = bi === bars.length - 1 ? ` right="end"` : sectionAt.has(bi + 1) ? ` right="dbl"` : "";
    body.push(`<measure xml:id="m${bi + 1}" n="${bi + 1}"${right}><staff n="1"><layer n="1">${parts.join("")}</layer></staff>${dirs.join("")}`);
  });
  body.forEach((m, bi) => {
    body[bi] = m + ties[bi].join("") + "</measure>";
  });
  const tuningXml =
    "<tuning>" +
    sounding
      .map((m, i) => {
        const pc = ((m % 12) + 12) % 12;
        return `<course n="${strings - i}" pname="${PNAMES[pc]}" oct="${Math.floor(m / 12) - 1}"${SHARP[pc] ? ' accid="s"' : ""}/>`;
      })
      .reverse()
      .join("") +
    "</tuning>";
  const firstMeter = bars.length ? Math.round((bars[0][1] - bars[0][0]) / TICKS) : 4;
  const mei =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<mei xmlns="http://www.music-encoding.org/ns/mei" meiversion="5.0"><meiHead><fileDesc><titleStmt><title>${esc(song.title)}</title></titleStmt><pubStmt/></fileDesc></meiHead>` +
    `<music><body><mdiv><score><scoreDef meter.count="${firstMeter}" meter.unit="4" midi.bpm="${g.bpm}">` +
    `<staffGrp><staffDef n="1" notationtype="tab.guitar" lines="${strings}"><clef shape="TAB" line="${strings - 1}"/>${tuningXml}</staffDef></staffGrp>` +
    `</scoreDef><section>${body.join("")}</section></score></mdiv></body></music></mei>`;
  return { mei, bpm: g.bpm, tuning: sounding, capo, measures: bars.length, notes: noteCount, barBeats: bars.map(([b]) => b / TICKS) };
}

/**
 * Остальные партии — аккомпанемент: время в нотах (постоянный темп партии `main`, ноль — первый такт
 * её табулатуры), гитары — звуком электрогитары, бас — бас-гитары.
 */
export function rsAccompaniment(song: RsSong, main: RsArrangement, barBeats: number[]): AccompNote[] {
  const g = grid(main.beats);
  const msPerBeat = 60000 / g.bpm;
  const startBeat = barBeats[0] ?? 0;
  const lastBar = barBeats.length ? barBeats[barBeats.length - 1] + 4 : Infinity;
  const out: AccompNote[] = [];
  song.arrangements
    .filter((a) => a.id !== main.id)
    .forEach((a, k) => {
      const open = rsTuning(a);
      const channel = 2 + k;
      const program = a.bass ? 33 : a.name.toLowerCase() === "lead" ? 29 : 27;
      for (const n of a.notes) {
        if (n.string >= open.length || n.techniques & (T.MUTE | T.FRET_HAND_MUTE)) continue;
        const beat = beatPos(g, n.time);
        if (beat < startBeat - 1e-6 || beat >= lastBar) continue;
        const startMs = Math.round((beat - startBeat) * msPerBeat);
        const durMs = Math.round(Math.max(n.sustain > 0 ? (n.sustain / g.beatSec) * msPerBeat : msPerBeat / 2, 60));
        const measure = lastAtMost(barBeats, beat + 1e-6) + 1;
        out.push({ pitch: open[n.string] + n.fret, startMs, durMs, measure, channel, program });
      }
    });
  return out;
}
