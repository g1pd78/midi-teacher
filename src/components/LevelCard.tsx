/**
 * Кнопка ступени тренажёра: «✓ 3. Название», описание и строка состояния.
 * Закрытая ступень недоступна и подписана «Откроется после предыдущей ступени».
 */
export function LevelCard({
  n,
  title,
  hint,
  status,
  passed,
  open,
  current,
  disabled,
  onClick,
  data,
}: {
  n: number;
  title: string;
  hint: React.ReactNode;
  /** Строка под описанием, когда ступень открыта (попытки, результат). */
  status: string;
  passed: boolean;
  open: boolean;
  /** Подсветить как следующую к прохождению. */
  current?: boolean;
  /** Недоступна и открытая (например, ещё не загрузился строй). */
  disabled?: boolean;
  onClick: () => void;
  /** data-атрибуты для сквозных тестов: { "fret-level": 1 } → data-fret-level="1". */
  data: Record<string, string | number>;
}) {
  const attrs = Object.fromEntries(Object.entries(data).map(([k, v]) => [`data-${k}`, v]));
  return (
    <button
      className={`drum-item${passed ? " passed" : open ? " open" : ""}${current ? " current" : ""}`}
      disabled={!open || disabled}
      onClick={onClick}
      {...attrs}
    >
      <span className="drum-item-title">
        {passed && "✓ "}
        {n}. {title}
      </span>
      <span className="drum-item-hint">{hint}</span>
      <span className="drum-item-hint muted">{open ? status : "Откроется после предыдущей ступени"}</span>
    </button>
  );
}
