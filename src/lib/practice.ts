// Движок практики на стороне интерфейса: описание пьесы для ядра, пресеты
// подсказок для уровней, точность прохода, время занятий по дням.
// Решения (уровни, предложения, сцепление) принимает Rust (`mt_core::practice`).

import type { MeiStructure, ScoreNote } from "./score";

export type PlayHands = "right" | "left" | "both" | "none";

export interface LevelInfo {
  id: number;
  short: string;
  title: string;
  description: string;
}

export const LEVELS: LevelInfo[] = [
  { id: 0, short: "Слушать", title: "Знакомство", description: "Приложение играет отрезок, ты слушаешь и смотришь на ноты и клавиши." },
  {
    id: 1,
    short: "Подсказки",
    title: "Полные подсказки",
    description: "Каждая рука отдельно, курсор ждёт. Названия нот, подсветка клавиш и падающие ноты.",
  },
  { id: 2, short: "Ноты", title: "Ноты с курсором", description: "Обе руки, курсор ждёт. Названий нот уже нет, клавиши ещё подсвечены." },
  {
    id: 3,
    short: "В темпе",
    title: "Только ноты",
    description: "Обе руки в темпе: с 60 % до 100 %, темп растёт сам. Без падающих нот и подсветки.",
  },
  { id: 4, short: "По памяти", title: "По памяти", description: "Ноты отрезка скрыты. Играй в темпе по памяти." },
];

export interface LevelPreset {
  mode: "wait" | "rhythm";
  names: boolean;
  keyHints: boolean;
  waterfall: boolean;
  /** Скрыть ноты отрезка на стане. */
  hide: boolean;
}

export function levelPreset(level: number): LevelPreset {
  switch (level) {
    case 0:
      return { mode: "rhythm", names: false, keyHints: true, waterfall: true, hide: false };
    case 1:
      return { mode: "wait", names: true, keyHints: true, waterfall: true, hide: false };
    case 2:
      return { mode: "wait", names: false, keyHints: true, waterfall: true, hide: false };
    case 3:
      return { mode: "rhythm", names: false, keyHints: false, waterfall: false, hide: false };
    default:
      return { mode: "rhythm", names: false, keyHints: false, waterfall: false, hide: true };
  }
}

/** Темп уровня — как `UnitState::play_tempo` в ядре. */
export function levelTempo(level: number, unitTempo: number): number {
  return level === 3 ? unitTempo : level >= 4 ? 1 : 0.8;
}

/** Нужные хорошие проходы подряд — как `STREAK_TO_ADVANCE` в ядре. */
export const STREAK_TO_ADVANCE = 3;

export interface PieceMetaIn {
  id: string;
  title: string;
  measures: number;
  phraseEnds: number[];
  measureHands: number[];
}

/**
 * Где заканчиваются фразы: двойная/финальная черта, долгая нота в конце такта
 * (не короче половины такта) или пауза во второй половине такта. Смотрим на
 * мелодию — правую руку (если её в такте нет, то на левую): бас часто движется
 * и под долгой нотой мелодии.
 */
export function phraseEnds(notes: ScoreNote[], structure: MeiStructure, starts: number[], endMs: number): number[] {
  const ends = new Set(structure.sectionEnds);
  const byMeasure = new Map<number, ScoreNote[]>();
  for (const n of notes) byMeasure.set(n.measure, [...(byMeasure.get(n.measure) ?? []), n]);
  for (let m = 1; m <= structure.measures; m++) {
    const start = starts[m - 1] ?? 0;
    const next = m < starts.length ? starts[m] : endMs;
    const len = next - start;
    const all = byMeasure.get(m) ?? [];
    const right = all.filter((n) => n.hand === "right");
    const ns = right.length ? right : all;
    if (len <= 0 || !ns.length) continue;
    const lastOnset = Math.max(...ns.map((n) => n.startMs));
    const longest = Math.max(...ns.filter((n) => n.startMs === lastOnset).map((n) => n.durMs));
    const soundEnd = Math.max(...ns.map((n) => n.startMs + n.durMs));
    if (longest >= len * 0.5 - 1 || soundEnd <= start + len * 0.5 + 1) ends.add(m);
  }
  ends.add(structure.measures);
  return [...ends].filter((m) => m >= 1 && m <= structure.measures).sort((a, b) => a - b);
}

/** Маска рук по тактам: бит 1 — правая, бит 2 — левая. */
export function measureHands(notes: ScoreNote[], measures: number): number[] {
  const mask = new Array<number>(measures).fill(0);
  for (const n of notes) if (n.measure >= 1 && n.measure <= measures) mask[n.measure - 1] |= n.hand === "right" ? 1 : 2;
  return mask;
}

/** Точность прохода в ожидании — как `wait_accuracy` в ядре. */
export function waitAccuracy(required: number, errors: number): number {
  return required === 0 ? 1 : required / (required + errors);
}

/** Точность прохода в темпе — как `rhythm_accuracy` в ядре. */
export function rhythmAccuracy(required: number, hits: number, extras: number): number {
  return required === 0 ? 1 : hits / (required + extras);
}

/** Подпись отрезка цепочки: «1», «1+2», «1–3». */
export function unitLabel(frags: [number, number]): string {
  const [a, b] = frags;
  if (a === b) return String(a + 1);
  return b === a + 1 ? `${a + 1}+${b + 1}` : `${a + 1}–${b + 1}`;
}

function dayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Минуты игры по дням (местное время) за последние `days` дней, от старых к новым. */
export function minutesByDay(play: [number, number][], days: number, now = new Date()): { date: Date; key: string; minutes: number }[] {
  const totals = new Map<string, number>();
  for (const [bucket, secs] of play) {
    const key = dayKey(new Date(bucket * 1000));
    totals.set(key, (totals.get(key) ?? 0) + secs);
  }
  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    const key = dayKey(d);
    out.push({ date: d, key, minutes: (totals.get(key) ?? 0) / 60 });
  }
  return out;
}
