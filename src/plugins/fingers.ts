// Сверка пальцев с аппликатурой: каким пальцем нажата нота (сообщает плагин) → верно / не тот палец,
// счёт и путаницы для итога попытки. Без React и без ядра — проверяется тестами.

import type { HandSide } from "../lib/hands";

/** Нота шага, которую ждёт пьеса. */
export interface ExpectedNote {
  id: string;
  pitch: number;
  hand: HandSide;
  /** Палец по аппликатуре; null — аппликатуры у ноты нет (не сверяется). */
  finger: number | null;
  measure: number;
}

/** Сообщение плагина: клавиша `pitch` нажата пальцем `finger` (1–5) руки `hand`. */
export interface FingerReport {
  pitch: number;
  finger: number;
  hand?: HandSide;
}

export interface FingerVerdict {
  note: ExpectedNote;
  ok: boolean;
  played: number;
  hand?: HandSide;
}

export interface Confusion {
  expected: number;
  played: number;
  count: number;
  measures: number[];
}

export interface FingerSummary {
  correct: number;
  total: number;
  /** Чаще всего первыми. */
  confusions: Confusion[];
}

/** Сколько ждать сообщения о пальце после того, как шаг уже пройден (камера запаздывает). */
export const LATE_MS = 1500;

/** Итог попытки ждёт запоздавших сообщений о последних нотах столько. */
export const FINISH_GRACE_MS = 600;

interface Judged {
  pass: number;
  ok: boolean;
  expected: number;
  played: number;
  measure: number;
}

/**
 * Счёт ведётся по проходам: цикл по тактам — новый проход с теми же нотами. Нота сверяется один раз за проход;
 * сообщение о последней ноте прохода может прийти уже после его конца и всё равно идёт в его счёт.
 */
export class FingerTally {
  private pass = 0;
  private cur: ExpectedNote[] = [];
  private curPass = 0;
  private recent: { note: ExpectedNote; pass: number; at: number }[] = [];
  private judged = new Set<string>();
  private records: Judged[] = [];

  /** Новый шаг: прежние ноты ещё LATE_MS ждут запоздавших сообщений. */
  setStep(notes: ExpectedNote[], now: number) {
    for (const note of this.cur) this.recent.push({ note, pass: this.curPass, at: now });
    this.recent = this.recent.filter((r) => now - r.at <= LATE_MS);
    this.cur = notes;
    this.curPass = this.pass;
  }

  /** Ноты текущего шага. */
  expected(): ExpectedNote[] {
    return this.cur;
  }

  /** Проход закончен (конец пьесы или круг цикла); возвращает его номер для `summary`. */
  endPass(now: number): number {
    const done = this.pass;
    this.setStep([], now);
    this.pass++;
    return done;
  }

  /** Сверить сообщение плагина. null — нечего сверять (нет такой ноты или у неё нет аппликатуры). */
  judge(r: FingerReport, now: number): FingerVerdict | null {
    const key = (n: ExpectedNote, pass: number) => `${pass}:${n.id}`;
    const sameHand = (n: ExpectedNote) => !r.hand || n.hand === r.hand;
    const cands = [
      ...this.cur.map((note) => ({ note, pass: this.curPass })),
      ...this.recent.filter((x) => now - x.at <= LATE_MS),
    ].filter((x) => x.note.pitch === r.pitch && x.note.finger !== null && !this.judged.has(key(x.note, x.pass)));
    const hit = cands.find((x) => sameHand(x.note)) ?? cands[0];
    if (!hit) return null;
    const { note, pass } = hit;
    this.judged.add(key(note, pass));
    const ok = note.finger === r.finger && sameHand(note);
    this.records.push({ pass, ok, expected: note.finger!, played: r.finger, measure: note.measure });
    return { note, ok, played: r.finger, hand: r.hand };
  }

  /** Отклонённая нота снова ждёт сообщения (режим «пальцы обязательны»: повтор нажатия). */
  retry(id: string) {
    this.judged.delete(`${this.curPass}:${id}`);
  }

  /** Итог прохода `pass` (по умолчанию — текущего). */
  summary(pass = this.pass): FingerSummary {
    const rs = this.records.filter((r) => r.pass === pass);
    const conf = new Map<string, Confusion>();
    for (const r of rs) {
      if (r.ok) continue;
      const k = `${r.expected}>${r.played}`;
      const c = conf.get(k) ?? { expected: r.expected, played: r.played, count: 0, measures: [] };
      c.count++;
      if (!c.measures.includes(r.measure)) c.measures.push(r.measure);
      conf.set(k, c);
    }
    const confusions = [...conf.values()]
      .map((c) => ({ ...c, measures: [...c.measures].sort((a, b) => a - b) }))
      .sort((a, b) => b.count - a.count || a.expected - b.expected);
    return { correct: rs.filter((r) => r.ok).length, total: rs.length, confusions };
  }

  /** Новая попытка: счёт с нуля. */
  reset() {
    this.pass++;
    this.cur = [];
    this.curPass = this.pass;
    this.recent = [];
    this.judged.clear();
    this.records = [];
  }
}

/** «такты 5–6», «такт 3», «такты 2, 5, 9». */
export function measuresText(ms: number[]): string {
  if (!ms.length) return "";
  const s = [...ms].sort((a, b) => a - b);
  if (s.length === 1) return `такт ${s[0]}`;
  const run = s.every((m, i) => i === 0 || m === s[i - 1] + 1);
  return `такты ${run ? `${s[0]}–${s[s.length - 1]}` : s.slice(0, 4).join(", ") + (s.length > 4 ? "…" : "")}`;
}

/** «Пальцы: 87% верно, чаще всего 3 вместо 4 — такты 5–6». */
export function fingerSummaryText(s: FingerSummary): string {
  if (!s.total) return "";
  const pct = Math.round((100 * s.correct) / s.total);
  const top = s.confusions[0];
  return `Пальцы: ${pct}% верно` + (top ? `, чаще всего ${top.played} вместо ${top.expected} — ${measuresText(top.measures)}` : "");
}

/** Точность пальцев по дням (новые первыми): попытки `{ at (секунды), correct, total }`. */
export function fingerByDay(attempts: { at: number; correct: number; total: number }[], days = 5): { day: string; pct: number }[] {
  const by = new Map<string, { correct: number; total: number; at: number }>();
  for (const a of attempts) {
    const d = new Date(a.at * 1000);
    const key = `${String(d.getDate()).padStart(2, "0")}.${String(d.getMonth() + 1).padStart(2, "0")}`;
    const v = by.get(key) ?? { correct: 0, total: 0, at: a.at };
    v.correct += a.correct;
    v.total += a.total;
    v.at = Math.max(v.at, a.at);
    by.set(key, v);
  }
  return [...by.entries()]
    .filter(([, v]) => v.total > 0)
    .sort((a, b) => b[1].at - a[1].at)
    .slice(0, days)
    .map(([day, v]) => ({ day, pct: Math.round((100 * v.correct) / v.total) }));
}
