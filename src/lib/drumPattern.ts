// Барабанная партия из строк-узоров для упражнений и боя: «k:x.......x.......» — бочка,
// «s:» — малый, «h:» — закрытый хэт, «o:» — открытый, «r:» — райд, «c:» — тарелка;
// клетка — шестнадцатая (или восьмая триолью — для шаффла), «x» — удар, «.» — пауза.

import { TPQ, type TsBeat, type TsPart } from "./tabsong";

const GM: Record<string, number> = { k: 36, s: 38, h: 42, o: 46, r: 51, c: 49 };

/** Такт из узоров: `cells` клеток по `cellTicks` (16 шестнадцатых — такт 4/4, 12 — 3/4 или 6/8; триоли — TPQ/3). */
export function patternBar(lines: string[], cells = 16, cellTicks = TPQ / 4): TsBeat[] {
  const out: number[][] = Array.from({ length: cells }, () => []);
  for (const l of lines) {
    const [d, pat] = l.split(":");
    [...pat.slice(0, cells)].forEach((ch, i) => ch !== "." && out[i].push(GM[d]));
  }
  const triplet = Math.abs(cellTicks - TPQ / 3) < 1;
  return out.flatMap((c, i) =>
    c.length
      ? [{ tick: i * cellTicks, dur: cellTicks, type: triplet ? 8 : 16, dots: 0, tuplet: triplet ? ([3, 2] as [number, number]) : undefined, notes: c.map((p) => ({ pitch: p })) }]
      : [],
  );
}

/** Партия барабанов на `count` тактов: узоры тактов `bars` по кругу. */
export function patternPart(bars: string[][], count: number, cells = 16, cellTicks = TPQ / 4): TsPart {
  return {
    id: "drums",
    name: "Барабаны",
    kind: "drums",
    program: 0,
    capo: 0,
    staves: [{ tab: false, clef: "G", bars: Array.from({ length: count }, (_, i) => [patternBar(bars[i % bars.length], cells, cellTicks)]) }],
  };
}
