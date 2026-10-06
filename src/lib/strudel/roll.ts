// Нотная лента под редактором: раскладка нот и ударных кода в окне циклов вокруг «сейчас».

import type { CodeNote } from "./haps";

export const PART_COLORS = ["#5AA9FF", "#FFB454", "#4CC38A", "#C792EA", "#FF7A90", "#7FDBCA", "#F2C94C", "#9AA0AB"];

export interface RollBox {
  /** Доли ширины и высоты холста (0..1), y — сверху. */
  x: number;
  w: number;
  y: number;
  h: number;
  color: string;
  /** Моя партия — контуром. */
  you: boolean;
}

export interface RollLayout {
  from: number;
  to: number;
  boxes: RollBox[];
  /** Строки ударных снизу вверх: имя звука и середина строки (доля высоты). */
  drumRows: { name: string; y: number }[];
  /** Высоты нот: нижняя и верхняя границы окна. */
  low: number;
  high: number;
  /** Доля высоты под ноты (сверху); ниже — ударные. */
  split: number;
}

/** Порядок строк ударных снизу вверх — как на установке: бочка, малый, хэты, томы, тарелки. */
const DRUM_ORDER = ["bd", "sd", "rim", "cp", "hh", "oh", "lt", "mt", "ht", "cr", "rd", "cb", "sh", "tb", "perc", "misc"];

const drumName = (n: CodeNote) => {
  const s = (n.s ?? "").replace(/^.*_/, "").replace(/:.*/, "");
  return s || "drum";
};

/** Цвет партии: по порядку партий кода; без имени — серый. */
export function partColor(part: string | null, parts: string[]): string {
  const i = part ? parts.indexOf(part) : -1;
  return i < 0 ? PART_COLORS[PART_COLORS.length - 1] : PART_COLORS[i % (PART_COLORS.length - 1)];
}

/** Раскладка нот окна [now − span/2, now + span/2]; высоты — по нотам окна (не уже октавы). */
export function rollLayout(notes: CodeNote[], now: number, parts: string[], span = 2): RollLayout {
  const from = now - span / 2;
  const to = now + span / 2;
  const inWin = notes.filter((n) => n.begin < to && n.begin + n.dur > from);
  const pitched = inWin.filter((n) => !n.drum && n.midi !== null);
  const drums = inWin.filter((n) => n.drum);
  const names = [...new Set(drums.map(drumName))].sort((a, b) => {
    const ia = DRUM_ORDER.indexOf(a);
    const ib = DRUM_ORDER.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.localeCompare(b);
  });
  let low = Math.min(...pitched.map((n) => n.midi!), 60) - 1;
  let high = Math.max(...pitched.map((n) => n.midi!), 60) + 1;
  if (!pitched.length) [low, high] = [54, 66];
  if (high - low < 12) {
    const add = 12 - (high - low);
    low -= Math.floor(add / 2);
    high += Math.ceil(add / 2);
  }
  // Ударным — до трети высоты (строка не больше 1/12), остальное — нотам.
  const drumH = names.length ? Math.min(1 / 3, names.length / 12) : 0;
  const split = pitched.length ? 1 - drumH : names.length ? 0 : 1;
  const rowH = names.length ? (1 - split) / names.length : 0;
  const keyH = split / (high - low + 1);
  const x = (b: number) => (b - from) / span;
  const boxes: RollBox[] = [];
  for (const n of pitched) {
    boxes.push({
      x: x(n.begin),
      w: Math.max(n.dur / span, 0.004),
      y: (high - n.midi!) * keyH,
      h: keyH,
      color: partColor(n.part, parts),
      you: n.you,
    });
  }
  for (const n of drums) {
    const row = names.indexOf(drumName(n));
    boxes.push({
      x: x(n.begin),
      w: Math.min(Math.max(n.dur / span, 0.004), 0.02),
      y: 1 - (row + 1) * rowH,
      h: rowH,
      color: partColor(n.part, parts),
      you: n.you,
    });
  }
  const drumRows = names.map((name, row) => ({ name, y: 1 - (row + 0.5) * rowH }));
  return { from, to, boxes, drumRows, low, high, split };
}

/** Точка моего нажатия: место на ленте (доли) или null, если вне окна. */
export function playedPoint(begin: number, midi: number, l: RollLayout): { x: number; y: number } | null {
  if (begin < l.from || begin > l.to || l.split === 0) return null;
  const keyH = l.split / (l.high - l.low + 1);
  const m = Math.min(l.high, Math.max(l.low, midi));
  return { x: (begin - l.from) / (l.to - l.from), y: (l.high - m + 0.5) * keyH };
}
