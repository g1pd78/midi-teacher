import { useEffect, useRef } from "react";
import type { NoteState } from "./Waterfall";

export interface HighwayNote {
  id: string;
  string: number;
  fret: number;
  startMs: number;
  durMs: number;
}

const COLORS = {
  bg: "#101216",
  row: "#1b1e25",
  bar: "#2a2e38",
  now: "#e6e6e6",
  note: "#5AA9FF",
  hit: "#4CC38A",
  poor: "#F2C94C",
  miss: "#FF5C5C",
  text: "#0d1118",
};

/**
 * «Дорожка» для гитары и баса: ноты едут справа налево по строкам струн
 * (высокая сверху, как в табулатуре) к линии «сейчас»; в ноте — номер лада.
 */
export function TabHighway({
  notes,
  strings,
  getPos,
  windowMs,
  states,
  bars,
  loop,
}: {
  notes: HighwayNote[];
  strings: number;
  getPos: () => number;
  windowMs: number;
  states: React.MutableRefObject<Map<string, NoteState>>;
  bars: number[];
  loop?: [number, number] | null;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const props = useRef({ notes, strings, getPos, windowMs, bars, loop });
  props.current = { notes, strings, getPos, windowMs, bars, loop };

  useEffect(() => {
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext("2d")!;
    let raf = 0;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const { notes, strings, getPos, windowMs, bars, loop } = props.current;
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
      const rowH = h / strings;
      const nowX = Math.round(w * 0.12);
      const pos = getPos();
      const xOf = (ms: number) => nowX + ((ms - pos) / windowMs) * (w - nowX);
      const yOf = (s: number) => (strings - 1 - s) * rowH + rowH / 2;

      ctx.fillStyle = COLORS.row;
      for (let s = 0; s < strings; s++) ctx.fillRect(0, Math.round(yOf(s)), w, 1);
      ctx.fillStyle = COLORS.bar;
      for (const b of bars) {
        const x = xOf(b);
        if (x < -2 || x > w) continue;
        ctx.fillRect(Math.round(x), 0, 1, h);
      }

      const bh = Math.min(26, rowH * 0.72);
      for (const n of notes) {
        const x0 = xOf(n.startMs);
        const x1 = xOf(n.startMs + n.durMs);
        if (x0 > w || x1 < -20) continue;
        const state = states.current.get(n.id);
        let color = COLORS.note;
        if (state === "hit") color = COLORS.hit;
        else if (state === "poor") color = COLORS.poor;
        else if (state === "miss") color = COLORS.miss;
        const outside = loop && (n.startMs < loop[0] || n.startMs >= loop[1]);
        ctx.globalAlpha = outside ? 0.2 : x1 < nowX && !state ? 0.45 : 1;
        const y = yOf(n.string) - bh / 2;
        const width = Math.max(bh, x1 - x0 - 2);
        ctx.fillStyle = color;
        roundRect(ctx, x0, y, width, bh, bh / 2);
        if (state === "current") {
          ctx.strokeStyle = "#ffffff";
          ctx.lineWidth = 2;
          ctx.stroke();
        }
        ctx.font = `700 ${Math.round(bh * 0.62)}px Inter, "Segoe UI", sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillStyle = COLORS.text;
        ctx.fillText(String(n.fret), x0 + bh / 2, y + bh / 2 + 1);
      }
      ctx.globalAlpha = 1;
      ctx.fillStyle = COLORS.now;
      ctx.globalAlpha = 0.55;
      ctx.fillRect(nowX - 1, 0, 2, h);
      ctx.globalAlpha = 1;
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [states]);

  return <canvas ref={canvasRef} className="waterfall" data-highway />;
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
