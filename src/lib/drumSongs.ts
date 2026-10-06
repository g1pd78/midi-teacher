// Барабаны к песням по буквам: ученик играет партию на пэдах (грув, сбивки в конце фраз,
// тарелка в последнем такте), приложение — мелодию, аккорды и бас. Затакт песни пропускается,
// как в бое и басовых линиях.

import { bassLineSong } from "./bassline";
import { patternBar } from "./drumPattern";
import { TUNINGS } from "./guitar";
import { BUILTIN_SONGS, barLen, parseChart, type LeadSong } from "./songs";
import { TPQ, writtenDuration, type TabSong, type TsBeat, type TsPart } from "./tabsong";

export interface DrumGroove {
  name: string;
  /** Размер песни, под который он подходит. */
  beats: number;
  /** Клеток в такте (шестнадцатые). */
  cells: number;
  main: string[];
  fill: string[];
  end: string[];
}

export const DRUM_GROOVES: Record<string, DrumGroove> = {
  basic: {
    name: "простой бит",
    beats: 4,
    cells: 16,
    main: ["k:x.......x.......", "s:....x.......x...", "h:x...x...x...x..."],
    fill: ["k:x...............", "h:x...x...........", "s:....x...x.x.....", "t:............x...", "f:..............x."],
    end: ["k:x...............", "c:x..............."],
  },
  pop: {
    name: "поп",
    beats: 4,
    cells: 16,
    main: ["k:x.......x.......", "s:....x.......x...", "h:x.x.x.x.x.x.x.x."],
    fill: ["k:x...............", "h:x.x.x.x.........", "s:....x...x.x.....", "t:............x...", "f:..............x."],
    end: ["k:x...............", "c:x..............."],
  },
  rock: {
    name: "рок",
    beats: 4,
    cells: 16,
    main: ["k:x.......x.x.....", "s:....x.......x...", "h:x.x.x.x.x.x.x.x."],
    fill: ["k:x...............", "h:x.x.x.x.........", "s:....x...x.x.x.x.", "t:............x.x.", "f:..............x."],
    end: ["k:x...............", "c:x..............."],
  },
  waltz: {
    name: "вальс",
    beats: 3,
    cells: 12,
    main: ["k:x...........", "s:....x...x...", "h:x...x...x..."],
    fill: ["k:x...........", "s:....x.x.....", "t:........x...", "f:..........x."],
    end: ["k:x...........", "c:x..........."],
  },
  polka: {
    name: "полька",
    beats: 2,
    cells: 8,
    main: ["k:x...x...", "s:..x...x.", "h:x.x.x.x."],
    fill: ["k:x.......", "s:..x.x...", "t:......x."],
    end: ["k:x.......", "c:x......."],
  },
};

export interface DrumSong {
  id: string;
  songId: string;
  groove: string;
  hint: string;
}

export const DRUM_SONGS: DrumSong[] = [
  { id: "drum-song-ode", songId: "builtin-ode", groove: "basic", hint: "Хэт четвертями, бочка на 1 и 3, малый на 2 и 4. В конце каждой четвёртой строки — сбивка по томам." },
  { id: "drum-song-jingle", songId: "builtin-jingle", groove: "pop", hint: "Хэт восьмыми, бочка на 1 и 3, малый на 2 и 4; сбивка раз в четыре такта." },
  { id: "drum-song-birthday", songId: "builtin-birthday", groove: "waltz", hint: "Вальс на три: бочка на «раз», малый и хэт — на «два» и «три». Песня начинается без затакта." },
  { id: "drum-song-kalinka", songId: "builtin-kalinka", groove: "polka", hint: "Полька на два: бочка на доли, малый между ними, хэт восьмыми." },
  { id: "drum-song-korobeiniki", songId: "builtin-korobeiniki", groove: "rock", hint: "Рок: бочка на 1, 3 и «и» третьей доли, малый на 2 и 4, хэт восьмыми; сбивка шестнадцатыми по малому и томам." },
];

export const DRUM_SONG_BY_ID = new Map(DRUM_SONGS.map((d) => [d.id, d]));

export function drumSongLead(d: DrumSong): LeadSong {
  return BUILTIN_SONGS.find((s) => s.id === d.songId)!;
}

export function drumSongTitle(d: DrumSong): string {
  return `${drumSongLead(d).title.replace(/\s*\(.*\)$/, "")} · ${DRUM_GROOVES[d.groove].name}`;
}

/** Песня для экрана игры: барабаны (партия ученика, индекс 0), мелодия, бас, аккорды. */
export function drumSongTs(d: DrumSong): TabSong {
  const song = drumSongLead(d);
  const g = DRUM_GROOVES[d.groove];
  if (g.beats !== song.beats || song.unit !== 4) throw new Error(`${d.id}: грув «${g.name}» не подходит к размеру песни`);
  const base = bassLineSong(song, "roots", TUNINGS.bass, { chords: "piano", drums: false, chordsVolume: 60, drumsVolume: 80 });
  const count = base.masters.length;
  const drums: TsPart = {
    id: "drums",
    name: "Барабаны",
    kind: "drums",
    program: 0,
    capo: 0,
    staves: [
      {
        tab: false,
        clef: "G",
        bars: Array.from({ length: count }, (_, i) => [patternBar(i === count - 1 ? g.end : i % 4 === 3 ? g.fill : g.main, g.cells)]),
      },
    ],
  };
  return { ...base, title: song.title, parts: [drums, melodyPart(song, count), ...base.parts] };
}

/** Мелодия песни по тактам (после затакта) — звучит флейтой поверх аккомпанемента. */
function melodyPart(song: LeadSong, count: number): TsPart {
  const sixteenth = TPQ / 4;
  const bl = barLen(song);
  const bars: TsBeat[][] = Array.from({ length: count }, () => []);
  for (const n of song.melody) {
    const t = n.start - song.pickup;
    if (t < 0) continue;
    const bar = Math.floor(t / bl);
    if (bar >= count) continue;
    const w = writtenDuration(n.len * sixteenth) ?? { type: 16, dots: 0 };
    bars[bar].push({ tick: (t - bar * bl) * sixteenth, dur: n.len * sixteenth, type: w.type, dots: w.dots, notes: [{ pitch: n.pitch }] });
  }
  return { id: "melody", name: "Мелодия", kind: "other", program: 73, capo: 0, staves: [{ tab: false, clef: "G", bars: bars.map((b) => [b]) }] };
}

/** Тактов в песне (для подсказки на карточке). */
export function drumSongBars(d: DrumSong): number {
  const song = drumSongLead(d);
  return parseChart(song.chords, song).bars;
}
