import { useEffect } from "react";

const GROUPS: { title: string; keys: [string, string][] }[] = [
  {
    title: "Везде",
    keys: [
      ["?  или  F1", "это окно"],
      ["Esc", "закрыть окно, выйти из режима правки, назад к списку"],
    ],
  },
  {
    title: "Пьеса, упражнение, барабаны, чтение с листа, ритм",
    keys: [
      ["Пробел", "старт / стоп (в режиме «Ритм» / «В темпе»)"],
      ["R", "заново"],
      ["1 / 2 / 3", "правая / левая / обе руки (в «Свободно»)"],
      ["+ / −", "темп на 5%"],
      ["H", "показать / скрыть падающие ноты (дорожку)"],
      ["← / →", "соседний отрезок (в «Разучить»)"],
      ["Enter", "принять предложение уровня"],
      ["Esc", "сбросить цикл тактов, убрать предложение, к списку"],
    ],
  },
  {
    title: "Режим «Пальцы…»",
    keys: [
      ["1–5", "палец выбранной ноты"],
      ["0 / Delete", "убрать свою правку"],
      ["← / →", "соседняя нота"],
      ["Esc", "готово"],
    ],
  },
  {
    title: "Студия",
    keys: [["Пробел", "играть / стоп (во время записи — стоп и дубль)"]],
  },
];

/** Окно с горячими клавишами всех экранов. */
export function Hotkeys({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    // Пока окно открыто, клавиши не доходят до экрана (Пробел не запустит пьесу).
    const onKey = (e: KeyboardEvent) => {
      e.stopImmediatePropagation();
      if (e.key !== "Escape" && e.key !== "?" && e.key !== "F1") return;
      e.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);
  return (
    <div className="theory-modal" onClick={onClose} data-hotkeys>
      <div className="card hotkeys-card" onClick={(e) => e.stopPropagation()}>
        <h2>Горячие клавиши</h2>
        <div className="hotkeys-grid">
          {GROUPS.map((g) => (
            <section key={g.title}>
              <h3>{g.title}</h3>
              <table>
                <tbody>
                  {g.keys.map(([k, v]) => (
                    <tr key={k + v}>
                      <td>
                        <kbd>{k}</kbd>
                      </td>
                      <td>{v}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          ))}
        </div>
        <div className="summary-actions">
          <button className="primary" onClick={onClose}>
            Понятно
          </button>
        </div>
      </div>
    </div>
  );
}
