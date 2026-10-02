// Связь с Rust-ядром. Типы повторяют serde-структуры из mt-core и src-tauri.
//
// Вне Tauri (обычный браузер, `npm run dev`) используется имитация: клавиши
// компьютерной клавиатуры изображают MIDI-устройство. Это нужно для вёрстки
// и скриншотов без настоящего инструмента.

import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { listen as tauriListen, type UnlistenFn } from "@tauri-apps/api/event";
import { createMock } from "./mock";
import type { PieceMetaIn } from "./lib/practice";
import type { Finger, FingerNoteIn } from "./lib/fingering";
import type { ExerciseStatView } from "./lib/exercises";
import type { LeadSong } from "./lib/songs";

export interface TodayStatus {
  warmupDone: boolean;
  exercises: number;
  trainerSessions: number;
  pieceAttempts: number;
  lastPiece: [string, string] | null;
}

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
  /** Пэды, назначенные барабанами. */
  pads: PadBinding[];
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
  /** GM-банк аккомпанемента, если загружен. */
  gm: string | null;
}

export interface AudioMeters {
  outputLatencyMs: number;
  lastCallbackFrames: number;
  xruns: number;
  /** Сколько нот дошло до синтезатора с запуска. */
  notesPlayed: number;
  /** Пиковый уровень вывода, 0…1. */
  level: number;
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
  guided: boolean;
  heat: boolean;
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

export type TrackRole = "right" | "left" | "both" | "accompany" | "drums" | "off";

export interface HandOverride {
  /** Начало в долях сетки импорта (12 на четверть) до обрезки пустого начала. */
  start: number;
  /** Высота до транспонирования. */
  pitch: number;
  hand: "right" | "left";
}

/** Настройки одной пьесы. */
/** Пэд MIDI-клавиатуры, назначенный барабаном (нота GM-ударных `drum`). */
export interface PadBinding {
  device: string;
  channel: number;
  note: number;
  drum: number;
}

/** Имя устройства, от которого приходят удары по пэдам. */
export const PADS_DEVICE = "Пэды";

export type PieceInstrument = "piano" | "guitar" | "bass" | "drums";

export interface PieceSetup {
  transpose: number;
  roles: TrackRole[] | null;
  handOverrides: HandOverride[];
  /** На чём играем пьесу (по умолчанию фортепиано). */
  instrument: PieceInstrument | null;
  /** Стан для гитары/баса: 0 — выбрать самому (мелодия для гитары, бас для баса). */
  part: number;
}

export interface UiPrefs {
  noteNames: "solfege" | "latin";
  wizardDone: boolean;
  trainer: TrainerPrefs;
  piece: PiecePrefs;
  theorySeen: string[];
  pieceSetup: Record<string, PieceSetup>;
  /** Свои песни по буквам аккордов (раздел «Аккорды»). */
  songs?: LeadSong[];
}

export interface TrackInfo {
  index: number;
  name: string;
  channel: number;
  program: number | null;
  drums: boolean;
  notes: number;
  low: number;
  high: number;
  role: TrackRole;
}

export interface MidiInfo {
  tracks: TrackInfo[];
  bpm: number;
  meter: [number, number];
  keyFifths: number;
  keyMinor: boolean;
  keyFromFile: boolean;
  durationSec: number;
}

export interface ConvertOptions {
  roles: TrackRole[];
  handOverrides: HandOverride[];
  transpose: number;
  title: string;
}

export interface AccompNote {
  pitch: number;
  startMs: number;
  durMs: number;
  measure: number;
  /** Канал дорожки (0–15, 9 — барабаны) и её инструмент General MIDI. */
  channel: number;
  program: number | null;
}

/** Такт барабанной партии из MIDI: клеток на четверть 4 (шестнадцатые) или 3 (триоли). */
export interface DrumMeasureIn {
  perBeat: number;
  cells: number;
  hits: { cell: number; gm: number; velocity: number }[];
}

// --- Студия: свой трек из дорожек ---

export interface SongNote {
  startMs: number;
  durMs: number;
  pitch: number;
  velocity: number;
}

export interface SongCc {
  atMs: number;
  controller: number;
  value: number;
}

export interface Take {
  id: string;
  name: string;
  notes: SongNote[];
  cc: SongCc[];
  /** Точность к оригиналу песни 0–1. */
  accuracy: number | null;
  /** Партия из файла песни. */
  original: boolean;
}

export type TrackKind = "keys" | "drums" | "guitar" | "bass" | "other";

export interface SongTrack {
  id: string;
  name: string;
  kind: TrackKind;
  /** Инструмент GM; null у клавишных — рояль приложения. */
  program: number | null;
  volume: number;
  mute: boolean;
  solo: boolean;
  takes: Take[];
  active: number;
  /** 0 — как сыграно, 4/8/16 — четверти/восьмые/шестнадцатые, 12 — триоли. */
  grid: number;
  strength: number;
}

export interface Song {
  file: string;
  name: string;
  bpm: number;
  meter: [number, number];
  bars: number;
  tracks: SongTrack[];
  source: string | null;
}

export interface SongSummary {
  file: string;
  name: string;
  bpm: number;
  bars: number;
  tracks: number;
  modified: number;
}

export interface PlayInfo {
  originUs: number;
  fromMs: number;
  startUs: number;
}

export interface Recorded {
  notes: SongNote[];
  cc: SongCc[];
}

/** Дубль записи своей игры. */
export interface TakeInfo {
  notes: number;
  durationMs: number;
}

export interface Converted {
  musicxml: string;
  accompaniment: AccompNote[];
  /** Ноты рук как аккомпанемент — когда играешь барабаны. */
  handsAccompaniment: AccompNote[];
  /** Барабанная партия (роль «Барабаны»). */
  drums: DrumMeasureIn[] | null;
  meter: [number, number];
  bpm: number;
  measures: number;
  trim: number;
  keyFifths: number;
  tripletQuarters: number;
}

export type Instrument = "guitar" | "bass";
export type ToneKind = "clean" | "drive";

export interface GuitarConfig {
  enabled: boolean;
  /** Системное устройство записи, "ASIO" (входы драйвера вывода) или null — по умолчанию. */
  device: string | null;
  channel: number;
  instrument: Instrument;
  gain: number;
  monitor: boolean;
  monitorVolume: number;
  tone: ToneKind;
  latencyMs: number | null;
}

export interface GuitarInput {
  name: string;
  channels: number;
}

export interface PitchReading {
  hz: number;
  midi: number;
  cents: number;
  clarity: number;
}

export interface GuitarRecording {
  elapsedSec: number;
  totalSec: number;
  path: string | null;
  error: string | null;
}

export interface GuitarStatus {
  running: boolean;
  device: string;
  sampleRate: number;
  channels: number;
  bufferFrames: number;
  error: string | null;
  levelDb: number;
  peakDb: number;
  clipping: boolean;
  pitch: PitchReading | null;
  recording: GuitarRecording | null;
  /** Последние распознанные ноты (MIDI), новые в конце. */
  recentNotes: number[];
}

export interface GuitarState {
  config: GuitarConfig;
  status: GuitarStatus;
  inputs: GuitarInput[];
}

export interface Calibration {
  offsetMs: number;
  spreadMs: number;
  matched: number;
  total: number;
}

export interface RecordStatus {
  recording: boolean;
  elapsedMs: number;
  notes: number;
}

export interface PieceNoteIn {
  id: string;
  pitch: number;
  startMs: number;
  durMs: number;
  /** `accomp` — аккомпанемент из MIDI-файла: всегда играет приложение. */
  hand: "right" | "left" | "accomp";
  measure: number;
  /** Аккомпанемент MIDI: канал и инструмент для GM-синтезатора. */
  channel?: number | null;
  program?: number | null;
}

/** Руки ученика в сессии; `none` — приложение играет всё (прослушивание). */
export type PlayHands = HandMode | "none";

/** Как нажатие сопоставляется с нотами: по высоте, любой клавишей (ритм) или по рукам (ритм двумя руками). */
export type KeyMap = "exact" | "anyKey" | "byHand" | "leftAnyOctave" | "anyOctave";

export interface PieceConfig {
  hands: PlayHands;
  accompany: boolean;
  tempo: number;
  looping: boolean;
  keyMap?: KeyMap;
}

export interface RhythmConfig {
  hands: PlayHands;
  accompany: boolean;
  tempo: number;
  countIn: boolean;
  metronome: boolean;
  loopRange: [number, number] | null;
  beatsPerMeasure: number;
  beatMs: number;
  keyMap?: KeyMap;
}

/** Одна попытка упражнения (для статистики по дням). */
export interface ExerciseAttempt {
  exercise: string;
  finishedAt: number;
  accuracy: number;
  passed: boolean;
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
  | { kind: "hit"; id: string; deltaMs: number; grade: Grade; velocity: number }
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

export interface MeasureErrors {
  measure: number;
  errors: number;
}

export interface UnitState {
  level: number;
  streak: number;
  fails: number;
  rightStreak: number;
  leftStreak: number;
  tempo: number;
  learned: boolean;
  passes: number;
}

export interface UnitView {
  frags: [number, number];
  from: number;
  to: number;
  state: UnitState;
  hand: PlayHands;
  hands: { right: boolean; left: boolean };
  started: boolean;
}

export interface PracticeView {
  piece: string;
  measures: number;
  fragments: [number, number][];
  custom: boolean;
  units: UnitView[];
  current: number;
  heat: MeasureErrors[];
}

export type Suggestion = { kind: "levelUp"; to: number } | { kind: "levelDown"; to: number } | { kind: "learned" };

export interface Outcome {
  good: boolean;
  suggestion: Suggestion | null;
  tempo: number | null;
  learnedNow: boolean;
}

export interface AttemptRecord {
  from: number;
  to: number;
  level: number | null;
  mode: "wait" | "rhythm";
  hands: PlayHands;
  tempo: number;
  accuracy: number;
  durationMs: number;
  trouble: MeasureErrors[];
}

export interface PieceProgress {
  id: string;
  title: string;
  measures: number;
  fragments: { from: number; to: number; level: number; learned: boolean; started: boolean }[];
  learned: boolean;
  heat: MeasureErrors[];
  activity: { attempts: number; lastAt: number | null; minutes: number };
  openedAt: number;
}

export interface Progress {
  play: [number, number][];
  bucketSecs: number;
  pieces: PieceProgress[];
}

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
  /** «ended» — трек доигран до конца. */
  studio: string;
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
  setDrumPads: (pads: PadBinding[]) => invoke<void>("set_drum_pads", { pads }),
  hitDrum: (drum: number, velocity: number) => invoke<void>("hit_drum", { drum, velocity }),
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
  practiceOpen: (meta: PieceMetaIn) => invoke<PracticeView>("practice_open", { meta }),
  practiceSetFragments: (piece: string, starts: number[] | null) =>
    invoke<PracticeView>("practice_set_fragments", { piece, starts }),
  practiceSetLevel: (piece: string, from: number, to: number, level: number) =>
    invoke<PracticeView>("practice_set_level", { piece, from, to, level }),
  practiceRecord: (piece: string, attempt: AttemptRecord) =>
    invoke<{ outcome: Outcome | null; view: PracticeView }>("practice_record", { piece, attempt }),
  progressOverview: () => invoke<Progress>("progress_overview"),
  exerciseStats: () => invoke<ExerciseStatView[]>("exercise_stats"),
  exerciseRecord: (result: { exercise: string; tempo: number; accuracy: number; timingSdMs: number; loudness: number; passed: boolean }) =>
    invoke<ExerciseStatView[]>("exercise_record", { result }),
  exerciseHistory: (prefix: string, since: number) => invoke<ExerciseAttempt[]>("exercise_history", { prefix, since }),
  warmupDone: () => invoke<void>("warmup_done"),
  todayStatus: (dayStart: number) => invoke<TodayStatus>("today_status", { dayStart }),
  midiInspect: (id: string) => invoke<MidiInfo>("midi_inspect", { id }),
  midiConvert: (id: string, options: ConvertOptions) => invoke<Converted>("midi_convert", { id, options }),
  midiPreview: (id: string, track: number) => invoke<void>("midi_preview", { id, track }),
  midiPreviewStop: () => invoke<void>("midi_preview_stop"),
  recordStart: (bpm: number, beatsPerBar: number, metronome: boolean, countIn: boolean) =>
    invoke<void>("record_start", { bpm, beatsPerBar, metronome, countIn }),
  recordStatus: () => invoke<RecordStatus>("record_status"),
  recordStop: (name: string, save: boolean) => invoke<string | null>("record_stop", { name, save }),
  /** Остановить запись и оставить дублем (прослушать / сохранить / выбросить). */
  recordTakeStop: () => invoke<TakeInfo | null>("record_take_stop"),
  recordTakePlay: () => invoke<void>("record_take_play"),
  recordTakeSave: (name: string) => invoke<string>("record_take_save", { name }),
  recordTakeDiscard: () => invoke<void>("record_take_discard"),
  restartApp: () => invoke<void>("restart_app"),
  studioList: () => invoke<SongSummary[]>("studio_list"),
  studioLoad: (file: string) => invoke<Song>("studio_load", { file }),
  studioSave: (song: Song) => invoke<Song>("studio_save", { song }),
  studioDelete: (file: string) => invoke<void>("studio_delete", { file }),
  studioFromMidi: (id: string) => invoke<Song>("studio_from_midi", { id }),
  studioPlay: (song: Song, fromBar: number, record: { track: number; punch: [number, number] | null } | null, metronome: boolean, countIn: boolean) =>
    invoke<PlayInfo>("studio_play", { song, fromBar, record, metronome, countIn }),
  studioStop: () => invoke<Recorded | null>("studio_stop"),
  studioExportMidi: (song: Song) => invoke<string>("studio_export_midi", { song }),
  studioExportWav: (song: Song) => invoke<string>("studio_export_wav", { song }),
  saveTextFile: (path: string, content: string) => invoke<void>("save_text_file", { path, content }),
  guitarState: () => invoke<GuitarState>("guitar_state"),
  guitarInputs: () => invoke<GuitarInput[]>("guitar_inputs"),
  guitarSet: (config: GuitarConfig) => invoke<void>("guitar_set", { config }),
  guitarCalibrate: (bpm: number, count: number) => invoke<Calibration | null>("guitar_calibrate", { bpm, count }),
  guitarRecord: (name: string, secs: number) => invoke<string>("guitar_record", { name, secs }),
  guitarStopRecord: () => invoke<void>("guitar_stop_record"),
  guitarExpect: (pitches: number[]) => invoke<void>("guitar_expect", { pitches }),
  guitarTestSignal: (hz: number, secs: number, kind: "pluck" | "sine") => invoke<void>("guitar_test_signal", { hz, secs, kind }),
  fingeringGet: (piece: string, notes: FingerNoteIn[]) => invoke<Finger[]>("fingering_get", { piece, notes }),
  fingeringSet: (piece: string, notes: FingerNoteIn[], noteId: string, finger: number | null) =>
    invoke<Finger[]>("fingering_set", { piece, notes, noteId, finger }),
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

/**
 * «Сохранить как…»: в приложении — системный диалог, в браузере — скачивание.
 * Возвращает путь (или имя файла) либо `null`, если отменили.
 */
export async function saveTextAs(name: string, content: string, ext: string, label: string): Promise<string | null> {
  if (!inTauri) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([content], { type: "application/xml" }));
    a.download = name;
    a.click();
    URL.revokeObjectURL(a.href);
    return name;
  }
  const { save } = await import("@tauri-apps/plugin-dialog");
  const path = await save({ defaultPath: name, filters: [{ name: label, extensions: [ext] }] });
  if (!path) return null;
  await api.saveTextFile(path, content);
  return path;
}

/** Сохранить резервную копию: диалог «Сохранить как», затем копия в выбранный файл. */
export async function exportBackup(): Promise<{ path: string; info: BackupInfo } | null> {
  const d = new Date();
  const name = `MIDI Teacher ${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}.mtbackup`;
  let path: string | null = name;
  if (inTauri) {
    const { save } = await import("@tauri-apps/plugin-dialog");
    path = await save({ defaultPath: name, filters: [{ name: "Резервная копия MIDI Teacher", extensions: ["mtbackup"] }] });
  }
  if (!path) return null;
  return { path, info: await invoke<BackupInfo>("backup_export", { path }) };
}

/** Восстановить из резервной копии (выбор файла в диалоге). */
export async function importBackup(): Promise<BackupInfo | null> {
  let path: string | null = "demo.mtbackup";
  if (inTauri) {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const res = await open({
      multiple: false,
      filters: [
        { name: "Резервная копия MIDI Teacher", extensions: ["mtbackup"] },
        { name: "Все файлы", extensions: ["*"] },
      ],
    });
    path = typeof res === "string" ? res : null;
  }
  if (!path) return null;
  return invoke<BackupInfo>("backup_import", { path });
}

export interface BackupInfo {
  settings: boolean;
  progress: boolean;
  songs: number;
  created: number;
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
  try {
    await openUrl(url);
  } catch (e) {
    console.error("openUrl", e);
    window.alert(`Не удалось открыть браузер. Открой ссылку вручную:\n${url}`);
  }
}
