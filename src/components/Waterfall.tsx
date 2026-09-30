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
export function Waterfall({ notes, low, high, getPos, windowMs, includes, states, bars, loop }: WaterfallProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const keys = useMemo(() => new Map(keyboardLayout(low, high).map((k) => [k.note, k])), [low, high]);
  // Сначала белые, потом чёрные — чёрные поверх.
  const ordered = useMemo(
    () => [...notes].sort((a, b) => Number(keys.get(a.pitch)?.black ?? 0) - Number(keys.get(b.pitch)?.black ?? 0)),
    [notes, keys],
  );
  const props = useRef({ getPos, windowMs, includes, bars, loop });
  props.current = { getPos, windowMs, includes, bars, loop };

  useEffect(() => {
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext("2d")!;
    let raf = 0;

    const draw = () => {
      raf = requestAnimationFrame(draw);
      const { getPos, windowMs, includes, bars, loop } = props.current;
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

      for (const n of ordered) {
        const end = n.startMs + n.durMs;
        if (n.startMs > pos + windowMs || end < pos - windowMs * 0.15) continue;
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
  }, [ordered, keys, states]);

  return <canvas ref={canvasRef} className="waterfall" />;
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
