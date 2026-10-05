// Текстовые табы (как на Ultimate Guitar, ClassTab):
//
//   e|-----0---3-|          строки — струны (сверху тонкая), «|» — тактовые черты,
//   B|---1-------|          цифры — лады, x — глушёная, h/p — хаммер и пулл-офф,
//   G|-2---------|          / \ — слайды, b — бенд (цифра после — куда тянуть), ~ — вибрато.
//
// Ритма в таких табах нет: длительность берётся по расстоянию между цифрами внутри такта
// (такт — между чертами, размер по умолчанию 4/4) или ровно восьмыми/шестнадцатыми.
// Строй — по буквам слева (D|… — Drop D), темп, размер и каподастр — из строк вида
// «Темп: 100», «Tempo 100», «Размер: 3/4», «Capo 2».

import { TUNINGS } from "./guitar";
import { TPQ, type TabSong, type TsBeat, type TsMasterBar, type TsNote } from "./tabsong";

export type TabRhythm = "spacing" | 4 | 8 | 16;

export interface TextTabOptions {
  title?: string;
  /** Переопределить то, что написано в тексте. */
  tempo?: number;
  meter?: [number, number];
  rhythm?: TabRhythm;
}

export interface TextTab {
  song: TabSong;
  strings: number;
  bars: number;
  notes: number;
  tempo: number;
  meter: [number, number];
  rhythm: TabRhythm;
  capo: number;
}

const PC: Record<string, number> = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };
const TAB_LINE = /^\s*([A-Ga-g][#b♯♭]?)?\s*[|:]?\s*([-|0-9xXhpbr/\\~()<>.*=sStT^ ]*)$/;

/** Строка таба: метка струны (если есть) и содержимое после первой черты. */
function tabLine(line: string): { label: string; body: string } | null {
  const m = TAB_LINE.exec(line.replace(/\s+$/, ""));
  if (!m) return null;
  const body = m[2];
  if ((body.match(/-/g) ?? []).length < 4) return null;
  // Должно быть хоть немного «таба»: черта в начале строки или метка струны.
  if (!m[1] && !/^\s*[|:]/.test(line)) return null;
  return { label: m[1] ?? "", body };
}

/** Параметры из текста: темп, размер, каподастр, ритм. */
export function textTabHeader(text: string): { tempo?: number; meter?: [number, number]; capo?: number; rhythm?: TabRhythm } {
  const out: { tempo?: number; meter?: [number, number]; capo?: number; rhythm?: TabRhythm } = {};
  for (const line of text.split(/\r?\n/)) {
    if (tabLine(line)) continue;
    const t = /(?:темп|tempo|bpm)\s*[:=]?\s*(\d{2,3})/i.exec(line);
    if (t) out.tempo = Number(t[1]);
    const m = /(?:размер|time(?: signature)?)\s*[:=]?\s*(\d{1,2})\s*\/\s*(\d{1,2})/i.exec(line);
    if (m) out.meter = [Number(m[1]), Number(m[2])];
    const c = /(?:capo|каподастр)\s*[:=]?\s*(\d{1,2})/i.exec(line);
    if (c) out.capo = Number(c[1]);
    const r = /ритм\s*[:=]?\s*(по расстоянию|четвертями|восьмыми|шестнадцатыми)/i.exec(line);
    if (r) out.rhythm = ({ "по расстоянию": "spacing", четвертями: 4, восьмыми: 8, шестнадцатыми: 16 } as const)[r[1].toLowerCase() as "по расстоянию"];
  }
  return out;
}

/** Строка заголовка для сохранённого таба. */
export function textTabHeaderLine(o: { tempo: number; meter: [number, number]; rhythm: TabRhythm }): string {
  const r = o.rhythm === "spacing" ? "по расстоянию" : o.rhythm === 4 ? "четвертями" : o.rhythm === 8 ? "восьмыми" : "шестнадцатыми";
  return `Темп: ${o.tempo} · Размер: ${o.meter[0]}/${o.meter[1]} · Ритм: ${r}`;
}

/** Системы — подряд идущие строки таба одной длины (4–7 струн). */
function systems(text: string): { label: string; body: string }[][] {
  const out: { label: string; body: string }[][] = [];
  let cur: { label: string; body: string }[] = [];
  const flush = () => {
    if (cur.length >= 4 && cur.length <= 7) out.push(cur);
    cur = [];
  };
  for (const line of text.split(/\r?\n/)) {
    const t = tabLine(line);
    if (t) cur.push(t);
    else flush();
  }
  flush();
  return out;
}

/** Строй по меткам струн (сверху вниз — от тонкой), иначе стандартный. */
function tuningOf(labels: string[], strings: number): number[] {
  const std = strings <= 5 ? (strings === 5 ? [23, ...TUNINGS.bass] : TUNINGS.bass) : strings === 7 ? [35, ...TUNINGS.guitar] : TUNINGS.guitar;
  const low = [...labels].reverse();
  return std.map((d, i) => {
    const l = low[i];
    if (!l) return d;
    let pc = PC[l[0].toLowerCase()];
    if (/[#♯]/.test(l)) pc += 1;
    if (/[b♭]/.test(l.slice(1))) pc -= 1;
    // Ближайшая к стандартной октава.
    let best = d;
    for (let m = d - 6; m <= d + 6; m++) if (((m % 12) + 12) % 12 === ((pc % 12) + 12) % 12) best = m;
    return best;
  });
}

interface Onset {
  col: number;
  notes: TsNote[];
}

/** Ноты одной строки-струны в отрезке такта. */
function scanString(body: string, from: number, to: number, string: number, open: number, capo: number, into: Map<number, Onset>) {
  let prev: TsNote | null = null;
  for (let c = from; c < to; c++) {
    const ch = body[c] ?? "-";
    if (/\d/.test(ch)) {
      // Двузначный лад — если он не больше 24.
      let fret = Number(ch);
      if (/\d/.test(body[c + 1] ?? "") && Number(ch + body[c + 1]) <= 24) {
        fret = Number(ch + body[c + 1]);
      }
      const width = fret >= 10 ? 2 : 1;
      const before = body[c - 1];
      // Цель бенда или отпускания — не новая нота.
      if ((before === "b" || before === "r") && prev) {
        const semis = fret - (prev.fret ?? 0);
        prev.techniques = [...(prev.techniques ?? []), before === "b" ? (semis >= 4 ? "B2" : semis >= 3 ? "B1½" : semis >= 2 ? "B1" : "B½") : "R"];
        c += width - 1;
        continue;
      }
      const note: TsNote = { pitch: open + capo + fret, string, fret };
      if (prev && (before === "h" || before === "p")) prev.techniques = [...(prev.techniques ?? []), fret > (prev.fret ?? 0) ? "H" : "P"];
      if (prev && (before === "/" || before === "\\")) prev.techniques = [...(prev.techniques ?? []), fret > (prev.fret ?? 0) ? "↗" : "↘"];
      const o = into.get(c) ?? { col: c, notes: [] };
      o.notes.push(note);
      into.set(c, o);
      prev = note;
      c += width - 1;
    } else if (ch === "x" || ch === "X") {
      const o = into.get(c) ?? { col: c, notes: [] };
      o.notes.push({ pitch: open + capo, string, fret: 0, dead: true });
      into.set(c, o);
      prev = null;
    } else if (ch === "~" && prev) {
      if (!prev.techniques?.includes("~")) prev.techniques = [...(prev.techniques ?? []), "~"];
    }
  }
}

/** Записываемая длительность не длиннее `ticks`: тип и точки. */
function writable(ticks: number): { ticks: number; type: number; dots: number } {
  const opts: { ticks: number; type: number; dots: number }[] = [];
  for (const type of [1, 2, 4, 8, 16, 32]) {
    const base = (TPQ * 4) / type;
    opts.push({ ticks: base * 1.5, type, dots: 1 }, { ticks: base, type, dots: 0 });
  }
  return opts.find((o) => o.ticks <= ticks + 1) ?? { ticks: TPQ / 8, type: 32, dots: 0 };
}

/** Разобрать текстовый таб. */
export function parseTextTab(text: string, opts: TextTabOptions = {}): TextTab {
  const head = textTabHeader(text);
  const tempo = Math.max(30, Math.min(300, opts.tempo ?? head.tempo ?? 90));
  const meter: [number, number] = opts.meter ?? head.meter ?? [4, 4];
  const rhythm: TabRhythm = opts.rhythm ?? head.rhythm ?? "spacing";
  const capo = head.capo ?? 0;
  const sys = systems(text);
  if (!sys.length) throw new Error("не нашёл строк таба (вида «e|---0---3---|»)");
  // Число струн — как в большинстве систем.
  const counts = new Map<number, number>();
  for (const s of sys) counts.set(s.length, (counts.get(s.length) ?? 0) + 1);
  const strings = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0][0];
  const used = sys.filter((s) => s.length === strings);
  const tuning = tuningOf(used[0].map((l) => l.label), strings);
  const barTicks = (meter[0] * TPQ * 4) / meter[1];

  // Такты: отрезки между чертами, общими для всех строк системы.
  const rawBars: Onset[][] = [];
  const widths: number[] = [];
  for (const s of used) {
    const width = Math.max(...s.map((l) => l.body.length));
    const bodies = s.map((l) => l.body.padEnd(width, "-"));
    const bars: number[] = [];
    for (let c = 0; c < width; c++) if (bodies.filter((b) => b[c] === "|").length > strings / 2) bars.push(c);
    const cuts = [-1, ...bars, width];
    for (let k = 0; k < cuts.length - 1; k++) {
      const from = cuts[k] + 1;
      const to = cuts[k + 1];
      if (to - from < 2) continue;
      const onsets = new Map<number, Onset>();
      bodies.forEach((b, line) => {
        const string = strings - 1 - line;
        scanString(b, from, to, string, tuning[string], capo, onsets);
      });
      rawBars.push([...onsets.values()].sort((a, b) => a.col - b.col).map((o) => ({ ...o, col: o.col - from })));
      widths.push(to - from);
    }
  }
  // Пустые такты в конце (хвосты строк) — не нужны.
  while (rawBars.length > 1 && !rawBars[rawBars.length - 1].length) {
    rawBars.pop();
    widths.pop();
  }

  // Ритм.
  const barsBeats: TsBeat[][] = [];
  if (rhythm === "spacing") {
    rawBars.forEach((ons, k) => {
      const grid = 16 * (meter[0] / meter[1]);
      const cell = barTicks / grid;
      const used = new Set<number>();
      // Отступ перед первой нотой (обычно «-» после черты) — если он меньше клетки, это сильная доля.
      const lead = ons.length && ons[0].col < widths[k] / grid + 1 ? ons[0].col : 0;
      const span = Math.max(1, widths[k] - lead);
      const cells = ons.map((o) => {
        let c = Math.min(grid - 1, Math.max(0, Math.round(((o.col - lead) / span) * grid)));
        while (used.has(c) && c < grid - 1) c++;
        used.add(c);
        return c;
      });
      barsBeats.push(beatsFrom(ons, cells.map((c) => c * cell), barTicks));
    });
  } else {
    // Ровно: ноты подряд одной длительности, такты — по размеру.
    const step = (TPQ * 4) / rhythm;
    const all = rawBars.flat();
    const perBar = Math.max(1, Math.round(barTicks / step));
    for (let i = 0; i < Math.max(1, all.length); i += perBar) {
      const chunk = all.slice(i, i + perBar);
      barsBeats.push(beatsFrom(chunk, chunk.map((_, j) => j * step), barTicks, step));
    }
  }

  const masters: TsMasterBar[] = barsBeats.map(() => ({ num: meter[0], den: meter[1], ticks: barTicks, key: 0 }));
  const song: TabSong = {
    title: opts.title ?? "",
    artist: "",
    album: "",
    tempo,
    masters,
    order: masters.map((_, i) => ({ master: i, tempos: [], pass: 0 })),
    parts: [
      {
        id: "tab",
        name: "",
        kind: strings <= 5 ? "bass" : "guitar",
        program: strings <= 5 ? 33 : 25,
        tuning,
        capo,
        staves: [{ tab: true, clef: "G8", bars: barsBeats.map((b) => [b]) }],
      },
    ],
  };
  const notes = barsBeats.flat().reduce((n, b) => n + b.notes.filter((x) => !x.dead).length, 0);
  return { song, strings, bars: barsBeats.length, notes, tempo, meter, rhythm, capo };
}

function beatsFrom(ons: Onset[], ticks: number[], barTicks: number, step?: number): TsBeat[] {
  return ons.map((o, i) => {
    const next = step ? ticks[i] + step : (ticks[i + 1] ?? barTicks);
    const w = writable(Math.max(TPQ / 8, next - ticks[i]));
    return { tick: ticks[i], dur: w.ticks, type: w.type, dots: w.dots, notes: o.notes };
  });
}
