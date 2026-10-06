// Схема ладони (вид сверху, ладонь на клавишах): пальцы 1–5, подсветка нужного пальца.

import type { HandFingers, HandSide, PalmHit } from "../lib/hands";

// Пальцы правой руки слева направо: большой (1) — к центру клавиатуры, мизинец (5) — наружу.
// x — середина пальца, top — кончик, h — длина, tilt — наклон (большой палец отведён в сторону).
const FINGERS = [
  { n: 1, x: 17, top: 52, h: 34, tilt: -28 },
  { n: 2, x: 37, top: 16, h: 50 },
  { n: 3, x: 53, top: 8, h: 58 },
  { n: 4, x: 69, top: 14, h: 52 },
  { n: 5, x: 84, top: 30, h: 38 },
];

/** Одна ладонь. Левая — зеркально: большой палец справа, у центра клавиатуры. */
export function Palm({ side, fingers, hit }: { side: HandSide; fingers: HandFingers; hit?: PalmHit | null }) {
  const mine = hit && hit.hand === side ? hit : null;
  return (
    <svg
      className={`palm ${side}${mine && !mine.ok ? " miss" : ""}`}
      viewBox="0 0 100 124"
      role="img"
      aria-label={`${side === "left" ? "Левая" : "Правая"} рука: ${fingers.next.length ? `палец ${fingers.next.join(", ")}` : "свободна"}`}
      data-palm={side}
      data-next={fingers.next.join(",")}
      data-hit={mine ? `${mine.finger ?? ""}:${mine.ok ? "ok" : "miss"}` : ""}
    >
      <g transform={side === "left" ? "translate(100 0) scale(-1 1)" : undefined}>
        <rect className="palm-base" x="26" y="62" width="68" height="56" rx="16" />
        {FINGERS.map((f) => {
          const cls = fingers.next.includes(f.n) ? "next" : fingers.soon.includes(f.n) ? "soon" : "";
          const flash = mine?.ok && mine.finger === f.n ? " hit" : "";
          const cx = f.x;
          // Цифра — у кончика пальца, без наклона (точка кончика поворачивается вместе с пальцем).
          const a = ((f.tilt ?? 0) * Math.PI) / 180;
          const dy = -(f.h - 13);
          const tx = cx - dy * Math.sin(a);
          const ty = f.top + f.h + dy * Math.cos(a);
          return (
            <g key={f.n}>
              <rect
                className={`palm-finger ${cls}${flash}`}
                x={cx - 7}
                y={f.top}
                width="14"
                height={f.h + 10}
                rx="7"
                transform={f.tilt ? `rotate(${f.tilt} ${cx} ${f.top + f.h})` : undefined}
              />
              <text
                className="palm-num"
                x={tx}
                y={ty + 4}
                textAnchor="middle"
                transform={side === "left" ? `scale(-1 1) translate(${-2 * tx} 0)` : undefined}
              >
                {f.n}
              </text>
            </g>
          );
        })}
      </g>
    </svg>
  );
}
