// Имитация движка практики для браузера (упрощённая копия `mt_core::practice`).

import type { AttemptRecord, Outcome, PieceProgress, PracticeView, Progress, Suggestion, UnitState, UnitView } from "./api";
import type { PieceMetaIn, PlayHands } from "./lib/practice";
import type { Finger, FingerNoteIn } from "./lib/fingering";

interface PieceRec {
  meta: PieceMetaIn;
  custom: number[] | null;
  units: Map<string, UnitState>;
  attempts: { at: number; a: AttemptRecord }[];
  openedAt: number;
}

function split(measures: number, ends: number[]): [number, number][] {
  const out: [number, number][] = [];
  let start = 1;
  for (let m = 1; m <= measures; m++) {
    const len = m - start + 1;
    if ((len >= 2 && ends.includes(m)) || len >= 4) {
      out.push([start, m]);
      start = m + 1;
    }
  }
  if (start <= measures) {
    if (measures - start + 1 === 1 && out.length) {
      const last = out[out.length - 1];
      if (last[1] - last[0] + 1 > 2) {
        last[1] -= 1;
        start -= 1;
      } else {
        last[1] = measures;
        start = measures + 1;
      }
    }
    if (start <= measures) out.push([start, measures]);
  }
  return out;
}

function fromStarts(measures: number, starts: number[]): [number, number][] {
  const s = [...new Set([1, ...starts.filter((m) => m >= 1 && m <= measures)])].sort((a, b) => a - b);
  return s.map((a, i) => [a, i + 1 < s.length ? s[i + 1] - 1 : measures]);
}

const fresh = (level: number): UnitState => ({ level, streak: 0, fails: 0, rightStreak: 0, leftStreak: 0, tempo: 0.6, learned: false, passes: 0 });

function handFor(st: UnitState, h: { right: boolean; left: boolean }): PlayHands {
  if (st.level === 0) return "none";
  const both = h.right && h.left;
  if (st.level === 1 && both) return st.rightStreak < 3 ? "right" : st.leftStreak < 3 ? "left" : st.rightStreak <= st.leftStreak ? "right" : "left";
  return both ? "both" : h.right ? "right" : "left";
}

export function createPracticeMock() {
  const pieces = new Map<string, PieceRec>();
  const manual = new Map<string, Map<string, number>>();
  const exResults: { exercise: string; at: number; tempo: number; accuracy: number; timingSdMs: number; loudness: number; passed: boolean }[] = [];
  let warmupAt = 0;
  const exStats = () => {
    const by = new Map<string, typeof exResults>();
    for (const r of exResults) by.set(r.exercise, [...(by.get(r.exercise) ?? []), r]);
    return [...by].map(([exercise, rs]) => ({
      exercise,
      attempts: rs.length,
      passed: rs.some((r) => r.passed),
      passes: rs.filter((r) => r.passed).length,
      bestAccuracy: Math.max(...rs.map((r) => r.accuracy)),
      lastAt: rs[rs.length - 1].at,
      lastTimingSdMs: rs[rs.length - 1].timingSdMs,
      lastLoudness: rs[rs.length - 1].loudness,
    }));
  };

  // Имитация подбора: палец по положению ноты в пятипальцевой позиции руки.
  function fingers(piece: string, notes: FingerNoteIn[]): Finger[] {
    const man = manual.get(piece) ?? new Map<string, number>();
    const base = { right: 0, left: 0 };
    return [...notes]
      .sort((a, b) => a.startMs - b.startMs)
      .map((n) => {
        const m = man.get(n.id);
        if (m) return { id: n.id, finger: m, source: "manual" as const };
        if (n.file) return { id: n.id, finger: n.file, source: "file" as const };
        let off = n.pitch - base[n.hand];
        if (!base[n.hand] || off < 0 || off > 7) {
          base[n.hand] = n.hand === "right" ? n.pitch : n.pitch - 7;
          off = n.pitch - base[n.hand];
        }
        const pos = Math.min(4, Math.round(off / 1.8));
        return { id: n.id, finger: n.hand === "right" ? pos + 1 : 5 - pos, source: "auto" as const };
      });
  }
  const play = new Map<number, number>();
  let lastNote = 0;

  const fragments = (r: PieceRec) => (r.custom ? fromStarts(r.meta.measures, r.custom) : split(r.meta.measures, r.meta.phraseEnds));

  function view(r: PieceRec): PracticeView {
    const frs = fragments(r);
    const chain: [number, number][] = [];
    frs.forEach((_, i) => {
      chain.push([i, i]);
      if (i > 0) chain.push([0, i]);
    });
    const units: UnitView[] = chain.map((frags) => {
      const from = frs[frags[0]][0];
      const to = frs[frags[1]][1];
      const saved = r.units.get(`${from}-${to}`);
      const state = saved ?? fresh(frags[0] === frags[1] ? 0 : 2);
      const hands = { right: false, left: false };
      for (let m = from; m <= to; m++) {
        const bits = r.meta.measureHands[m - 1] ?? 0;
        hands.right ||= (bits & 1) !== 0;
        hands.left ||= (bits & 2) !== 0;
      }
      return { frags, from, to, state, hand: handFor(state, hands), hands, started: !!saved };
    });
    const heat = new Map<number, number>();
    for (const { a } of r.attempts) for (const t of a.trouble) heat.set(t.measure, (heat.get(t.measure) ?? 0) + t.errors);
    const cur = units.findIndex((u) => !u.state.learned);
    return {
      piece: r.meta.id,
      measures: r.meta.measures,
      fragments: frs,
      custom: !!r.custom,
      units,
      current: cur < 0 ? units.length - 1 : cur,
      heat: [...heat].sort((a, b) => a[0] - b[0]).map(([measure, errors]) => ({ measure, errors })),
    };
  }

  function record(st: UnitState, a: AttemptRecord, hands: { right: boolean; left: boolean }): Outcome {
    st.passes++;
    const out: Outcome = { good: false, suggestion: null, tempo: null, learnedNow: false };
    if (a.level !== st.level) return out;
    const good = st.level === 0 || a.accuracy >= 0.95;
    const bad = st.level > 0 && a.accuracy < 0.8;
    out.good = good;
    st.streak = good ? st.streak + 1 : 0;
    if (good) st.fails = 0;
    else if (bad) st.fails++;
    const down = (to: number): Suggestion => ({ kind: "levelDown", to });
    if (st.level === 0) out.suggestion = { kind: "levelUp", to: 1 };
    else if (st.level === 1) {
      if (a.hands === "right") st.rightStreak = good ? st.rightStreak + 1 : 0;
      else if (a.hands === "left") st.leftStreak = good ? st.leftStreak + 1 : 0;
      if ((!hands.right || st.rightStreak >= 3) && (!hands.left || st.leftStreak >= 3)) out.suggestion = { kind: "levelUp", to: 2 };
      else if (st.fails >= 3) out.suggestion = down(0);
    } else if (st.level === 2) {
      if (st.streak >= 3) out.suggestion = { kind: "levelUp", to: 3 };
      else if (st.fails >= 3) out.suggestion = down(1);
    } else if (st.level === 3) {
      if (good && st.tempo < 0.999) {
        st.tempo = Math.min(1, Math.round((st.tempo + 0.1) * 100) / 100);
        st.streak = 0;
        out.tempo = st.tempo;
      } else if (st.fails >= 3) {
        if (st.tempo > 0.601) {
          st.tempo = Math.round((st.tempo - 0.1) * 100) / 100;
          st.fails = 0;
          out.tempo = st.tempo;
        } else out.suggestion = down(2);
      }
      if (st.streak >= 3) out.suggestion = { kind: "levelUp", to: 4 };
    } else if (st.streak >= 3) {
      out.learnedNow = !st.learned;
      st.learned = true;
      out.suggestion = { kind: "learned" };
    } else if (st.fails >= 3) out.suggestion = down(3);
    return out;
  }

  const get = (piece: string) => {
    const r = pieces.get(piece);
    if (!r) throw new Error(`пьеса ${piece} ещё не открывалась`);
    return r;
  };
  const unitOf = (r: PieceRec, from: number, to: number) => view(r).units.find((u) => u.from === from && u.to === to);

  return {
    onNote() {
      const now = performance.now();
      if (lastNote && now - lastNote < 30000) {
        const secs = Math.floor(Date.now() / 1000);
        const bucket = secs - (secs % 900);
        play.set(bucket, (play.get(bucket) ?? 0) + (now - lastNote) / 1000);
      }
      lastNote = now;
    },
    handlers: {
      exercise_stats: () => exStats(),
      exercise_record: ({ result }: { result: Omit<(typeof exResults)[number], "at"> }) => {
        exResults.push({ ...result, at: Date.now() / 1000 });
        return exStats();
      },
      exercise_history: ({ prefix, since }: { prefix: string; since: number }) =>
        exResults
          .filter((r) => r.exercise.startsWith(prefix) && r.at >= since)
          .map((r) => ({ exercise: r.exercise, finishedAt: r.at, accuracy: r.accuracy, passed: r.passed })),
      warmup_done: () => {
        warmupAt = Date.now() / 1000;
      },
      today_status: ({ dayStart }: { dayStart: number }) => {
        const last = [...pieces.values()].sort((a, b) => b.openedAt - a.openedAt)[0];
        return {
          warmupDone: warmupAt >= dayStart,
          exercises: exResults.filter((r) => r.at >= dayStart && !/^(read|rhythm)-/.test(r.exercise)).length,
          trainerSessions: 0,
          pieceAttempts: [...pieces.values()].reduce((n, r) => n + r.attempts.filter((a) => a.at >= dayStart).length, 0),
          lastPiece: last ? [last.meta.id, last.meta.title] : null,
        };
      },
      fingering_get: ({ piece, notes }: { piece: string; notes: FingerNoteIn[] }) => fingers(piece, notes),
      fingering_set: ({ piece, notes, noteId, finger }: { piece: string; notes: FingerNoteIn[]; noteId: string; finger: number | null }) => {
        const m = manual.get(piece) ?? new Map<string, number>();
        if (finger) m.set(noteId, finger);
        else m.delete(noteId);
        manual.set(piece, m);
        return fingers(piece, notes);
      },
      practice_open: ({ meta }: { meta: PieceMetaIn }) => {
        const old = pieces.get(meta.id);
        const r: PieceRec = old
          ? { ...old, meta, custom: old.meta.measures === meta.measures ? old.custom : null, openedAt: Date.now() / 1000 }
          : { meta, custom: null, units: new Map(), attempts: [], openedAt: Date.now() / 1000 };
        pieces.set(meta.id, r);
        return view(r);
      },
      practice_set_fragments: ({ piece, starts }: { piece: string; starts: number[] | null }) => {
        const r = get(piece);
        r.custom = starts;
        return view(r);
      },
      practice_set_level: ({ piece, from, to, level }: { piece: string; from: number; to: number; level: number }) => {
        const r = get(piece);
        const st = { ...(unitOf(r, from, to)?.state ?? fresh(0)) };
        if (level === 3 && st.level !== 3) st.tempo = 0.6;
        Object.assign(st, { level, streak: 0, fails: 0, rightStreak: 0, leftStreak: 0 });
        r.units.set(`${from}-${to}`, st);
        return view(r);
      },
      practice_record: ({ piece, attempt }: { piece: string; attempt: AttemptRecord }) => {
        const r = get(piece);
        r.attempts.push({ at: Date.now() / 1000, a: attempt });
        let outcome: Outcome | null = null;
        if (attempt.level !== null) {
          const u = unitOf(r, attempt.from, attempt.to);
          const st = { ...(u?.state ?? fresh(0)) };
          outcome = record(st, attempt, u?.hands ?? { right: true, left: true });
          r.units.set(`${attempt.from}-${attempt.to}`, st);
        }
        return { outcome, view: view(r) };
      },
      progress_overview: (): Progress => ({
        play: [...play].sort((a, b) => a[0] - b[0]),
        bucketSecs: 900,
        pieces: [...pieces.values()]
          .sort((a, b) => b.openedAt - a.openedAt)
          .map((r): PieceProgress => {
            const v = view(r);
            return {
              id: r.meta.id,
              title: r.meta.title,
              measures: r.meta.measures,
              fragments: v.units
                .filter((u) => u.frags[0] === u.frags[1])
                .map((u) => ({ from: u.from, to: u.to, level: u.state.level, learned: u.state.learned, started: u.started })),
              learned: v.units[v.units.length - 1]?.state.learned ?? false,
              heat: v.heat,
              activity: {
                attempts: r.attempts.length,
                lastAt: r.attempts.length ? r.attempts[r.attempts.length - 1].at : null,
                minutes: r.attempts.reduce((s, x) => s + x.a.durationMs, 0) / 60000,
              },
              openedAt: r.openedAt,
            };
          }),
      }),
    },
  };
}
