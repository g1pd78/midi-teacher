import { useEffect, useRef } from "react";
import type { LiveCode } from "../../lib/strudel/engine";
import type { CodeNote } from "../../lib/strudel/haps";
import { playedPoint, rollLayout } from "../../lib/strudel/roll";

/**
 * Нотная лента под редактором: все партии кода цветом партии, моя партия — контуром, мои нажатия — точками,
 * линия «сейчас» посередине. Без запуска показывает первые два цикла.
 */
export function CodeRoll({
  live,
  parts,
  played,
  compact = false,
}: {
  live: () => LiveCode | null;
  parts: string[];
  played: () => CodeNote[];
  compact?: boolean;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const partsRef = useRef(parts);
  partsRef.current = parts;

  useEffect(() => {
    let raf = 0;
    let last = 0;
    const draw = (t: number) => {
      raf = requestAnimationFrame(draw);
      if (t - last < 33) return; // ~30 кадров в секунду
      last = t;
      const c = canvas.current;
      const lc = live();
      if (!c) return;
      const dpr = window.devicePixelRatio || 1;
      const w = c.clientWidth;
      const h = c.clientHeight;
      if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
        c.width = Math.round(w * dpr);
        c.height = Math.round(h * dpr);
      }
      const ctx = c.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      const started = !!lc?.started;
      const now = started ? (lc!.nowCycle() ?? 0) : 1;
      const l = rollLayout(lc?.notes(now - 1, now + 1) ?? [], now, partsRef.current);
      c.dataset.boxes = String(l.boxes.length);
      // Границы циклов.
      ctx.strokeStyle = "rgba(255,255,255,0.08)";
      ctx.lineWidth = 1;
      for (let k = Math.ceil(l.from); k <= l.to; k++) {
        const x = ((k - l.from) / (l.to - l.from)) * w;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, h);
        ctx.stroke();
      }
      if (l.split > 0 && l.split < 1) {
        ctx.strokeStyle = "rgba(255,255,255,0.12)";
        ctx.beginPath();
        ctx.moveTo(0, l.split * h);
        ctx.lineTo(w, l.split * h);
        ctx.stroke();
      }
      for (const b of l.boxes) {
        const x = b.x * w;
        const y = b.y * h;
        const bw = Math.max(2, b.w * w - 1);
        const bh = Math.max(3, b.h * h - 1);
        if (b.you) {
          ctx.strokeStyle = b.color;
          ctx.lineWidth = 1.5;
          ctx.strokeRect(x + 0.75, y + 0.75, bw - 1.5, bh - 1.5);
        } else {
          ctx.fillStyle = b.color;
          ctx.globalAlpha = 0.85;
          ctx.fillRect(x, y, bw, bh);
          ctx.globalAlpha = 1;
        }
      }
      ctx.fillStyle = "rgba(230,230,230,0.55)";
      ctx.font = "10px system-ui, sans-serif";
      for (const r of l.drumRows) ctx.fillText(r.name, 4, r.y * h + 3);
      // Мои нажатия.
      if (started) {
        ctx.fillStyle = "#ffffff";
        for (const p of played()) {
          if (p.midi === null) continue;
          const pt = playedPoint(p.begin, p.midi, l);
          if (!pt) continue;
          ctx.beginPath();
          ctx.arc(pt.x * w, pt.y * h, 3, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.strokeStyle = "rgba(255,255,255,0.7)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(w / 2, 0);
        ctx.lineTo(w / 2, h);
        ctx.stroke();
      }
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [live, played]);

  return <canvas ref={canvas} className={`code-roll${compact ? " compact" : ""}`} data-code-roll aria-label="Нотная лента кода" />;
}
