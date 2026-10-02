import { useEffect, useState } from "react";
import { useApp } from "./store";
import { Header } from "./components/Header";
import { Hotkeys } from "./components/Hotkeys";
import { Home } from "./screens/Home";
import { Exercises } from "./screens/Exercises";
import { Guitar } from "./screens/Guitar";
import { Drums } from "./screens/Drums";
import { Studio } from "./screens/Studio";
import { Pieces } from "./screens/Pieces";
import { Progress } from "./screens/Progress";
import { Reference } from "./screens/Reference";
import { Settings } from "./screens/Settings";
import { Trainers, type TrainerSection } from "./screens/Trainers";
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
  // «Тренажёры»: открытый раздел и запуск текущей ступени с главной.
  const [trainerSection, setTrainerSection] = useState<TrainerSection>("notes");
  const [drillReq, setDrillReq] = useState(false);
  // Окно горячих клавиш: «?» или F1 на любом экране.
  const [help, setHelp] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (e.key === "?" || e.key === "F1") {
        e.preventDefault();
        setHelp(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    init().catch((e) => setError(String(e)));
  }, [init]);

  if (error) return <div className="fatal">Не удалось запустить ядро приложения: {error}</div>;
  if (!ready) return <div className="loading">Загрузка…</div>;
  if (!prefs.wizardDone) return <Wizard />;

  return (
    <div className="app">
      <Header screen={screen} onNavigate={setScreen} onHelp={() => setHelp(true)} />
      {help && <Hotkeys onClose={() => setHelp(false)} />}
      {screen === "home" && (
        <Home
          onNavigate={setScreen}
          today={{
            warmup: () => {
              setWarmupReq(true);
              setScreen("exercises");
            },
            trainer: () => {
              setTrainerSection("notes");
              setScreen("trainer");
            },
            reading: () => {
              setTrainerSection("reading");
              setDrillReq(true);
              setScreen("trainer");
            },
            rhythm: () => {
              setTrainerSection("rhythm");
              setDrillReq(true);
              setScreen("trainer");
            },
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
      {screen === "trainer" && (
        <Trainers
          section={trainerSection}
          onSection={setTrainerSection}
          autoStart={drillReq}
          onAutoStarted={() => setDrillReq(false)}
        />
      )}
      {screen === "reference" && <Reference />}
      {screen === "guitar" && <Guitar />}
      {screen === "drums" && <Drums />}
      {screen === "studio" && <Studio />}
      {screen === "settings" && <Settings />}
    </div>
  );
}
