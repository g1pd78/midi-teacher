// Пьесы для классической гитары: мелодия с басом и арпеджио правой руки. Переложения MIDI Teacher
// общеизвестных мелодий (общественное достояние) и этюды-арпеджио в духе op. 1 М. Джулиани.
//
// Запись такта — голоса через « / »: верхний (мелодия, штили вверх) и нижний (бас). Токен —
// «B1:q» (струна по букве открытой струны стандартного строя от низкой E A D G B e, лад,
// длительность w h q e s, точка — «q.», t — восьмая триоли), аккорд — «A3+B1:h», пауза — «r:q», палец правой руки —
// «A3/p:e» (p i m a). Звуки считаются от открытых струн ученика, как в упражнениях.

import { TPQ, writtenDuration, type TabSong, type TsBeat, type TsPart } from "./tabsong";

export interface GtrPiece {
  id: string;
  title: string;
  /** Композитор или «народная». */
  composer: string;
  level: string;
  bpm: number;
  beats: number;
  hint: string;
  bars: string[];
}

const LETTERS = "EADGBe";
const LEN: Record<string, number> = { w: TPQ * 4, h: TPQ * 2, q: TPQ, e: TPQ / 2, s: TPQ / 4, t: TPQ / 3 };
const TOKEN = /^(r|[EADGBe]\d+(?:\+[EADGBe]\d+)*)(?:\/([pima]))?:([whqest])(\.?)$/;

/** Голос такта → доли; ошибка, если длительности не складываются в такт. */
function voiceBeats(text: string, tuning: number[], barTicks: number, where: string): TsBeat[] {
  const out: TsBeat[] = [];
  let tick = 0;
  for (const tok of text.trim().split(/\s+/)) {
    const m = TOKEN.exec(tok);
    if (!m) throw new Error(`${where}: «${tok}»`);
    const dur = LEN[m[3]] * (m[4] ? 1.5 : 1);
    const triplet = m[3] === "t";
    const w = triplet ? { type: 8, dots: 0 } : writtenDuration(dur)!;
    if (m[1] !== "r") {
      const notes = m[1].split("+").map((n, i) => {
        const string = LETTERS.indexOf(n[0]);
        const fret = Number(n.slice(1));
        return { pitch: tuning[string] + fret, string, fret, techniques: i === 0 && m[2] ? [m[2]] : undefined };
      });
      out.push({ tick, dur, type: w.type, dots: w.dots, notes, ...(triplet ? { tuplet: [3, 2] as [number, number] } : {}) });
    }
    tick += dur;
  }
  if (tick !== barTicks) throw new Error(`${where}: длительность ${tick / TPQ} четвертей, нужно ${barTicks / TPQ}`);
  return out;
}

/** Пьеса → песня из табов под строй `tuning` (от низкой струны). */
export function gtrPieceSong(p: GtrPiece, tuning: number[]): TabSong {
  const barTicks = TPQ * p.beats;
  const bars = p.bars.map((b, i) => b.split(" / ").map((v, vi) => voiceBeats(v, tuning, barTicks, `${p.title}, такт ${i + 1}, голос ${vi + 1}`)));
  const masters = bars.map(() => ({ num: p.beats, den: 4, ticks: barTicks, key: 0 }));
  const part: TsPart = {
    id: "guitar",
    name: p.title,
    kind: "guitar",
    program: 24,
    tuning,
    capo: 0,
    staves: [{ tab: true, clef: "G8", bars }],
  };
  return { title: p.title, artist: p.composer, album: "", tempo: p.bpm, masters, order: masters.map((_, i) => ({ master: i, tempos: [], pass: 0 })), parts: [part] };
}

// --- Пьесы ---

/** Бас по букве аккорда: до — 3-й лад пятой струны, фа — 3-й лад четвёртой, соль — 3-й лад шестой. */
const BASS: Record<string, string> = { C: "A3", F: "D3", G: "E3", Am: "A0", E: "E0", Em: "E0" };
const halves = (a: string, b = a) => `${BASS[a]}:h ${BASS[b]}:h`;

// «Ах, скажу я вам, мама»: мелодия на 1-й и 2-й струнах (до — B1, ре — B3, ми — e0, фа — e1, соль — e3, ля — e5).
const TW = {
  a: "B1:q B1:q e3:q e3:q",
  b: "e5:q e5:q e3:h",
  c: "e1:q e1:q e0:q e0:q",
  d: "B3:q B3:q B1:h",
  e: "e3:q e3:q e1:q e1:q",
  f: "e0:q e0:q B3:h",
};

// «Ода к радости»: те же позиции, бас до и соль.
const ODE = {
  a: "e0:q e0:q e1:q e3:q",
  b: "e3:q e1:q e0:q B3:q",
  c: "B1:q B1:q B3:q e0:q",
  d: "e0:q. B3:e B3:h",
  e: "B3:q. B1:e B1:h",
};

// «Гринсливз», ля минор: мелодия на 1–3-й струнах, бас на открытых ля и ми, до и соль — на 3-м ладу.
const GS_V = ["B1:h B3:q / A0:h.", "e0:q. e1:e e0:q / A3:h.", "B3:h B0:q / E3:h.", "G0:q. G2:e B0:q / E0:h."];
const GS_C = ["e3:h. / A3:h.", "e3:q. e2:e e0:q / A3:h.", "B3:h B0:q / E3:h.", "G0:q. G2:e B0:q / E0:h."];

/** Арпеджио на до мажор (x32010) и соль-септаккорд (320001): узор пальцев правой руки по струнам. */
function arpeggio(order: string[], fingers: string): string[] {
  const C: Record<string, string> = { p: "A3", i: "G0", m: "B1", a: "e0" };
  const G7: Record<string, string> = { p: "E3", i: "G0", m: "B0", a: "e1" };
  const bar = (ch: Record<string, string>) =>
    [...fingers, ...fingers].map((f, k) => `${ch[f]}${k < fingers.length ? `/${f}` : ""}:e`).join(" ");
  return order.map((c) => (c === "end" ? "A3+D2+G0+B1+e0:w" : bar(c === "C" ? C : G7)));
}

export const GTR_PIECES: GtrPiece[] = [
  {
    id: "twinkle",
    title: "Ах, скажу я вам, мама",
    composer: "Французская народная песня",
    level: "Самое начало",
    bpm: 80,
    beats: 4,
    hint: "Мелодия — на первой и второй струнах, бас большим пальцем (p) на сильные доли: до — 3-й лад пятой струны, фа — 3-й лад четвёртой, соль — 3-й лад шестой. Бас и мелодия звучат вместе.",
    bars: [
      `${TW.a} / ${halves("C")}`,
      `${TW.b} / ${halves("F", "C")}`,
      `${TW.c} / ${halves("F", "C")}`,
      `${TW.d} / ${halves("G", "C")}`,
      `${TW.e} / ${halves("C", "F")}`,
      `${TW.f} / ${halves("C", "G")}`,
      `${TW.e} / ${halves("C", "F")}`,
      `${TW.f} / ${halves("C", "G")}`,
      `${TW.a} / ${halves("C")}`,
      `${TW.b} / ${halves("F", "C")}`,
      `${TW.c} / ${halves("F", "C")}`,
      `${TW.d} / ${halves("G", "C")}`,
    ],
  },
  {
    id: "ode",
    title: "Ода к радости",
    composer: "Л. ван Бетховен",
    level: "Начальный",
    bpm: 90,
    beats: 4,
    hint: "Мелодия на первой и второй струнах в первой позиции; бас большим пальцем: до (5-я струна, 3-й лад) и соль (6-я струна, 3-й лад).",
    bars: [
      `${ODE.a} / ${halves("C")}`,
      `${ODE.b} / ${halves("G")}`,
      `${ODE.c} / ${halves("C")}`,
      `${ODE.d} / ${halves("G")}`,
      `${ODE.a} / ${halves("C")}`,
      `${ODE.b} / ${halves("G")}`,
      `${ODE.c} / ${halves("C")}`,
      `${ODE.e} / ${halves("G", "C")}`,
    ],
  },
  {
    id: "giuliani-pima",
    title: "Арпеджио p-i-m-a (в духе Джулиани)",
    composer: "Этюд по op. 1 М. Джулиани",
    level: "Начальный",
    bpm: 70,
    beats: 4,
    hint: "Правая рука: p — большой палец на басу, i — указательный на 3-й струне, m — средний на 2-й, a — безымянный на 1-й. Левая держит до мажор и соль-септаккорд; струны звучат, пока не сменится аккорд.",
    bars: arpeggio(["C", "G7", "C", "G7", "C", "C", "G7", "end"], "pima"),
  },
  {
    id: "giuliani-pami",
    title: "Арпеджио p-a-m-i (в духе Джулиани)",
    composer: "Этюд по op. 1 М. Джулиани",
    level: "Начальный",
    bpm: 70,
    beats: 4,
    hint: "Тот же аккорд сверху вниз: после баса — безымянный (a) на 1-й струне, средний (m) на 2-й, указательный (i) на 3-й.",
    bars: arpeggio(["C", "G7", "C", "G7", "C", "C", "G7", "end"], "pami"),
  },
  {
    id: "greensleeves",
    title: "Гринсливз",
    composer: "Английская народная песня",
    level: "Лёгкий",
    bpm: 84,
    beats: 3,
    hint: "Ля минор, 3/4. Мелодия на первых трёх струнах (соль-диез — 1-й лад третьей струны, фа-диез — 2-й лад первой), бас — открытые ля и ми, до и соль на 3-м ладу. Затакт — в конце первого такта.",
    bars: [
      "r:h G2:q / r:h.",
      ...GS_V,
      "B1:h G2:q / A0:h.",
      "G2:q. G1:e G2:q / E0:h.",
      "B0:h G1:q / E0:h.",
      "D2:h G2:q / E0:h.",
      ...GS_V,
      "B1:q. B0:e G2:q / A0:h.",
      "G1:q. D4:e G1:q / E0:h.",
      "G2:h. / A0:h.",
      "r:h. / A0:h.",
      ...GS_C,
      "B1:h G2:q / A0:h.",
      "G2:q. G1:e G2:q / E0:h.",
      "B0:h G1:q / E0:h.",
      "D2:h. / E0:h.",
      ...GS_C,
      "B1:q. B0:e G2:q / A0:h.",
      "G1:q. D4:e G1:q / E0:h.",
      "G2:h. / A0:h.",
    ],
  },
  {
    // «Испанский романс» (аноним, XIX в.). По изданию Mutopia Project №795 (набор Jeff Covey, 2006),
    // лицензия CC BY-SA 2.5. Обе части без повторов; струны и лады — MIDI Teacher.
    id: "romance",
    title: "Испанский романс",
    composer: "Аноним (изд. Mutopia №795, CC BY-SA 2.5)",
    level: "Средний",
    bpm: 60,
    beats: 3,
    hint: "Ми минор, затем ми мажор; 3/4, в каждой доле триоль. Мелодия — первая нота триоли на первой струне (a), за ней вторая и третья струны (m, i), бас большим пальцем (p) на первую долю. Во второй части — позиции на 4-м, 7-м и 9-м ладах. В оригинале каждая часть повторяется.",
    bars: [
      "e7/a:t B0/m:t G0/i:t e7/a:t B0/m:t G0/i:t e7/a:t B0/m:t G0/i:t / E0/p:h.",
      "e7/a:t B0/m:t G0/i:t e5/a:t B0/m:t G0/i:t e3/a:t B0/m:t G0/i:t / E0/p:h.",
      "e3/a:t B0/m:t G0/i:t e2/a:t B0/m:t G0/i:t e0/a:t B0/m:t G0/i:t / E0/p:h.",
      "e0/a:t B0/m:t G0/i:t e3/a:t B0/m:t G0/i:t e7/a:t B0/m:t G0/i:t / E0/p:h.",
      "e12/a:t B0/m:t G0/i:t e12/a:t B0/m:t G0/i:t e12/a:t B0/m:t G0/i:t / E0/p:h.",
      "e12/a:t B0/m:t G0/i:t e10/a:t B0/m:t G0/i:t e8/a:t B0/m:t G0/i:t / E0/p:h.",
      "e8/a:t B5/m:t G5/i:t e7/a:t B5/m:t G5/i:t e5/a:t B5/m:t G5/i:t / A0/p:h.",
      "e5/a:t B5/m:t G5/i:t e7/a:t B5/m:t G5/i:t e8/a:t B5/m:t G5/i:t / A0/p:h.",
      "e7/a:t B7/m:t G8/i:t e8/a:t B7/m:t G8/i:t e7/a:t B7/m:t G8/i:t / A2/p:h.",
      "e11/a:t B7/m:t G8/i:t e8/a:t B7/m:t G8/i:t e7/a:t B7/m:t G8/i:t / A2/p:h.",
      "e7/a:t B0/m:t G0/i:t e5/a:t B0/m:t G0/i:t e3/a:t B0/m:t G0/i:t / E0/p:h.",
      "e3/a:t B0/m:t G0/i:t e2/a:t B0/m:t G0/i:t e0/a:t B0/m:t G0/i:t / E0/p:h.",
      "e2/a:t B0/m:t G2/i:t e2/a:t B0/m:t G2/i:t e2/a:t B0/m:t G2/i:t / A2/p:h.",
      "e2/a:t B0/m:t G2/i:t e3/a:t B0/m:t G2/i:t e2/a:t B0/m:t G2/i:t / D1/p:h.",
      "e0/a:t B0/m:t G0/i:t e0/a:t B0/m:t G0/i:t e0/a:t B0/m:t G0/i:t / D2/p:q A2/p:q E3/p:q",
      "e0/a:h r:q / E0/p:h r:q",
      "e4/a:t B0/m:t G1/i:t e4/a:t B0/m:t G1/i:t e4/a:t B0/m:t G1/i:t / E0/p:h.",
      "e4/a:t B0/m:t G1/i:t e2/a:t B0/m:t G1/i:t e0/a:t B0/m:t G1/i:t / E0/p:h.",
      "e0/a:t G2/m:t D4/i:t B4/a:t G2/m:t D4/i:t B4/a:t G2/m:t D4/i:t / A0/p:h.",
      "B4/a:t G2/m:t D4/i:t B3/a:t G2/m:t D4/i:t B4/a:t G2/m:t D4/i:t / A0/p:h.",
      "e9/a:t B7/m:t G8/i:t e9/a:t B7/m:t G8/i:t e9/a:t B7/m:t G8/i:t / A2/p:h.",
      "e9/a:t B7/m:t G8/i:t e11/a:t B7/m:t G8/i:t e9/a:t B7/m:t G8/i:t / A2/p:h.",
      "e9/a:t B9/m:t G9/i:t e7/a:t B9/m:t G9/i:t e7/a:t B9/m:t G9/i:t / E0/p:h.",
      "e7/a:t B9/m:t G9/i:t e9/a:t B9/m:t G9/i:t e11/a:t B9/m:t G9/i:t / E0/p:h.",
      "e12/a:t B9/m:t G9/i:t e12/a:t B9/m:t G9/i:t e12/a:t B9/m:t G9/i:t / E0/p:h.",
      "e12/a:t B9/m:t G9/i:t e11/a:t B9/m:t G9/i:t e10/a:t B9/m:t G9/i:t / E0/p:h.",
      "e9/a:t B5/m:t G6/i:t e9/a:t B5/m:t G6/i:t e9/a:t B5/m:t G6/i:t / A0/p:h.",
      "e9/a:t B5/m:t G6/i:t e7/a:t B5/m:t G6/i:t e5/a:t B5/m:t G6/i:t / A0/p:h.",
      "e4/a:t B4/m:t G4/i:t e4/a:t B4/m:t G4/i:t e4/a:t B4/m:t G4/i:t / A2/p:h.",
      "e4/a:t B4/m:t G4/i:t e5/a:t B4/m:t G4/i:t e2/a:t B4/m:t G4/i:t / A2/p:h.",
      "e0/a:t B0/m:t G1/i:t e0/a:t B0/m:t G1/i:t e0/a:t B0/m:t G1/i:t / D2/p:q A2/p:q E4/p:q",
      "e0/a:h r:q / E0/p:h r:q",
    ],
  },
];

export const GTR_PIECE_BY_ID = new Map(GTR_PIECES.map((p) => [p.id, p]));
