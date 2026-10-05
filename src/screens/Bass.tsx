import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, PADS_DEVICE } from "../api";
import { Fretboard, type FretMark } from "../components/Fretboard";
import { LevelCard } from "../components/LevelCard";
import { usePlayError } from "../components/PlayError";
import { BASS_STYLES, BASS_STYLE_BY_ID, DEFAULT_BASS_ACCOMP, bassAccompaniment, bassLineSong, quarterBeats, type BassAccomp, type BassStyle } from "../lib/bassline";
import { ROOT_LEVELS, ROOT_PASS, ROOT_WINDOW, checkPitch, rootAccompaniment, rootLevelId, rootSession, rootUnlocked, scoreRoot, type RootLevel } from "../lib/bassRoot";
import { bassPc, parseChord } from "../lib/chords";
import type { ExerciseStatView } from "../lib/exercises";
import { openTuning } from "../lib/guitar";
import { GTR_PASS } from "../lib/guitarExercises";
import { pitchName } from "../lib/notes";
import type { LeadSong } from "../lib/songs";
import { partChart } from "../lib/tabsong";
import { useApp, useMidi } from "../store";
import { PieceView, type PieceSource } from "./PieceView";
import { useBackLabel } from "../components/BackLabel";

/** Строй баса с вкладки «Гитара» (если там выбран бас), иначе стандартный. */
export function useBassTuning(): number[] {
  const [tuning, setTuning] = useState<number[]>(() => openTuning({ instrument: "bass", tuning: null }));
  useEffect(() => {
    api
      .guitarState()
      .then((g) => setTuning(openTuning({ instrument: "bass", tuning: g.config.instrument === "bass" ? g.config.tuning : null })))
      .catch(() => {});
  }, []);
  return tuning;
}

const ACCOMP_KEY = "mt-bass-accomp";
function loadAccomp(): BassAccomp {
  try {
    return { ...DEFAULT_BASS_ACCOMP, ...(JSON.parse(localStorage.getItem(ACCOMP_KEY) ?? "{}") as Partial<BassAccomp>) };
  } catch {
    return DEFAULT_BASS_ACCOMP;
  }
}

/** Что звучит вместе с басом: запоминается на этом компьютере. */
export function useBassAccomp(): [BassAccomp, (a: Partial<BassAccomp>) => void] {
  const [accomp, setAccomp] = useState<BassAccomp>(loadAccomp);
  const update = useCallback((a: Partial<BassAccomp>) => {
    setAccomp((cur) => {
      const next = { ...cur, ...a };
      try {
        localStorage.setItem(ACCOMP_KEY, JSON.stringify(next));
      } catch {
        /* без сохранения */
      }
      return next;
    });
  }, []);
  return [accomp, update];
}

/** Аккомпанемент баса: аккорды (фортепиано, гитара или нет), барабаны и их громкость. */
export function BassAccompControls({ accomp, onChange }: { accomp: BassAccomp; onChange: (a: Partial<BassAccomp>) => void }) {
  return (
    <div className="bass-accomp" data-bass-accomp>
      <span className="muted">Вместе с басом:</span>
      <label>
        Аккорды{" "}
        <select value={accomp.chords} onChange={(e) => onChange({ chords: e.target.value as BassAccomp["chords"] })} data-bass-chords>
          <option value="piano">фортепиано</option>
          <option value="guitar">гитара</option>
          <option value="none">нет</option>
        </select>
      </label>
      <label title="Громкость аккордов">
        <input type="range" min={10} max={100} step={5} value={accomp.chordsVolume} disabled={accomp.chords === "none"} onChange={(e) => onChange({ chordsVolume: Number(e.target.value) })} />
      </label>
      <label className="toggle-inline">
        <input type="checkbox" checked={accomp.drums} onChange={(e) => onChange({ drums: e.target.checked })} data-bass-drums /> Барабаны
      </label>
      <label title="Громкость барабанов">
        <input type="range" min={10} max={100} step={5} value={accomp.drumsVolume} disabled={!accomp.drums} onChange={(e) => onChange({ drumsVolume: Number(e.target.value) })} />
      </label>
    </div>
  );
}

/** Выбор стиля линии и «▶ Басом» в строке песни. */
export function BassSongPlay({ onPlay }: { onPlay: (style: BassStyle) => void }) {
  const [style, setStyle] = useState<BassStyle>("roots");
  return (
    <span className="song-strum">
      <select value={style} onChange={(e) => setStyle(e.target.value as BassStyle)} data-song-bass-style title={BASS_STYLE_BY_ID.get(style)!.hint}>
        {BASS_STYLES.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </select>
      <button onClick={() => onPlay(style)} data-song-bass-play>
        ▶ Басом
      </button>
    </span>
  );
}

/** Песня по буквам басом: табы линии, буквы аккордов, барабаны и аккорды; итог с оценкой грува. */
export function BassSongView({ song, style, onBack }: { song: LeadSong; style: BassStyle; onBack: () => void }) {
  const back = useBackLabel("← Аккорды");
  const tuning = useBassTuning();
  const [accomp] = useBassAccomp();
  const st = BASS_STYLE_BY_ID.get(style)!;
  const tuningKey = tuning.join(",");
  const source: PieceSource = useMemo(() => {
    const ts = bassLineSong(song, style, tuning, accomp);
    return {
      id: `bline:${song.id}:${style}`,
      title: `${song.title} · бас: ${st.name.toLowerCase()}`,
      load: async () => ({ data: partChart(ts, 0).mei, zip: false }),
      accompaniment: bassAccompaniment(ts, accomp),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [song, style, tuningKey]);
  return (
    <PieceView
      key={source.id + tuningKey}
      source={source}
      onBack={onBack}
      exercise={{
        id: `bassline-${song.id}-${style}`,
        instrument: "bass",
        hint: st.hint,
        pass: GTR_PASS,
        listen: true,
        backLabel: back,
        groove: { bpm: song.bpm, beats: quarterBeats(song), drums: accomp.drums },
      }}
    />
  );
}

/** Список ступеней «Найди основной тон». */
export function RootTrainerList({ stats, onLevel }: { stats: ExerciseStatView[]; onLevel: (l: RootLevel) => void }) {
  const open = rootUnlocked(stats);
  const statOf = (id: string) => stats.find((s) => s.exercise === id);
  return (
    <section className="card ex-category" data-category="bass-root">
      <h2 className="section-h">Найди основной тон</h2>
      <p className="hint">
        Звучат барабаны и аккорды — без баса. Играй линию сам: на смене аккорда должен прозвучать его основной тон (буква
        аккорда; у «C/E» — нижняя нота E). Серия — три круга последовательности; зачёт — от {Math.round(ROOT_PASS * 100)}% верных нот.
      </p>
      <div className="drum-list">
        {ROOT_LEVELS.map((l) => {
          const st = statOf(rootLevelId(l.id));
          const passed = !!st?.passed;
          return (
            <LevelCard
              key={l.id}
              n={l.id}
              title={l.title}
              hint={l.description}
              status={st ? `Серий: ${st.attempts}, лучшая ${Math.round(st.bestAccuracy * 100)}%` : "Ещё не играл"}
              passed={passed}
              open={l.id <= open}
              current={l.id === open && !passed}
              onClick={() => onLevel(l)}
              data={{ "root-level": l.id }}
            />
          );
        })}
      </div>
    </section>
  );
}

/** Серия «Найди основной тон»: аккомпанемент без баса, ученик играет основные тоны. */
export function RootDrill({ level, seed, onAgain, onBack, onRecorded }: { level: RootLevel; seed: number; onAgain: () => void; onBack: () => void; onRecorded: () => void }) {
  const back = useBackLabel("← Аккорды");
  const { prefs } = useApp();
  const tuning = useBassTuning();
  const [accomp, setAccomp] = useBassAccomp();
  const session = useMemo(() => rootSession(level, seed), [level, seed]);
  const beatMs = 60000 / level.bpm;
  const totalBeats = session.bars * 4;
  const [phase, setPhase] = useState<"idle" | "count" | "run" | "done">("idle");
  const [beat, setBeat] = useState(-4);
  const [results, setResults] = useState<(boolean | null)[]>([]);
  const [last, setLast] = useState<number | null>(null);
  const t0 = useRef(0);
  const onsets = useRef<{ t: number; pitch: number }[]>([]);
  const playError = usePlayError();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onBack();
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      void api.midiPreviewStop().catch(() => {});
    };
  }, [onBack]);

  const start = () => {
    const a = rootAccompaniment(session, level.bpm, accomp);
    onsets.current = [];
    setResults([]);
    setLast(null);
    t0.current = performance.now() + a.firstBeatMs;
    setBeat(-4);
    setPhase("count");
    void api.playNotes(a.notes, null).catch(playError.report);
  };
  const stop = () => {
    void api.midiPreviewStop().catch(() => {});
    setPhase("idle");
  };

  // Часы серии: доля, итог по закрытым окнам, конец.
  useEffect(() => {
    if (phase !== "count" && phase !== "run") return;
    const t = setInterval(() => {
      const now = performance.now() - t0.current;
      const b = now / beatMs;
      setBeat(b);
      if (b >= 0 && phase === "count") setPhase("run");
      const all = scoreRoot(session, onsets.current, beatMs);
      setResults(all.map((r, i) => (now > session.checks[i].beat * beatMs + ROOT_WINDOW.late ? r : undefined)).filter((r) => r !== undefined) as (boolean | null)[]);
      if (b > totalBeats + 0.5) setPhase("done");
    }, 50);
    return () => clearInterval(t);
  }, [phase, beatMs, session, totalBeats]);

  useMidi((ev) => {
    if ((phase !== "count" && phase !== "run") || ev.type !== "noteOn" || ev.device === PADS_DEVICE) return;
    onsets.current.push({ t: performance.now() - t0.current, pitch: ev.note });
    setLast(ev.note);
  });

  const okCount = results.filter((r) => r === true).length;
  const accuracy = session.checks.length ? okCount / session.checks.length : 0;
  const passed = phase === "done" && accuracy >= ROOT_PASS;
  const recordedFor = useRef(-1);
  const attempt = useRef(0);
  useEffect(() => {
    if (phase === "count") attempt.current++;
    if (phase !== "done" || recordedFor.current === attempt.current) return;
    recordedFor.current = attempt.current;
    void api
      .exerciseRecord({ exercise: rootLevelId(level.id), tempo: 1, accuracy, timingSdMs: 0, loudness: 1, passed })
      .then(onRecorded)
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  const curIdx = session.chords.findIndex((c) => beat >= c.beat && beat < c.beat + c.beats);
  const cur = session.chords[Math.max(0, curIdx)];
  const next = session.chords[curIdx + 1];
  const running = phase === "count" || phase === "run";
  const hidden = level.hint === "ear";
  // Подсказка на грифе: все места основного тона текущего аккорда (следующий — бледнее).
  const marks: FretMark[] = [];
  if (level.hint === "board" && cur) {
    const add = (symbol: string, color: string, strength: number) => {
      const c = parseChord(symbol);
      if (!c) return;
      const pc = bassPc(c);
      tuning.forEach((open, string) => {
        for (let fret = 0; fret <= 12; fret++) if ((open + fret) % 12 === pc) marks.push({ string, fret, color, strength, label: strength > 0.5 ? pitchName(pc, prefs.noteNames) : undefined });
      });
    };
    if (next && running && next.symbol !== cur.symbol) add(next.symbol, "#FFB454", 0.35);
    add(cur.symbol, "#5AA9FF", 1);
  }
  const plan = session.checks.map((c) => `${c.beat}:${checkPitch(c, tuning[0])}`).join(",");
  return (
    <main
      className="chord-drill root-drill"
      data-root-phase={phase}
      data-root-t0={running ? String(t0.current) : ""}
      data-root-beat-ms={beatMs}
      data-root-plan={plan}
      data-root-done={phase === "done" ? (passed ? "passed" : "failed") : ""}
      data-root-ok={okCount}
    >
      <div className="piece-bar">
        <button className="ghost" onClick={onBack} title="Esc">
          {back}
        </button>
        <div className="piece-name">Найди основной тон · {level.title}</div>
        <span className="chip">{level.bpm} уд/мин</span>
      </div>
      {playError.notice}
      <section className="card chord-card">
        {phase === "done" ? (
          <div className="summary-inline">
            <h2>{passed ? "Засчитано ✓" : "Серия сыграна"}</h2>
            <div className="summary-stats">
              <div>
                <div className={`big ${passed ? "good" : ""}`}>{Math.round(accuracy * 100)}%</div>
                <div className="muted">
                  верных нот ({okCount} из {session.checks.length})
                </div>
              </div>
            </div>
            {!passed && <p className="hint">Для зачёта — от {Math.round(ROOT_PASS * 100)}%. Не прозвучало: {results.filter((r) => r === null).length}, не та нота: {results.filter((r) => r === false).length}.</p>}
            <div className="summary-actions">
              <button className="primary" onClick={onAgain}>
                Ещё серия
              </button>
              <button className="ghost" onClick={onBack}>
                К списку
              </button>
            </div>
          </div>
        ) : (
          <>
            <div className="root-now">
              <div>
                <div className="chord-symbol" data-root-chord={hidden ? "" : cur?.symbol}>
                  {phase === "count" ? Math.max(1, Math.ceil(-beat)) : hidden ? "?" : cur?.symbol}
                </div>
                <div className="muted">
                  {hidden ? `Тональность: ${session.key} мажор` : next && running ? `дальше ${next.symbol}` : `Последовательность: ${[...new Set(session.chords.slice(0, 4).map((c) => c.symbol))].join(" – ")}`}
                </div>
              </div>
              <div className="root-beats">
                {[0, 1, 2, 3].map((k) => (
                  <span key={k} className={`root-beat${running && beat >= 0 && Math.floor(beat) % 4 === k ? " on" : ""}`} />
                ))}
              </div>
              {last !== null && <div className="root-last muted">звучит: {pitchName(last, prefs.noteNames)}</div>}
            </div>
            <div className="root-results" title="Проверки по порядку: зелёная — верно, красная — не та нота, серая — не прозвучало">
              {session.checks.map((c, i) => (
                <span key={i} className={`root-dot${results[i] === true ? " ok" : results[i] === false ? " bad" : results[i] === null ? " miss" : ""}${c.kind === "root" ? " root" : ""}`} />
              ))}
            </div>
            <div className="summary-actions">
              {running ? (
                <button onClick={stop} data-root-stop>
                  ■ Стоп
                </button>
              ) : (
                <button className="primary" onClick={start} data-root-start>
                  ▶ Старт
                </button>
              )}
            </div>
            {!running && <BassAccompControls accomp={accomp} onChange={setAccomp} />}
            {level.tones && <p className="hint">На «раз» — основной тон, на остальные доли — любой звук аккорда.</p>}
          </>
        )}
      </section>
      {level.hint === "board" && phase !== "done" && (
        <section className="fret-board-wrap">
          <Fretboard tuning={tuning} frets={12} naming={prefs.noteNames} marks={marks} />
        </section>
      )}
    </main>
  );
}
