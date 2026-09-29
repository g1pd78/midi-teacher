// Связь с Rust-ядром. Типы повторяют serde-структуры из mt-core и src-tauri.
//
// Вне Tauri (обычный браузер, `npm run dev`) используется имитация: клавиши
// компьютерной клавиатуры изображают MIDI-устройство. Это нужно для вёрстки
// и скриншотов без настоящего инструмента.

import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { listen as tauriListen, type UnlistenFn } from "@tauri-apps/api/event";
import { createMock } from "./mock";

export type SoundRoute = { kind: "internal" } | { kind: "silent" } | { kind: "output"; port: string };

export interface InputSettings {
  enabled: boolean;
  route: SoundRoute;
  range: [number, number] | null;
}

export interface InputInfo {
  name: string;
  available: boolean;
  connected: boolean;
  error: string | null;
  settings: InputSettings;
  matchingOutput: string | null;
}

export interface DevicesSnapshot {
  inputs: InputInfo[];
  outputs: string[];
  appRoute: SoundRoute;
  appChannel: number;
  internalSoundNeeded: boolean;
}

export type AudioBackend = "auto" | "asio" | "system";

export interface AudioConfig {
  backend: AudioBackend;
  device: string | null;
  bufferFrames: number | null;
  volume: number;
}

export interface AudioStatus {
  running: boolean;
  suspended: boolean;
  backend: string;
  device: string;
  sampleRate: number;
  channels: number;
  bufferFrames: number | null;
  synth: string;
  error: string | null;
  notice: string | null;
  asioSupported: boolean;
}

export interface AudioMeters {
  outputLatencyMs: number;
  lastCallbackFrames: number;
  xruns: number;
}

export interface AudioDevices {
  asio: string[];
  system: string[];
}

export type ErrorMode = "wait" | "advance";

export interface TrainerPrefs {
  layout: "single" | "lane";
  errorMode: ErrorMode;
  names: "always" | "struggle" | "never";
}

export interface UiPrefs {
  noteNames: "solfege" | "latin";
  wizardDone: boolean;
  trainer: TrainerPrefs;
}

export type Clef = "treble" | "bass";

export interface TrainerLevel {
  id: number;
  title: string;
  description: string;
  grandStaff: boolean;
  pool: [number, Clef][];
}

export interface LevelStat {
  level: number;
  sessions: number;
  bestAccuracy: number;
  lastAccuracy: number;
  lastReactionMs: number;
  passed: boolean;
}

export interface NoteStatView {
  clef: Clef;
  midi: number;
  attempts: number;
  accuracy: number;
  avgReactionMs: number;
}

export interface TrainerOverview {
  levels: TrainerLevel[];
  unlocked: number;
  levelStats: LevelStat[];
  noteStats: NoteStatView[];
  passAccuracy: number;
  passReactionMs: number;
  storageError: boolean;
}

export interface TrainerTarget {
  id: string;
  midi: number;
  clef: Clef;
  step: string;
  alter: number;
  octave: number;
}

export interface SessionView {
  level: number;
  mode: ErrorMode;
  grandStaff: boolean;
  targets: TrainerTarget[];
}

export type Feedback =
  | { kind: "correct"; index: number; reactionMs: number }
  | { kind: "wrong"; index: number; played: number; expected: number; hint: boolean; advanced: boolean };

export interface TrainerSummary {
  level: number;
  notes: number;
  firstTry: number;
  accuracy: number;
  avgReactionMs: number;
  trouble: { midi: number; clef: Clef; errors: number }[];
  passed: boolean;
  unlockedLevel: number | null;
}

export interface TrainerEvent {
  feedback: Feedback;
  finished: TrainerSummary | null;
}

export interface FullState {
  prefs: UiPrefs;
  audioConfig: AudioConfig;
  customSoundfont: string | null;
  devices: DevicesSnapshot;
  audio: AudioStatus;
  audioDevices: AudioDevices;
}

export type MidiEvent = { device: string; channel: number; timeUs: number } & (
  | { type: "noteOn"; note: number; velocity: number }
  | { type: "noteOff"; note: number }
  | { type: "controlChange"; controller: number; value: number }
);

export interface Events {
  midi: MidiEvent;
  devices: DevicesSnapshot;
  audio: AudioStatus;
  trainer: TrainerEvent;
}

export const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

const mock = inTauri ? null : createMock();

function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  return mock ? mock.invoke<T>(cmd, args) : tauriInvoke<T>(cmd, args);
}

export function listen<K extends keyof Events>(event: K, cb: (payload: Events[K]) => void): Promise<UnlistenFn> {
  if (mock) return Promise.resolve(mock.listen(event, cb));
  return tauriListen<Events[K]>(event, (e) => cb(e.payload));
}

export const api = {
  getState: () => invoke<FullState>("get_state"),
  getAudioMeters: () => invoke<AudioMeters>("get_audio_meters"),
  listAudioDevices: () => invoke<AudioDevices>("list_audio_devices"),
  setInput: (name: string, input: InputSettings) => invoke<void>("set_input", { name, input }),
  setAppRoute: (route: SoundRoute, channel: number) => invoke<void>("set_app_route", { route, channel }),
  setAudioConfig: (config: AudioConfig) => invoke<void>("set_audio_config", { config }),
  setPrefs: (prefs: UiPrefs) => invoke<void>("set_prefs", { prefs }),
  loadSoundfont: (path: string | null) => invoke<string>("load_soundfont", { path }),
  useFallbackSynth: () => invoke<void>("use_fallback_synth"),
  playNote: (note: number, velocity: number, on: boolean) => invoke<void>("play_note", { note, velocity, on }),
  rescanDevices: () => invoke<DevicesSnapshot>("rescan_devices"),
  simulateMidi: (device: string, bytes: number[]) => invoke<void>("simulate_midi", { device, bytes }),
  trainerOverview: () => invoke<TrainerOverview>("trainer_overview"),
  trainerStart: (level: number, mode: ErrorMode, count = 20) =>
    invoke<SessionView>("trainer_start", { level, mode, count }),
  trainerReady: () => invoke<void>("trainer_ready"),
  trainerStop: () => invoke<void>("trainer_stop"),
};

export async function pickSoundfont(): Promise<string | null> {
  if (!inTauri) return null;
  const { open } = await import("@tauri-apps/plugin-dialog");
  const res = await open({ multiple: false, filters: [{ name: "SoundFont", extensions: ["sf2"] }] });
  return typeof res === "string" ? res : null;
}

export async function openUrl(url: string): Promise<void> {
  if (!inTauri) {
    window.open(url, "_blank");
    return;
  }
  const { openUrl } = await import("@tauri-apps/plugin-opener");
  await openUrl(url);
}
