// Ведущий режим «Разучить»: отрезки, уровни подсказок, предложения перейти.

import type { PracticeView, Suggestion, UnitView } from "../../api";
import { LEVELS, STREAK_TO_ADVANCE, unitLabel } from "../../lib/practice";

/** Панель ведущего режима: отрезки в порядке разучивания и уровень подсказок. */
export function GuidePanel({
  practice,
  unit,
  editBounds,
  onSelect,
  onLevel,
  onEditBounds,
  editFingers,
  fingersAvailable = true,
  onEditFingers,
  status,
  toggles,
}: {
  practice: PracticeView;
  unit: UnitView;
  editBounds: boolean;
  onSelect: (i: number) => void;
  onLevel: (l: number) => void;
  onEditBounds: () => void;
  editFingers: boolean;
  fingersAvailable?: boolean;
  onEditFingers: () => void;
  status: React.ReactNode;
  toggles: React.ReactNode;
}) {
  const level = unit.state.level;
  return (
    <div className="guide">
      <div className="guide-units">
        <span className="muted">Отрезки</span>
        <span className="unit-chips" title="Порядок разучивания: фрагменты по одному и сцепки. ← / → — соседний отрезок">
          {practice.units.map((u, i) => (
            <button
              key={`${u.from}-${u.to}`}
              className={`unit-chip${u === unit ? " on" : ""}${u.state.learned ? " learned" : ""}${i === practice.current ? " current" : ""}${u.started ? "" : " fresh"}`}
              onClick={() => onSelect(i)}
              title={`Такты ${u.from}–${u.to} · уровень ${u.state.level} «${LEVELS[u.state.level].title}»${u.state.learned ? " · выучено" : ""}`}
              data-unit={`${u.from}-${u.to}`}
            >
              <b>{unitLabel(u.frags)}</b>
              <span className="level-dots">
                {[1, 2, 3, 4].map((l) => (
                  <i key={l} className={u.state.learned || l <= u.state.level ? "on" : ""} />
                ))}
              </span>
            </button>
          ))}
        </span>
        <button className={`small${editBounds ? " primary" : ""}`} onClick={onEditBounds}>
          Границы…
        </button>
        {fingersAvailable && (
          <button className={`small${editFingers ? " primary" : ""}`} onClick={onEditFingers} title="Поправить аппликатуру">
            Пальцы…
          </button>
        )}
      </div>
      <div className="guide-level">
        <span className="muted">
          Такты {unit.from}–{unit.to}
        </span>
        <span className="segmented level-seg">
          {LEVELS.map((l) => (
            <button key={l.id} className={l.id === level ? "on" : ""} onClick={() => onLevel(l.id)} title={l.description} data-level={l.id}>
              {l.id} {l.short}
            </button>
          ))}
        </span>
        <span className="guide-status">{status}</span>
        {toggles}
      </div>
      <div className="guide-hint">
        <b>{LEVELS[level].title}.</b> {LEVELS[level].description}
        {unit.state.learned && <span className="learned-mark"> Отрезок выучен ✓</span>}
      </div>
    </div>
  );
}

export function SuggestionBar({
  suggestion,
  unit,
  practice,
  onAccept,
  onDismiss,
}: {
  suggestion: Suggestion;
  unit: UnitView;
  practice: PracticeView | null;
  onAccept: () => void;
  onDismiss: () => void;
}) {
  let text: string;
  let accept: string;
  let stay: string;
  if (suggestion.kind === "levelUp") {
    text =
      unit.state.level === 0
        ? `Послушали. Попробуешь сыграть сам? Уровень ${suggestion.to} «${LEVELS[suggestion.to].title}».`
        : `${STREAK_TO_ADVANCE} прохода подряд без ошибок. Перейти на уровень ${suggestion.to} «${LEVELS[suggestion.to].title}»?`;
    accept = "Перейти";
    stay = "Ещё потренируюсь";
  } else if (suggestion.kind === "levelDown") {
    text = `Пока трудновато. Вернуться на уровень ${suggestion.to} «${LEVELS[suggestion.to].title}»?`;
    accept = "Вернуться";
    stay = "Продолжу здесь";
  } else {
    const next = practice?.units[practice.current];
    const done = !next || (next.from === unit.from && next.to === unit.to);
    text = done
      ? "Пьеса сыграна по памяти целиком. Отлично!"
      : `Такты ${unit.from}–${unit.to} выучены наизусть. Дальше: отрезок «${unitLabel(next!.frags)}» (такты ${next!.from}–${next!.to}).`;
    accept = done ? "Хорошо" : "Дальше";
    stay = "Повторить ещё";
  }
  return (
    <div className={`notice suggest ${suggestion.kind}`} data-suggestion={suggestion.kind}>
      <span>{text}</span>
      <span className="buttons">
        <button className="primary" onClick={onAccept} title="Enter">
          {accept}
        </button>
        <button onClick={onDismiss} title="Esc">
          {stay}
        </button>
      </span>
    </div>
  );
}
