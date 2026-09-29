import { useEffect, useState } from "react";
import { useApp } from "./store";
import { Header } from "./components/Header";
import { Home } from "./screens/Home";
import { Pieces } from "./screens/Pieces";
import { Settings } from "./screens/Settings";
import { Trainer } from "./screens/Trainer";
import { Wizard } from "./screens/Wizard";

export type Screen = "home" | "pieces" | "trainer" | "settings";

export function App() {
  const { ready, init, prefs } = useApp();
  const [screen, setScreen] = useState<Screen>("home");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    init().catch((e) => setError(String(e)));
  }, [init]);

  if (error) return <div className="fatal">Не удалось запустить ядро приложения: {error}</div>;
  if (!ready) return <div className="loading">Загрузка…</div>;
  if (!prefs.wizardDone) return <Wizard />;

  return (
    <div className="app">
      <Header screen={screen} onNavigate={setScreen} />
      {screen === "home" && <Home onNavigate={setScreen} />}
      {screen === "pieces" && <Pieces />}
      {screen === "trainer" && <Trainer />}
      {screen === "settings" && <Settings />}
    </div>
  );
}
