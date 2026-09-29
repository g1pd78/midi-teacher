// Имитация Rust-ядра для запуска интерфейса в обычном браузере.
//
// Два «устройства»: «Демо-пианино» (есть выход, как у цифрового пианино)
// и «Демо-клавиатура». Клавиши компьютера играют ноты:
//   нижний ряд Z S X D C V G B H N J M ,  → до–до малой октавы (демо-клавиатура)
//   верхний ряд Q 2 W 3 E R 5 T 6 Y 7 U I → до–до первой октавы (демо-пианино)

import type {
  AudioStatus,
  DevicesSnapshot,
  Events,
  FullState,
  InputSettings,
  MidiEvent,
  SoundRoute,
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
    prefs: { noteNames: "solfege", wizardDone: new URLSearchParams(location.search).has("done") },
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
  const send = (device: string, ev: Body) =>
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

  const handlers: Record<string, (args: Record<string, never>) => unknown> = {
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
