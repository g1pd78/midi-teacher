// «В код»: своё из приложения → код Strudel. Грувы и барабаны песен, песни по буквам, стили джема,
// упражнения. Цикл = такт; темп через setcpm (долей в минуту / долей в такте).

import { parseChord } from "../chords";
import type { DrumId, DrumScore } from "../drums";
import { midiOf, type ExerciseScore } from "../exercises";
import { romanToChord, styleChords, type JamStyle } from "../jam";
import { barLen, type LeadSong } from "../songs";
import { riffToMini, type RiffNote } from "./gen";

/** Обозначение аккорда → как понимает chord().voicing() в Strudel (maj7 → ^7, dim → o, sus4 → sus…). */
export function strudelChord(symbol: string): string {
  const c = parseChord(symbol);
  const s = c ? c.symbol : symbol;
  return s
    .replace(/maj7/g, "^7")
    .replace(/dim7/g, "o7")
    .replace(/dim/g, "o")
    .replace(/sus4/g, "sus")
    .replace(/sus2/g, "2")
    .replace(/♯/g, "#")
    .replace(/♭/g, "b");
}

/** Такты (по строке на такт) → `<[a] [b]>`, одинаковые подряд — через «!». */
function perCycle(bars: string[]): string {
  if (bars.every((b) => b === bars[0])) return bars[0];
  const items: string[] = [];
  for (const b of bars.map((x) => (x.includes(" ") ? `[${x}]` : x))) {
    const last = items[items.length - 1];
    const m = last ? /^(.*?)(?:!(\d+))?$/.exec(last) : null;
    if (m && m[1] === b) items[items.length - 1] = `${b}!${Number(m[2] ?? 1) + 1}`;
    else items.push(b);
  }
  return `<${items.join(" ")}>`;
}

const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);

/** Клетки одного голоса → «bd ~ sd ~» с укрупнением шага. */
function cellsMini(sound: string, cells: boolean[]): string {
  let g = cells.length;
  cells.forEach((on, i) => {
    if (on) g = gcd(g, i);
  });
  const step = g || cells.length;
  const tokens = cells.map((on) => (on ? sound : "~")).filter((_, i) => i % step === 0);
  return tokens.join(" ");
}

const DRUM_SOUND: Record<DrumId, string> = {
  kick: "bd",
  snare: "sd",
  hhClosed: "hh",
  hhOpen: "oh",
  tom: "mt",
  floorTom: "lt",
  crash: "cr",
  ride: "rd",
};

/** Барабанная партия (грув, рудимент, барабаны песни) → s("…") по голосам. */
export function drumScoreToCode(score: DrumScore, title: string): string {
  const beats = score.meter?.[0] ?? 4;
  const used = [...new Set(score.bars.flatMap((b) => b.cells.flat().map((h) => h.drum)))];
  const voices = used.map((drum) => {
    const bars = score.bars.map((b) => cellsMini(DRUM_SOUND[drum], b.cells.map((c) => c.some((h) => h.drum === drum))));
    return perCycle(bars);
  });
  return `// ${title}
setcpm(${score.bpm} / ${beats})

drums: s("${voices.join(", ")}")
`;
}

/** Песня по буквам → мелодия, аккорды и бас. Мелодию можно сделать «моей партией» в панели. */
export function leadSongToCode(song: LeadSong): string {
  const bl = barLen(song);
  const shift = song.pickup ? bl - song.pickup : 0;
  const notes: RiffNote[] = song.melody.map((n) => ({ begin: (n.start + shift) / bl, dur: n.len / bl, midi: n.pitch }));
  const cycles = Math.max(1, Math.ceil(Math.max(...notes.map((n) => n.begin + n.dur), 1) - 1e-9));
  const melody = riffToMini(notes, cycles, bl);
  // Аккорды по тактам (после затакта); «%» — как в прошлом такте.
  const groups = song.chords.split("|").map((g) => g.trim()).filter(Boolean);
  const bars: string[] = song.pickup ? ["~"] : [];
  let prev = "~";
  for (const g of groups) {
    const toks = g.split(/\s+/).filter((t) => t && t !== "-");
    if (toks.length === 1 && toks[0] === "%") bars.push(prev);
    else {
      prev = toks.map(strudelChord).join(" ") || "~";
      bars.push(prev);
    }
  }
  const chords = perCycle(bars.length ? bars : ["~"]);
  const roots = perCycle(bars.map((b) => b.split(" ").map((c) => (c === "~" ? "~" : `${rootName(c)}2`)).join(" ")));
  return `// ${song.title}${song.source ? ` (${song.source})` : ""}
// В панели «Моя партия» = melody — играй мелодию по подсветке.
setcpm(${song.bpm} / ${song.beats})

melody: ${melody}.s("piano")
chords: chord("${chords}").voicing().s("gm_epiano1").gain(0.45)
bass: note("${roots}").s("gm_acoustic_bass").gain(0.8)
`;
}

/** «Am7» → «a», «Bb» → «bb», «F#m» → «f#» (основной тон для баса). */
function rootName(chord: string): string {
  const m = /^([A-G])([#b]?)/.exec(chord);
  return m ? `${m[1].toLowerCase()}${m[2]}` : "c";
}

/** Стиль джема → барабаны, бас по основным тонам и аккорды; гармония — для импровизации. */
export function jamStyleToCode(style: JamStyle, tonic: number): string {
  const cells = style.triplet ? 12 : 16;
  const names: Record<string, string> = { k: "bd", s: "sd", h: "hh", o: "oh", r: "rd", c: "cr", t: "mt", f: "lt" };
  const drums = style.drums.map((l) => {
    const [d, pat] = l.split(":");
    return cellsMini(names[d] ?? "perc", [...pat.slice(0, cells)].map((ch) => ch !== "."));
  });
  const bars = styleChords(style, tonic)
    .split("|")
    .map((b) => b.trim().split(/\s+/).map(strudelChord).join(" "));
  const chords = perCycle(bars);
  const roots = perCycle(bars.map((b) => b.split(" ").map((c) => `${rootName(c)}2`).join(" ")));
  const scale = { minpenta: "minor:pentatonic", majpenta: "major:pentatonic", blues: "minor:pentatonic", major: "major", minor: "minor", dorian: "dorian", mixolydian: "mixolydian" }[style.scale];
  const key = romanToChord(tonic, "I");
  return `// Джем: ${style.name}
setcpm(${style.bpm} / 4)

harmony("${chords}", "${key}:${scale}")  // только в MIDI Teacher: подсветка для импровизации
drums: s("${drums.join(", ")}").gain(0.8)
bass: note("${roots}").s("gm_electric_bass_finger").gain(0.8)
comp: chord("${chords}").voicing().s("gm_epiano1").struct("~ x ~ x").gain(0.45)
`;
}

/** Упражнение → партии рук; правая отмечена как моя (.you()) — играй по подсветке. */
export function exerciseToCode(score: ExerciseScore, title: string): string {
  const hand = (notes: ExerciseScore["right"]) => {
    if (!notes?.length) return null;
    let t = 0;
    const riff: RiffNote[] = notes.map((n) => {
      const r = { begin: t / 8, dur: n.eighths / 8, midi: midiOf(n.pitch) };
      t += n.eighths;
      return r;
    });
    return riffToMini(riff, Math.ceil(t / 8), 8);
  };
  const right = hand(score.right);
  const left = hand(score.left);
  return `// Упражнение: ${title}
// Партии рук отмечены как мои (.you() — только в MIDI Teacher): не звучат, подсвечиваются и оцениваются.
setcpm(${score.bpm} / 4)

click: s("rim*4").gain(0.4)
${right ? `right: ${right}.s("piano").you()\n` : ""}${left ? `left: ${left}.s("piano").you()\n` : ""}`;
}
