// «Студия»: свой трек из дорожек — новые треки и дорожки, сетка, склейка
// перезаписанного куска, точность дубля к оригиналу песни.

import type { Song, SongNote, SongTrack, Take, TrackKind } from "../api";

export const KIND_NAME: Record<TrackKind, string> = {
  keys: "Клавишные",
  drums: "Барабаны",
  guitar: "Гитара",
  bass: "Бас",
  other: "Другое",
};

/** Инструменты для выбора у дорожки (null — рояль приложения). */
export const INSTRUMENTS: { program: number | null; name: string; kinds: TrackKind[] }[] = [
  { program: null, name: "Рояль приложения", kinds: ["keys"] },
  { program: 0, name: "Рояль (GM)", kinds: ["keys", "other"] },
  { program: 4, name: "Электропиано", kinds: ["keys", "other"] },
  { program: 6, name: "Клавесин", kinds: ["keys", "other"] },
  { program: 19, name: "Орган", kinds: ["keys", "other"] },
  { program: 21, name: "Аккордеон", kinds: ["keys", "other"] },
  { program: 24, name: "Гитара (нейлон)", kinds: ["guitar", "other"] },
  { program: 25, name: "Гитара (сталь)", kinds: ["guitar", "other"] },
  { program: 27, name: "Электрогитара (чистая)", kinds: ["guitar", "other"] },
  { program: 29, name: "Электрогитара (перегруз)", kinds: ["guitar", "other"] },
  { program: 30, name: "Электрогитара (дисторшн)", kinds: ["guitar", "other"] },
  { program: 32, name: "Акустический бас", kinds: ["bass", "other"] },
  { program: 33, name: "Бас-гитара", kinds: ["bass", "other"] },
  { program: 34, name: "Бас медиатором", kinds: ["bass", "other"] },
  { program: 38, name: "Синтезаторный бас", kinds: ["bass", "other"] },
  { program: 40, name: "Скрипка", kinds: ["other"] },
  { program: 42, name: "Виолончель", kinds: ["other"] },
  { program: 48, name: "Струнный ансамбль", kinds: ["other", "keys"] },
  { program: 52, name: "Хор", kinds: ["other"] },
  { program: 56, name: "Труба", kinds: ["other"] },
  { program: 65, name: "Саксофон", kinds: ["other"] },
  { program: 73, name: "Флейта", kinds: ["other"] },
  { program: 80, name: "Синтезатор (соло)", kinds: ["other", "keys"] },
  { program: 88, name: "Синтезатор (пэд)", kinds: ["other", "keys"] },
];

const DEFAULT_PROGRAM: Record<TrackKind, number | null> = { keys: null, drums: null, guitar: 27, bass: 33, other: 48 };

export const GRIDS: { grid: number; name: string }[] = [
  { grid: 0, name: "как сыграно" },
  { grid: 4, name: "по четвертям" },
  { grid: 8, name: "по восьмым" },
  { grid: 16, name: "по шестнадцатым" },
  { grid: 12, name: "по триолям" },
];

export function newSong(name: string, bpm: number, meter: [number, number], bars: number): Song {
  return { file: "", name: name.trim() || "Мой трек", bpm, meter, bars, tracks: [], source: null };
}

export function newTrack(kind: TrackKind, existing: SongTrack[]): SongTrack {
  const same = existing.filter((t) => t.kind === kind).length;
  const n = Math.max(0, ...existing.map((t) => Number(t.id.replace(/\D/g, "")) || 0)) + 1;
  return {
    id: `t${n}`,
    name: same ? `${KIND_NAME[kind]} ${same + 1}` : KIND_NAME[kind],
    kind,
    program: DEFAULT_PROGRAM[kind],
    volume: 0.8,
    mute: false,
    solo: false,
    takes: [],
    active: 0,
    grid: 0,
    strength: 1,
  };
}

export const barMs = (song: Song) => (60000 / song.bpm) * (4 / song.meter[1]) * song.meter[0];
export const beatMs = (song: Song) => (60000 / song.bpm) * (4 / song.meter[1]);

/** «такт 3 · доля 2» для времени трека. */
export function position(song: Song, ms: number): { bar: number; beat: number } {
  const b = barMs(song);
  const bar = Math.floor(Math.max(0, ms) / b) + 1;
  const beat = Math.floor((Math.max(0, ms) - (bar - 1) * b) / beatMs(song)) + 1;
  return { bar, beat };
}

/** То же выравнивание, что в ядре: к ближайшей линии сетки на долю `strength`. */
export function quantize(t: number, bpm: number, grid: number, strength: number): number {
  if (!grid) return t;
  const quarter = 60000 / bpm;
  const step = grid === 12 ? quarter / 3 : (quarter * 4) / grid;
  const target = Math.round(t / step) * step;
  return t + (target - t) * Math.min(1, Math.max(0, strength));
}

/** Ноты дубля так, как они звучат (с сеткой дорожки). */
export function placedNotes(song: Song, track: SongTrack): SongNote[] {
  const take = track.takes[track.active] ?? track.takes[track.takes.length - 1];
  if (!take) return [];
  if (!track.grid) return take.notes;
  return take.notes.map((n) => {
    const start = Math.max(0, quantize(n.startMs, song.bpm, track.grid, track.strength));
    const end = quantize(n.startMs + n.durMs, song.bpm, track.grid, track.strength);
    return { ...n, startMs: start, durMs: Math.max(20, end - start) };
  });
}

/** Перезапись куска [from, to): старые ноты вне куска остаются, внутри — новые. */
export function mergePunch(old: SongNote[], fresh: SongNote[], fromMs: number, toMs: number): SongNote[] {
  const keep = old.filter((n) => n.startMs < fromMs || n.startMs >= toMs);
  const inside = fresh.filter((n) => n.startMs >= fromMs && n.startMs < toMs);
  return [...keep, ...inside].sort((a, b) => a.startMs - b.startMs);
}

/**
 * Точность дубля к оригиналу: нота засчитана, если в оригинале есть та же высота
 * в пределах ±`windowMs`. Лишние и пропущенные снижают оценку: верные / (оригинал + лишние).
 */
export function takeAccuracy(played: SongNote[], original: SongNote[], range?: [number, number], windowMs = 120): number {
  const inRange = (n: SongNote) => !range || (n.startMs >= range[0] && n.startMs < range[1]);
  const orig = original.filter(inRange);
  const mine = played.filter(inRange);
  if (!orig.length) return mine.length ? 0 : 1;
  const used = new Set<number>();
  let hits = 0;
  for (const n of mine) {
    let best = -1;
    let bestD = windowMs + 1;
    orig.forEach((o, i) => {
      const d = Math.abs(o.startMs - n.startMs);
      if (!used.has(i) && o.pitch === n.pitch && d <= windowMs && d < bestD) {
        best = i;
        bestD = d;
      }
    });
    if (best >= 0) {
      used.add(best);
      hits++;
    }
  }
  const extras = mine.length - hits;
  return hits / (orig.length + extras);
}

/** Новый дубль дорожки после записи (с куском — склеенный с выбранным дублем). */
export function addTake(
  song: Song,
  trackIndex: number,
  recorded: { notes: SongNote[]; cc: Take["cc"] },
  punch: [number, number] | null,
): Song {
  const track = song.tracks[trackIndex];
  const current = track.takes[track.active];
  const range: [number, number] | null = punch
    ? [(punch[0] - 1) * barMs(song), punch[1] * barMs(song)]
    : null;
  const notes = range && current ? mergePunch(current.notes, recorded.notes, range[0], range[1]) : recorded.notes;
  const cc = range && current ? [...current.cc.filter((c) => c.atMs < range[0] || c.atMs >= range[1]), ...recorded.cc] : recorded.cc;
  const original = track.takes.find((t) => t.original);
  const n = track.takes.filter((t) => !t.original).length + 1;
  const take: Take = {
    id: `k${Date.now().toString(36)}`,
    name: range ? `Дубль ${n} (такты ${punch![0]}–${punch![1]})` : `Дубль ${n}`,
    notes,
    cc,
    accuracy: original ? takeAccuracy(notes, original.notes, range ?? undefined) : null,
    original: false,
  };
  const takes = [...track.takes, take];
  const end = Math.max(0, ...notes.map((x) => x.startMs + x.durMs));
  const bars = Math.max(song.bars, Math.ceil(end / barMs(song)));
  return {
    ...song,
    bars,
    tracks: song.tracks.map((t, i) => (i === trackIndex ? { ...t, takes, active: takes.length - 1 } : t)),
  };
}

/** Есть ли в треке уже записанные ноты (тогда темп менять нельзя — сдвинется сетка). */
export function hasNotes(song: Song): boolean {
  return song.tracks.some((t) => t.takes.some((k) => k.notes.length > 0));
}
