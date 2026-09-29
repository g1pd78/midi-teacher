// Имитация Rust-ядра для запуска интерфейса в обычном браузере.
//
// Два «устройства»: «Демо-пианино» (есть выход, как у цифрового пианино)
// и «Демо-клавиатура». Клавиши компьютера играют ноты:
//   нижний ряд Z S X D C V G B H N J M ,  → до–до малой октавы (демо-клавиатура)
//   верхний ряд Q 2 W 3 E R 5 T 6 Y 7 U I → до–до первой октавы (демо-пианино)

import type {
  AudioStatus,
  Clef,
  DevicesSnapshot,
  ErrorMode,
  Events,
  FullState,
  InputSettings,
  MidiEvent,
  SoundRoute,
  TrainerLevel,
  TrainerTarget,
} from "./api";

type Listener = (payload: never) => void;

const LOWER = ["z", "s", "x", "d", "c", "v", "g", "b", "h", "n", "j", "m", ","];
const UPPER = ["q", "2", "w", "3", "e", "r", "5", "t", "6", "y", "7", "u", "i"];

export function createMock() {
  const listeners = new Map<string, Set<Listener>>();
  const emit = <K extends keyof Events>(event: K, payload: Events[K]) =>
    listeners.get(event)?.forEach((cb) => (cb as (p: Events[K]) => void)(payload));

  const start = performance.now();
  const inputs: Record<string, InputSettings> = {
    "Демо-пианино": { enabled: true, route: { kind: "internal" }, range: null },
    "Демо-клавиатура": { enabled: true, route: { kind: "internal" }, range: null },
  };
  let appRoute: SoundRoute = { kind: "internal" };
  let appChannel = 0;

  const state: Omit<FullState, "devices"> = {
    prefs: {
      noteNames: "solfege",
      wizardDone: new URLSearchParams(location.search).has("done"),
      trainer: { layout: "single", errorMode: "wait", names: "struggle" },
    },
    audioConfig: { backend: "auto", device: null, bufferFrames: 128, volume: 0.8 },
    customSoundfont: null,
    audio: {
      running: true,
      suspended: false,
      backend: "WASAPI",
      device: "Динамики (демо)",
      sampleRate: 48000,
      channels: 2,
      bufferFrames: 128,
      synth: "SoundFont: YDP-GrandPiano.sf2",
      error: null,
      notice: null,
      asioSupported: true,
    } satisfies AudioStatus,
    audioDevices: { asio: [], system: ["Динамики (демо)", "Наушники (демо)"] },
  };

  const snapshot = (): DevicesSnapshot => {
    const connected = Object.entries(inputs).filter(([, s]) => s.enabled);
    return {
      inputs: Object.entries(inputs).map(([name, settings]) => ({
        name,
        available: true,
        connected: settings.enabled,
        error: null,
        settings,
        matchingOutput: name === "Демо-пианино" ? "Демо-пианино" : null,
      })),
      outputs: ["Демо-пианино"],
      appRoute,
      appChannel,
      internalSoundNeeded:
        appRoute.kind === "internal" || connected.some(([, s]) => s.route.kind === "internal"),
    };
  };

  type Body = { type: "noteOn"; note: number; velocity: number } | { type: "noteOff"; note: number };
  const send = (device: string, ev: Body) => {
    if (ev.type === "noteOn") judge(ev.note);
    emitMidi(device, ev);
  };
  const emitMidi = (device: string, ev: Body) =>
    emit("midi", {
      device,
      channel: 0,
      timeUs: Math.round((performance.now() - start) * 1000),
      ...ev,
    } as MidiEvent);

  const held = new Set<string>();
  if (typeof window !== "undefined") {
    window.addEventListener("keydown", (e) => {
      if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
      if ((e.target as HTMLElement)?.tagName === "INPUT") return;
      const key = e.key.toLowerCase();
      const lo = LOWER.indexOf(key);
      const hi = UPPER.indexOf(key);
      if (lo < 0 && hi < 0) return;
      held.add(key);
      const [device, note] = lo >= 0 ? ["Демо-клавиатура", 48 + lo] : ["Демо-пианино", 60 + hi];
      if (inputs[device].enabled) send(device, { type: "noteOn", note, velocity: 70 + Math.round(Math.random() * 40) });
    });
    window.addEventListener("keyup", (e) => {
      const key = e.key.toLowerCase();
      if (!held.delete(key)) return;
      const lo = LOWER.indexOf(key);
      const [device, note] = lo >= 0 ? ["Демо-клавиатура", 48 + lo] : ["Демо-пианино", 60 + UPPER.indexOf(key)];
      send(device, { type: "noteOff", note });
    });
  }

  // --- Тренажёр (упрощённая копия логики ядра) ---
  const levels: TrainerLevel[] = MOCK_LEVELS.map(([id, title, description, grandStaff, lo, hi, clef]) => ({
    id,
    title,
    description,
    grandStaff,
    pool: range(lo, hi)
      .filter((m) => id === 9 || isWhite(m))
      .map((m) => [m, clef ?? (m >= 60 ? "treble" : "bass")] as [number, Clef]),
  }));
  let unlocked = new URLSearchParams(location.search).has("all") ? 9 : 3;
  let session: { level: number; mode: ErrorMode; targets: TrainerTarget[]; index: number; errors: number; since: number; firstTry: number; total: number } | null = null;

  function judge(note: number) {
    if (!session) return;
    const t = session.targets[session.index];
    const reactionMs = Math.round(performance.now() - session.since);
    const index = session.index;
    let feedback: Events["trainer"]["feedback"];
    if (note === t.midi) {
      if (session.errors === 0) session.firstTry++;
      session.total += reactionMs;
      session.index++;
      session.errors = 0;
      session.since = performance.now();
      feedback = { kind: "correct", index, reactionMs };
    } else {
      session.errors++;
      const advanced = session.mode === "advance";
      if (advanced) {
        session.total += reactionMs;
        session.index++;
        session.errors = 0;
        session.since = performance.now();
      }
      feedback = { kind: "wrong", index, played: note, expected: t.midi, hint: advanced || session.errors >= 2, advanced };
    }
    let finished = null;
    if (session.index >= session.targets.length) {
      const n = session.targets.length;
      const accuracy = session.firstTry / n;
      const avg = Math.round(session.total / n);
      const passed = accuracy >= 0.9 && avg <= 2000;
      const unlockedLevel = passed && session.level >= unlocked && session.level < 9 ? session.level + 1 : null;
      if (unlockedLevel) unlocked = unlockedLevel;
      finished = { level: session.level, notes: n, firstTry: session.firstTry, accuracy, avgReactionMs: avg, trouble: [], passed, unlockedLevel };
      session = null;
    }
    emit("trainer", { feedback, finished });
  }

  const handlers: Record<string, (args: Record<string, never>) => unknown> = {
    trainer_overview: () => ({
      levels,
      unlocked,
      levelStats: [
        { level: 1, sessions: 4, bestAccuracy: 1, lastAccuracy: 0.95, lastReactionMs: 900, passed: true },
        { level: 2, sessions: 2, bestAccuracy: 0.92, lastAccuracy: 0.92, lastReactionMs: 1400, passed: true },
        { level: 3, sessions: 1, bestAccuracy: 0.7, lastAccuracy: 0.7, lastReactionMs: 2300, passed: false },
      ],
      noteStats: [60, 62, 64, 65, 67, 69, 71, 72].map((midi, i) => ({
        clef: "treble",
        midi,
        attempts: 10,
        accuracy: [1, 0.95, 0.9, 0.6, 0.85, 0.7, 0.5, 0.9][i],
        avgReactionMs: 900 + i * 150,
      })),
      passAccuracy: 0.9,
      passReactionMs: 2000,
      storageError: false,
    }),
    trainer_start: ({ level, mode, count }) => {
      const lvl = levels.find((l) => l.id === (level as number))!;
      const targets: TrainerTarget[] = [];
      for (let i = 0; i < ((count as number) || 20); i++) {
        let pick: [number, Clef];
        do pick = lvl.pool[Math.floor(Math.random() * lvl.pool.length)];
        while (lvl.pool.length > 1 && targets.length && pick[0] === targets[targets.length - 1].midi);
        targets.push(spellMock(`t${i}`, pick[0], pick[1]));
      }
      session = { level: level as number, mode: mode as ErrorMode, targets, index: 0, errors: 0, since: performance.now(), firstTry: 0, total: 0 };
      // Для скриптов скриншотов: какую ноту ждёт серия.
      (window as unknown as { __mockTrainer: () => number | null }).__mockTrainer = () =>
        session ? session.targets[session.index].midi : null;
      return { level, mode, grandStaff: lvl.grandStaff, targets };
    },
    trainer_ready: () => {
      if (session) session.since = performance.now();
    },
    trainer_stop: () => {
      session = null;
    },
    get_state: () => ({ ...state, devices: snapshot() }),
    get_audio_meters: () => ({
      outputLatencyMs: 5.3 + Math.random() * 0.4,
      lastCallbackFrames: 128,
      xruns: 0,
    }),
    list_audio_devices: () => state.audioDevices,
    set_input: ({ name, input }) => {
      inputs[name] = input;
      emit("devices", snapshot());
    },
    set_app_route: ({ route, channel }) => {
      appRoute = route;
      appChannel = channel;
      emit("devices", snapshot());
    },
    set_audio_config: ({ config }) => {
      state.audioConfig = config;
    },
    set_prefs: ({ prefs }) => {
      state.prefs = prefs;
    },
    load_soundfont: () => "SoundFont: YDP-GrandPiano.sf2",
    use_fallback_synth: () => {
      state.audio = { ...state.audio, synth: "Встроенный простой синтез" };
      emit("audio", state.audio);
    },
    play_note: () => undefined,
    rescan_devices: () => snapshot(),
    simulate_midi: () => undefined,
  };

  return {
    invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
      const h = handlers[cmd];
      if (!h) return Promise.reject(new Error(`mock: нет команды ${cmd}`));
      return Promise.resolve(h((args ?? {}) as Record<string, never>) as T);
    },
    listen<K extends keyof Events>(event: K, cb: (payload: Events[K]) => void) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(cb as Listener);
      return () => listeners.get(event)?.delete(cb as Listener);
    },
  };
}

const MOCK_LEVELS: [number, string, string, boolean, number, number, Clef | null][] = [
  [1, "До–соль первой октавы", "Скрипичный ключ, пять нот под правую руку", false, 60, 67, "treble"],
  [2, "Первая октава", "Скрипичный ключ, от до до до", false, 60, 72, "treble"],
  [3, "Весь скрипичный ключ", "От до первой до соль второй октавы", false, 60, 79, "treble"],
  [4, "Фа малой – до первой", "Басовый ключ, пять нот под левую руку", false, 53, 60, "bass"],
  [5, "Малая октава", "Басовый ключ, от до до до", false, 48, 60, "bass"],
  [6, "Весь басовый ключ", "От соль большой до до первой октавы", false, 43, 60, "bass"],
  [7, "Оба ключа", "Фортепианная система: ноты в обоих ключах вперемешку", true, 43, 79, null],
  [8, "Добавочные линейки", "Ноты над и под нотным станом", true, 36, 84, null],
  [9, "Диезы и бемоли", "Чёрные клавиши: знаки альтерации в обоих ключах", true, 48, 72, null],
];

const STEP_NAMES = ["c", "c", "d", "d", "e", "f", "f", "g", "g", "a", "a", "b"];

function isWhite(m: number): boolean {
  return ![1, 3, 6, 8, 10].includes(m % 12);
}

function range(lo: number, hi: number): number[] {
  return Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
}

function spellMock(id: string, midi: number, clef: Clef): TrainerTarget {
  if (isWhite(midi)) return { id, midi, clef, step: STEP_NAMES[midi % 12], alter: 0, octave: Math.floor(midi / 12) - 1 };
  const sharp = Math.random() < 0.5;
  const base = sharp ? midi - 1 : midi + 1;
  return { id, midi, clef, step: STEP_NAMES[base % 12], alter: sharp ? 1 : -1, octave: Math.floor(base / 12) - 1 };
}
