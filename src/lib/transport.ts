// Синхронизация с часами ядра: позиция в пьесе для анимации считается по тем же
// часам, по которым Rust оценивает нажатия.

import { api } from "../api";

export interface Transport {
  /** Момент (часы ядра, мкс), когда позиция равна `pos0`. */
  originUs: number;
  pos0: number;
  tempo: number;
}

export class ClockSync {
  private offsetUs = 0;

  /** Смещение часов ядра относительно performance.now() по середине запроса. */
  async sync(): Promise<void> {
    const t0 = performance.now();
    const core = await api.clockNow();
    const t1 = performance.now();
    this.offsetUs = core - ((t0 + t1) / 2) * 1000;
  }

  nowUs(): number {
    return performance.now() * 1000 + this.offsetUs;
  }
}

export function transportPos(t: Transport, nowUs: number): number {
  return t.pos0 + ((nowUs - t.originUs) / 1000) * t.tempo;
}

/** Индекс последнего элемента `onsets` (по возрастанию), не превышающего `pos`; −1, если такого нет. */
export function stepAt(onsets: number[], pos: number): number {
  let lo = 0;
  let hi = onsets.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (onsets[mid] <= pos) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}
