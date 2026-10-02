// Ритм-тренажёр: ступени и генератор ритмов.
//
// Ритм записан на однолинейном ударном стане (две строки — правая и левая рука).
// Стучать можно любой клавишей или пэдом: ядро сопоставляет нажатие со строкой
// (`KeyMap`): одна строка — любая клавиша, две — от до первой октавы и выше правая,
// ниже левая (на пэдах: бочка и низкие томы — левая). Высота нот в записи условная:
// правая строка — до второй октавы (72), левая — до малой (48), как в ядре.

import { seeded, type ExerciseStatView } from "./exercises";

export const RHYTHM_RIGHT = 72;
export const RHYTHM_LEFT = 48;

/** Событие ритма: длительность в шестнадцатых, пауза или нота. */
export interface RhythmEvent {
  len: number;
  rest?: boolean;
}

type Block = RhythmEvent[];

const n = (len: number): RhythmEvent => ({ len });
const r = (len: number): RhythmEvent => ({ len, rest: true });

/** Ритмические «кубики» — целое число долей. */
const B: Record<string, Block> = {
  q: [n(4)],
  h: [n(8)],
  w: [n(16)],
  hd: [n(12)],
  qr: [r(4)],
  hr: [r(8)],
  ee: [n(2), n(2)],
  qde: [n(6), n(2)],
  eqe: [n(2), n(4), n(2)],
  ere: [r(2), n(2)],
  ssss: [n(1), n(1), n(1), n(1)],
  ess: [n(2), n(1), n(1)],
  sse: [n(1), n(1), n(2)],
  eds: [n(3), n(1)],
};

export type RhythmTrack = "line" | "hands";

export interface RhythmLevel {
  id: number;
  track: RhythmTrack;
  title: string;
  description: string;
  /** Долей в такте (размер N/4). */
  beats: number;
  /** Кубики правой руки (одна строка — только они) и левой. */
  right: string[];
  left?: string[];
  /** Руки по очереди: на каждой доле играет одна рука. */
  alternate?: boolean;
  measures: number;
  bpm: number;
}

export const RHYTHM_LEVELS: RhythmLevel[] = [
  { id: 1, track: "line", title: "Четверти и половинные", description: "Раз-два-три-четыре: четверть — один счёт, половинная — два.", beats: 4, right: ["q", "q", "h"], measures: 4, bpm: 70 },
  { id: 2, track: "line", title: "Целые и паузы", description: "Целая — на весь такт; пауза — счёт без удара.", beats: 4, right: ["q", "q", "h", "w", "qr"], measures: 4, bpm: 70 },
  { id: 3, track: "line", title: "Восьмые", description: "Две восьмые на один счёт: «раз-и».", beats: 4, right: ["q", "h", "ee", "ee", "qr"], measures: 4, bpm: 70 },
  { id: 4, track: "line", title: "Четверть с точкой", description: "Точка добавляет половину: четверть с точкой и восьмая — на два счёта.", beats: 4, right: ["q", "h", "ee", "qde", "qr"], measures: 4, bpm: 70 },
  { id: 5, track: "line", title: "Синкопы и паузы-восьмые", description: "Восьмая — четверть — восьмая; удар на «и» после паузы.", beats: 4, right: ["q", "ee", "eqe", "ere", "qde", "qr"], measures: 4, bpm: 70 },
  { id: 6, track: "line", title: "Размер 3/4", description: "Три счёта в такте, половинная с точкой — на весь такт.", beats: 3, right: ["q", "h", "hd", "ee", "qr"], measures: 4, bpm: 80 },
  { id: 7, track: "line", title: "Шестнадцатые", description: "Четыре шестнадцатые на счёт: «раз-и-и-и».", beats: 4, right: ["q", "ee", "ssss", "ess", "sse"], measures: 4, bpm: 60 },
  { id: 8, track: "line", title: "Пунктир с шестнадцатой", description: "Восьмая с точкой и шестнадцатая — «длинно-коротко».", beats: 4, right: ["q", "ee", "ssss", "eds", "qde", "ere"], measures: 4, bpm: 60 },
  { id: 1, track: "hands", title: "Правая — четверти, левая — половинные", description: "Правая стучит каждый счёт, левая — через счёт.", beats: 4, right: ["q"], left: ["h", "h", "w"], measures: 4, bpm: 70 },
  { id: 2, track: "hands", title: "Руки по очереди", description: "На каждый счёт — одна рука: правая или левая.", beats: 4, right: ["q"], left: ["q"], alternate: true, measures: 4, bpm: 70 },
  { id: 3, track: "hands", title: "Восьмые против четвертей", description: "Правая — восьмые и четверти, левая — четверти и половинные.", beats: 4, right: ["ee", "ee", "q"], left: ["q", "h"], measures: 4, bpm: 66 },
  { id: 4, track: "hands", title: "Независимые ритмы", description: "У каждой руки свой ритм: пунктир, синкопы, паузы.", beats: 4, right: ["q", "ee", "qde", "eqe", "qr"], left: ["q", "h", "qr", "ee"], measures: 4, bpm: 60 },
];

export const rhythmKey = (l: Pick<RhythmLevel, "track" | "id">) => `rhythm-${l.track}-${l.id}`;
export const RHYTHM_BY_KEY = new Map(RHYTHM_LEVELS.map((l) => [rhythmKey(l), l]));

// --- Зачёт ---

export const RHYTHM_PASS_ACCURACY = 0.9;
export const RHYTHM_PASS_TIMING_SD_MS = 70;
/** Ступень пройдена: засчитано ритмов. */
export const RHYTHM_LEVEL_PASSES = 3;
/** «Две руки» открываются после этой ступени «одной строки». */
export const HANDS_GATE = 3;

function passesOf(stats: ExerciseStatView[], id: string): number {
  const s = stats.find((x) => x.exercise === id);
  return s ? (s.passes ?? (s.passed ? 1 : 0)) : 0;
}

export function rhythmLevelPassed(stats: ExerciseStatView[], l: Pick<RhythmLevel, "track" | "id">): boolean {
  return passesOf(stats, rhythmKey(l)) >= RHYTHM_LEVEL_PASSES;
}

export function rhythmPasses(stats: ExerciseStatView[], l: Pick<RhythmLevel, "track" | "id">): number {
  return passesOf(stats, rhythmKey(l));
}

/** Сколько ступеней открыто на дорожке (0 — дорожка закрыта). */
export function rhythmUnlocked(stats: ExerciseStatView[], track: RhythmTrack): number {
  if (track === "hands" && !rhythmLevelPassed(stats, { track: "line", id: HANDS_GATE })) return 0;
  const count = RHYTHM_LEVELS.filter((l) => l.track === track).length;
  let open = 1;
  while (open < count && rhythmLevelPassed(stats, { track, id: open })) open++;
  return open;
}

// --- Генератор ---

export interface RhythmScore {
  beats: number;
  bpm: number;
  /** Такты: события каждой строки. */
  right: RhythmEvent[][];
  left?: RhythmEvent[][];
}

/** Один такт из кубиков. Двухдольные кубики — с сильной доли (1 или 3), целая — с начала такта. */
function fillMeasure(rnd: () => number, vocab: string[], beats: number, opts: { firstNote: boolean; ending: boolean }): RhythmEvent[] {
  const total = beats * 4;
  for (let attempt = 0; attempt < 50; attempt++) {
    const out: RhythmEvent[] = [];
    let pos = 0;
    // Последний такт заканчивается долгой нотой, если она есть в словаре.
    const tail = opts.ending ? (beats === 3 && vocab.includes("hd") ? B.hd : vocab.includes("h") ? B.h : null) : null;
    const end = total - (tail ? tail.reduce((s, e) => s + e.len, 0) : 0);
    while (pos < end) {
      const fits = vocab.filter((k) => {
        const len = B[k].reduce((s, e) => s + e.len, 0);
        if (pos + len > end) return false;
        if (len === 16 || len === 12) return pos === 0;
        if (len === 8 && beats === 4) return pos % 8 === 0;
        if (pos === 0 && opts.firstNote && B[k][0].rest) return false;
        return true;
      });
      if (!fits.length) break;
      const k = fits[Math.floor(rnd() * fits.length)];
      out.push(...B[k].map((e) => ({ ...e })));
      pos += B[k].reduce((s, e) => s + e.len, 0);
    }
    if (pos !== end) continue;
    if (tail) out.push(...tail.map((e) => ({ ...e })));
    if (out.some((e) => !e.rest)) return out;
  }
  // Запасной вариант — четверти.
  return Array.from({ length: beats }, () => n(4));
}

/** Ритм для ступени: один и тот же для одного `seed`. */
export function rhythmScore(level: RhythmLevel, seed: number): RhythmScore {
  const rnd = seeded(seed * 104729 + level.id * 31 + (level.track === "hands" ? 7 : 0));
  const right: RhythmEvent[][] = [];
  const left: RhythmEvent[][] = [];
  for (let m = 0; m < level.measures; m++) {
    const ending = m === level.measures - 1;
    if (level.alternate) {
      // Руки по очереди; в последнем такте — обе вместе половинными.
      if (ending) {
        right.push([n(8), n(8)]);
        left.push([n(8), n(8)]);
        continue;
      }
      const who = Array.from({ length: level.beats }, () => (rnd() < 0.5 ? "R" : "L"));
      if (!who.includes("R")) who[0] = "R";
      if (!who.includes("L")) who[level.beats - 1] = "L";
      right.push(who.map((w) => (w === "R" ? n(4) : r(4))));
      left.push(who.map((w) => (w === "L" ? n(4) : r(4))));
      continue;
    }
    right.push(fillMeasure(rnd, level.right, level.beats, { firstNote: m === 0, ending }));
    if (level.left) left.push(fillMeasure(rnd, level.left, level.beats, { firstNote: false, ending }));
  }
  return { beats: level.beats, bpm: level.bpm, right, left: level.left ? left : undefined };
}

/** Моменты ударов строки в шестнадцатых от начала (для тестов и бота). */
export function onsets(measures: RhythmEvent[][], beats: number): number[] {
  const out: number[] = [];
  measures.forEach((evs, m) => {
    let pos = m * beats * 4;
    for (const e of evs) {
      if (!e.rest) out.push(pos);
      pos += e.len;
    }
  });
  return out;
}

const DUR: Record<number, [string, number]> = {
  1: ["16", 0],
  2: ["8", 0],
  3: ["8", 1],
  4: ["4", 0],
  6: ["4", 1],
  8: ["2", 0],
  12: ["2", 1],
  16: ["1", 0],
};

function layerXml(evs: RhythmEvent[], pnum: number, idp: string): string {
  const parts: string[] = [];
  let group: string[] = [];
  let groupBeat = -1;
  const flush = () => {
    if (group.length >= 2) parts.push(`<beam>${group.join("")}</beam>`);
    else parts.push(...group);
    group = [];
  };
  let pos = 0;
  evs.forEach((e, i) => {
    const [dur, dots] = DUR[e.len] ?? ["4", 0];
    const dot = dots ? ` dots="${dots}"` : "";
    const xml = e.rest ? `<rest dur="${dur}"${dot}/>` : `<note xml:id="${idp}${i}" dur="${dur}"${dot} loc="0" pnum="${pnum}" stem.dir="up"/>`;
    // Восьмые и шестнадцатые внутри одной доли — под общим ребром.
    const beat = Math.floor(pos / 4);
    const inBeat = e.len < 4 && (pos % 4) + e.len <= 4;
    if (inBeat && !e.rest && (group.length === 0 || beat === groupBeat)) {
      group.push(xml);
      groupBeat = beat;
    } else {
      flush();
      if (inBeat && !e.rest) {
        group.push(xml);
        groupBeat = beat;
      } else parts.push(xml);
    }
    pos += e.len;
  });
  flush();
  return parts.join("");
}

/** MEI ритма: одна или две однолинейные строки ударного стана. */
export function rhythmMei(score: RhythmScore): string {
  const two = !!score.left;
  const measures = score.right.map((evs, m) => {
    const staves = [`<staff n="1"><layer n="1">${layerXml(evs, RHYTHM_RIGHT, `r${m}_`)}</layer></staff>`];
    if (two) staves.push(`<staff n="2"><layer n="1">${layerXml(score.left![m], RHYTHM_LEFT, `l${m}_`)}</layer></staff>`);
    const right = m === score.right.length - 1 ? ` right="end"` : "";
    return `<measure n="${m + 1}"${right}>${staves.join("")}</measure>`;
  });
  const staffDef = (k: number, label: string) => `<staffDef n="${k}" lines="1" clef.shape="perc" label="${label}"/>`;
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<mei xmlns="http://www.music-encoding.org/ns/mei" meiversion="5.0"><music><body><mdiv><score>` +
    `<scoreDef meter.count="${score.beats}" meter.unit="4" midi.bpm="${score.bpm}">` +
    `<staffGrp${two ? ` bar.thru="true"` : ""}>${two ? staffDef(1, "П") + staffDef(2, "Л") : staffDef(1, "")}</staffGrp>` +
    `</scoreDef><section>${measures.join("")}</section></score></mdiv></body></music></mei>`
  );
}
