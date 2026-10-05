// Басовая линия к песне по буквам: по аккордам песни строится партия баса табами (стили — от
// основных тонов до walking bass), барабаны под размер и аккорды (фортепиано или гитара) для
// аккомпанемента с отдельной громкостью.

import type { AccompNote } from "../api";
import { bassPc, chordPcs, type Chord } from "./chords";
import { patternPart } from "./drumPattern";
import { barLen, beatLen, parseChart, type LeadSong } from "./songs";
import { patternsFor } from "./strum";
import { assignPositions } from "./tab";
import { TPQ, partChannel, songAccompaniment, writtenDuration, type TabSong, type TsBeat, type TsPart } from "./tabsong";

export type BassStyle = "roots" | "rootfifth" | "octaves" | "passing" | "walking";

export const BASS_STYLES: { id: BassStyle; name: string; hint: string }[] = [
  { id: "roots", name: "Основной тон", hint: "На каждую долю — основной тон аккорда (буква над нотами; у «C/E» — нижняя нота E)." },
  { id: "rootfifth", name: "Тон — квинта", hint: "Основной тон и квинта по очереди: квинта — на соседней струне на два лада выше." },
  { id: "octaves", name: "Октавы", hint: "Восьмые: основной тон и октава над ним — через струну на два лада выше." },
  { id: "passing", name: "Проходящие", hint: "Основной тон, звуки аккорда, а перед сменой — проходящая нота на полтона к следующему аккорду." },
  { id: "walking", name: "Walking bass", hint: "Четверти без остановки: от основного тона по звукам аккорда к проходящей перед следующим." },
];

export const BASS_STYLE_BY_ID = new Map(BASS_STYLES.map((s) => [s.id, s]));

/** Что звучит вместе с басом. Громкость 0–100 (70 — обычная). */
export interface BassAccomp {
  chords: "piano" | "guitar" | "none";
  drums: boolean;
  chordsVolume: number;
  drumsVolume: number;
}

export const DEFAULT_BASS_ACCOMP: BassAccomp = { chords: "piano", drums: true, chordsVolume: 60, drumsVolume: 80 };

/** Отрезок с одним аккордом: начало и длина в шестнадцатых от начала первого такта, счётных долей. */
interface Segment {
  bar: number;
  start: number;
  pulses: number;
  chord: Chord;
}

/** Нота линии: начало и длина в шестнадцатых от начала первого такта. */
interface LineNote {
  start: number;
  len: number;
  pitch: number;
  bar: number;
  chord?: string;
}

/** Отрезки песни по счётным долям (затакт пропускается, аккорд держится до следующего). */
function segments(song: LeadSong): Segment[] {
  const chart = parseChart(song.chords, song);
  const bl = barLen(song);
  const pulse = beatLen(song);
  const perBar = Math.max(1, Math.round(bl / pulse));
  const out: Segment[] = [];
  let current: Chord | null = chart.chords[0]?.chord ?? null;
  for (let b = 0; b < chart.bars; b++) {
    for (let k = 0; k < perBar; k++) {
      const t = song.pickup + b * bl + k * pulse;
      for (const c of chart.chords) if (c.start <= t + 1e-6) current = c.chord;
      if (!current) continue;
      const last = out[out.length - 1];
      // Новый отрезок — со сменой аккорда или с началом такта.
      if (last && last.bar === b && last.chord.symbol === current.symbol) last.pulses++;
      else out.push({ bar: b, start: b * bl + k * pulse, pulses: 1, chord: current });
    }
  }
  return out;
}

/** Высота основного тона: ближе к предыдущему, в нижней октаве баса (от `low` до `low + 12`). */
function rootPitch(pc: number, low: number, prev: number | null): number {
  const base = low + ((((pc - low) % 12) + 12) % 12);
  const options = [base, base + 12].filter((p) => p <= low + 14);
  if (prev === null) return options[0];
  return options.reduce((a, b) => (Math.abs(b - prev) < Math.abs(a - prev) ? b : a));
}

/** Звуки аккорда над основным тоном (в полутонах): терция, квинта, септима, октава. */
function tones(c: Chord): number[] {
  const pcs = chordPcs(c);
  const root = pcs[0];
  const steps = pcs.map((p) => (((p - root) % 12) + 12) % 12).filter((s) => s > 0);
  return [...new Set([...steps, 12])].sort((a, b) => a - b);
}

/** Линия по стилю: ноты отрезков. `low` — самая низкая нота баса (открытая нижняя струна). */
export function bassLine(song: LeadSong, style: BassStyle, low = 28): LineNote[] {
  const segs = segments(song);
  const pulse = beatLen(song);
  const roots: number[] = [];
  let prev: number | null = null;
  for (const s of segs) {
    const r = rootPitch(bassPc(s.chord), low, prev);
    roots.push(r);
    prev = r;
  }
  const out: LineNote[] = [];
  // Тот же аккорд подряд: walking идёт то вверх к октаве, то вниз от неё.
  let same = 0;
  segs.forEach((s, i) => {
    same = i > 0 && segs[i - 1].chord.symbol === s.chord.symbol ? same + 1 : 0;
    const r = roots[i];
    const t = tones(s.chord);
    const fifth = t.includes(7) ? r + 7 : r + (t.find((x) => x >= 6 && x <= 8) ?? 7);
    const next = segs[i + 1];
    const changes = !!next && next.chord.symbol !== s.chord.symbol;
    const nextRoot = next ? roots[i + 1] : r;
    // Проходящая: на полтона к следующему основному тону (снизу, если он выше, иначе сверху).
    const approach = nextRoot > r || nextRoot - 1 < low ? nextRoot - 1 : nextRoot + 1;
    const approachOk = approach >= low;
    const pitches: number[] = [];
    const n = s.pulses;
    switch (style) {
      case "roots":
        for (let k = 0; k < n; k++) pitches.push(r);
        break;
      case "rootfifth":
        for (let k = 0; k < n; k++) pitches.push(k % 2 ? fifth : r);
        break;
      case "octaves": {
        // Восьмые: низ — верх по очереди, на всю длину отрезка.
        const eighths = (n * pulse) / 2;
        for (let k = 0; k < eighths; k++) out.push({ start: s.start + k * 2, len: 2, pitch: k % 2 ? r + 12 : r, bar: s.bar, chord: k === 0 ? s.chord.symbol : undefined });
        return;
      }
      case "passing": {
        const third = r + (t.find((x) => x === 3 || x === 4) ?? 7);
        const middle = [fifth, third, r + 12];
        for (let k = 0; k < n; k++) {
          if (k === 0) pitches.push(r);
          else if (k === n - 1 && changes && approachOk) pitches.push(approach);
          else pitches.push(middle[(k - 1) % middle.length]);
        }
        break;
      }
      case "walking": {
        // От основного тона к проходящей перед следующим аккордом по звукам аккорда.
        const target = changes && approachOk ? approach : same % 2 ? r - 5 >= low ? r - 5 : r + 7 : r + 12;
        const chordNotes = [0, ...t].map((x) => r + x).concat(t.map((x) => r - 12 + x)).filter((p) => p >= low);
        for (let k = 0; k < n; k++) {
          if (k === 0) pitches.push(r);
          else if (k === n - 1 && changes && approachOk) pitches.push(approach);
          else {
            const want = r + ((target - r) * k) / Math.max(1, n - 1);
            const last = pitches[pitches.length - 1];
            const pick = chordNotes.filter((p) => p !== last).reduce((a, b) => (Math.abs(b - want) < Math.abs(a - want) ? b : a));
            pitches.push(pick);
          }
        }
        break;
      }
    }
    pitches.forEach((p, k) => out.push({ start: s.start + k * pulse, len: pulse, pitch: p, bar: s.bar, chord: k === 0 ? s.chord.symbol : undefined }));
  });
  return out;
}

/** Аккорд для аккомпанемента: звуки в средней октаве (от соль малой). */
function voicing(c: Chord): number[] {
  return chordPcs(c)
    .map((pc) => 55 + ((((pc - 55) % 12) + 12) % 12))
    .sort((a, b) => a - b);
}

/** Песня баса: партия баса табами (+ барабаны и аккорды для аккомпанемента). */
export function bassLineSong(song: LeadSong, style: BassStyle, tuning: number[], accomp: BassAccomp = DEFAULT_BASS_ACCOMP): TabSong {
  const sixteenth = TPQ / 4;
  const bl = barLen(song);
  const barTicks = bl * sixteenth;
  const chart = parseChart(song.chords, song);
  const line = bassLine(song, style, tuning[0]);
  const positions = assignPositions(line.map((n) => ({ pitches: [n.pitch] })), tuning, 15);
  const bars: TsBeat[][] = Array.from({ length: chart.bars }, () => []);
  line.forEach((n, i) => {
    const pos = positions[i]?.[0];
    if (!pos) return;
    const w = writtenDuration(n.len * sixteenth) ?? { type: 16, dots: 0 };
    const len = writtenDuration(n.len * sixteenth) ? n.len : 1;
    bars[n.bar].push({
      tick: (n.start - n.bar * bl) * sixteenth,
      dur: len * sixteenth,
      type: w.type,
      dots: w.dots,
      notes: [{ pitch: n.pitch, string: pos.string, fret: pos.fret }],
      chord: n.chord,
    });
  });
  const masters = bars.map(() => ({ num: song.beats, den: song.unit, ticks: barTicks, key: song.fifths }));
  const parts: TsPart[] = [
    { id: "bass", name: song.title, kind: "bass", program: 33, tuning, capo: 0, staves: [{ tab: true, clef: "F8", bars: bars.map((b) => [b]) }] },
  ];
  if (accomp.drums) {
    const pattern = patternsFor(song)[0];
    if (pattern) parts.push(patternPart([pattern.drums], masters.length, Math.round(barTicks / sixteenth)));
  }
  if (accomp.chords !== "none") {
    const segs = segments(song);
    const chordBars: TsBeat[][] = bars.map(() => []);
    for (const s of segs) {
      const len = s.pulses * beatLen(song);
      const w = writtenDuration(len * sixteenth);
      const pitches = voicing(s.chord);
      // Длинный отрезок, который не записать одной нотой, — по долям.
      const pieces = w ? [{ start: s.start, len }] : Array.from({ length: s.pulses }, (_, k) => ({ start: s.start + k * beatLen(song), len: beatLen(song) }));
      for (const p of pieces) {
        const pw = writtenDuration(p.len * sixteenth) ?? { type: 4, dots: 0 };
        chordBars[s.bar].push({ tick: (p.start - s.bar * bl) * sixteenth, dur: p.len * sixteenth, type: pw.type, dots: pw.dots, notes: pitches.map((pitch) => ({ pitch })) });
      }
    }
    parts.push({
      id: "chords",
      name: accomp.chords === "piano" ? "Фортепиано" : "Гитара",
      kind: accomp.chords === "piano" ? "piano" : "other",
      program: accomp.chords === "piano" ? 0 : 25,
      capo: 0,
      staves: [{ tab: false, clef: "G", bars: chordBars.map((b) => [b]) }],
    });
  }
  return { title: song.title, artist: "", album: "", tempo: song.bpm, masters, order: masters.map((_, i) => ({ master: i, tempos: [], pass: 0 })), parts };
}

/** Аккомпанемент к басу с громкостью партий: барабаны и аккорды отдельно. */
export function bassAccompaniment(ts: TabSong, accomp: BassAccomp): AccompNote[] {
  const drumsCh = ts.parts.findIndex((p) => p.kind === "drums");
  const drumChannel = drumsCh >= 0 ? partChannel(ts, drumsCh) : 9;
  const vel = (v: number) => Math.max(1, Math.min(127, Math.round((v / 100) * 127)));
  return songAccompaniment(ts, 0).map((n) => ({ ...n, velocity: vel(n.channel === drumChannel ? accomp.drumsVolume : accomp.chordsVolume) }));
}

/** Доли такта в четвертях (для оценки грува): 4/4 — 4, 6/8 — 3. */
export const quarterBeats = (song: Pick<LeadSong, "beats" | "unit">) => (barLen(song) * (TPQ / 4)) / TPQ;
