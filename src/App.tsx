import { useEffect, useState } from "react";
import { useApp } from "./store";
import { Header } from "./components/Header";
import { Home } from "./screens/Home";
import { Exercises } from "./screens/Exercises";
import { Guitar } from "./screens/Guitar";
import { Drums } from "./screens/Drums";
import { Studio } from "./screens/Studio";
import { Pieces } from "./screens/Pieces";
import { Progress } from "./screens/Progress";
import { Reference } from "./screens/Reference";
import { Settings } from "./screens/Settings";
import { Trainer } from "./screens/Trainer";
import { Wizard } from "./screens/Wizard";

export type Screen = "home" | "pieces" | "exercises" | "trainer" | "guitar" | "drums" | "studio" | "reference" | "progress" | "settings";

export function App() {
  const { ready, init, prefs } = useApp();
  const [screen, setScreen] = useState<Screen>("home");
  const [error, setError] = useState<string | null>(null);
  // Пьеса, которую открыть в разделе «Пьесы» (переход с экрана «Прогресс»).
  const [openPiece, setOpenPiece] = useState<string | null>(null);
  // Разминка по кнопке с главного экрана.
  const [warmupReq, setWarmupReq] = useState(false);

  useEffect(() => {
    init().catch((e) => setError(String(e)));
  }, [init]);

  if (error) return <div className="fatal">Не удалось запустить ядро приложения: {error}</div>;
  if (!ready) return <div className="loading">Загрузка…</div>;
  if (!prefs.wizardDone) return <Wizard />;

  return (
    <div className="app">
      <Header screen={screen} onNavigate={setScreen} />
      {screen === "home" && (
        <Home
          onNavigate={setScreen}
          today={{
            warmup: () => {
              setWarmupReq(true);
              setScreen("exercises");
            },
            trainer: () => setScreen("trainer"),
            piece: (id) => {
              setOpenPiece(id);
              setScreen("pieces");
            },
          }}
        />
      )}
      {screen === "pieces" && <Pieces initial={openPiece} onInitialOpened={() => setOpenPiece(null)} />}
      {screen === "progress" && (
        <Progress
          onOpenPiece={(id) => {
            setOpenPiece(id);
            setScreen("pieces");
          }}
        />
      )}
      {screen === "exercises" && <Exercises startWarmup={warmupReq} onWarmupStarted={() => setWarmupReq(false)} />}
      {screen === "trainer" && <Trainer />}
      {screen === "reference" && <Reference />}
      {screen === "guitar" && <Guitar />}
      {screen === "drums" && <Drums />}
      {screen === "studio" && <Studio />}
      {screen === "settings" && <Settings />}
    </div>
  );
}
