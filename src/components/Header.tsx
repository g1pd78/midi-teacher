import type { Screen } from "../App";
import { deviceColor, useApp } from "../store";

export function Header({ screen, onNavigate }: { screen: Screen; onNavigate: (s: Screen) => void }) {
  const { devices, audio } = useApp();
  const connected = devices.inputs.filter((d) => d.connected);
  const problems = devices.inputs.filter((d) => d.available && d.error);

  return (
    <header className="header">
      <button className="brand" onClick={() => onNavigate("home")}>
        <span className="brand-mark" aria-hidden>
          ♪
        </span>
        MIDI Teacher
      </button>

      <div className="header-status">
        {connected.length === 0 && <span className="chip muted">Инструменты не подключены</span>}
        {connected.map((d) => (
          <span key={d.name} className="chip" title={d.name}>
            <span className="dot" style={{ background: deviceColor(d.name, devices) }} />
            {d.name}
          </span>
        ))}
        {problems.map((d) => (
          <span key={d.name} className="chip warn" title={d.error ?? ""}>
            {d.name}: ошибка
          </span>
        ))}
        {audio?.error && <span className="chip warn">Звук: ошибка</span>}
      </div>

      <nav className="header-nav">
        <button className={screen === "home" ? "tab active" : "tab"} onClick={() => onNavigate("home")}>
          Главная
        </button>
        <button className={screen === "pieces" ? "tab active" : "tab"} onClick={() => onNavigate("pieces")}>
          Пьесы
        </button>
        <button className={screen === "exercises" ? "tab active" : "tab"} onClick={() => onNavigate("exercises")}>
          Упражнения
        </button>
        <button className={screen === "trainer" ? "tab active" : "tab"} onClick={() => onNavigate("trainer")}>
          Тренажёр нот
        </button>
        <button className={screen === "guitar" ? "tab active" : "tab"} onClick={() => onNavigate("guitar")}>
          Гитара
        </button>
        <button className={screen === "drums" ? "tab active" : "tab"} onClick={() => onNavigate("drums")}>
          Барабаны
        </button>
        <button className={screen === "reference" ? "tab active" : "tab"} onClick={() => onNavigate("reference")}>
          Справочник
        </button>
        <button className={screen === "progress" ? "tab active" : "tab"} onClick={() => onNavigate("progress")}>
          Прогресс
        </button>
        <button className={screen === "settings" ? "tab active" : "tab"} onClick={() => onNavigate("settings")}>
          Настройки
        </button>
      </nav>
    </header>
  );
}
