// Песни по буквам аккордов: мелодия (если есть) + аккорды по тактам → фортепианная
// партия с аккомпанементом выбранной фактуры и буквами над нотами (MEI для Verovio).
//
// Время — в шестнадцатых от начала песни. Аккорды хранятся текстом, как их пишет
// человек: «C | G7 | Am F | -» — такты через «|», аккорды такта делят его поровну
// («-» — тот же аккорд дальше).

import { scaleUp, type Pitch } from "./exercises";
import {
  bassPc,
  chordPcs,
  chordSpelling,
  detectChordFit,
  parseChord,
  pcIn,
  pitchOf,
  rootPc,
  spellPc,
  voiceLead,
  type Chord,
} from "./chords";

export type Style = "block" | "oompah" | "alberti";

export const STYLE_NAME: Record<Style, string> = {
  block: "Аккорд целиком",
  oompah: "Бас + аккорд",
  alberti: "Альберти",
};

export interface MelodyNote {
  pitch: number;
  start: number;
  len: number;
}

export interface LeadSong {
  id: string;
  title: string;
  bpm: number;
  /** Размер: долей и длительность доли (4 — четверть, 8 — восьмая). */
  beats: number;
  unit: 4 | 8;
  /** Знаки при ключе. */
  fifths: number;
  /** Затакт, шестнадцатых (0 — нет). */
  pickup: number;
  melody: MelodyNote[];
  /** Аккорды по тактам (после затакта). */
  chords: string;
  style: Style;
  builtin?: boolean;
  /** Откуда взята мелодия: «из пьесы …». */
  source?: string;
}

// --- Размер ---

export const barLen = (s: Pick<LeadSong, "beats" | "unit">) => (s.beats * 16) / s.unit;
/** Счётная доля в шестнадцатых: четверть, а в 6/8 и 9/8 — четверть с точкой. */
export const beatLen = (s: Pick<LeadSong, "beats" | "unit">) => (s.unit === 8 && s.beats % 3 === 0 ? 6 : 16 / s.unit);

export function barStarts(s: Pick<LeadSong, "beats" | "unit" | "pickup">, length: number): number[] {
  const out = [0];
  let t = s.pickup > 0 ? s.pickup : barLen(s);
  while (t < length) {
    out.push(t);
    t += barLen(s);
  }
  return out;
}

// --- Мелодия мини-записью ---

const LEN: Record<string, number> = { w: 16, h: 8, q: 4, e: 2, s: 1 };
const LETTER_SEMI: Record<string, number> = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };

/** «e4q e4q f4q g4q | g4h. r q» → ноты (паузы — промежутки). Ошибки — список непонятных слов. */
export function parseMelody(text: string): { notes: MelodyNote[]; length: number; errors: string[] } {
  const notes: MelodyNote[] = [];
  const errors: string[] = [];
  let t = 0;
  for (const tok of text.split(/\s+/).filter(Boolean)) {
    if (tok === "|") continue;
    const m = /^([a-g])(#|b)?(\d)([whqes])(\.?)$/.exec(tok) ?? /^(r)()()([whqes])(\.?)$/.exec(tok);
    if (!m) {
      errors.push(tok);
      continue;
    }
    const len = LEN[m[4]] * (m[5] ? 1.5 : 1);
    if (m[1] !== "r") {
      const alter = m[2] === "#" ? 1 : m[2] === "b" ? -1 : 0;
      notes.push({ pitch: (Number(m[3]) + 1) * 12 + LETTER_SEMI[m[1]] + alter, start: t, len });
    }
    t += len;
  }
  return { notes, length: t, errors };
}

// --- Аккорды по тактам ---

export interface SongChord {
  start: number;
  chord: Chord;
}

/** Текст аккордов → аккорды во времени. Такт k начинается после затакта. */
export function parseChart(
  text: string,
  s: Pick<LeadSong, "beats" | "unit" | "pickup">,
): { chords: SongChord[]; bars: number; errors: string[] } {
  const chords: SongChord[] = [];
  const errors: string[] = [];
  const bl = barLen(s);
  const beat = beatLen(s);
  const groups = text
    .split("|")
    .map((g) => g.trim())
    .filter((g, i, all) => g || i < all.length - 1);
  groups.forEach((g, k) => {
    const toks = g.split(/\s+/).filter(Boolean);
    if (!toks.length) return;
    const start = s.pickup + k * bl;
    const beats = bl / beat;
    // Аккорды делят такт по долям; первому достаётся остаток.
    const each = toks.length <= beats ? Math.floor(beats / toks.length) : 0;
    let pos = 0;
    toks.forEach((tok, i) => {
      const span = each ? (each + (i === 0 ? beats - each * toks.length : 0)) * beat : bl / toks.length;
      if (tok !== "-" && tok !== "%") {
        const c = parseChord(tok);
        if (c) chords.push({ start: start + Math.round(pos), chord: c });
        else errors.push(tok);
      }
      pos += span;
    });
  });
  return { chords, bars: groups.length, errors };
}

// --- Написание нот в тональности ---

const TONICS: Record<number, Pitch> = {
  [-6]: { letter: "g", alter: -1, oct: 4 },
  [-5]: { letter: "d", alter: -1, oct: 4 },
  [-4]: { letter: "a", alter: -1, oct: 4 },
  [-3]: { letter: "e", alter: -1, oct: 4 },
  [-2]: { letter: "b", alter: -1, oct: 4 },
  [-1]: { letter: "f", alter: 0, oct: 4 },
  0: { letter: "c", alter: 0, oct: 4 },
  1: { letter: "g", alter: 0, oct: 4 },
  2: { letter: "d", alter: 0, oct: 4 },
  3: { letter: "a", alter: 0, oct: 4 },
  4: { letter: "e", alter: 0, oct: 4 },
  5: { letter: "b", alter: 0, oct: 4 },
  6: { letter: "f", alter: 1, oct: 4 },
};

export const KEY_NAMES: Record<number, string> = {
  [-4]: "ля♭ мажор / фа минор",
  [-3]: "ми♭ мажор / до минор",
  [-2]: "си♭ мажор / соль минор",
  [-1]: "фа мажор / ре минор",
  0: "до мажор / ля минор",
  1: "соль мажор / ми минор",
  2: "ре мажор / си минор",
  3: "ля мажор / фа♯ минор",
  4: "ми мажор / до♯ минор",
};

/** Нота по-правильному: звук гаммы тональности — её буквой, остальное — диезом или бемолем. */
export function spell(midi: number, fifths: number): Pitch {
  const scale = scaleUp(TONICS[Math.max(-6, Math.min(6, fifths))], "major", 1);
  const pc = ((midi % 12) + 12) % 12;
  const inKey = scale.find((p) => (((LETTER_SEMI[p.letter] + p.alter) % 12) + 12) % 12 === pc);
  return pitchOf(midi, inKey ?? spellPc(pc, fifths < 0));
}

/** Нота аккорда — буквой из его написания (ми♭ в до миноре, а не ре♯). */
function spellIn(midi: number, chord: Chord | null, fifths: number): Pitch {
  if (chord) {
    const pc = ((midi % 12) + 12) % 12;
    const tones = [...chordSpelling(chord), ...(chord.bass ? [chord.bass] : [])];
    const t = tones.find((n) => (((LETTER_SEMI[n.letter] + n.alter) % 12) + 12) % 12 === pc);
    if (t) return pitchOf(midi, t);
  }
  return spell(midi, fifths);
}

// --- Аккомпанемент ---

interface Ev {
  pitches: number[];
  start: number;
  len: number;
  chord: Chord | null;
}

/** Отрезки аккордов по тактам: в начале каждого такта аккорд берётся заново. */
function segments(chords: SongChord[], starts: number[], length: number): { start: number; end: number; chord: Chord; barStart: number }[] {
  const out: { start: number; end: number; chord: Chord; barStart: number }[] = [];
  starts.forEach((b, i) => {
    const e = starts[i + 1] ?? length;
    const cuts = [b, ...chords.filter((c) => c.start > b && c.start < e).map((c) => c.start), e];
    for (let k = 0; k < cuts.length - 1; k++) {
      const active = [...chords].reverse().find((c) => c.start <= cuts[k]);
      if (active) out.push({ start: cuts[k], end: cuts[k + 1], chord: active.chord, barStart: b });
    }
  });
  return out;
}

const LH_CHORD: [number, number] = [48, 62];
const LH_HIGH: [number, number] = [52, 64];
const BASS_LOW = 40;
const RH_CHORD: [number, number] = [60, 72];

/** Партии рук: правая — мелодия (или аккорды, если мелодии нет), левая — аккомпанемент фактуры. */
export function arrange(song: LeadSong, style: Style = song.style): { right: Ev[]; left: Ev[]; length: number; chords: SongChord[] } {
  const chart = parseChart(song.chords, song);
  const bl = barLen(song);
  const melodyEnd = Math.max(0, ...song.melody.map((n) => n.start + n.len));
  const chartEnd = song.pickup + chart.bars * bl;
  // Длина — до конца последнего такта.
  const rawEnd = Math.max(melodyEnd, chartEnd, song.pickup + bl);
  const length = song.pickup + Math.ceil((rawEnd - song.pickup) / bl) * bl;
  const starts = barStarts(song, length);
  const segs = segments(chart.chords, starts, length);
  const beat = beatLen(song);
  const right: Ev[] = [];
  const left: Ev[] = [];
  const hasMelody = song.melody.length > 0;
  if (hasMelody) {
    const mel = [...song.melody].sort((a, b) => a.start - b.start);
    mel.forEach((n, i) => {
      const next = mel[i + 1]?.start ?? length;
      const len = Math.max(1, Math.min(n.len, next - n.start, length - n.start));
      right.push({ pitches: [n.pitch], start: n.start, len, chord: null });
    });
  }
  let prevLow: number[] | null = null;
  let prevHigh: number[] | null = null;
  for (const seg of segs) {
    const pcs = chordPcs(seg.chord);
    const bass = pcIn(bassPc(seg.chord), BASS_LOW);
    const fifth = pcIn((rootPc(seg.chord) + 7) % 12, BASS_LOW);
    const span = seg.end - seg.start;
    const beatsInBar = bl / beat;
    // Сильные доли для баса: первая и (в чётных размерах из 4+ долей) середина такта.
    const bassBeat = (b: number) => b === 0 || (beatsInBar >= 4 && beatsInBar % 2 === 0 && b === beatsInBar / 2);
    if (hasMelody) {
      if (style === "block") {
        prevLow = voiceLead(pcs, prevLow, ...LH_CHORD);
        left.push({ pitches: prevLow, start: seg.start, len: span, chord: seg.chord });
      } else if (style === "oompah") {
        prevHigh = voiceLead(pcs, prevHigh, ...LH_HIGH);
        for (let t = seg.start; t < seg.end; t += beat) {
          const b = Math.round((t - seg.barStart) / beat);
          const len = Math.min(beat, seg.end - t);
          if (bassBeat(b)) left.push({ pitches: [b > 0 && t > seg.start ? fifth : bass], start: t, len, chord: seg.chord });
          else left.push({ pitches: prevHigh, start: t, len, chord: seg.chord });
        }
      } else {
        prevLow = voiceLead(pcs, prevLow, ...LH_CHORD);
        const v = prevLow;
        const order = [v[0], v[v.length - 1], v[1], v[v.length - 1]];
        for (let t = seg.start; t < seg.end; t += 2) {
          const k = Math.round((t - seg.barStart) / 2) % 4;
          left.push({ pitches: [order[k]], start: t, len: Math.min(2, seg.end - t), chord: seg.chord });
        }
      }
    } else {
      // Без мелодии: правая — аккорды, левая — бас.
      prevHigh = voiceLead(pcs, prevHigh, ...RH_CHORD);
      if (style === "oompah") {
        for (let t = seg.start; t < seg.end; t += beat) {
          const b = Math.round((t - seg.barStart) / beat);
          const len = Math.min(beat, seg.end - t);
          if (bassBeat(b)) left.push({ pitches: [b > 0 && t > seg.start ? fifth : bass], start: t, len, chord: seg.chord });
          else right.push({ pitches: prevHigh, start: t, len, chord: seg.chord });
        }
      } else if (style === "alberti") {
        const v = prevHigh;
        const order = [v[0], v[v.length - 1], v[1], v[v.length - 1]];
        for (let t = seg.start; t < seg.end; t += 2) {
          const k = Math.round((t - seg.barStart) / 2) % 4;
          right.push({ pitches: [order[k]], start: t, len: Math.min(2, seg.end - t), chord: seg.chord });
        }
        left.push({ pitches: [bass + 12 <= 55 ? bass + 12 : bass], start: seg.start, len: span, chord: seg.chord });
      } else {
        right.push({ pitches: prevHigh, start: seg.start, len: span, chord: seg.chord });
        left.push({ pitches: [bass + 12 <= 55 ? bass + 12 : bass], start: seg.start, len: span, chord: seg.chord });
      }
    }
  }
  return { right, left, length, chords: chart.chords };
}

// --- MEI ---

const DUR: Record<number, [string, number]> = { 1: ["16", 0], 2: ["8", 0], 3: ["8", 1], 4: ["4", 0], 6: ["4", 1], 8: ["2", 0], 12: ["2", 1], 16: ["1", 0] };
const SIZES = [16, 12, 8, 6, 4, 3, 2, 1];

/** Разбить длительность на записываемые (с лигами): длинные — с доли, короткие — внутри доли. */
export function splitLen(offset: number, len: number, beat = 4): number[] {
  const out: number[] = [];
  while (len > 0) {
    const d =
      SIZES.find((x) => {
        if (x > len) return false;
        if (x >= beat) return offset % beat === 0 && (x !== 16 || offset === 0);
        return (offset % beat) + x <= beat && offset % (x >= 2 ? 2 : 1) === 0;
      }) ?? 1;
    out.push(d);
    offset += d;
    len -= d;
  }
  return out;
}

function keyAlters(fifths: number): Record<string, number> {
  const out: Record<string, number> = {};
  if (fifths > 0) for (const l of "fcgdaeb".slice(0, fifths)) out[l] = 1;
  else for (const l of "beadgcf".slice(0, -fifths)) out[l] = -1;
  return out;
}

interface Piece {
  start: number;
  len: number;
  ev: Ev | null;
  tie?: "i" | "m" | "t";
}

/** Такт одной партии: ноты и паузы, разбитые на записываемые длительности. */
function barPieces(evs: Ev[], b: number, e: number, beat: number): Piece[] {
  const out: Piece[] = [];
  let t = b;
  const inBar = evs.filter((x) => x.start < e && x.start + x.len > b).sort((x, y) => x.start - y.start);
  const push = (start: number, len: number, ev: Ev | null, tieIn: boolean, tieOut: boolean) => {
    const parts = splitLen(start - b, len, beat);
    let s = start;
    parts.forEach((d, i) => {
      const first = i === 0;
      const last = i === parts.length - 1;
      const into = (first && tieIn) || !first;
      const onward = (last && tieOut) || !last;
      out.push({ start: s, len: d, ev, tie: ev ? (into && onward ? "m" : into ? "t" : onward ? "i" : undefined) : undefined });
      s += d;
    });
  };
  for (const x of inBar) {
    const s = Math.max(x.start, b);
    if (s > t) push(t, s - t, null, false, false);
    const end = Math.min(x.start + x.len, e);
    if (end <= s) continue;
    push(s, end - s, x, x.start < b, x.start + x.len > e);
    t = end;
  }
  if (t < e) push(t, e - t, null, false, false);
  return out;
}

/** MEI песни: фортепианная система, буквы аккордов над верхним станом. */
export function songMei(song: LeadSong, style: Style = song.style): string {
  const { right, left, length, chords } = arrange(song, style);
  const starts = barStarts(song, length);
  const beat = beatLen(song);
  const alters = keyAlters(song.fifths);
  let id = 0;
  const measures = starts.map((b, m) => {
    const e = starts[m + 1] ?? length;
    const staffXml = ([right, left] as Ev[][]).map((evs, si) => {
      const pieces = barPieces(evs, b, e, beat);
      const seen = new Map<string, number>();
      const parts: string[] = [];
      let group: string[] = [];
      let groupBeat = -1;
      const flush = () => {
        if (group.length >= 2) parts.push(`<beam>${group.join("")}</beam>`);
        else parts.push(...group);
        group = [];
      };
      for (const p of pieces) {
        const [dur, dots] = DUR[p.len] ?? ["4", 0];
        const dotAttr = dots ? ` dots="${dots}"` : "";
        let xml: string;
        if (!p.ev) xml = `<rest dur="${dur}"${dotAttr}/>`;
        else {
          const notes = p.ev.pitches.map((midi) => {
            const pitch = spellIn(midi, p.ev!.chord, song.fifths);
            const key = `${pitch.letter}${pitch.oct}`;
            const implied = seen.get(key) ?? alters[pitch.letter] ?? 0;
            let acc = "";
            // Продолжение лиги не пишет знак заново.
            if (pitch.alter !== implied && p.tie !== "t" && p.tie !== "m") {
              acc = ` accid="${pitch.alter === 1 ? "s" : pitch.alter === -1 ? "f" : pitch.alter === 2 ? "x" : pitch.alter === -2 ? "ff" : "n"}"`;
              seen.set(key, pitch.alter);
            } else if (pitch.alter) acc = ` accid.ges="${pitch.alter === 1 ? "s" : pitch.alter === -1 ? "f" : pitch.alter === 2 ? "ss" : "ff"}"`;
            const tie = p.tie ? ` tie="${p.tie}"` : "";
            return { pname: pitch.letter, oct: pitch.oct, attrs: `pname="${pitch.letter}" oct="${pitch.oct}"${acc}${tie}` };
          });
          if (notes.length === 1) xml = `<note xml:id="s${++id}" dur="${dur}"${dotAttr} ${notes[0].attrs}/>`;
          else xml = `<chord xml:id="s${++id}" dur="${dur}"${dotAttr}>${notes.map((n) => `<note xml:id="s${++id}" ${n.attrs}/>`).join("")}</chord>`;
        }
        // Восьмые и шестнадцатые одной доли — под общим ребром.
        const off = p.start - b;
        const bt = Math.floor(off / beat);
        const short = p.len < 4 && (off % beat) + p.len <= beat && !!p.ev;
        if (short && (group.length === 0 || bt === groupBeat)) {
          group.push(xml);
          groupBeat = bt;
        } else {
          flush();
          if (short) {
            group.push(xml);
            groupBeat = bt;
          } else parts.push(xml);
        }
      }
      flush();
      return `<staff n="${si + 1}"><layer n="1">${parts.join("")}</layer></staff>`;
    });
    // Буквы аккордов в такте.
    const unit16 = 16 / song.unit;
    const harms = chords
      .filter((c) => c.start >= b && c.start < e)
      .map((c) => `<harm xml:id="h${++id}" staff="1" place="above" tstamp="${+((c.start - b) / unit16 + 1).toFixed(4)}">${c.chord.symbol}</harm>`);
    const endBar = m === starts.length - 1 ? ` right="end"` : "";
    const metcon = m === 0 && song.pickup > 0 ? ` metcon="false"` : "";
    return `<measure n="${m + (song.pickup > 0 ? 0 : 1)}"${metcon}${endBar}>${staffXml.join("")}${harms.join("")}</measure>`;
  });
  const sig = song.fifths === 0 ? "0" : `${Math.abs(song.fifths)}${song.fifths > 0 ? "s" : "f"}`;
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<mei xmlns="http://www.music-encoding.org/ns/mei" meiversion="5.0"><meiHead><fileDesc><titleStmt><title>${escapeXml(song.title)}</title></titleStmt><pubStmt/></fileDesc></meiHead>` +
    `<music><body><mdiv><score>` +
    `<scoreDef key.sig="${sig}" meter.count="${song.beats}" meter.unit="${song.unit}" midi.bpm="${song.bpm}">` +
    `<staffGrp symbol="brace" bar.thru="true">` +
    `<staffDef n="1" lines="5" clef.shape="G" clef.line="2"/>` +
    `<staffDef n="2" lines="5" clef.shape="F" clef.line="4"/>` +
    `</staffGrp></scoreDef><section>${measures.join("")}</section></score></mdiv></body></music></mei>`
  );
}

function escapeXml(s: string): string {
  return s.replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" })[c]!);
}

// --- Песня из пьесы (MusicXML или MIDI) ---

export interface ScoreLike {
  notes: { pitch: number; startMs: number; durMs: number; hand: string; measure: number }[];
  starts: number[];
  tempoBpm: number;
  endMs: number;
  meter: { count: number; unit: number };
}

/** Буквы аккордов из MEI (элементы harm, например из MusicXML с обозначениями): такт → [доля, аккорд]. */
export function harmsFromMei(mei: string): { measure: number; tstamp: number; chord: Chord }[] {
  const out: { measure: number; tstamp: number; chord: Chord }[] = [];
  let measure = 0;
  const re = /<measure\b[^>]*>|<harm\b([^>]*)>([\s\S]*?)<\/harm>/g;
  for (let m = re.exec(mei); m; m = re.exec(mei)) {
    if (m[0].startsWith("<measure")) {
      measure++;
      continue;
    }
    const ts = /tstamp="([\d.]+)"/.exec(m[1]);
    const text = m[2].replace(/<[^>]+>/g, "").replace(/\s+/g, "").replace(/♯/g, "#").replace(/♭/g, "b");
    const chord = parseChord(text);
    if (chord) out.push({ measure, tstamp: ts ? Number(ts[1]) : 1, chord });
  }
  return out;
}

/**
 * Песня по буквам из пьесы: мелодия — верхний голос правой руки, аккорды — буквы из файла
 * (если есть) или распознанные по нотам каждого такта (по половинам такта, если аккорд меняется).
 */
export function songFromScore(score: ScoreLike, mei: string, title: string, id: string): LeadSong {
  const unit = score.meter.unit === 8 ? 8 : 4;
  const beats = score.meter.count;
  const bpm = Math.round(score.tempoBpm);
  const ms16 = 60000 / bpm / 4;
  const t0 = score.starts[0] ?? 0;
  const q = (ms: number) => Math.round((ms - t0) / ms16);
  const bl = (beats * 16) / unit;
  const firstBar = score.starts.length > 1 ? q(score.starts[1]) : bl;
  const pickup = firstBar > 0 && firstBar < bl ? firstBar : 0;
  const fifthsMatch = /key\.sig="(\d)([sf])"/.exec(mei);
  const fifths = fifthsMatch ? Number(fifthsMatch[1]) * (fifthsMatch[2] === "s" ? 1 : -1) : 0;

  // Мелодия: верхняя нота правой руки на каждом моменте.
  const byStart = new Map<number, { pitch: number; len: number }>();
  for (const n of score.notes.filter((x) => x.hand === "right")) {
    const s = q(n.startMs);
    const len = Math.max(1, Math.round(n.durMs / ms16));
    const cur = byStart.get(s);
    if (!cur || n.pitch > cur.pitch) byStart.set(s, { pitch: n.pitch, len });
  }
  const melody = [...byStart].sort((a, b) => a[0] - b[0]).map(([start, v]) => ({ pitch: v.pitch, start, len: v.len }));

  // Аккорды: из файла или распознанные.
  const total = q(score.endMs);
  const bars = Math.max(1, Math.ceil((total - pickup) / bl));
  const perBar: string[] = [];
  const harms = harmsFromMei(mei);
  const beatsInBar = bl / ((unit === 8 && beats % 3 === 0 ? 6 : 16 / unit) || 4);
  if (harms.length) {
    // Номер такта MEI: при затакте первый такт MEI — затакт.
    for (let k = 0; k < bars; k++) {
      const mi = k + 1 + (pickup ? 1 : 0);
      const list = harms.filter((h) => h.measure === mi).sort((a, b) => a.tstamp - b.tstamp);
      perBar.push(list.length ? beatTokens(list.map((h) => ({ beat: Math.floor(h.tstamp - 1), symbol: h.chord.symbol })), Math.round(beatsInBar)) : "-");
    }
  } else {
    for (let k = 0; k < bars; k++) {
      const b = pickup + k * bl;
      const sliceChord = (from: number, to: number) => {
        const notes = score.notes
          .map((n) => ({ pitch: n.pitch, s: q(n.startMs), e: q(n.startMs + n.durMs) }))
          .filter((n) => n.s < to && n.e > from)
          .map((n) => ({ pitch: n.pitch, durMs: (Math.min(n.e, to) - Math.max(n.s, from)) * ms16 }));
        return detectChordFit(notes, fifths);
      };
      const whole = sliceChord(b, b + bl);
      let tok = whole?.chord.symbol ?? "-";
      // Половины такта — только если целый такт ложится на один аккорд плохо.
      if ((bl >= 16 || (bl === 12 && unit === 8)) && (!whole || whole.fit < 0.8)) {
        const h1 = sliceChord(b, b + bl / 2);
        const h2 = sliceChord(b + bl / 2, b + bl);
        if (h1 && h2 && h1.chord.symbol !== h2.chord.symbol && h1.fit >= 0.8 && h2.fit >= 0.8) tok = `${h1.chord.symbol} ${h2.chord.symbol}`;
      }
      // Тот же аккорд, что в прошлом такте, — всё равно пишем (так читать проще).
      perBar.push(tok);
    }
  }
  return { id, title, bpm, beats, unit, fifths, pickup, melody, chords: perBar.join(" | "), style: "block", source: title };
}

/** Аккорды такта по долям → текст: «C G» при равных частях, иначе по долям с «-». */
function beatTokens(list: { beat: number; symbol: string }[], beats: number): string {
  const slots: string[] = new Array(beats).fill("-");
  for (const x of list) if (x.beat >= 0 && x.beat < beats) slots[x.beat] = x.symbol;
  const changes = slots.map((s, i) => (s !== "-" ? i : -1)).filter((i) => i >= 0);
  if (!changes.length) return "-";
  const n = changes.length;
  const equal = beats % n === 0 && changes.every((c, i) => c === (i * beats) / n);
  return equal ? changes.map((c) => slots[c]).join(" ") : slots.join(" ");
}

// --- Встроенные песни ---

interface BuiltinDef {
  id: string;
  title: string;
  bpm: number;
  beats: number;
  pickup?: number;
  melody: string;
  chords: string;
  style: Style;
}

const BUILTIN_DEFS: BuiltinDef[] = [
  {
    id: "ode",
    title: "Ода к радости (Бетховен)",
    bpm: 100,
    beats: 4,
    melody:
      "e4q e4q f4q g4q | g4q f4q e4q d4q | c4q c4q d4q e4q | e4q. d4e d4h | e4q e4q f4q g4q | g4q f4q e4q d4q | c4q c4q d4q e4q | d4q. c4e c4h",
    chords: "C | G | C | G | C | G | C | G C",
    style: "block",
  },
  {
    id: "twinkle",
    title: "Ах, скажу я вам, мама (Моцарт, тема)",
    bpm: 96,
    beats: 4,
    melody:
      "c4q c4q g4q g4q | a4q a4q g4h | f4q f4q e4q e4q | d4q d4q c4h | g4q g4q f4q f4q | e4q e4q d4h | g4q g4q f4q f4q | e4q e4q d4h | c4q c4q g4q g4q | a4q a4q g4h | f4q f4q e4q e4q | d4q d4q c4h",
    chords: "C | F C | F C | G C | C F | C G | C F | C G | C | F C | F C | G C",
    style: "oompah",
  },
  {
    id: "mary",
    title: "У Мэри был барашек",
    bpm: 100,
    beats: 4,
    melody: "e4q d4q c4q d4q | e4q e4q e4h | d4q d4q d4h | e4q g4q g4h | e4q d4q c4q d4q | e4q e4q e4q e4q | d4q d4q e4q d4q | c4w",
    chords: "C | C | G | C | C | C | G | C",
    style: "block",
  },
  {
    id: "jacques",
    title: "Братец Яков",
    bpm: 100,
    beats: 4,
    melody:
      "c4q d4q e4q c4q | c4q d4q e4q c4q | e4q f4q g4h | e4q f4q g4h | g4e a4e g4e f4e e4q c4q | g4e a4e g4e f4e e4q c4q | c4q g3q c4h | c4q g3q c4h",
    chords: "C | C | C | C | C | C | C G C | C G C",
    style: "alberti",
  },
  {
    id: "jingle",
    title: "Бубенчики (Jingle Bells, припев)",
    bpm: 120,
    beats: 4,
    melody:
      "e4q e4q e4h | e4q e4q e4h | e4q g4q c4q. d4e | e4w | f4q f4q f4q. f4e | f4q e4q e4q e4e e4e | e4q d4q d4q e4q | d4h g4h | e4q e4q e4h | e4q e4q e4h | e4q g4q c4q. d4e | e4w | f4q f4q f4q f4q | f4q e4q e4q e4e e4e | g4q g4q f4q d4q | c4w",
    chords: "C | C | C | C | F | C | D7 | G7 | C | C | C | C | F | C | G7 | C",
    style: "oompah",
  },
  {
    id: "lune",
    title: "При лунном свете (Au clair de la lune)",
    bpm: 96,
    beats: 4,
    melody:
      "c4q c4q c4q d4q | e4h d4h | c4q e4q d4q d4q | c4w | c4q c4q c4q d4q | e4h d4h | c4q e4q d4q d4q | c4w | d4q d4q d4q d4q | a3h a3h | d4q c4q b3q a3q | g3w | c4q c4q c4q d4q | e4h d4h | c4q e4q d4q d4q | c4w",
    chords: "C | C G | C G | C | C | C G | C G | C | G | D7 | G D7 | G | C | C G | C G | C",
    style: "block",
  },
  {
    id: "birthday",
    title: "С днём рождения",
    bpm: 90,
    beats: 3,
    pickup: 4,
    melody: "g4e. g4s | a4q g4q c5q | b4h g4e. g4s | a4q g4q d5q | c5h g4e. g4s | g5q e5q c5q | b4q a4q f5e. f5s | e5q c5q d5q | c5h.",
    chords: "C | G7 | G7 | C | C7 | F | C G7 | C",
    style: "oompah",
  },
];

export const BUILTIN_SONGS: LeadSong[] = BUILTIN_DEFS.map((d) => {
  const m = parseMelody(d.melody);
  return {
    id: `builtin-${d.id}`,
    title: d.title,
    bpm: d.bpm,
    beats: d.beats,
    unit: 4,
    fifths: 0,
    pickup: d.pickup ?? 0,
    melody: m.notes,
    chords: d.chords,
    style: d.style,
    builtin: true,
  };
});

/** Песня по буквам как источник для экрана игры: id включает фактуру (у разных фактур — свой прогресс). */
export function songSourceId(song: LeadSong, style: Style): string {
  return `song:${song.id}:${style}`;
}

/** Пустая своя песня. */
export function newSong(id: string): LeadSong {
  return { id, title: "Моя песня", bpm: 90, beats: 4, unit: 4, fifths: 0, pickup: 0, melody: [], chords: "C | Am | F | G", style: "block" };
}
