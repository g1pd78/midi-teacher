import { diagramBase, type ChordShape } from "../lib/guitarChords";

/**
 * Диаграмма аккорда («квадратик»): струны вертикально (6-я слева), лады сверху вниз,
 * точки с номерами пальцев, дуга баррэ, × и ○ над струнами, номер лада слева.
 * `wrong` — струны, которые прозвучали не так (красные), `missing` — не прозвучали (жёлтые).
 */
export function ChordDiagram({
  shape,
  size = 120,
  title = true,
  wrong = [],
  missing = [],
}: {
  shape: ChordShape;
  size?: number;
  title?: boolean;
  wrong?: number[];
  missing?: number[];
}) {
  const n = shape.frets.length;
  const base = diagramBase(shape);
  const rows = 5;
  const W = 100;
  const left = 18;
  const right = 8;
  const top = title ? 34 : 18;
  const gap = (W - left - right) / (n - 1);
  const rowH = 15;
  const H = top + rows * rowH + 6;
  const xOf = (s: number) => left + s * gap;
  const yOf = (f: number) => top + (f - base + 0.5) * rowH;
  const stateOf = (s: number) => (wrong.includes(s) ? " wrong" : missing.includes(s) ? " missing" : "");
  return (
    <svg className="chord-diagram" viewBox={`0 0 ${W} ${H}`} width={size} height={(size * H) / W} data-chord-diagram={shape.symbol}>
      {title && (
        <text x={W / 2} y={14} className="cd-title">
          {shape.symbol}
        </text>
      )}
      {/* Порожек или номер лада. */}
      {base === 1 ? (
        <rect x={left - 1} y={top - 3} width={W - left - right + 2} height={3} className="cd-nut" />
      ) : (
        <text x={left - 6} y={top + rowH * 0.5 + 3.5} className="cd-base">
          {base}
        </text>
      )}
      {Array.from({ length: rows + 1 }, (_, r) => (
        <line key={r} x1={left} x2={W - right} y1={top + r * rowH} y2={top + r * rowH} className="cd-fret" />
      ))}
      {shape.frets.map((_, s) => (
        <line key={s} x1={xOf(s)} x2={xOf(s)} y1={top} y2={top + rows * rowH} className="cd-string" />
      ))}
      {shape.frets.map((f, s) => (
        <text key={s} x={xOf(s)} y={top - 6} className={`cd-open${stateOf(s)}`}>
          {f < 0 ? "×" : f === 0 ? "○" : ""}
        </text>
      ))}
      {shape.barre && (
        <rect
          x={xOf(shape.barre.from) - 5}
          y={yOf(shape.barre.fret) - 5}
          width={xOf(shape.barre.to) - xOf(shape.barre.from) + 10}
          height={10}
          rx={5}
          className="cd-barre"
        />
      )}
      {shape.frets.map((f, s) =>
        f > 0 ? (
          <g key={s} className={`cd-dot${stateOf(s)}`}>
            <circle cx={xOf(s)} cy={yOf(f)} r={5.5} />
            {shape.fingers[s] > 0 && (
              <text x={xOf(s)} y={yOf(f) + 3.2}>
                {shape.fingers[s]}
              </text>
            )}
          </g>
        ) : null,
      )}
    </svg>
  );
}
