// События паттерна → ноты: для «Код → ноты/MIDI», проверки уроков, подсказок «моей партии» и гармонии.

import type { Song, SongNote } from "../../api";
import { newSong, newTrack } from "../studio";
import { partLabel } from "./mt";
import { DRUM_NOTES } from "./sounds";
import type { Pattern } from "./evaluate";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface CodeNote {
  /** Начало в циклах. */
  begin: number;
  /** Длительность в циклах. */
  dur: number;
  /** Высота MIDI (для нот) или нота GM-барабана (для ударных `s("bd")`); null — без высоты. */
  midi: number | null;
  drum: boolean;
  /** Звук (`s`), если задан. */
  s: string | null;
  /** Вариант сэмпла (`hh:1` → 1). */
  n: number;
  part: string | null;
  you: boolean;
  gain: number;
}

const LETTER: Record<string, number> = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };

/** «c4», «Eb3», «f#5», «a» → MIDI (как в Strudel: c4 = 60, без октавы — 3-я). */
export function noteNameToMidi(name: string): number | null {
  const m = /^([a-gA-G])([#sb]*)(-?\d+)?$/.exec(name.trim());
  if (!m) return null;
  const acc = [...m[2]].reduce((a, ch) => a + (ch === "b" ? -1 : 1), 0);
  const oct = m[3] === undefined ? 3 : Number(m[3]);
  return (oct + 1) * 12 + LETTER[m[1].toLowerCase()] + acc;
}

export function valueMidi(v: any): number | null {
  if (v === null || typeof v !== "object") return typeof v === "number" ? v : typeof v === "string" ? noteNameToMidi(v) : null;
  const n = v.note ?? v.freq;
  if (typeof v.note === "number") return Math.round(v.note);
  if (typeof v.note === "string") return noteNameToMidi(v.note);
  if (typeof v.freq === "number") return Math.round(69 + 12 * Math.log2(v.freq / 440));
  void n;
  return null;
}

/** Ударные: «bd» → 36, «sd:1» → 40; иначе null. */
export function drumMidi(v: any): number | null {
  if (!v || typeof v !== "object" || typeof v.s !== "string") return null;
  const [name, idx] = v.s.split(":");
  const base = name.includes("_") ? name.slice(name.lastIndexOf("_") + 1) : name;
  const notes = DRUM_NOTES[base];
  if (!notes) return null;
  const i = Number(idx ?? v.n ?? 0) || 0;
  return notes[((i % notes.length) + notes.length) % notes.length];
}

/** Ноты паттерна за циклы [from, to) — только начала событий. */
export function patternNotes(pattern: Pattern, from: number, to: number): CodeNote[] {
  const haps = pattern.queryArc(from, to) as any[];
  const out: CodeNote[] = [];
  for (const h of haps) {
    if (!h.hasOnset()) continue;
    const v = h.value;
    const pitch = valueMidi(v);
    const drum = pitch === null ? drumMidi(v) : null;
    out.push({
      begin: h.whole.begin.valueOf(),
      dur: h.whole.end.valueOf() - h.whole.begin.valueOf(),
      midi: pitch ?? drum,
      drum: pitch === null && drum !== null,
      s: v && typeof v === "object" && typeof v.s === "string" ? v.s : null,
      n: v && typeof v === "object" && typeof v.n === "number" && pitch === null ? v.n : 0,
      part: v && typeof v === "object" ? (v.mtPart ?? null) : null,
      you: !!(v && typeof v === "object" && v.mtYou),
      gain: v && typeof v === "object" && typeof v.gain === "number" ? v.gain : 1,
    });
  }
  return out.sort((a, b) => a.begin - b.begin || (a.midi ?? 0) - (b.midi ?? 0));
}

/** Партия (или всё) за N циклов → трек Студии: такт = цикл, размер 4/4, темп из cps; партия — дорожка. */
export function notesToSong(notes: CodeNote[], name: string, cps: number, cycles: number): Song {
  const song = newSong(name, Math.max(20, Math.min(300, Math.round(cps * 60 * 4))), [4, 4], Math.max(1, Math.ceil(cycles)));
  const msPerCycle = 1000 / cps;
  const groups = new Map<string, CodeNote[]>();
  for (const n of notes) {
    if (n.midi === null) continue;
    const key = `${n.part ?? "код"}|${n.drum ? "drums" : "keys"}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(n);
  }
  for (const [key, ns] of groups) {
    const [part, kind] = key.split("|") as [string, "drums" | "keys"];
    const track = { ...newTrack(kind, song.tracks), name: partLabel(part) };
    const songNotes: SongNote[] = ns.map((n) => ({
      pitch: n.midi!,
      velocity: Math.max(1, Math.min(127, Math.round(90 * Math.min(1.4, n.gain)))),
      startMs: Math.round(n.begin * msPerCycle),
      durMs: Math.max(30, Math.round(n.dur * msPerCycle * 0.95)),
    }));
    track.takes = [{ id: "k1", name: "Из кода", notes: songNotes, cc: [], accuracy: null, original: true }];
    song.tracks.push(track);
  }
  return song;
}
