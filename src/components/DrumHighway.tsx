import { useEffect, useRef } from "react";
import type { NoteState } from "./Waterfall";
import { DRUMS, drumOfGm, type DrumDef } from "../lib/drums";

export interface DrumLaneNote {
  id: string;
  pitch: number;
  startMs: number;
  accent?: boolean;
  ghost?: boolean;
}

const COLORS = {
  bg: "#101216",
  row: "#1b1e25",
  bar: "#2a2e38",
  now: "#e6e6e6",
  label: "#8a91a0",
  hit: "#4CC38A",
  poor: "#F2C94C",
  miss: "#FF5C5C",
};

/** Строки сверху вниз — как на стане: тарелки, томы, малый, бочка. */
const ORDER: DrumDef["id"][] = ["crash", "ride", "hhOpen", "hhClosed", "tom", "snare", "floorTom", "kick"];

/** Барабаны, которые есть в партии, в порядке строк дорожки. */
export function drumLanes(notes: { pitch: number }[]): DrumDef[] {
  const used = new Set(notes.map((n) => drumOfGm(n.pitch)?.id).filter(Boolean));
  return ORDER.filter((id) => used.has(id)).map((id) => DRUMS.find((d) => d.id === id)!);
}

/**
 * «Дорожка» барабанов: удары едут справа налево по строкам барабанов к линии «сейчас».
 * Цвет — барабана, после игры — оценки; акцент — крупнее с обводкой, тихая нота — мельче.
 */
export function DrumHighway({
  notes,
  getPos,
  windowMs,
  states,
  bars,
  loop,
}: {
  notes: DrumLaneNote[];
  getPos: () => number;
  windowMs: number;
  states: React.MutableRefObject<Map<string, NoteState>>;
  bars: number[];
  loop?: [number, number] | null;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const props = useRef({ notes, getPos, windowMs, bars, loop });
  props.current = { notes, getPos, windowMs, bars, loop };

  useEffect(() => {
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext("2d")!;
    let raf = 0;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const { notes, getPos, windowMs, bars, loop } = props.current;
      const lanes = drumLanes(notes);
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
      if (!lanes.length) return;
      const rowH = h / lanes.length;
      const labelW = 96;
      const nowX = labelW + Math.round((w - labelW) * 0.08);
      const pos = getPos();
      const xOf = (ms: number) => nowX + ((ms - pos) / windowMs) * (w - nowX);
      const row = new Map(lanes.map((d, i) => [d.id, i]));
      const yOf = (i: number) => i * rowH + rowH / 2;

      ctx.font = `600 ${Math.round(Math.min(14, rowH * 0.42))}px Inter, "Segoe UI", sans-serif`;
      ctx.textBaseline = "middle";
      ctx.textAlign = "left";
      lanes.forEach((d, i) => {
        ctx.fillStyle = COLORS.row;
        ctx.fillRect(labelW, Math.round(yOf(i)), w - labelW, 1);
        ctx.fillStyle = d.color;
        ctx.fillRect(8, yOf(i) - 5, 10, 10);
        ctx.fillStyle = COLORS.label;
        ctx.fillText(d.name, 24, yOf(i) + 1);
      });
      ctx.fillStyle = COLORS.bar;
      for (const b of bars) {
        const x = xOf(b);
        if (x < labelW || x > w) continue;
        ctx.fillRect(Math.round(x), 0, 1, h);
      }

      const r0 = Math.min(13, rowH * 0.36);
      for (const n of notes) {
        const d = drumOfGm(n.pitch);
        if (!d) continue;
        const x = xOf(n.startMs);
        if (x > w + r0 || x < labelW - r0) continue;
        const state = states.current.get(n.id);
        let color = d.color;
        if (state === "hit") color = COLORS.hit;
        else if (state === "poor") color = COLORS.poor;
        else if (state === "miss") color = COLORS.miss;
        const outside = loop && (n.startMs < loop[0] || n.startMs >= loop[1]);
        ctx.globalAlpha = outside ? 0.2 : x < nowX && !state ? 0.45 : 1;
        const r = n.accent ? r0 * 1.2 : n.ghost ? r0 * 0.65 : r0;
        const y = yOf(row.get(d.id)!);
        ctx.fillStyle = color;
        ctx.beginPath();
        if (d.cymbal) {
          // Тарелки — ромбом, как крестик на стане.
          ctx.moveTo(x, y - r);
          ctx.lineTo(x + r, y);
          ctx.lineTo(x, y + r);
          ctx.lineTo(x - r, y);
          ctx.closePath();
        } else ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
        if (n.accent || state === "current") {
          ctx.strokeStyle = "#ffffff";
          ctx.lineWidth = 2;
          ctx.stroke();
        }
      }
      ctx.globalAlpha = 0.55;
      ctx.fillStyle = COLORS.now;
      ctx.fillRect(nowX - 1, 0, 2, h);
      ctx.globalAlpha = 1;
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [states]);

  return <canvas ref={canvasRef} className="waterfall" data-drum-highway />;
}
