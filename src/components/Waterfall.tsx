import { useEffect, useMemo, useRef } from "react";
import { keyboardLayout } from "../lib/notes";
import type { ScoreNote } from "../lib/score";

export type NoteState = "hit" | "poor" | "miss" | "current";

export interface WaterfallProps {
  notes: ScoreNote[];
  low: number;
  high: number;
  /** Текущая позиция в пьесе (мс); вызывается каждый кадр. */
  getPos: () => number;
  /** Сколько миллисекунд пьесы видно над клавиатурой. */
  windowMs: number;
  includes: (hand: "right" | "left") => boolean;
  /** Состояния нот по id; читаются каждый кадр без перерисовки React. */
  states: React.MutableRefObject<Map<string, NoteState>>;
  /** Начала тактов (мс) — тонкие линии. */
  bars: number[];
  /** Затемнить ноты вне цикла [от, до) мс. */
  loop?: [number, number] | null;
  /** Пальцы по id ноты — цифра внутри падающей ноты. */
  fingers?: Map<string, { finger: number; auto: boolean }> | null;
}

const COLORS = {
  bg: "#101216",
  guide: "#1b1e25",
  bar: "#2a2e38",
  now: "#e6e6e6",
  right: "#5AA9FF",
  left: "#FFB454",
  other: "#4a4f5a",
  hit: "#4CC38A",
  poor: "#F2C94C",
  miss: "#FF5C5C",
};

/** Падающие ноты над клавиатурой (Canvas, отрисовка каждый кадр). */
export function Waterfall({ notes, low, high, getPos, windowMs, includes, states, bars, loop, fingers }: WaterfallProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const keys = useMemo(() => new Map(keyboardLayout(low, high).map((k) => [k.note, k])), [low, high]);
  // Ноты по началу: каждый кадр перебираются только видимые (двоичный поиск окна).
  const byStart = useMemo(() => [...notes].sort((a, b) => a.startMs - b.startMs), [notes]);
  const maxDur = useMemo(() => notes.reduce((m, n) => Math.max(m, n.durMs), 0), [notes]);
  const props = useRef({ getPos, windowMs, includes, bars, loop, fingers });
  props.current = { getPos, windowMs, includes, bars, loop, fingers };

  useEffect(() => {
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext("2d")!;
    let raf = 0;

    const draw = () => {
      raf = requestAnimationFrame(draw);
      const { getPos, windowMs, includes, bars, loop, fingers } = props.current;
      const dpr = window.devicePixelRatio || 1;
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = COLORS.bg;
      ctx.fillRect(0, 0, w, h);

      // Направляющие у каждой «до».
      ctx.fillStyle = COLORS.guide;
      for (const k of keys.values()) if (k.note % 12 === 0) ctx.fillRect(k.x * w, 0, 1, h);

      const pos = getPos();
      const yOf = (ms: number) => h - ((ms - pos) / windowMs) * h;

      ctx.fillStyle = COLORS.bar;
      for (const b of bars) {
        if (b < pos - 50 || b > pos + windowMs) continue;
        ctx.fillRect(0, Math.round(yOf(b)), w, 1);
      }

      // Видимые ноты: начались не раньше «самой длинной ноты» до окна и не позже его верха.
      const from = firstAtOrAfter(byStart, pos - windowMs * 0.15 - maxDur);
      const visible: ScoreNote[] = [];
      for (let i = from; i < byStart.length && byStart[i].startMs <= pos + windowMs; i++) visible.push(byStart[i]);
      // Сначала белые, потом чёрные — чёрные поверх.
      visible.sort((a, b) => Number(keys.get(a.pitch)?.black ?? 0) - Number(keys.get(b.pitch)?.black ?? 0));
      for (const n of visible) {
        const end = n.startMs + n.durMs;
        if (end < pos - windowMs * 0.15) continue;
        const k = keys.get(n.pitch);
        if (!k) continue;
        const state = states.current.get(n.id);
        const mine = includes(n.hand);
        let color = mine ? COLORS[n.hand] : COLORS.other;
        if (state === "hit") color = COLORS.hit;
        else if (state === "poor") color = COLORS.poor;
        else if (state === "miss") color = COLORS.miss;
        const outside = loop && (n.startMs < loop[0] || n.startMs >= loop[1]);
        ctx.globalAlpha = outside ? 0.18 : mine || state ? 1 : 0.55;
        const y1 = yOf(end);
        const y0 = yOf(n.startMs);
        const x = k.x * w + 1.5;
        const width = Math.max(2, k.width * w - 3);
        const height = Math.max(4, y0 - y1 - 2);
        ctx.fillStyle = color;
        roundRect(ctx, x, y1 + 1, width, height, Math.min(5, width / 3));
        if (state === "current") {
          ctx.strokeStyle = "#ffffff";
          ctx.lineWidth = 2;
          ctx.stroke();
        }
        // Цифра пальца у нижнего края ноты (если нота достаточно высокая).
        const f = fingers?.get(n.id);
        if (f && height >= 16 && width >= 10) {
          const size = Math.min(15, width * 0.8, height - 4);
          ctx.font = `600 ${size}px Inter, "Segoe UI", sans-serif`;
          ctx.textAlign = "center";
          ctx.textBaseline = "bottom";
          ctx.fillStyle = f.auto ? "rgba(13, 17, 24, 0.55)" : "#0d1118";
          ctx.fillText(String(f.finger), x + width / 2, y1 + 1 + height - 2);
        }
      }
      ctx.globalAlpha = 1;

      // Линия «сейчас» у самой клавиатуры.
      ctx.fillStyle = COLORS.now;
      ctx.globalAlpha = 0.5;
      ctx.fillRect(0, h - 2, w, 2);
      ctx.globalAlpha = 1;
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [byStart, maxDur, keys, states]);

  return <canvas ref={canvasRef} className="waterfall" />;
}

/** Индекс первой ноты с началом не раньше `ms` (ноты отсортированы по началу). */
export function firstAtOrAfter(notes: { startMs: number }[], ms: number): number {
  let lo = 0;
  let hi = notes.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (notes[mid].startMs < ms) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
  ctx.fill();
}
