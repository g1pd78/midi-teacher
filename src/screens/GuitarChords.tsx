import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, PADS_DEVICE } from "../api";
import { ChordDiagram } from "../components/ChordDiagram";
import { Fretboard, type FretMark } from "../components/Fretboard";
import type { ExerciseStatView } from "../lib/exercises";
import { chordName, parseChord } from "../lib/chords";
import { openTuning } from "../lib/guitar";
import { chordShape, FORM_NAME, judgeGuitarChord, shapeForTuning, shapePitches, type ChordShape } from "../lib/guitarChords";
import {
  CHANGE_PAIRS,
  CHANGES_GOAL,
  CHANGES_SECS,
  GTR_CHORD_LEVELS,
  GTR_CHORD_PASS_ACCURACY,
  GTR_CHORD_PASS_TIME_MS,
  GTR_CHORD_SERIES,
  accuracyToChanges,
  changeId,
  changesToAccuracy,
  gtrChordLevelId,
  gtrChordSeries,
  gtrChordUnlocked,
  pcNames,
  type ChangePair,
  type GtrChordLevel,
} from "../lib/guitarChordDrill";
import { useApp, useMidi } from "../store";
import { LevelCard } from "../components/LevelCard";
import { missingShapes, patternArrows, songStrumBars, strumSong, type StrumPattern } from "../lib/strum";
import { parseChart, type LeadSong } from "../lib/songs";
import { partChart, songAccompaniment } from "../lib/tabsong";
import { PieceView, type PieceSource } from "./PieceView";

export interface GtrSetup {
  tuning: number[];
  capo: number;
  bass: boolean;
}

/** Строй гитары с вкладки «Гитара» (аккорды — всегда шестиструнная гитара). */
export function useGtrSetup(): GtrSetup | null {
  const [setup, setSetup] = useState<GtrSetup | null>(null);
  useEffect(() => {
    api
      .guitarState()
      .then((g) =>
        setSetup({
          tuning: openTuning({ instrument: "guitar", tuning: g.config.instrument === "guitar" ? g.config.tuning : null }),
          capo: g.config.instrument === "guitar" ? g.config.capo : 0,
          bass: g.config.instrument === "bass",
        }),
      )
      .catch(() => setSetup({ tuning: openTuning({ instrument: "guitar", tuning: null }), capo: 0, bass: false }));
  }, []);
  return setup;
}

/**
 * Удар по струнам: ноты, начатые в пределах ~200 мс, — один аккорд (звук гитары в режиме
 * аккорда приходит сразу целиком, MIDI-гитара или клавиатура — с разбросом).
 */
export function useStrum(onStrum: (pitches: number[]) => void, windowMs = 200) {
  const cb = useRef(onStrum);
  cb.current = onStrum;
  const acc = useRef<number[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  useMidi((ev) => {
    if (ev.type !== "noteOn" || ev.device === PADS_DEVICE) return;
    acc.current.push(ev.note);
    if (!timer.current)
      timer.current = setTimeout(() => {
        timer.current = null;
        const ps = [...new Set(acc.current)].sort((a, b) => a - b);
        acc.current = [];
        cb.current(ps);
      }, windowMs);
  });
}

/** Распознаванию звука — какие аккорды сейчас ждём (снимается при уходе с экрана). */
export function useExpectChords(chords: number[][]) {
  const key = JSON.stringify(chords);
  useEffect(() => {
    void api.guitarExpectChords(JSON.parse(key)).catch(() => {});
  }, [key]);
  useEffect(() => () => void api.guitarExpectChords([]).catch(() => {}), []);
}

/** Какие струны формы прозвучали не так: лишние (красные) и пропавшие (жёлтые). */
export function strumMarks(shape: ChordShape, tuning: number[], capo: number, missingPcs: number[], foreign: number[]): { wrong: number[]; missing: number[] } {
  const wrong: number[] = [];
  const missing: number[] = [];
  shape.frets.forEach((f, s) => {
    const open = tuning[s] + capo;
    if (f < 0) {
      // Заглушённая струна звучит открытой или около того.
      if (foreign.some((p) => p >= open && p <= open + 4)) wrong.push(s);
      return;
    }
    const p = open + f;
    if (missingPcs.includes(p % 12)) missing.push(s);
    else if (foreign.some((q) => Math.abs(q - p) <= 2 && q !== p)) wrong.push(s);
  });
  return { wrong, missing };
}

/** Гриф с формой аккорда (пальцы на точках). */
function ShapeBoard({ shape, tuning, capo }: { shape: ChordShape; tuning: number[]; capo: number }) {
  const { prefs } = useApp();
  const marks: FretMark[] = shape.frets.flatMap((f, s) =>
    f < 0 ? [] : [{ string: s, fret: f + capo, color: f === 0 ? "#4CC38A" : "#5AA9FF", label: f === 0 ? "○" : shape.fingers[s] ? String(shape.fingers[s]) : undefined }],
  );
  return (
    <section className="fret-board-wrap">
      <Fretboard tuning={tuning} frets={Math.max(12, ...shape.frets.map((f) => f + capo + 1))} naming={prefs.noteNames} marks={marks} />
    </section>
  );
}

/** Список в разделе «Аккорды», режим «Гитара»: ступени и смены. */
export function GuitarChordsList({
  stats,
  onDrill,
  onChanges,
}: {
  stats: ExerciseStatView[];
  onDrill: (level: GtrChordLevel) => void;
  onChanges: (pair: ChangePair) => void;
}) {
  const open = gtrChordUnlocked(stats);
  const statOf = (id: string) => stats.find((s) => s.exercise === id);
  return (
    <>
      <section className="card ex-category" data-category="guitar-chords">
        <h2 className="section-h">Тренажёр гитарных аккордов</h2>
        <p className="hint">
          Появляется аккорд и его схема — возьми и ударь по струнам. Приложение слушает звук: должны звучать все звуки аккорда
          и ничего лишнего (незаглушённая струна, не тот лад). Серия — {GTR_CHORD_SERIES} аккордов; зачёт — от{" "}
          {Math.round(GTR_CHORD_PASS_ACCURACY * 100)}% с первого удара и в среднем до {GTR_CHORD_PASS_TIME_MS / 1000} с на аккорд.
        </p>
        <div className="drum-list">
          {GTR_CHORD_LEVELS.map((l) => {
            const st = statOf(gtrChordLevelId(l.id));
            const passed = !!st?.passed;
            const isOpen = l.id <= open;
            return (
              <LevelCard
                key={l.id}
                n={l.id}
                title={l.title}
                hint={l.description}
                status={st ? `Серий: ${st.attempts}, лучшая ${Math.round(st.bestAccuracy * 100)}%` : "Ещё не играл"}
                passed={passed}
                open={isOpen}
                current={l.id === open && !passed}
                onClick={() => onDrill(l)}
                data={{ "gchord-level": l.id }}
              />
            );
          })}
        </div>
      </section>
      <section className="card ex-category" data-category="chord-changes">
        <h2 className="section-h">Смены аккордов</h2>
        <p className="hint">
          «Минута смен»: два аккорда по очереди, сколько чистых смен успеешь за {CHANGES_SECS} секунд. Считается только верно
          взятый аккорд. Хороший результат — от {CHANGES_GOAL} смен; рекорд сохраняется для каждой пары.
        </p>
        <div className="change-pairs">
          {CHANGE_PAIRS.map((p) => {
            const st = statOf(changeId(p));
            return (
              <button key={changeId(p)} className={`ex-chip${st?.passed ? " passed" : " open"}`} onClick={() => onChanges(p)} data-change-pair={changeId(p)}>
                {p.a.symbol} ↔ {p.b.symbol}
                {st && <span className="muted"> · рекорд {accuracyToChanges(st.bestAccuracy)}</span>}
              </button>
            );
          })}
        </div>
      </section>
    </>
  );
}

const HINT_MS = 4000;

/** Серия тренажёра гитарных аккордов. */
export function GuitarChordDrill({ level, seed, onAgain, onBack, onRecorded }: { level: GtrChordLevel; seed: number; onAgain: () => void; onBack: () => void; onRecorded: () => void }) {
  const setup = useGtrSetup();
  const series = useMemo(() => gtrChordSeries(level, seed), [level, seed]);
  const [index, setIndex] = useState(0);
  const [results, setResults] = useState<{ first: boolean; ms: number }[]>([]);
  const [flash, setFlash] = useState<"ok" | "wrong" | null>(null);
  const [verdict, setVerdict] = useState<{ missing: number[]; foreign: number[] } | null>(null);
  const [showShape, setShowShape] = useState(true);
  const [hint, setHint] = useState(false);
  const missed = useRef(false);
  const since = useRef(performance.now());
  const done = index >= series.length;
  const cur = series[Math.min(index, series.length - 1)];
  const shape = setup ? shapeForTuning(cur.shape, setup.tuning) : cur.shape;
  const expected = setup ? shapePitches(shape, setup.tuning, setup.capo) : [];
  useExpectChords(done || !setup ? [] : [expected]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onBack();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onBack]);

  useEffect(() => {
    setHint(false);
    setVerdict(null);
    since.current = performance.now();
    missed.current = false;
    if (done) return;
    const t = setTimeout(() => setHint(true), HINT_MS);
    return () => clearTimeout(t);
  }, [index, done]);

  useStrum((pitches) => {
    if (done || flash === "ok" || !setup) return;
    // Звук аккорда переводим обратно в звуки без каподастра не нужно: имена звуков те же, высоты — как звучат.
    const v = judgeGuitarChord(transposeSymbol(cur.item.symbol, setup.capo), pitches);
    setVerdict(v.ok ? null : { missing: v.missing, foreign: v.foreign });
    if (v.ok) {
      const ms = performance.now() - since.current;
      setResults((r) => [...r, { first: !missed.current, ms }]);
      setFlash("ok");
      setTimeout(() => {
        setFlash(null);
        setIndex((i) => i + 1);
      }, 500);
    } else {
      missed.current = true;
      setFlash("wrong");
      setTimeout(() => setFlash((f) => (f === "wrong" ? null : f)), 400);
    }
  });

  const recorded = useRef(false);
  const accuracy = results.length ? results.filter((r) => r.first).length / results.length : 0;
  const avgMs = results.length ? results.reduce((s, r) => s + r.ms, 0) / results.length : 0;
  const passed = done && accuracy >= GTR_CHORD_PASS_ACCURACY && avgMs <= GTR_CHORD_PASS_TIME_MS;
  useEffect(() => {
    if (!done || recorded.current) return;
    recorded.current = true;
    void api
      .exerciseRecord({ exercise: gtrChordLevelId(level.id), tempo: 1, accuracy, timingSdMs: Math.round(avgMs), loudness: 1, passed })
      .then(onRecorded)
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [done]);

  const chord = parseChord(cur.item.symbol);
  const marks = verdict && setup ? strumMarks(shape, setup.tuning, setup.capo, verdict.missing, verdict.foreign) : { wrong: [], missing: [] };
  const visible = showShape || hint;
  return (
    <main
      className="chord-drill gchord-drill"
      data-gchord-index={index}
      data-gchord-done={done ? (passed ? "passed" : "failed") : ""}
      data-gchord-expected={done ? "" : expected.join(",")}
    >
      <div className="piece-bar">
        <button className="ghost" onClick={onBack} title="Esc">
          ← Аккорды
        </button>
        <div className="piece-name">Гитарные аккорды · {level.title}</div>
        <label className="toggle-inline">
          <input type="checkbox" checked={showShape} onChange={(e) => setShowShape(e.target.checked)} /> Сразу показывать схему
        </label>
        <span className="chip">
          {Math.min(index + 1, series.length)} / {series.length}
        </span>
      </div>
      {setup?.bass && <div className="notice">На вкладке «Гитара» выбран бас — аккорды показаны для шестиструнной гитары.</div>}
      {!done ? (
        <section className={`card chord-card gchord-card${flash ? ` flash-${flash}` : ""}`} data-gchord-target={cur.item.symbol}>
          <div className="gchord-row">
            <div>
              <div className="chord-symbol">{cur.item.symbol}</div>
              <div className="chord-name">{chord ? chordName(chord) : ""}</div>
              <div className="muted">{FORM_NAME[shape.form]}{setup?.capo ? ` · каподастр ${setup.capo}` : ""}</div>
              {verdict && (
                <div className="gchord-verdict" data-gchord-verdict>
                  {verdict.missing.length > 0 && <div className="warn-text">Не слышно: {pcNames(verdict.missing)}</div>}
                  {verdict.foreign.length > 0 && <div className="bad-text">Лишнее: {pcNames([...new Set(verdict.foreign.map((p) => p % 12))])}</div>}
                </div>
              )}
            </div>
            {visible ? <ChordDiagram shape={shape} size={150} wrong={marks.wrong} missing={marks.missing} /> : <div className="muted chord-wait">Схема — через несколько секунд</div>}
          </div>
        </section>
      ) : (
        <section className="card chord-card summary-inline">
          <h2>{passed ? "Засчитано ✓" : "Серия сыграна"}</h2>
          <div className="summary-stats">
            <div>
              <div className={`big ${accuracy >= GTR_CHORD_PASS_ACCURACY ? "good" : ""}`}>{Math.round(accuracy * 100)}%</div>
              <div className="muted">с первого удара</div>
            </div>
            <div>
              <div className={`big ${avgMs <= GTR_CHORD_PASS_TIME_MS ? "good" : ""}`}>{(avgMs / 1000).toFixed(1).replace(".", ",")} с</div>
              <div className="muted">в среднем на аккорд</div>
            </div>
          </div>
          {!passed && (
            <p className="hint">
              Для зачёта — от {Math.round(GTR_CHORD_PASS_ACCURACY * 100)}% с первого удара и до {GTR_CHORD_PASS_TIME_MS / 1000} с на аккорд.
            </p>
          )}
          {passed && <p className="hint">Следующая ступень открыта.</p>}
          <div className="summary-actions">
            <button className="primary" onClick={onAgain}>
              Ещё серия
            </button>
            <button className="ghost" onClick={onBack}>
              К списку
            </button>
          </div>
        </section>
      )}
      {!done && setup && visible && <ShapeBoard shape={shape} tuning={setup.tuning} capo={setup.capo} />}
    </main>
  );
}

/** Аккорд, который звучит при каподастре (C с каподастром 2 звучит как D). */
export function transposeSymbol(symbol: string, semis: number): string {
  if (!semis) return symbol;
  const c = parseChord(symbol);
  if (!c) return symbol;
  const NAMES = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];
  const SEMI: Record<string, number> = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };
  const root = (((SEMI[c.letter] + c.alter + semis) % 12) + 12) % 12;
  return NAMES[root] + c.quality;
}

/** «Минута смен»: два аккорда по очереди за минуту. */
export function ChordChanges({ pair, best, onBack, onRecorded }: { pair: ChangePair; best: number; onBack: () => void; onRecorded: () => void }) {
  const setup = useGtrSetup();
  const [phase, setPhase] = useState<"idle" | "count" | "run" | "done">("idle");
  const [left, setLeft] = useState(CHANGES_SECS);
  const [count, setCount] = useState(0);
  const [side, setSide] = useState<0 | 1>(0);
  const [flash, setFlash] = useState<"ok" | "wrong" | null>(null);
  const endAt = useRef(0);
  const shapes = useMemo(() => {
    const raw = [chordShape(pair.a.symbol, pair.a.form)!, chordShape(pair.b.symbol, pair.b.form)!];
    return setup ? raw.map((s) => shapeForTuning(s, setup.tuning)) : raw;
  }, [pair, setup]);
  const pitches = setup ? shapes.map((s) => shapePitches(s, setup.tuning, setup.capo)) : [[], []];
  const symbols = [pair.a.symbol, pair.b.symbol];
  useExpectChords(phase === "run" || phase === "idle" ? [pitches[side]] : []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onBack();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onBack]);

  const start = useCallback(() => {
    setCount(0);
    setSide(0);
    setPhase("count");
    setLeft(3);
  }, []);

  useEffect(() => {
    if (phase !== "count" && phase !== "run") return;
    const t = setInterval(() => {
      if (phase === "count") {
        setLeft((l) => {
          if (l <= 1) {
            endAt.current = performance.now() + CHANGES_SECS * 1000;
            setPhase("run");
            return CHANGES_SECS;
          }
          return l - 1;
        });
      } else {
        const rest = Math.max(0, Math.ceil((endAt.current - performance.now()) / 1000));
        setLeft(rest);
        if (rest <= 0) setPhase("done");
      }
    }, phase === "count" ? 1000 : 200);
    return () => clearInterval(t);
  }, [phase]);

  // Итог — один раз за попытку.
  const recordedFor = useRef(-1);
  const attempt = useRef(0);
  useEffect(() => {
    if (phase === "run") attempt.current++;
    if (phase !== "done" || recordedFor.current === attempt.current) return;
    recordedFor.current = attempt.current;
    void api
      .exerciseRecord({ exercise: changeId(pair), tempo: 1, accuracy: changesToAccuracy(count), timingSdMs: 0, loudness: 1, passed: count >= CHANGES_GOAL })
      .then(onRecorded)
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  useStrum((ps) => {
    if (!setup || (phase !== "run" && phase !== "idle")) return;
    const ok = judgeGuitarChord(transposeSymbol(symbols[side], setup.capo), ps).ok;
    setFlash(ok ? "ok" : "wrong");
    setTimeout(() => setFlash(null), 250);
    if (!ok) return;
    if (phase === "run") setCount((c) => c + 1);
    setSide((s) => (s === 0 ? 1 : 0));
  });

  const record = Math.max(best, phase === "done" ? count : 0);
  return (
    <main className="chord-drill chord-changes" data-changes-phase={phase} data-changes-count={count} data-changes-side={side} data-changes-expected={pitches[side].join(",")}>
      <div className="piece-bar">
        <button className="ghost" onClick={onBack} title="Esc">
          ← Аккорды
        </button>
        <div className="piece-name">
          Минута смен · {pair.a.symbol} ↔ {pair.b.symbol}
        </div>
        <span className="chip">рекорд {record}</span>
      </div>
      <section className={`card chord-card${flash ? ` flash-${flash}` : ""}`}>
        <div className="changes-head">
          <div className="changes-timer">{phase === "count" ? left : phase === "run" ? `${left} с` : phase === "done" ? "Время!" : `${CHANGES_SECS} с`}</div>
          <div className="changes-count">
            <span className="big">{count}</span> <span className="muted">смен</span>
          </div>
        </div>
        <div className="changes-shapes">
          {shapes.map((s, i) => (
            <div key={i} className={`changes-shape${side === i ? " on" : ""}`}>
              <ChordDiagram shape={s} size={140} />
            </div>
          ))}
        </div>
        {phase === "idle" && <p className="hint">Можно разыграться: удар по аккорду в рамке переключает на другой. Когда готов — «▶ Минута».</p>}
        {phase === "done" && (
          <p className="hint" data-changes-result={count}>
            {count >= CHANGES_GOAL ? `Отлично: ${count} смен за минуту.` : `${count} смен за минуту. Цель — ${CHANGES_GOAL}: смены станут быстрее, если заранее «видеть» следующую форму и двигать пальцы вместе.`}
            {count > best && best > 0 ? " Новый рекорд!" : ""}
          </p>
        )}
        <div className="summary-actions">
          {phase !== "run" && phase !== "count" && (
            <button className="primary" onClick={start} data-changes-start>
              ▶ Минута
            </button>
          )}
          {(phase === "run" || phase === "count") && (
            <button onClick={() => setPhase("idle")} data-changes-stop>
              ■ Стоп
            </button>
          )}
        </div>
      </section>
      {setup && <ShapeBoard shape={shapes[side]} tuning={setup.tuning} capo={setup.capo} />}
    </main>
  );
}

/** Аккорды песни маленькими схемами (в строке списка — первые несколько). */
export function SongShapes({ song, size = 46, max = 5 }: { song: LeadSong; size?: number; max?: number }) {
  const symbols = [...new Set(parseChart(song.chords, song).chords.map((c) => c.chord.symbol.replace(/\/.*$/, "")))];
  return (
    <span className="song-shapes">
      {symbols.slice(0, max).map((sym) => {
        const sh = chordShape(sym);
        return sh ? <ChordDiagram key={sym} shape={sh} size={size} /> : <span key={sym} className="muted">{sym}</span>;
      })}
      {symbols.length > max && <span className="muted">…</span>}
    </span>
  );
}

/** Песня по буквам боем: табы с аккордами и стрелками, барабаны, схемы сверху. */
export function GuitarSongView({ song, pattern, onBack }: { song: LeadSong; pattern: StrumPattern; onBack: () => void }) {
  const setup = useGtrSetup();
  const source: PieceSource | null = useMemo(() => {
    if (!setup) return null;
    const bars = songStrumBars(song, pattern);
    const ts = strumSong({ bars, pattern, bpm: song.bpm, tuning: setup.tuning, capo: setup.capo, title: song.title });
    const symbols = [...new Set(bars.flatMap((b) => b.chords.map((c) => c.symbol)))];
    const missing = missingShapes(bars);
    return {
      id: `gstrum:${song.id}:${pattern.id}`,
      title: `${song.title} · бой «${pattern.name}»`,
      load: async () => ({ data: partChart(ts, 0).mei, zip: false }),
      accompaniment: songAccompaniment(ts, 0),
      instrument: "guitar",
      backLabel: "← Аккорды",
      banner: (
        <div className="song-banner" data-song-banner>
          <span className="song-banner-arrows" title="Схема боя">
            {patternArrows(pattern)}
          </span>
          {symbols.map((sym) => {
            const sh = chordShape(sym);
            return sh ? <ChordDiagram key={sym} shape={shapeForTuning(sh, setup.tuning)} size={64} /> : null;
          })}
          {missing.length > 0 && <span className="muted">Нет схемы: {missing.join(", ")} — эти такты пропущены</span>}
        </div>
      ),
    };
  }, [song, pattern, setup]);
  if (!source) return null;
  return <PieceView key={source.id} source={source} onBack={onBack} />;
}
