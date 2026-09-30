import { pitchName, type NoteNaming } from "../lib/notes";

export interface FretMark {
  string: number;
  fret: number;
  color: string;
  /** 0…1: насколько ярко (подсказка — бледнее, нажатие — ярче). */
  strength?: number;
  label?: string;
}

const INLAYS = [3, 5, 7, 9, 15, 17, 19, 21];

/**
 * Гриф гитары/баса: струны сверху вниз от высокой к низкой (как в табулатуре),
 * лады 0…`frets`. Метки — куда поставить палец и что нажато.
 */
export function Fretboard({ tuning, frets, naming, marks }: { tuning: number[]; frets: number; naming: NoteNaming; marks: FretMark[] }) {
  const n = tuning.length;
  const W = 1000;
  const rowH = 26;
  const top = 14;
  const H = top * 2 + rowH * (n - 1) + 18;
  const openW = 46; // место для открытых струн слева от порожка
  const fretW = (W - openW - 8) / frets;
  const xOfFret = (f: number) => openW + f * fretW; // правая граница лада f (порожек — 0)
  const xCenter = (f: number) => (f === 0 ? openW / 2 + 6 : xOfFret(f) - fretW / 2);
  const yOf = (string: number) => top + (n - 1 - string) * rowH; // высокая струна сверху
  return (
    <svg className="fretboard" viewBox={`0 0 ${W} ${H}`} data-fretboard>
      <rect x={openW} y={top - 8} width={W - openW - 8} height={rowH * (n - 1) + 16} rx={4} className="fb-wood" />
      {INLAYS.filter((f) => f <= frets).map((f) => (
        <circle key={f} cx={xCenter(f)} cy={top + (rowH * (n - 1)) / 2} r={5} className="fb-inlay" />
      ))}
      {frets >= 12 && (
        <>
          <circle cx={xCenter(12)} cy={top + rowH * 0.5} r={5} className="fb-inlay" />
          <circle cx={xCenter(12)} cy={top + rowH * (n - 1.5)} r={5} className="fb-inlay" />
        </>
      )}
      {Array.from({ length: frets + 1 }, (_, f) => (
        <line key={f} x1={xOfFret(f)} x2={xOfFret(f)} y1={top - 8} y2={top + rowH * (n - 1) + 8} className={f === 0 ? "fb-nut" : "fb-fret"} />
      ))}
      {tuning.map((open, s) => (
        <g key={s}>
          <line x1={openW - 4} x2={W - 8} y1={yOf(s)} y2={yOf(s)} className="fb-string" strokeWidth={1 + (n - 1 - s) * 0.35} />
          <text x={8} y={yOf(s) + 4} className="fb-open">
            {pitchName(open, naming)}
          </text>
        </g>
      ))}
      {Array.from({ length: frets }, (_, k) => k + 1)
        .filter((f) => f === 1 || INLAYS.includes(f) || f === 12)
        .map((f) => (
          <text key={f} x={xCenter(f)} y={H - 3} className="fb-num">
            {f}
          </text>
        ))}
      {marks.map((m, i) => (
        <g key={i} opacity={0.35 + 0.65 * (m.strength ?? 1)}>
          <circle cx={xCenter(Math.min(m.fret, frets))} cy={yOf(m.string)} r={10} fill={m.color} className="fb-mark" />
          {m.label && (
            <text x={xCenter(Math.min(m.fret, frets))} y={yOf(m.string) + 4} className="fb-mark-label">
              {m.label}
            </text>
          )}
        </g>
      ))}
    </svg>
  );
}
