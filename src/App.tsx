import { lazy, Suspense, useEffect, useState } from "react";
import { useApp } from "./store";
import { Header } from "./components/Header";
import { Hotkeys } from "./components/Hotkeys";
import { Home } from "./screens/Home";
import type { ExInstrument } from "./screens/Exercises";
import type { TrainerSection } from "./screens/Trainers";
import { Wizard } from "./screens/Wizard";

// Разделы грузятся отдельно: при запуске — только главная, остальное подгружается в фоне сразу после.
const screens = {
  exercises: () => import("./screens/Exercises"),
  guitar: () => import("./screens/Guitar"),
  drums: () => import("./screens/Drums"),
  studio: () => import("./screens/Studio"),
  pieces: () => import("./screens/Pieces"),
  progress: () => import("./screens/Progress"),
  reference: () => import("./screens/Reference"),
  settings: () => import("./screens/Settings"),
  trainers: () => import("./screens/Trainers"),
  course: () => import("./screens/Course"),
  journal: () => import("./screens/Journal"),
  code: () => import("./screens/Code"),
};
const Exercises = lazy(() => screens.exercises().then((m) => ({ default: m.Exercises })));
const Guitar = lazy(() => screens.guitar().then((m) => ({ default: m.Guitar })));
const Drums = lazy(() => screens.drums().then((m) => ({ default: m.Drums })));
const Studio = lazy(() => screens.studio().then((m) => ({ default: m.Studio })));
const Pieces = lazy(() => screens.pieces().then((m) => ({ default: m.Pieces })));
const Progress = lazy(() => screens.progress().then((m) => ({ default: m.Progress })));
const Reference = lazy(() => screens.reference().then((m) => ({ default: m.Reference })));
const Settings = lazy(() => screens.settings().then((m) => ({ default: m.Settings })));
const Trainers = lazy(() => screens.trainers().then((m) => ({ default: m.Trainers })));
const Course = lazy(() => screens.course().then((m) => ({ default: m.Course })));
const Journal = lazy(() => screens.journal().then((m) => ({ default: m.Journal })));
const Code = lazy(() => screens.code().then((m) => ({ default: m.Code })));

export type Screen = "home" | "course" | "journal" | "pieces" | "exercises" | "trainer" | "guitar" | "drums" | "studio" | "code" | "reference" | "progress" | "settings";

export function App() {
  const { ready, init, prefs } = useApp();
  const [screen, setScreen] = useState<Screen>("home");
  const [error, setError] = useState<string | null>(null);
  // Пьеса, которую открыть в разделе «Пьесы» (переход с экрана «Прогресс»).
  const [openPiece, setOpenPiece] = useState<string | null>(null);
  // Разминка по кнопке с главного экрана.
  const [warmupReq, setWarmupReq] = useState(false);
  const [exInstrument, setExInstrument] = useState<ExInstrument | undefined>(undefined);
  // «Тренажёры»: открытый раздел и запуск текущей ступени с главной.
  const [trainerSection, setTrainerSection] = useState<TrainerSection>("notes");
  const [drillReq, setDrillReq] = useState(false);
  // «Курс»: открыть текущий урок с главной.
  const [courseReq, setCourseReq] = useState(false);
  // «Дневник»: прокрутить к плану или повторению (переход с главной).
  const [journalFocus, setJournalFocus] = useState<"plan" | "review" | null>(null);
  // Окно горячих клавиш: «?» или F1 на любом экране.
  const [help, setHelp] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || (e.target as HTMLElement)?.isContentEditable) return;
      if (e.key === "?" || e.key === "F1") {
        e.preventDefault();
        setHelp(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // «В код» с любого экрана — перейти на вкладку «Код» (запрос забирает она сама).
  useEffect(() => {
    const onCode = () => setScreen("code");
    window.addEventListener("mt-open-code", onCode);
    return () => window.removeEventListener("mt-open-code", onCode);
  }, []);
  useEffect(() => {
    init().catch((e) => setError(String(e)));
  }, [init]);
  // Когда главная показана — подгрузить остальные разделы, чтобы переходы были мгновенными.
  useEffect(() => {
    if (!ready) return;
    const t = setTimeout(() => Object.values(screens).forEach((load) => void load().catch(() => {})), 300);
    return () => clearTimeout(t);
  }, [ready]);

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
            course: () => {
              setCourseReq(true);
              setScreen("course");
            },
            warmup: () => {
              setExInstrument("piano");
              setWarmupReq(true);
              setScreen("exercises");
            },
            guitar: (inst) => {
              setExInstrument(inst);
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
            ear: () => {
              setTrainerSection("ear");
              setDrillReq(true);
              setScreen("trainer");
            },
            piece: (id) => {
              setOpenPiece(id);
              setScreen("pieces");
            },
            journal: (focus) => {
              setJournalFocus(focus);
              setScreen("journal");
            },
          }}
        />
      )}
      <Suspense fallback={<div className="loading">Загрузка…</div>}>
      {screen === "course" && <Course openLesson={courseReq} onOpened={() => setCourseReq(false)} />}
      {screen === "journal" && (
        <Journal
          focus={journalFocus}
          onFocused={() => setJournalFocus(null)}
          onOpenPiece={(id) => {
            setOpenPiece(id);
            setScreen("pieces");
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
      {screen === "exercises" && <Exercises startWarmup={warmupReq} onWarmupStarted={() => setWarmupReq(false)} instrument={exInstrument} />}
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
      {screen === "code" && <Code />}
      {screen === "settings" && <Settings />}
      </Suspense>
    </div>
  );
}
