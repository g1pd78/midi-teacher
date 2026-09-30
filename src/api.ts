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

export type HandMode = "right" | "left" | "both";

export interface PiecePrefs {
  layout: "line" | "pages";
  hands: HandMode;
  accompany: boolean;
  names: boolean;
  fingering: boolean;
  keyHints: boolean;
  mode: "wait" | "rhythm";
  tempo: number;
  countIn: boolean;
  metronome: boolean;
  waterfall: boolean;
}

export interface UiPrefs {
  noteNames: "solfege" | "latin";
  wizardDone: boolean;
  trainer: TrainerPrefs;
  piece: PiecePrefs;
}

export interface PieceNoteIn {
  id: string;
  pitch: number;
  startMs: number;
  durMs: number;
  hand: "right" | "left";
  measure: number;
}

export interface PieceConfig {
  hands: HandMode;
  accompany: boolean;
  tempo: number;
  looping: boolean;
}

export interface RhythmConfig {
  hands: HandMode;
  accompany: boolean;
  tempo: number;
  countIn: boolean;
  metronome: boolean;
  loopRange: [number, number] | null;
  beatsPerMeasure: number;
  beatMs: number;
}

export type Grade = "perfect" | "good" | "poor";

export interface RhythmSummary {
  requiredNotes: number;
  hits: number;
  misses: number;
  extras: number;
  perfect: number;
  good: number;
  poor: number;
  accuracy: number;
  meanAbsDeltaMs: number;
  meanDeltaMs: number;
  troubleMeasures: { measure: number; errors: number }[];
}

export type RhythmEvent =
  | { kind: "clock"; originUs: number; pos0: number; tempo: number }
  | { kind: "hit"; id: string; deltaMs: number; grade: Grade }
  | { kind: "miss"; id: string }
  | { kind: "extra"; pitch: number }
  | { kind: "loopPass"; pass: number; summary: RhythmSummary }
  | { kind: "finished"; summary: RhythmSummary };

export interface PieceSummary {
  playedSteps: number;
  requiredNotes: number;
  errors: number;
  durationMs: number;
  troubleMeasures: { measure: number; errors: number }[];
}

export type PieceEvent =
  | { kind: "step"; index: number; noteIds: string[]; required: number[]; auto: boolean }
  | { kind: "hit"; index: number; noteIds: string[] }
  | { kind: "wrong"; index: number; pitch: number }
  | { kind: "finished"; summary: PieceSummary }
  | { kind: "loopPass"; pass: number; summary: PieceSummary };

export interface LibraryItem {
  id: string;
  title: string;
  format: "musicxml" | "mxl" | "midi";
  size: number;
  modified: number;
}

export interface LibraryListing {
  dir: string;
  items: LibraryItem[];
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
  piece: PieceEvent;
  rhythm: RhythmEvent;
}

export const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

// Имитация создаётся при первом обращении (в тестах под Node её нет вовсе).
let mockInstance: ReturnType<typeof createMock> | null = null;
function mock() {
  if (inTauri || typeof window === "undefined") return null;
  return (mockInstance ??= createMock());
}

function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const m = mock();
  return m ? m.invoke<T>(cmd, args) : tauriInvoke<T>(cmd, args);
}

export function listen<K extends keyof Events>(event: K, cb: (payload: Events[K]) => void): Promise<UnlistenFn> {
  const m = mock();
  if (m) return Promise.resolve(m.listen(event, cb));
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
  libraryList: () => invoke<LibraryListing>("library_list"),
  libraryRead: (id: string) => invoke<ArrayBuffer>("library_read", { id }),
  libraryImport: (paths: string[]) => invoke<string[]>("library_import", { paths }),
  libraryOpenFolder: () => invoke<void>("library_open_folder"),
  pieceStart: (notes: PieceNoteIn[], config: PieceConfig) => invoke<number>("piece_start", { notes, config }),
  pieceStop: () => invoke<void>("piece_stop"),
  rhythmStart: (notes: PieceNoteIn[], beats: { ms: number; accent: boolean }[], config: RhythmConfig) =>
    invoke<void>("rhythm_start", { notes, beats, config }),
  rhythmStop: () => invoke<void>("rhythm_stop"),
  clockNow: () => invoke<number>("clock_now"),
};

export async function pickSoundfont(): Promise<string | null> {
  if (!inTauri) return null;
  const { open } = await import("@tauri-apps/plugin-dialog");
  const res = await open({ multiple: false, filters: [{ name: "SoundFont", extensions: ["sf2"] }] });
  return typeof res === "string" ? res : null;
}

/** Выбор нотных файлов для добавления в библиотеку. */
export async function pickScoreFiles(): Promise<string[]> {
  if (!inTauri) return [];
  const { open } = await import("@tauri-apps/plugin-dialog");
  const res = await open({
    multiple: true,
    filters: [{ name: "Ноты", extensions: ["musicxml", "xml", "mxl", "mid", "midi"] }],
  });
  if (!res) return [];
  return Array.isArray(res) ? res : [res];
}

/** Перетаскивание файлов в окно приложения. */
export async function onFileDrop(cb: (event: { type: "over" | "drop" | "leave"; paths: string[] }) => void) {
  if (!inTauri) return () => {};
  const { getCurrentWebview } = await import("@tauri-apps/api/webview");
  return getCurrentWebview().onDragDropEvent((e) => {
    const p = e.payload;
    if (p.type === "drop") cb({ type: "drop", paths: p.paths });
    else if (p.type === "over" || p.type === "enter") cb({ type: "over", paths: [] });
    else cb({ type: "leave", paths: [] });
  });
}

export async function openUrl(url: string): Promise<void> {
  if (!inTauri) {
    window.open(url, "_blank");
    return;
  }
  const { openUrl } = await import("@tauri-apps/plugin-opener");
  await openUrl(url);
}
