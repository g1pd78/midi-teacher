import { create } from "zustand";
import { useEffect, useRef } from "react";
import {
  api,
  listen,
  type AudioConfig,
  type AudioDevices,
  type AudioStatus,
  type DevicesSnapshot,
  type MidiEvent,
  type UiPrefs,
} from "./api";

export interface HeldNote {
  device: string;
  velocity: number;
}

export interface LastNote {
  note: number;
  velocity: number;
  device: string;
}

const LOG_SIZE = 80;

interface AppStore {
  ready: boolean;
  prefs: UiPrefs;
  audioConfig: AudioConfig;
  customSoundfont: string | null;
  devices: DevicesSnapshot;
  audio: AudioStatus | null;
  audioDevices: AudioDevices;
  /** Нажатые сейчас клавиши (со всех устройств и с экрана). */
  held: Record<number, HeldNote>;
  lastNote: LastNote | null;
  sustain: boolean;
  log: MidiEvent[];

  init: () => Promise<void>;
  setPrefs: (patch: Partial<UiPrefs>) => void;
  setAudioConfig: (patch: Partial<AudioConfig>) => void;
  refreshAudioDevices: () => Promise<void>;
  pressScreenKey: (note: number, on: boolean) => void;
}

export const SCREEN_DEVICE = "Экранная клавиатура";

/**
 * Запись настроек на диск: первая правка — сразу, серия правок подряд (ползунок темпа, переключатели)
 * — одной записью в конце серии, а не файлом на каждое движение.
 */
const SAVE_GAP_MS = 150;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let pendingPrefs: UiPrefs | null = null;
function savePrefs(prefs: UiPrefs) {
  if (saveTimer) {
    pendingPrefs = prefs;
    return;
  }
  void api.setPrefs(prefs);
  const tick = () => {
    if (pendingPrefs) {
      void api.setPrefs(pendingPrefs);
      pendingPrefs = null;
      saveTimer = setTimeout(tick, SAVE_GAP_MS);
    } else saveTimer = null;
  };
  saveTimer = setTimeout(tick, SAVE_GAP_MS);
}
if (typeof window !== "undefined")
  window.addEventListener("pagehide", () => {
    if (pendingPrefs) void api.setPrefs(pendingPrefs);
    pendingPrefs = null;
  });

export const useApp = create<AppStore>((set, get) => ({
  ready: false,
  prefs: {
    noteNames: "solfege",
    wizardDone: true,
    trainer: { layout: "single", errorMode: "wait", names: "struggle" },
    theorySeen: [],
    pieceSetup: {},
    piece: { guided: true, heat: false, layout: "line", hands: "right", accompany: true, names: false, fingering: true, keyHints: true, mode: "wait", tempo: 0.8, countIn: true, metronome: false, waterfall: true },
  },
  audioConfig: { backend: "auto", device: null, bufferFrames: 128, volume: 0.8 },
  customSoundfont: null,
  devices: { inputs: [], outputs: [], appRoute: { kind: "internal" }, appChannel: 0, internalSoundNeeded: true, pads: [], lights: { enabled: true, port: null, brightness: 25, showPresses: true }, lightsPort: null },
  audio: null,
  audioDevices: { asio: [], system: [] },
  held: {},
  lastNote: null,
  sustain: false,
  log: [],

  init: async () => {
    const s = await api.getState();
    set({
      ready: true,
      prefs: s.prefs,
      audioConfig: s.audioConfig,
      customSoundfont: s.customSoundfont,
      devices: s.devices,
      audio: s.audio,
      audioDevices: s.audioDevices,
    });
    await listen("devices", (devices) =>
      set((st) => {
        // Отключённое устройство не пришлёт «отпущено» — его клавиши не должны залипнуть.
        const gone = new Set(devices.inputs.filter((d) => !d.connected).map((d) => d.name));
        const stuck = Object.entries(st.held).filter(([, h]) => gone.has(h.device));
        if (!stuck.length) return { devices };
        const held = { ...st.held };
        for (const [k] of stuck) delete held[Number(k)];
        return { devices, held };
      }),
    );
    await listen("audio", (audio) => set({ audio }));
    await listen("midi", (ev) => {
      set((st) => {
        const log = [ev, ...st.log].slice(0, LOG_SIZE);
        if (ev.type === "noteOn") {
          return {
            log,
            held: { ...st.held, [ev.note]: { device: ev.device, velocity: ev.velocity } },
            lastNote: { note: ev.note, velocity: ev.velocity, device: ev.device },
          };
        }
        if (ev.type === "noteOff") {
          const held = { ...st.held };
          delete held[ev.note];
          return { log, held };
        }
        if (ev.controller === 64) return { log, sustain: ev.value >= 64 };
        return { log };
      });
    });
  },

  setPrefs: (patch) => {
    const prefs = { ...get().prefs, ...patch };
    set({ prefs });
    savePrefs(prefs);
  },

  setAudioConfig: (patch) => {
    const audioConfig = { ...get().audioConfig, ...patch };
    set({ audioConfig });
    void api.setAudioConfig(audioConfig);
  },

  refreshAudioDevices: async () => set({ audioDevices: await api.listAudioDevices() }),

  pressScreenKey: (note, on) => {
    void api.playNote(note, 90, on);
    set((st) => {
      const held = { ...st.held };
      if (on) held[note] = { device: SCREEN_DEVICE, velocity: 90 };
      else delete held[note];
      return on ? { held, lastNote: { note, velocity: 90, device: SCREEN_DEVICE } } : { held };
    });
  },
}));

/** Подписка на MIDI-события на время жизни компонента. */
export function useMidi(cb: (ev: MidiEvent) => void) {
  const ref = useRef(cb);
  ref.current = cb;
  useEffect(() => {
    let off: (() => void) | undefined;
    let alive = true;
    void listen("midi", (ev) => ref.current(ev)).then((fn) => {
      if (alive) off = fn;
      else fn();
    });
    return () => {
      alive = false;
      off?.();
    };
  }, []);
}

/** Цвет устройства для подсветки клавиш. */
const DEVICE_COLORS = ["#5AA9FF", "#FFB454", "#4CC38A", "#C792EA"];
export function deviceColor(device: string, devices: DevicesSnapshot): string {
  if (device === SCREEN_DEVICE) return "#4CC38A";
  const i = devices.inputs.findIndex((d) => d.name === device);
  return DEVICE_COLORS[(i < 0 ? 0 : i) % DEVICE_COLORS.length];
}
