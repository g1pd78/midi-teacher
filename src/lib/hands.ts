// Схема ладоней: какими пальцами каждой руки играть сейчас и следом — по аппликатуре нот шага.

export type HandSide = "left" | "right";

export interface HandFingers {
  /** Пальцы 1–5 текущего шага (ярко). */
  next: number[];
  /** Пальцы следующего шага (бледно). */
  soon: number[];
}

export interface PalmHit {
  hand: HandSide;
  /** Палец сыгранной ноты; null — мимо (MIDI не знает, каким пальцем нажата клавиша). */
  finger: number | null;
  ok: boolean;
}

const uniq = (xs: number[]) => [...new Set(xs)].sort((a, b) => a - b);

/** Пальцы шага по рукам: ноты `now` (ещё не сыгранные) и ноты следующего шага `then`. */
export function handFingers(
  now: string[],
  then: string[],
  handOf: (id: string) => HandSide | undefined,
  fingerOf: (id: string) => number | undefined,
  skip: (id: string) => boolean = () => false,
): Record<HandSide, HandFingers> {
  const out: Record<HandSide, HandFingers> = { left: { next: [], soon: [] }, right: { next: [], soon: [] } };
  const add = (ids: string[], key: keyof HandFingers) => {
    for (const id of ids) {
      if (skip(id)) continue;
      const hand = handOf(id);
      const f = fingerOf(id);
      if (hand && f && f >= 1 && f <= 5) out[hand][key].push(f);
    }
  };
  add(now, "next");
  add(then, "soon");
  for (const h of ["left", "right"] as const) {
    out[h].next = uniq(out[h].next);
    // Палец, который нужен и сейчас, и следом, показывается как текущий.
    out[h].soon = uniq(out[h].soon).filter((f) => !out[h].next.includes(f));
  }
  return out;
}

/** Рука для промаха: та, чья ожидаемая нота ближе к нажатой клавише; без ожидаемых — по середине клавиатуры. */
export function handOfMiss(pitch: number, expected: { pitch: number; hand: HandSide }[]): HandSide {
  let best: { d: number; hand: HandSide } | null = null;
  for (const e of expected) {
    const d = Math.abs(e.pitch - pitch);
    if (!best || d < best.d) best = { d, hand: e.hand };
  }
  return best?.hand ?? (pitch < 60 ? "left" : "right");
}
