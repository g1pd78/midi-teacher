/** Пэды ритма: одна или две большие площадки (правая и левая рука), подсвечиваются от нажатий. */
export function RhythmPads({
  two,
  lit,
  onHit,
}: {
  two: boolean;
  /** Какие строки сейчас нажаты: «R» и/или «L». */
  lit: Set<"R" | "L">;
  onHit: (lane: "R" | "L") => void;
}) {
  const pads: { lane: "R" | "L"; title: string; hint: string }[] = two
    ? [
        { lane: "L", title: "Левая", hint: "клавиши ниже до первой октавы · бочка, томы" },
        { lane: "R", title: "Правая", hint: "до первой октавы и выше · малый, тарелки" },
      ]
    : [{ lane: "R", title: "Любая клавиша или пэд", hint: "важно только, когда нажал" }];
  return (
    <div className={`rhythm-pads${two ? " two" : ""}`}>
      {pads.map((p) => (
        <button
          key={p.lane}
          className={`rhythm-pad lane-${p.lane}${lit.has(p.lane) ? " lit" : ""}`}
          onPointerDown={(e) => {
            e.preventDefault();
            onHit(p.lane);
          }}
          data-rhythm-pad={p.lane}
        >
          <b>{p.title}</b>
          <span>{p.hint}</span>
        </button>
      ))}
    </div>
  );
}
