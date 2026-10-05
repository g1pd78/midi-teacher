// Экран пьесы: раскладка нот, рамки тактов, мелкие помощники.

import type { PieceInstrument, PieceNoteIn, PieceSetup, PlayHands, UnitView } from "../../api";
import type { MeiStructure, ScoreNote } from "../../lib/score";

export const NO_SETUP: PieceSetup = { transpose: 0, roles: null, handOverrides: [], instrument: null, part: 0 };
export const INSTRUMENT_NAME: Record<PieceInstrument, string> = { piano: "Фортепиано", guitar: "Гитара", bass: "Бас", drums: "Барабаны" };
export const TRANSPOSE_MAX = 12;

export const HAND_COLOR = { right: "#5AA9FF", left: "#FFB454" } as const;
/** Видимая высота падающих нот в секундах реального времени. */
export const WATERFALL_SEC = 3;
export const TEMPO_MIN = 0.3;
export const TEMPO_MAX = 1.2;

export const SOLFEGE: Record<string, string> = { c: "до", d: "ре", e: "ми", f: "фа", g: "соль", a: "ля", b: "си" };
export const ACCID: Record<string, string> = { s: "♯", f: "♭", ss: "𝄪", ff: "𝄫" };
export const HAND_NAME: Record<PlayHands, string> = { right: "правая рука", left: "левая рука", both: "обе руки", none: "слушаем" };

export function verovioLayout(layout: "line" | "pages", width: number, tab = false, tabWithStaff = false): Record<string, unknown> {
  const common = {
    // Ноты над табом — станы ближе друг к другу, чтобы строка не мельчала.
    ...(tabWithStaff ? { spacingStaff: 2 } : {}),
    // Цифры ладов в табулатуре мелкие — таб крупнее нот.
    scale: tab ? 58 : 42,
    header: "none",
    footer: "none",
    svgViewBox: true,
    svgRemoveXlink: true,
    adjustPageHeight: true,
    pageMarginTop: tab ? 15 : 60,
    pageMarginBottom: tab ? 15 : 60,
    pageMarginLeft: 40,
    pageMarginRight: 40,
    lyricSize: 2.5,
  };
  return layout === "line"
    ? { ...common, breaks: "none", pageWidth: 60000, pageHeight: 60000, adjustPageWidth: true }
    : // Ширина страницы в единицах Verovio подбирается под окно: ~2 единицы на пиксель при scale 42.
      { ...common, breaks: "auto", pageWidth: Math.max(1500, Math.round(width * 2)), pageHeight: 60000 };
}

// «Страницы»: ширина страницы в Verovio — ~2 единицы на пиксель окна, отсюда масштаб
// ~1,24 от собственного размера SVG. Короткое упражнение (одна неполная строка) Verovio
// обрезает по содержимому — без ограничения оно растянулось бы на всю ширину и стало огромным.
export const PAGE_ZOOM = 1.24;
export function capPageWidth(svg: string): string {
  const m = /viewBox="0 0 ([\d.]+) /.exec(svg);
  return m ? svg.replace("<svg", `<svg style="max-width:${Math.round(Number(m[1]) * PAGE_ZOOM)}px"`) : svg;
}

export function formatTime(ms: number): string {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function percent(x: number): string {
  return `${Math.round(x * 100)}%`;
}

export interface Current {
  index: number;
  noteIds: string[];
  required: number[];
}

export interface Loop {
  from: number;
  to: number;
}

export interface Score {
  notes: ScoreNote[];
  structure: MeiStructure;
  starts: number[];
  tempoBpm: number;
  endMs: number;
}

export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Серия хороших проходов на уровне: для уровня 1 — у руки, которая сейчас играет. */
export function streakOf(unit: UnitView): number {
  const s = unit.state;
  if (s.level === 1) return unit.hand === "left" ? s.leftStreak : unit.hand === "right" ? s.rightStreak : s.streak;
  return s.streak;
}

/** Рамки тактов одной строки (системы) — общий верх и низ. */
export function alignRows(boxes: (Rect | null)[]): (Rect | null)[] {
  const rows: { top: number; bottom: number; idx: number[] }[] = [];
  boxes.forEach((b, i) => {
    if (!b) return;
    const mid = b.top + b.height / 2;
    const row = rows.find((r) => mid > r.top && mid < r.bottom);
    if (row) {
      row.top = Math.min(row.top, b.top);
      row.bottom = Math.max(row.bottom, b.top + b.height);
      row.idx.push(i);
    } else rows.push({ top: b.top, bottom: b.top + b.height, idx: [i] });
  });
  const out = [...boxes];
  for (const r of rows) for (const i of r.idx) out[i] = { ...boxes[i]!, top: r.top, height: r.bottom - r.top };
  return out;
}

/**
 * Номер такта под курсором. Клик по пустому месту попадает в сам <svg>, поэтому,
 * если элемент такта не найден по дереву, ищем по координатам: такт, в рамку
 * которого попадает точка, иначе ближайший по горизонтали в той же строке.
 */
export function measureAt(x: number, y: number, target: Element, ids: string[], root: HTMLElement | null): number {
  const direct = target.closest?.("g.measure");
  if (direct) return ids.indexOf(direct.id) + 1;
  if (!root) return 0;
  let best = 0;
  let bestDist = Infinity;
  ids.forEach((id, i) => {
    const el = root.querySelector(`g[id="${id}"]`);
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (y < r.top - 20 || y > r.bottom + 20) return;
    const dist = x < r.left ? r.left - x : x > r.right ? x - r.right : 0;
    if (dist < bestDist) {
      bestDist = dist;
      best = i + 1;
    }
  });
  return bestDist < 60 ? best : 0;
}

export function clampTempo(t: number): number {
  return Math.round(Math.min(TEMPO_MAX, Math.max(TEMPO_MIN, t)) * 100) / 100;
}

export function toIn({ id, pitch, startMs, durMs, hand, measure }: ScoreNote): PieceNoteIn {
  return { id, pitch, startMs, durMs, hand, measure };
}
