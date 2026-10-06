// Оценка игры поверх кода: «моя партия» (и «Повтори за мной») — ноты, которые код ждёт от ученика.
// Время — в циклах Strudel; окна допуска — в миллисекундах, как в пьесах (±50 «точно», ±120 «нормально»).

export const WINDOW_GOOD_MS = 50;
export const WINDOW_OK_MS = 120;

export interface Expected {
  begin: number;
  midi: number;
}

export type HitKind = "good" | "ok" | "extra";

export interface JudgeResult {
  kind: HitKind;
  /** Насколько раньше (−) или позже (+), мс. */
  deltaMs: number;
  expected: Expected | null;
}

export interface JudgeSummary {
  expected: number;
  good: number;
  ok: number;
  misses: number;
  extras: number;
  /** Доля сыгранных вовремя нот, 0–1. */
  accuracy: number;
  /** Среднее отклонение попаданий, мс (минус — спешу). */
  meanDeltaMs: number;
  /** По циклам: сыграно/ждали. */
  cycles: { cycle: number; hit: number; total: number }[];
}

const key = (e: Expected) => `${e.begin.toFixed(4)}|${e.midi}`;

export class YouJudge {
  private pending = new Map<string, Expected & { cps: number }>();
  private done = new Set<string>();
  private deltas: number[] = [];
  private counts = { good: 0, ok: 0, misses: 0, extras: 0 };
  private perCycle = new Map<number, { hit: number; total: number }>();

  constructor(private anyOctave = false) {}

  /** Ноты, которых ждём (можно добавлять с запасом: повторы отбрасываются). */
  expect(notes: Expected[], cps: number) {
    for (const n of notes) {
      const k = key(n);
      if (this.done.has(k) || this.pending.has(k)) continue;
      this.pending.set(k, { ...n, cps });
    }
  }

  private same(a: number, b: number) {
    return this.anyOctave ? ((a - b) % 12 + 12) % 12 === 0 : a === b;
  }

  private cycleStat(c: number) {
    const i = Math.floor(c + 1e-9);
    if (!this.perCycle.has(i)) this.perCycle.set(i, { hit: 0, total: 0 });
    return this.perCycle.get(i)!;
  }

  /** Нажата клавиша в момент `cycle` (уже в шкале того, что слышно). */
  play(midi: number, cycle: number, cps: number): JudgeResult {
    let best: (Expected & { cps: number }) | null = null;
    let bestMs = Infinity;
    for (const e of this.pending.values()) {
      if (!this.same(e.midi, midi)) continue;
      const ms = ((cycle - e.begin) / cps) * 1000;
      if (Math.abs(ms) <= WINDOW_OK_MS && Math.abs(ms) < Math.abs(bestMs)) {
        best = e;
        bestMs = ms;
      }
    }
    if (!best) {
      this.counts.extras++;
      return { kind: "extra", deltaMs: 0, expected: null };
    }
    const k = key(best);
    this.pending.delete(k);
    this.done.add(k);
    const kind: HitKind = Math.abs(bestMs) <= WINDOW_GOOD_MS ? "good" : "ok";
    this.counts[kind]++;
    this.deltas.push(bestMs);
    const st = this.cycleStat(best.begin);
    st.hit++;
    st.total++;
    return { kind, deltaMs: bestMs, expected: { begin: best.begin, midi: best.midi } };
  }

  /** Время идёт: ноты, окно которых прошло, — пропущены. Возвращает их. */
  tick(nowCycle: number): Expected[] {
    const missed: Expected[] = [];
    for (const [k, e] of this.pending) {
      if (((nowCycle - e.begin) / e.cps) * 1000 > WINDOW_OK_MS) {
        this.pending.delete(k);
        this.done.add(k);
        this.counts.misses++;
        this.cycleStat(e.begin).total++;
        missed.push({ begin: e.begin, midi: e.midi });
      }
    }
    return missed;
  }

  summary(): JudgeSummary {
    const { good, ok, misses, extras } = this.counts;
    const expected = good + ok + misses;
    const mean = this.deltas.length ? this.deltas.reduce((a, b) => a + b, 0) / this.deltas.length : 0;
    return {
      expected,
      good,
      ok,
      misses,
      extras,
      accuracy: expected ? (good + ok) / (expected + extras * 0.5) : 0,
      meanDeltaMs: Math.round(mean),
      cycles: [...this.perCycle.entries()].sort((a, b) => a[0] - b[0]).map(([cycle, v]) => ({ cycle, ...v })),
    };
  }
}

/** Советы по итогу — коротко, по-русски. */
export function judgeTips(s: JudgeSummary): string[] {
  const tips: string[] = [];
  if (!s.expected) return ["Партия не прозвучала — запусти код и подожди, пока она начнётся."];
  if (s.misses > s.expected * 0.3) tips.push("Много пропусков: замедли код (setcps) или упрости партию.");
  if (s.extras > s.expected * 0.3) tips.push("Много лишних нот: смотри на подсветку — играй только отмеченные клавиши.");
  if (s.meanDeltaMs < -30) tips.push(`Спешишь в среднем на ${-s.meanDeltaMs} мс — дождись доли.`);
  if (s.meanDeltaMs > 30) tips.push(`Опаздываешь в среднем на ${s.meanDeltaMs} мс — слушай бочку и играй вместе с ней.`);
  if (!tips.length) tips.push(s.accuracy >= 0.9 ? "Отлично! Попробуй ускорить код." : "Хорошо. Ещё пара кругов — и будет ровно.");
  return tips;
}
