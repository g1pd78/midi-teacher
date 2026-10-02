import { DRUMS, type DrumDef } from "../lib/drums";

/**
 * Восемь пэдов на экране — как на MIDI-клавиатуре (два ряда по четыре).
 * Подсвечены барабаны, по которым бить сейчас; нажатые вспыхивают. Клик — удар.
 */
export function DrumPads({
  expected,
  held,
  wrong,
  labels,
  onHit,
}: {
  /** Ноты GM, которые нужно сыграть сейчас. */
  expected: Set<number>;
  /** Ноты GM, которые сейчас звучат (удары по пэдам). */
  held: Set<number>;
  wrong?: number | null;
  /** Подписи пэдов (какой пэд клавиатуры назначен), если есть. */
  labels?: Map<number, string>;
  onHit?: (d: DrumDef) => void;
}) {
  // Верхний ряд — тарелки и томы, нижний — бочка, малый, хэт (как удобнее рукам на пэдах).
  const top = DRUMS.slice(4);
  const bottom = DRUMS.slice(0, 4);
  return (
    <div className="drum-pads" data-drum-pads>
      {[top, bottom].map((row, i) => (
        <div key={i} className="drum-pad-row">
          {row.map((d) => {
            const cls = [
              "drum-pad",
              expected.has(d.gm) ? "expected" : "",
              held.has(d.gm) ? "held" : "",
              wrong === d.gm ? "wrong" : "",
            ]
              .filter(Boolean)
              .join(" ");
            return (
              <button
                key={d.id}
                className={cls}
                style={{ "--pad": d.color } as React.CSSProperties}
                onPointerDown={(e) => {
                  e.preventDefault();
                  onHit?.(d);
                }}
                data-drum={d.id}
              >
                <span className="drum-pad-name">{d.name}</span>
                {labels?.get(d.gm) && <span className="drum-pad-key">{labels.get(d.gm)}</span>}
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}
