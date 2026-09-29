import { useMemo, useRef } from "react";
import { keyboardLayout, keyLabel, type NoteNaming } from "../lib/notes";

export interface PianoProps {
  low?: number;
  high?: number;
  /** Подсветка: нота → цвет. */
  highlight?: Record<number, { color: string; strength?: number }>;
  naming: NoteNaming;
  /** Подписи: только на «до» или на всех белых клавишах. */
  labels?: "c" | "all" | "none";
  onPress?: (note: number, on: boolean) => void;
  /** Затемнить клавиши вне диапазона инструмента. */
  playable?: [number, number] | null;
}

export function Piano({ low = 21, high = 108, highlight = {}, naming, labels = "c", onPress, playable }: PianoProps) {
  const keys = useMemo(() => keyboardLayout(low, high), [low, high]);
  const down = useRef<number | null>(null);

  const press = (note: number) => {
    if (down.current === note) return;
    if (down.current !== null) onPress?.(down.current, false);
    down.current = note;
    onPress?.(note, true);
  };
  const release = () => {
    if (down.current !== null) onPress?.(down.current, false);
    down.current = null;
  };

  return (
    <div className="piano" onPointerUp={release} onPointerLeave={release} role="group" aria-label="Клавиатура">
      {keys.map((k) => {
        const h = highlight[k.note];
        const outside = playable && (k.note < playable[0] || k.note > playable[1]);
        const showLabel = !k.black && (labels === "all" || (labels === "c" && k.note % 12 === 0));
        return (
          <div
            key={k.note}
            className={`key ${k.black ? "black" : "white"}${h ? " active" : ""}${outside ? " outside" : ""}`}
            style={{
              left: `${k.x * 100}%`,
              width: `${k.width * 100}%`,
              ...(h ? ({ "--key-color": h.color, "--key-strength": h.strength ?? 1 } as React.CSSProperties) : {}),
            }}
            onPointerDown={(e) => {
              (e.target as HTMLElement).releasePointerCapture?.(e.pointerId);
              press(k.note);
            }}
            onPointerEnter={(e) => e.buttons === 1 && press(k.note)}
            data-note={k.note}
          >
            {showLabel && <span className="key-label">{keyLabel(k.note, naming)}</span>}
          </div>
        );
      })}
    </div>
  );
}
