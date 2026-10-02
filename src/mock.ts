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
  PadBinding,
  PieceNoteIn,
  Song,
  SoundRoute,
  TrainerLevel,
  TrainerTarget,
} from "./api";
import { createPracticeMock } from "./mockPractice";

const PADS_DEVICE = "Пэды";
import odeToJoy from "./pieces/ode-to-joy.musicxml?raw";

type Listener = (payload: never) => void;

const LOWER = ["z", "s", "x", "d", "c", "v", "g", "b", "h", "n", "j", "m", ","];
const UPPER = ["q", "2", "w", "3", "e", "r", "5", "t", "6", "y", "7", "u", "i"];

export function createMock() {
  const listeners = new Map<string, Set<Listener>>();
  const emit = <K extends keyof Events>(event: K, payload: Events[K]) =>
    listeners.get(event)?.forEach((cb) => (cb as (p: Events[K]) => void)(payload));

  const start = performance.now();
  const practice = createPracticeMock();
  const inputs: Record<string, InputSettings> = {
    "Демо-пианино": { enabled: true, route: { kind: "internal" }, range: null },
    "Демо-клавиатура": { enabled: true, route: { kind: "internal" }, range: null },
  };
  let appRoute: SoundRoute = { kind: "internal" };
  let recording: { start: number; notes: number } | null = null;
  // Гитара в демо: вход «Rocksmith Guitar Adapter», тюнер медленно плавает около ля.
  let guitar = {
    enabled: false,
    device: null as string | null,
    channel: 0,
    instrument: "guitar",
    gain: 1,
    monitor: true,
    monitorVolume: 0.8,
    tone: "clean",
    latencyMs: null as number | null,
  };
  let guitarSignal: { hz: number; until: number } | null = null;
  let guitarRec: { start: number; secs: number; path: string } | null = null;
  let appChannel = 0;

  const state: Omit<FullState, "devices"> = {
    prefs: {
      noteNames: "solfege",
      wizardDone: new URLSearchParams(location.search).has("done"),
      trainer: { layout: "single", errorMode: "wait", names: "struggle" },
      theorySeen: [],
      pieceSetup: {},
      piece: { guided: true, heat: false, layout: "line", hands: "right", accompany: true, names: false, fingering: true, keyHints: true, mode: "wait", tempo: 0.8, countIn: true, metronome: false, waterfall: true },
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
      gm: "SoundFont: GeneralUser-GS.sf2",
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
      pads,
    };
  };
  let pads: PadBinding[] = [];
  const songs: Record<string, Song> = {};

  type Body = { type: "noteOn"; note: number; velocity: number } | { type: "noteOff"; note: number };
  // Ритм «любой клавишей» / «по рукам»: как KeyMap в ядре.
  let keyMap = "exact";
  const mapKey = (note: number) => (keyMap === "anyKey" ? 72 : keyMap === "byHand" ? (note < 60 ? 48 : 72) : note);
  const send = (device: string, ev: Body) => {
    if (ev.type === "noteOn") {
      judge(ev.note);
      judgePiece(mapKey(ev.note));
      judgeRhythm(mapKey(ev.note), ev.velocity);
      practice.onNote();
      if (recording) recording.notes++;
    }
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

  // --- Пьеса (упрощённая копия режима ожидания из ядра) ---
  let piece: {
    steps: { onset: number; notes: PieceNoteIn[] }[];
    hands: string;
    looping: boolean;
    pass: number;
    index: number;
    pressed: Set<number>;
    errors: number;
    started: number;
  } | null = null;
  const pieceRequired = (i: number) =>
    piece!.steps[i].notes.filter((n) => n.hand !== "accomp" && (piece!.hands === "both" || n.hand === piece!.hands));
  // Руки ученика в имитации ритма: `none` — слушаем.
  const mineOf = (hands: string, n: PieceNoteIn) => n.hand !== "accomp" && (hands === "both" || n.hand === hands);

  function pieceActivate(i: number) {
    if (!piece) return;
    piece.index = i;
    piece.pressed.clear();
    if (i >= piece.steps.length) {
      const summary = {
        playedSteps: piece.steps.length,
        requiredNotes: piece.steps.reduce((s, _, k) => s + pieceRequired(k).length, 0),
        errors: piece.errors,
        durationMs: Math.round(performance.now() - piece.started),
        troubleMeasures: piece.errors ? [{ measure: piece.steps[0].notes[0].measure, errors: piece.errors }] : [],
      };
      if (piece.looping) {
        piece.pass++;
        emit("piece", { kind: "loopPass", pass: piece.pass, summary });
        piece.errors = 0;
        piece.started = performance.now();
        pieceActivate(0);
        return;
      }
      emit("piece", { kind: "finished", summary });
      piece = null;
      return;
    }
    const req = pieceRequired(i);
    emit("piece", {
      kind: "step",
      index: i,
      noteIds: piece.steps[i].notes.map((n) => n.id),
      required: req.map((n) => n.pitch),
      auto: req.length === 0,
    });
    if (req.length === 0) setTimeout(() => piece && piece.index === i && pieceActivate(i + 1), 300);
  }

  function judgePiece(note: number) {
    if (!piece || piece.index >= piece.steps.length) return;
    const i = piece.index;
    const req = pieceRequired(i);
    // «Любая октава» (аккорды по буквам): как note_matches в ядре, точное совпадение важнее.
    const loose = (n: PieceNoteIn) => (keyMap === "anyOctave" || (keyMap === "leftAnyOctave" && n.hand === "left")) && n.pitch % 12 === note % 12;
    const exact = req.filter((n) => n.pitch === note && !piece!.pressed.has(n.pitch));
    const hits = (exact.length ? exact : req.filter((n) => loose(n))).filter((n) => !piece!.pressed.has(n.pitch));
    if (hits.length || req.some((n) => n.pitch === note || loose(n))) {
      if (!hits.length) return;
      hits.forEach((n) => piece!.pressed.add(n.pitch));
      emit("piece", { kind: "hit", index: i, noteIds: hits.map((n) => n.id) });
      if (req.every((n) => piece!.pressed.has(n.pitch))) pieceActivate(i + 1);
    } else if (req.length && !piece.steps[i].notes.some((n) => n.pitch === note)) {
      piece.errors++;
      emit("piece", { kind: "wrong", index: i, pitch: note });
    }
  }

  // Для скриптов скриншотов: нажать любую ноту (не только из раскладки клавиш).
  (window as unknown as { __mockNote: (n: number) => void }).__mockNote = (n: number) => {
    send("Демо-пианино", { type: "noteOn", note: n, velocity: 90 });
    send("Демо-пианино", { type: "noteOff", note: n });
  };
  (window as unknown as { __mockPiece: () => number[] | null }).__mockPiece = () =>
    piece && piece.index < piece.steps.length ? pieceRequired(piece.index).map((n) => n.pitch) : null;

  // --- Ритм (упрощённо: попадания ±200 мс, пропуски, итог) ---
  type RNote = PieceNoteIn & { done?: boolean };
  let rhythm: { notes: RNote[]; origin: number; pos0: number; end: number; tempo: number; timer: number; hits: number; misses: number; extras: number; deltas: number[]; loop: boolean; pass: number } | null = null;
  const nowUs = () => performance.now() * 1000;
  const rPos = () => (rhythm ? rhythm.pos0 + ((nowUs() - rhythm.origin) / 1000) * rhythm.tempo : 0);
  function rhythmSummary() {
    const r = rhythm!;
    const abs = r.deltas.map(Math.abs);
    return {
      requiredNotes: r.notes.length,
      hits: r.hits,
      misses: r.misses,
      extras: r.extras,
      perfect: abs.filter((d) => d <= 50).length,
      good: abs.filter((d) => d > 50 && d <= 120).length,
      poor: abs.filter((d) => d > 120).length,
      accuracy: r.notes.length ? r.hits / r.notes.length : 0,
      meanAbsDeltaMs: abs.length ? Math.round(abs.reduce((a, b) => a + b, 0) / abs.length) : 0,
      meanDeltaMs: r.deltas.length ? Math.round(r.deltas.reduce((a, b) => a + b, 0) / r.deltas.length) : 0,
      troubleMeasures: [],
    };
  }
  function judgeRhythm(note: number, velocity: number) {
    if (!rhythm) return;
    const pos = rPos();
    const cand = rhythm.notes
      .filter((n) => !n.done && n.pitch === note)
      .map((n) => ({ n, d: Math.round((pos - n.startMs) / rhythm!.tempo) }))
      .filter((c) => Math.abs(c.d) <= 200)
      .sort((a, b) => Math.abs(a.d) - Math.abs(b.d))[0];
    if (cand) {
      cand.n.done = true;
      rhythm.hits++;
      rhythm.deltas.push(cand.d);
      const g = Math.abs(cand.d) <= 50 ? "perfect" : Math.abs(cand.d) <= 120 ? "good" : "poor";
      emit("rhythm", { kind: "hit", id: cand.n.id, deltaMs: cand.d, grade: g, velocity });
    } else if (pos > rhythm.pos0 - 200) {
      rhythm.extras++;
      emit("rhythm", { kind: "extra", pitch: note });
    }
  }
  function stopRhythmMock() {
    if (rhythm) clearInterval(rhythm.timer);
    rhythm = null;
  }
  (window as unknown as { __mockRhythm: () => { pos: number; next: { pitch: number; startMs: number }[] } | null }).__mockRhythm = () =>
    rhythm ? { pos: rPos(), next: rhythm.notes.filter((n) => !n.done).slice(0, 4).map((n) => ({ pitch: n.pitch, startMs: n.startMs })) } : null;

  const handlers: Record<string, (args: Record<string, never>) => unknown> = {
    ...(practice.handlers as unknown as Record<string, (args: Record<string, never>) => unknown>),
    clock_now: () => nowUs(),
    rhythm_start: ({ notes, config }) => {
      stopRhythmMock();
      const cfg = config as unknown as { hands: string; tempo: number; loopRange: [number, number] | null; countIn: boolean; beatMs: number; beatsPerMeasure: number; keyMap?: string };
      keyMap = cfg.keyMap ?? "exact";
      const [a, b] = cfg.loopRange ?? [0, Infinity];
      const all = (notes as unknown as PieceNoteIn[]).filter((n) => n.startMs >= a && n.startMs < b);
      const mine = all.filter((n) => mineOf(cfg.hands, n)).sort((x, y) => x.startMs - y.startMs);
      const pos0 = cfg.loopRange ? a : Math.min(...all.map((n) => n.startMs));
      const lead = Math.max(1200, cfg.countIn ? (cfg.beatsPerMeasure * cfg.beatMs) / cfg.tempo : 0);
      const end = cfg.loopRange ? b : Math.max(...all.map((n) => n.startMs + n.durMs));
      rhythm = { notes: mine, origin: nowUs() + lead * 1000, pos0, end, tempo: cfg.tempo, timer: 0, hits: 0, misses: 0, extras: 0, deltas: [], loop: !!cfg.loopRange, pass: 0 };
      emit("rhythm", { kind: "clock", originUs: rhythm.origin, pos0, tempo: cfg.tempo });
      rhythm.timer = window.setInterval(() => {
        if (!rhythm) return;
        const pos = rPos();
        for (const n of rhythm.notes) {
          if (!n.done && n.startMs + 200 * rhythm.tempo < pos) {
            n.done = true;
            rhythm.misses++;
            emit("rhythm", { kind: "miss", id: n.id });
          }
        }
        if (rhythm.loop && pos >= rhythm.end) {
          rhythm.pass++;
          emit("rhythm", { kind: "loopPass", pass: rhythm.pass, summary: rhythmSummary() });
          rhythm.origin += ((rhythm.end - rhythm.pos0) / rhythm.tempo) * 1000;
          Object.assign(rhythm, { hits: 0, misses: 0, extras: 0, deltas: [] });
          rhythm.notes.forEach((n) => (n.done = false));
          emit("rhythm", { kind: "clock", originUs: rhythm.origin, pos0: rhythm.pos0, tempo: rhythm.tempo });
        } else if (!rhythm.loop && pos > rhythm.end + 200) {
          emit("rhythm", { kind: "finished", summary: rhythmSummary() });
          stopRhythmMock();
        }
      }, 20);
      return undefined;
    },
    rhythm_stop: () => stopRhythmMock(),
    library_list: () => ({
      dir: "C:\\Users\\Ученик\\Documents\\MIDI Teacher",
      items: [{ id: "Песня.mid", title: "Песня", format: "midi", size: 2048, modified: 0 }],
    }),
    library_read: () => Promise.reject(new Error("в демо нет своих файлов")),
    // MIDI в демо: дорожки выдуманы, ноты — «Ода к радости» (настоящий перевод делает ядро).
    midi_inspect: () => ({
      tracks: [
        { index: 0, name: "Piano RH", channel: 1, program: 0, drums: false, notes: 62, low: 60, high: 67, role: "right" },
        { index: 1, name: "Piano LH", channel: 2, program: 0, drums: false, notes: 16, low: 43, high: 55, role: "left" },
        { index: 2, name: "Strings", channel: 3, program: 48, drums: false, notes: 8, low: 55, high: 72, role: "accompany" },
        { index: 3, name: "Drums", channel: 10, program: null, drums: true, notes: 64, low: 36, high: 42, role: "off" },
      ],
      bpm: 100,
      meter: [4, 4],
      keyFifths: 0,
      keyMinor: false,
      keyFromFile: false,
      durationSec: 38,
    }),
    midi_convert: () => ({
      musicxml: odeToJoy,
      accompaniment: [0, 1, 2, 3].map((m) => ({ pitch: 72, startMs: m * 2400, durMs: 2400, measure: m + 1 })),
      bpm: 100,
      measures: 16,
      trim: 0,
      keyFifths: 0,
      tripletQuarters: 0,
      handsAccompaniment: [],
      meter: [4, 4],
      // Демо-барабаны: рок-бит восьмыми на 4 такта.
      drums: [0, 1, 2, 3].map(() => ({
        perBeat: 4,
        cells: 16,
        hits: [
          ...[0, 2, 4, 6, 8, 10, 12, 14].map((cell) => ({ cell, gm: 42, velocity: 80 })),
          { cell: 0, gm: 36, velocity: 90 },
          { cell: 8, gm: 36, velocity: 90 },
          { cell: 4, gm: 38, velocity: 95 },
          { cell: 12, gm: 38, velocity: 95 },
        ],
      })),
    }),
    midi_preview: () => undefined,
    midi_preview_stop: () => undefined,
    record_start: ({ bpm, beatsPerBar, countIn }) => {
      recording = { start: performance.now() + (countIn ? (Number(beatsPerBar) * 60000) / Number(bpm) : 0), notes: 0 };
      return undefined;
    },
    record_status: () =>
      recording
        ? { recording: true, elapsedMs: Math.round(performance.now() - recording.start), notes: recording.notes }
        : { recording: false, elapsedMs: 0, notes: 0 },
    record_stop: ({ name, save }) => {
      const r = recording;
      recording = null;
      return save && r && r.notes > 0 ? `${name}.mid` : null;
    },
    save_text_file: () => undefined,
    record_take_stop: () => {
      const r = recording;
      recording = null;
      return r && r.notes > 0 ? { notes: r.notes, durationMs: Math.round(performance.now() - r.start) } : null;
    },
    record_take_play: () => undefined,
    backup_export: () => ({ settings: true, progress: true, songs: Object.keys(songs).length, created: Math.round(Date.now() / 1000) }),
    backup_import: () => ({ settings: true, progress: true, songs: 0, created: Math.round(Date.now() / 1000) }),
    restart_app: () => location.reload(),
    studio_list: () => Object.values(songs).map((s) => ({ file: s.file, name: s.name, bpm: s.bpm, bars: s.bars, tracks: s.tracks.length, modified: 0 })),
    studio_load: ({ file }) => songs[file as string],
    studio_save: ({ song }) => {
      const s = { ...(song as Song) };
      if (!s.file) s.file = `${s.name}.json`;
      songs[s.file] = s;
      return s;
    },
    studio_delete: ({ file }) => {
      delete songs[file as string];
    },
    studio_from_midi: () => ({
      file: "",
      name: "Демо-песня",
      bpm: 100,
      meter: [4, 4],
      bars: 4,
      source: "demo.mid",
      tracks: [
        {
          id: "t1", name: "Фортепиано", kind: "keys", program: 0, volume: 0.8, mute: false, solo: false, active: 0, grid: 0, strength: 1,
          takes: [{ id: "orig", name: "Оригинал", original: true, accuracy: null, cc: [], notes: [60, 62, 64, 65, 67, 65, 64, 62].map((p, i) => ({ startMs: i * 600, durMs: 550, pitch: p, velocity: 80 })) }],
        },
        {
          id: "t2", name: "Барабаны", kind: "drums", program: null, volume: 0.8, mute: false, solo: false, active: 0, grid: 0, strength: 1,
          takes: [{ id: "orig", name: "Оригинал", original: true, accuracy: null, cc: [], notes: Array.from({ length: 16 }, (_, i) => ({ startMs: i * 600, durMs: 100, pitch: i % 2 ? 38 : 36, velocity: 90 })) }],
        },
      ],
    }),
    studio_play: ({ fromBar, song }) => {
      const s = song as Song;
      const fromMs = ((fromBar as number) - 1) * (60000 / s.bpm) * s.meter[0];
      const startUs = Math.round((performance.now() - start) * 1000) + 300000;
      return { originUs: startUs - fromMs * 1000, fromMs, startUs };
    },
    studio_stop: () => ({ notes: [0, 500, 1000, 1500].map((t, i) => ({ startMs: t, durMs: 400, pitch: 60 + i * 2, velocity: 90 })), cc: [] }),
    studio_export_midi: ({ song }) => `${(song as Song).name}.mid`,
    studio_export_wav: ({ song }) => `Треки/${(song as Song).name}.wav`,
    record_take_save: ({ name }) => `${name}.mid`,
    record_take_discard: () => undefined,
    guitar_state: () => {
      const now = performance.now();
      const on = guitar.enabled;
      const test = guitarSignal && now < guitarSignal.until ? guitarSignal.hz : null;
      const hz = test ?? (on ? 110 * 2 ** ((Math.sin(now / 1500) * 18) / 1200) : null);
      const midi = hz ? Math.round(69 + 12 * Math.log2(hz / 440)) : 0;
      const cents = hz ? (69 + 12 * Math.log2(hz / 440) - midi) * 100 : 0;
      const level = hz ? -18 + Math.sin(now / 300) * 4 : -90;
      const rec = guitarRec
        ? (now - guitarRec.start) / 1000 >= guitarRec.secs
          ? { elapsedSec: guitarRec.secs, totalSec: guitarRec.secs, path: guitarRec.path, error: null }
          : { elapsedSec: (now - guitarRec.start) / 1000, totalSec: guitarRec.secs, path: null, error: null }
        : null;
      return {
        config: guitar,
        status: {
          running: on,
          device: on ? (guitar.device ?? "Rocksmith Guitar Adapter Mono") : "",
          sampleRate: on ? 48000 : 0,
          channels: 1,
          bufferFrames: on ? 480 : 0,
          error: null,
          levelDb: level,
          peakDb: level + 6,
          clipping: false,
          pitch: hz ? { hz, midi, cents, clarity: 0.97 } : null,
          recording: rec,
          recentNotes: on ? [64, 64, 65, 67] : [],
        },
        inputs: [
          { name: "Rocksmith Guitar Adapter Mono", channels: 1 },
          { name: "Микрофон (Realtek High Definition Audio)", channels: 2 },
        ],
      };
    },
    guitar_expect: () => undefined,
    guitar_inputs: () => [
      { name: "Rocksmith Guitar Adapter Mono", channels: 1 },
      { name: "Микрофон (Realtek High Definition Audio)", channels: 2 },
    ],
    guitar_set: ({ config }) => {
      guitar = config as unknown as typeof guitar;
      return undefined;
    },
    guitar_calibrate: () =>
      new Promise((resolve) => setTimeout(() => resolve({ offsetMs: 38, spreadMs: 6, matched: 8, total: 8 }), 5500)),
    guitar_record: ({ name, secs }) => {
      const path = `C:\\Users\\Ученик\\Documents\\MIDI Teacher\\Гитара\\${name}.wav`;
      guitarRec = { start: performance.now(), secs: Number(secs), path };
      return path;
    },
    guitar_stop_record: () => {
      if (guitarRec) guitarRec.secs = (performance.now() - guitarRec.start) / 1000;
      return undefined;
    },
    guitar_test_signal: ({ hz, secs }) => {
      guitarSignal = { hz: Number(hz), until: performance.now() + Number(secs) * 1000 + 1500 };
      return undefined;
    },
    library_import: () => [],
    library_open_folder: () => undefined,
    piece_start: ({ notes, config }) => {
      const list = [...(notes as unknown as PieceNoteIn[])].sort((a, b) => a.startMs - b.startMs);
      const steps: { onset: number; notes: PieceNoteIn[] }[] = [];
      for (const n of list) {
        const last = steps[steps.length - 1];
        if (last && n.startMs - last.onset <= 15) last.notes.push(n);
        else steps.push({ onset: n.startMs, notes: [n] });
      }
      const cfg = config as unknown as { hands: string; looping: boolean; keyMap?: string };
      keyMap = cfg.keyMap ?? "exact";
      piece = { steps, hands: cfg.hands, looping: cfg.looping, pass: 0, index: 0, pressed: new Set(), errors: 0, started: performance.now() };
      setTimeout(() => pieceActivate(0), 0);
      return steps.length;
    },
    piece_stop: () => {
      piece = null;
    },
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
      notesPlayed: 0,
      level: 0,
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
    set_drum_pads: ({ pads: next }) => {
      pads = next as PadBinding[];
      emit("devices", snapshot());
    },
    hit_drum: ({ drum, velocity }) => {
      send(PADS_DEVICE, { type: "noteOn", note: drum as number, velocity: velocity as number });
      setTimeout(() => emitMidi(PADS_DEVICE, { type: "noteOff", note: drum as number }), 150);
    },
    rescan_devices: () => snapshot(),
    simulate_midi: ({ device, bytes }) => {
      const [st, note, vel] = bytes as unknown as number[];
      if ((st & 0xf0) === 0x90 && vel > 0) send(String(device), { type: "noteOn", note, velocity: vel });
      else if ((st & 0xf0) === 0x80 || (st & 0xf0) === 0x90) send(String(device), { type: "noteOff", note });
      return undefined;
    },
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
