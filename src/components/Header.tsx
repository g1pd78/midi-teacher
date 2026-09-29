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
        <button className={screen === "settings" ? "tab active" : "tab"} onClick={() => onNavigate("settings")}>
          Устройства и звук
        </button>
      </nav>
    </header>
  );
}
