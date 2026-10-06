import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import { Fretboard, type FretMark } from "../components/Fretboard";
import { LevelCard } from "../components/LevelCard";
import { Piano } from "../components/Piano";
import { usePlayError } from "../components/PlayError";
import type { ExerciseStatView } from "../lib/exercises";
import { openTuning } from "../lib/guitar";
import {
  COUNT_IN_BEATS,
  DEFAULT_MIX,
  ECHO_LEVELS,
  ECHO_PASS,
  ECHO_SERIES,
  JAM_LESSONS,
  JAM_STYLES,
  JAM_STYLE_BY_ID,
  KEY_NAMES,
  LEAD_CHANNEL,
  SCALES,
  SCALE_IDS,
  boxWindow,
  callNotes,
  chordAt,
  chordScale,
  classify,
  customErrors,
  defaultSetup,
  echoLevelId,
  echoPlayback,
  echoSeries,
  evaluateLesson,
  highlightPcs,
  isCallBar,
  jamAccompaniment,
  jamLessonId,
  jamPlan,
  jamStats,
  jamTips,
  judgeEcho,
  scalePcs,
  soloSong,
  type EchoLevel,
  type JamInstrument,
  type JamLesson,
  type JamMix,
  type JamSetup,
  type LessonResult,
  type NoteClass,
  type PlayNote,
  type PlayedNote,
} from "../lib/jam";
import { pitchName } from "../lib/notes";
import { partChart } from "../lib/tabsong";
import { renderSvg } from "../lib/verovio";
import { useApp, useMidi } from "../store";
import { requestCode } from "../lib/codeBridge";
import { jamStyleToCode } from "../lib/strudel/fromApp";
import { useBackLabel } from "../components/BackLabel";

const CLASS_COLOR: Record<NoteClass, string> = { chord: "#4CC38A", scale: "#5AA9FF", out: "#FFB454" };
const CLASS_NAME: Record<NoteClass, string> = { chord: "звук аккорда", scale: "гамма", out: "вне гаммы" };
const INSTRUMENT_NAME: Record<JamInstrument, string> = { piano: "Фортепиано", guitar: "Гитара", bass: "Бас" };
const LEAD_PROGRAM: Record<JamInstrument, number> = { piano: 0, guitar: 27, bass: 33 };
/** Свободный джем: кругов на ~8 минут (остановить можно в любой момент). */
const FREE_MINUTES = 8;

function useStored<T>(key: string, initial: T): [T, (v: T) => void] {
  const [v, setV] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw ? ({ ...(initial as object), ...JSON.parse(raw) } as T) : initial;
    } catch {
      return initial;
    }
  });
  const set = useCallback(
    (next: T) => {
      setV(next);
      try {
        localStorage.setItem(key, JSON.stringify(next));
      } catch {
        /* без сохранения */
      }
    },
    [key],
  );
  return [v, set];
}

function useInstrumentTuning(instrument: JamInstrument): number[] {
  const kind = instrument === "bass" ? "bass" : "guitar";
  const [tuning, setTuning] = useState<number[]>(() => openTuning({ instrument: kind, tuning: null }));
  useEffect(() => {
    api
      .guitarState()
      .then((g) => setTuning(openTuning({ instrument: kind, tuning: g.config.instrument === kind ? g.config.tuning : null })))
      .catch(() => {});
  }, [kind]);
  return tuning;
}

type Run = { kind: "free" } | { kind: "lesson"; lesson: JamLesson; seed: number } | { kind: "echo"; level: EchoLevel; seed: number };

const freshSeed = () => Math.floor(Date.now() / 1000) % 100000;

/** Раздел «Джем» в «Тренажёрах»: свободный джем, уроки импровизации, «Повтори за мной». */
export function Jam({ tabs }: { tabs: React.ReactNode }) {
  const [inst, setInst] = useStored<{ v: JamInstrument }>("mt-jam-instrument", { v: "guitar" });
  const instrument = inst.v;
  const [setup, setSetup] = useStored<JamSetup>("mt-jam-setup", defaultSetup());
  const [mix, setMix] = useStored<JamMix>("mt-jam-mix", DEFAULT_MIX);
  const [stats, setStats] = useState<ExerciseStatView[]>([]);
  const [run, setRun] = useState<Run | null>(null);
  const reload = useCallback(() => {
    api.exerciseStats().then(setStats).catch(() => setStats([]));
  }, []);
  useEffect(reload, [reload]);
  const back = () => {
    setRun(null);
    reload();
  };

  if (run?.kind === "free") return <JamSession setup={setup} instrument={instrument} mix={mix} onBack={back} onRecorded={reload} />;
  if (run?.kind === "lesson")
    return (
      <JamSession
        key={`${run.lesson.id}-${run.seed}`}
        setup={run.lesson.setup}
        instrument={instrument}
        mix={mix}
        lesson={run.lesson}
        seed={run.seed}
        onAgain={() => setRun({ ...run, seed: run.seed + 1 })}
        onBack={back}
        onRecorded={reload}
      />
    );
  if (run?.kind === "echo")
    return <EchoDrill key={`${run.level.id}-${run.seed}`} level={run.level} seed={run.seed} instrument={instrument} mix={mix} onAgain={() => setRun({ ...run, seed: run.seed + 1 })} onBack={back} onRecorded={reload} />;

  const passed = new Set(stats.filter((s) => s.passed).map((s) => s.exercise));
  const statOf = (id: string) => stats.find((s) => s.exercise === id);
  const nextOpen = (ids: string[]) => {
    let n = 1;
    while (n < ids.length && passed.has(ids[n - 1])) n++;
    return n;
  };
  const lessonOpen = nextOpen(JAM_LESSONS.map((l) => jamLessonId(instrument, l.id)));
  const echoOpen = nextOpen(ECHO_LEVELS.map((l) => echoLevelId(instrument, l.id)));
  const style = JAM_STYLE_BY_ID.get(setup.style) ?? JAM_STYLES[0];
  const errors = customErrors(setup.custom);
  return (
    <main className="exercises trainers jam" data-jam-list>
      {tabs}
      <section className="card">
        <h1>Джем</h1>
        <span className="segmented ex-instrument">
          {(["piano", "guitar", "bass"] as const).map((i) => (
            <button key={i} className={instrument === i ? "on" : ""} onClick={() => setInst({ v: i })} data-jam-instrument={i}>
              {INSTRUMENT_NAME[i]}
            </button>
          ))}
        </span>
        <p className="hint">
          Звучат барабаны, бас и аккорды по кругу — играй поверх. На {instrument === "piano" ? "клавиатуре" : "грифе"} подсвечены звуки аккорда
          (зелёные) и гаммы (голубые); сыгранная нота вспыхивает своим цветом, оранжевая — вне гаммы. Игра записывается: после
          остановки — итог, ноты твоего соло, прослушивание и сохранение.
        </p>
      </section>

      <section className="card ex-category" data-category="jam-free">
        <h2 className="section-h">Свободный джем</h2>
        <div className="jam-setup">
          <label>
            Стиль{" "}
            <select
              value={setup.style}
              onChange={(e) => {
                const s = JAM_STYLE_BY_ID.get(e.target.value)!;
                setSetup({ ...setup, style: s.id, tonic: s.tonic, bpm: s.bpm, scale: s.scale });
              }}
              data-jam-style
            >
              {JAM_STYLES.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Тональность{" "}
            <select value={setup.tonic} onChange={(e) => setSetup({ ...setup, tonic: Number(e.target.value) })} data-jam-key>
              {KEY_NAMES.map((k, i) => (
                <option key={i} value={i}>
                  {k}
                </option>
              ))}
            </select>
          </label>
          <label>
            Гамма{" "}
            <select value={setup.scale} onChange={(e) => setSetup({ ...setup, scale: e.target.value as JamSetup["scale"] })} data-jam-scale-select>
              {SCALE_IDS.map((id) => (
                <option key={id} value={id}>
                  {SCALES[id].name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Темп{" "}
            <input type="range" min={50} max={160} step={5} value={setup.bpm} onChange={(e) => setSetup({ ...setup, bpm: Number(e.target.value) })} /> {setup.bpm}
          </label>
        </div>
        <p className="hint">
          {style.description}{" "}
          <button className="link" onClick={() => requestCode({ name: `Джем — ${style.name}`, text: jamStyleToCode(style, setup.tonic) })} data-jam-code>
            Открыть кодом во вкладке «Код»
          </button>
        </p>
        <label className="jam-custom">
          Свои аккорды (вместо стиля):{" "}
          <input value={setup.custom} placeholder="например: Am | F | C | G" onChange={(e) => setSetup({ ...setup, custom: e.target.value })} data-jam-custom />
        </label>
        {errors.length > 0 && <p className="bad-text">Непонятные аккорды: {errors.join(", ")}</p>}
        <MixControls mix={mix} onChange={setMix} instrument={instrument} />
        <div className="summary-actions">
          <button className="primary" disabled={errors.length > 0} onClick={() => setRun({ kind: "free" })} data-jam-free>
            ▶ Джемовать
          </button>
        </div>
      </section>

      <section className="card ex-category" data-category="jam-lessons">
        <h2 className="section-h">Уроки импровизации</h2>
        <p className="hint">У каждого урока своё правило; следующий открывается после зачёта. Прогресс — отдельно для каждого инструмента.</p>
        <div className="drum-list">
          {JAM_LESSONS.map((l) => {
            const st = statOf(jamLessonId(instrument, l.id));
            return (
              <LevelCard
                key={l.id}
                n={l.id}
                title={l.title}
                hint={l.description}
                status={st ? `Попыток: ${st.attempts}, лучшая ${Math.round(st.bestAccuracy * 100)}%` : "Ещё не играл"}
                passed={!!st?.passed}
                open={l.id <= lessonOpen}
                current={l.id === lessonOpen && !st?.passed}
                onClick={() => setRun({ kind: "lesson", lesson: l, seed: freshSeed() })}
                data={{ "jam-lesson": l.id }}
              />
            );
          })}
        </div>
      </section>

      <section className="card ex-category" data-category="jam-echo">
        <h2 className="section-h">Повтори за мной</h2>
        <p className="hint">
          Приложение играет короткую фразу под аккомпанемент — повтори её в следующем такте (любая октава). Серия — {ECHO_SERIES} фраз; зачёт —
          от {Math.round(ECHO_PASS * 100)}% повторённых верно.
        </p>
        <div className="drum-list">
          {ECHO_LEVELS.map((l) => {
            const st = statOf(echoLevelId(instrument, l.id));
            return (
              <LevelCard
                key={l.id}
                n={l.id}
                title={l.title}
                hint={l.description}
                status={st ? `Серий: ${st.attempts}, лучшая ${Math.round(st.bestAccuracy * 100)}%` : "Ещё не играл"}
                passed={!!st?.passed}
                open={l.id <= echoOpen}
                current={l.id === echoOpen && !st?.passed}
                onClick={() => setRun({ kind: "echo", level: l, seed: freshSeed() })}
                data={{ "echo-level": l.id }}
              />
            );
          })}
        </div>
      </section>
    </main>
  );
}

function MixControls({ mix, onChange, instrument }: { mix: JamMix; onChange: (m: JamMix) => void; instrument: JamInstrument }) {
  const part = (key: "drums" | "bass" | "chords", label: string, vol: "drumsVolume" | "bassVolume" | "chordsVolume", disabled = false) => (
    <span className="jam-mix-part">
      <label className="toggle-inline">
        <input type="checkbox" checked={mix[key] && !disabled} disabled={disabled} onChange={(e) => onChange({ ...mix, [key]: e.target.checked })} data-jam-mix={key} /> {label}
      </label>
      <input type="range" min={10} max={100} step={5} value={mix[vol]} disabled={!mix[key] || disabled} onChange={(e) => onChange({ ...mix, [vol]: Number(e.target.value) })} title={`Громкость: ${label.toLowerCase()}`} />
    </span>
  );
  return (
    <div className="bass-accomp jam-mix">
      <span className="muted">Аккомпанемент:</span>
      {part("drums", "Барабаны", "drumsVolume")}
      {part("bass", instrument === "bass" ? "Бас (играешь ты)" : "Бас", "bassVolume", instrument === "bass")}
      {part("chords", "Аккорды", "chordsVolume")}
    </div>
  );
}

/** Часы серии: `t0` — первая доля (performance.now), доля и позиция обновляются 20 раз в секунду. */
function useClock(running: boolean, t0: number) {
  const [now, setNow] = useState(0);
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(performance.now() - t0), 50);
    return () => clearInterval(t);
  }, [running, t0]);
  return now;
}

/** Ноты ученика: нажатие → время от первой доли, отпускание → длительность. */
function usePlayed(active: boolean, t0: React.MutableRefObject<number>) {
  const notes = useRef<PlayedNote[]>([]);
  const [last, setLast] = useState<{ pitch: number; at: number } | null>(null);
  useMidi((ev) => {
    if (!active) return;
    const t = performance.now() - t0.current;
    if (ev.type === "noteOn") {
      notes.current.push({ t, pitch: ev.note });
      setLast({ pitch: ev.note, at: performance.now() });
    } else if (ev.type === "noteOff") {
      for (let i = notes.current.length - 1; i >= 0; i--) {
        const n = notes.current[i];
        if (n.pitch === ev.note && n.dur === undefined) {
          n.dur = Math.max(30, t - n.t);
          break;
        }
      }
    }
  });
  return { notes, last, reset: () => (notes.current = []) };
}

/** Свободный джем или урок импровизации. */
function JamSession({
  setup,
  instrument,
  mix,
  lesson,
  seed = 1,
  onAgain,
  onBack,
  onRecorded,
}: {
  setup: JamSetup;
  instrument: JamInstrument;
  mix: JamMix;
  lesson?: JamLesson;
  seed?: number;
  onAgain?: () => void;
  onBack: () => void;
  onRecorded: () => void;
}) {
  const back = useBackLabel("← Джем");
  const { prefs } = useApp();
  const tuning = useInstrumentTuning(instrument);
  const style = JAM_STYLE_BY_ID.get(setup.style) ?? JAM_STYLES[0];
  const loops = useMemo(() => {
    if (lesson) return lesson.loops;
    const one = jamPlan(setup, 1);
    return Math.max(1, Math.ceil((FREE_MINUTES * 60000) / (one.loopBars * one.barMs)));
  }, [setup, lesson]);
  const plan = useMemo(() => jamPlan(setup, loops), [setup, loops]);
  const scale = useMemo(() => scalePcs(setup.tonic, setup.scale), [setup]);
  const totalMs = plan.loopBars * plan.loops * plan.barMs;
  const [phase, setPhase] = useState<"idle" | "count" | "run" | "done">("idle");
  const [box, setBox] = useState(0);
  const t0 = useRef(0);
  const acc = useRef<PlayNote[]>([]);
  const running = phase === "count" || phase === "run";
  const { notes, last, reset } = usePlayed(running, t0);
  const now = useClock(running, t0.current);
  const [result, setResult] = useState<LessonResult | null>(null);
  const [endMs, setEndMs] = useState(0);
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
    let a = jamAccompaniment(setup, plan, mix, instrument);
    if (lesson?.rule === "callresponse") a = [...a, ...callNotes(lesson, plan, instrument, seed)].sort((x, y) => x.startMs - y.startMs);
    acc.current = a;
    reset();
    setResult(null);
    t0.current = performance.now() + COUNT_IN_BEATS * plan.beatMs;
    setPhase("count");
    void api.playNotes(a, null).catch(playError.report);
  };
  const finish = useCallback(
    (manual: boolean) => {
      void api.midiPreviewStop().catch(() => {});
      setEndMs(Math.max(0, Math.min(totalMs, performance.now() - t0.current)));
      if (lesson) {
        if (manual) {
          setPhase("idle");
          return;
        }
        const r = evaluateLesson(lesson, notes.current, plan);
        setResult(r);
        void api
          .exerciseRecord({ exercise: jamLessonId(instrument, lesson.id), tempo: 1, accuracy: r.score, timingSdMs: 0, loudness: 1, passed: r.passed })
          .then(onRecorded)
          .catch(() => {});
      }
      setPhase("done");
    },
    [lesson, notes, plan, instrument, onRecorded, totalMs],
  );
  useEffect(() => {
    if (phase === "count" && now >= 0) setPhase("run");
    if (running && now > totalMs + 300) finish(false);
  }, [now, phase, running, totalMs, finish]);

  const cur = running ? chordAt(plan, Math.max(0, now)) : plan.chords[0];
  const next = cur ? plan.chords[plan.chords.indexOf(cur) + 1] : undefined;
  const bar = running ? Math.max(0, Math.floor(now / plan.barMs)) : 0;
  const barInLoop = bar % plan.loopBars;
  const lessonScale = lesson?.rule === "changes" && cur ? chordScale(cur.chord) : scale;
  const hl = highlightPcs(cur?.chord ?? null, lessonScale);
  const lastClass = last ? classify(last.pitch, (running ? chordAt(plan, last.at - t0.current) : cur)?.chord ?? null, lessonScale) : null;
  const flash = last && performance.now() - last.at < 350 ? last : null;
  const live = jamStats(notes.current, plan, scale);

  if (phase === "done")
    return (
      <SoloReview
        title={lesson ? lesson.title : `Джем · ${setup.custom.trim() ? "свои аккорды" : style.name}`}
        setup={setup}
        plan={plan}
        notes={notes.current}
        accompaniment={acc.current}
        endMs={endMs || totalMs}
        instrument={instrument}
        tuning={tuning}
        result={result}
        onAgain={() => (onAgain ? onAgain() : setPhase("idle"))}
        onBack={onBack}
      />
    );

  const marks: FretMark[] = [];
  const window_ = instrument !== "piano" && box ? boxWindow(setup.tonic, lessonScale, tuning[0], box) : null;
  if (instrument !== "piano")
    tuning.forEach((open, string) => {
      for (let fret = 0; fret <= 15; fret++) {
        const pc = (open + fret) % 12;
        const kind = hl.get(pc);
        const pressed = flash && flash.pitch === open + fret;
        if (pressed) marks.push({ string, fret, color: CLASS_COLOR[lastClass ?? "out"], strength: 1, label: pitchName(flash.pitch, prefs.noteNames) });
        else if (kind && (!window_ || (fret >= window_[0] && fret <= window_[1]))) marks.push({ string, fret, color: CLASS_COLOR[kind], strength: kind === "chord" ? 0.6 : 0.3, label: pc === setup.tonic ? "R" : undefined });
      }
    });
  const highlight: Record<number, { color: string; strength?: number }> = {};
  if (instrument === "piano") {
    for (let p = 48; p <= 84; p++) {
      const kind = hl.get(p % 12);
      if (kind) highlight[p] = { color: CLASS_COLOR[kind], strength: kind === "chord" ? 0.55 : 0.3 };
    }
    if (flash) highlight[flash.pitch] = { color: CLASS_COLOR[lastClass ?? "out"], strength: 1 };
  }
  const answerBar = lesson?.rule === "callresponse" && running && now >= 0 ? (isCallBar(bar) ? "Вопрос — слушай" : "Твой ответ") : null;
  return (
    <main
      className="chord-drill jam-session"
      data-jam-phase={phase}
      data-jam-t0={running ? String(t0.current) : ""}
      data-jam-beat-ms={plan.beatMs}
      data-jam-scale={scale.join(",")}
      data-jam-total-ms={totalMs}
    >
      <div className="piece-bar">
        <button className="ghost" onClick={onBack} title="Esc">
          {back}
        </button>
        <div className="piece-name">{lesson ? `Урок ${lesson.id} · ${lesson.title}` : `Джем · ${setup.custom.trim() ? setup.custom : style.name}`}</div>
        <span className="chip">
          {KEY_NAMES[setup.tonic]} · {SCALES[setup.scale].name.toLowerCase()} · {setup.bpm} уд/мин
        </span>
      </div>
      {playError.notice}
      <section className="card chord-card">
        {lesson && <p className="hint">{lesson.description}</p>}
        <div className="root-now">
          <div>
            <div className="chord-symbol">{phase === "count" ? Math.max(1, Math.ceil(-now / plan.beatMs)) : cur?.symbol}</div>
            <div className="muted">{running && next ? `дальше ${next.symbol}` : ""}</div>
          </div>
          {answerBar && <div className={`jam-turn${isCallBar(bar) ? "" : " mine"}`}>{answerBar}</div>}
          {last && (
            <div className="jam-last" style={{ color: CLASS_COLOR[lastClass ?? "out"] }}>
              {pitchName(last.pitch, prefs.noteNames)} — {CLASS_NAME[lastClass ?? "out"]}
            </div>
          )}
        </div>
        <div className="jam-chart">
          {plan.chart.map((c, i) => (
            <span key={i} className={`jam-bar${running && i === barInLoop ? " on" : ""}`}>
              {c}
            </span>
          ))}
        </div>
        {running && (
          <div className="jam-counts">
            <span style={{ color: CLASS_COLOR.chord }}>● {live.chord}</span>
            <span style={{ color: CLASS_COLOR.scale }}>● {live.scale}</span>
            <span style={{ color: CLASS_COLOR.out }}>● {live.out}</span>
            <span className="muted">{lesson ? `такт ${bar + 1} из ${plan.loopBars * plan.loops}` : `круг ${Math.floor(bar / plan.loopBars) + 1}`}</span>
          </div>
        )}
        <div className="summary-actions">
          {running ? (
            <button onClick={() => finish(true)} data-jam-stop>
              ■ {lesson ? "Стоп" : "Стоп и разбор"}
            </button>
          ) : (
            <button className="primary" onClick={start} data-jam-start>
              ▶ Старт
            </button>
          )}
          {instrument !== "piano" && (
            <label>
              Гриф{" "}
              <select value={box} onChange={(e) => setBox(Number(e.target.value))} data-jam-box>
                <option value={0}>весь</option>
                {[1, 2, 3, 4, 5].map((b) => (
                  <option key={b} value={b}>
                    позиция {b}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
      </section>
      {instrument === "piano" ? (
        <section className="jam-piano">
          <Piano low={48} high={84} highlight={highlight} naming={prefs.noteNames} labels="c" />
        </section>
      ) : (
        <section className="fret-board-wrap">
          <Fretboard tuning={tuning} frets={15} naming={prefs.noteNames} marks={marks} />
        </section>
      )}
    </main>
  );
}

/** Итог джема или урока: доли нот, советы, ноты соло, прослушивание и сохранение. */
function SoloReview({
  title,
  setup,
  plan,
  notes,
  accompaniment,
  endMs,
  instrument,
  tuning,
  result,
  onAgain,
  onBack,
}: {
  title: string;
  setup: JamSetup;
  plan: ReturnType<typeof jamPlan>;
  notes: PlayedNote[];
  accompaniment: PlayNote[];
  endMs: number;
  instrument: JamInstrument;
  tuning: number[];
  result: LessonResult | null;
  onAgain: () => void;
  onBack: () => void;
}) {
  const back = useBackLabel("← Джем");
  const scale = scalePcs(setup.tonic, setup.scale);
  const s = jamStats(notes, plan, scale);
  const tips = jamTips(s);
  const pct = (n: number) => (s.total ? Math.round((n / s.total) * 100) : 0);
  const [svg, setSvg] = useState("");
  const [saved, setSaved] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const playError = usePlayError();
  const off = COUNT_IN_BEATS * plan.beatMs;
  // До конца игры (с запасом в такт) — аккомпанемент и соло вместе.
  const take = useMemo(() => {
    const until = off + endMs + plan.barMs;
    const solo: PlayNote[] = notes.map((n) => ({ startMs: off + n.t, durMs: n.dur ?? plan.beatMs / 2, pitch: n.pitch, velocity: 110, channel: LEAD_CHANNEL, program: LEAD_PROGRAM[instrument] }));
    return [...accompaniment.filter((n) => n.startMs < until), ...solo].sort((a, b) => a.startMs - b.startMs);
  }, [accompaniment, notes, endMs, off, plan, instrument]);
  useEffect(() => () => void api.midiPreviewStop().catch(() => {}), []);

  const showNotes = () => {
    const song = soloSong(notes, plan, instrument, tuning);
    if (!song) return;
    renderSvg(partChart(song, 0).mei, {
      pageWidth: 2100,
      pageHeight: 60000,
      adjustPageHeight: true,
      breaks: "auto",
      scale: 40,
      header: "none",
      footer: "none",
      svgViewBox: true,
      svgRemoveXlink: true,
    })
      .then(setSvg)
      .catch(() => setSvg(""));
  };
  const listen = () => {
    if (playing) {
      void api.midiPreviewStop().catch(() => {});
      setPlaying(false);
      return;
    }
    setPlaying(true);
    void api.playNotes(take, null).catch(playError.report);
    setTimeout(() => setPlaying(false), (take[take.length - 1]?.startMs ?? 0) + 1500);
  };
  const save = () => {
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, "0");
    const name = `Джем ${p(d.getDate())}.${p(d.getMonth() + 1)} ${p(d.getHours())}-${p(d.getMinutes())}`;
    const shifted = take.filter((n) => n.startMs >= off).map((n) => ({ ...n, startMs: n.startMs - off }));
    api
      .jamSave(name, setup.bpm, shifted)
      .then(setSaved)
      .catch((e) => setSaved(`не сохранён: ${e}`));
  };
  return (
    <main className="chord-drill jam-review" data-jam-review data-jam-notes={s.total} data-jam-result={result ? (result.passed ? "passed" : "failed") : ""}>
      <div className="piece-bar">
        <button className="ghost" onClick={onBack}>
          {back}
        </button>
        <div className="piece-name">{title} · итог</div>
      </div>
      {playError.notice}
      <section className="card summary-inline">
        {result && (
          <>
            <h2>{result.passed ? "Засчитано ✓" : "Урок сыгран"}</h2>
            <p className="hint" data-jam-detail>
              {result.detail}
            </p>
          </>
        )}
        <div className="summary-stats">
          <div>
            <div className="big">{s.total}</div>
            <div className="muted">нот, фраз: {s.phrases}</div>
          </div>
          <div>
            <div className="big" style={{ color: CLASS_COLOR.chord }}>
              {pct(s.chord)}%
            </div>
            <div className="muted">звуки аккорда</div>
          </div>
          <div>
            <div className="big" style={{ color: CLASS_COLOR.scale }}>
              {pct(s.scale)}%
            </div>
            <div className="muted">другие ноты гаммы</div>
          </div>
          <div>
            <div className="big" style={{ color: CLASS_COLOR.out }}>
              {pct(s.out)}%
            </div>
            <div className="muted">вне гаммы</div>
          </div>
        </div>
        <ul className="jam-tips">
          {tips.map((t) => (
            <li key={t}>{t}</li>
          ))}
        </ul>
        <div className="summary-actions">
          <button className="primary" onClick={onAgain}>
            Ещё раз
          </button>
          <button onClick={listen} disabled={!s.total} data-jam-listen>
            {playing ? "■ Стоп" : "▶ Прослушать"}
          </button>
          <button onClick={showNotes} disabled={!s.total} data-jam-show-notes>
            Ноты соло
          </button>
          <button onClick={save} disabled={!s.total || !!saved} data-jam-save>
            Сохранить в библиотеку
          </button>
          <button className="ghost" onClick={onBack}>
            К списку
          </button>
        </div>
        {saved && (
          <p className="hint" data-jam-saved={saved}>
            {saved.startsWith("не ") ? `Джем ${saved}` : `Сохранено в библиотеку: «${saved}» — откроется в «Пьесах» с аккомпанементом по дорожкам.`}
          </p>
        )}
      </section>
      {svg && <div className="score-page paper jam-solo" data-jam-solo dangerouslySetInnerHTML={{ __html: svg }} />}
    </main>
  );
}

/** «Повтори за мной»: фраза приложения в такте вопроса, повтор ученика — в следующем. */
function EchoDrill({
  level,
  seed,
  instrument,
  mix,
  onAgain,
  onBack,
  onRecorded,
}: {
  level: EchoLevel;
  seed: number;
  instrument: JamInstrument;
  mix: JamMix;
  onAgain: () => void;
  onBack: () => void;
  onRecorded: () => void;
}) {
  const back = useBackLabel("← Джем");
  const { prefs } = useApp();
  const tonic = [9, 4, 2, 7][seed % 4];
  const phrases = useMemo(() => echoSeries(level, tonic, instrument, seed), [level, tonic, instrument, seed]);
  const playback = useMemo(() => echoPlayback(phrases, level.bpm, mix, instrument), [phrases, level, mix, instrument]);
  const beatMs = 60000 / level.bpm;
  const [phase, setPhase] = useState<"idle" | "count" | "run" | "done">("idle");
  const t0 = useRef(0);
  const running = phase === "count" || phase === "run";
  const { notes, last, reset } = usePlayed(running, t0);
  const now = useClock(running, t0.current);
  const [results, setResults] = useState<({ ok: boolean; pitches: boolean; rhythm: boolean } | null)[]>([]);
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
    reset();
    setResults([]);
    t0.current = performance.now() + COUNT_IN_BEATS * beatMs;
    setPhase("count");
    void api.playNotes(playback.notes, null).catch(playError.report);
  };
  const ok = results.filter((r) => r?.ok).length;
  const accuracy = ok / ECHO_SERIES;
  const passed = phase === "done" && accuracy >= ECHO_PASS;
  useEffect(() => {
    if (!running) return;
    if (phase === "count" && now >= 0) setPhase("run");
    // Ответ проверяется, когда закрылся его такт.
    const judged = playback.answers.filter((a) => now > a + 4 * beatMs).length;
    if (judged > results.length) setResults(playback.answers.slice(0, judged).map((a, k) => judgeEcho(phrases[k], notes.current, a, beatMs)));
    if (judged >= ECHO_SERIES) {
      void api.midiPreviewStop().catch(() => {});
      setPhase("done");
    }
  }, [now, running, phase, playback, beatMs, phrases, notes, results.length]);
  const recorded = useRef(false);
  useEffect(() => {
    if (phase !== "done" || recorded.current) return;
    recorded.current = true;
    void api
      .exerciseRecord({ exercise: echoLevelId(instrument, level.id), tempo: 1, accuracy, timingSdMs: 0, loudness: 1, passed })
      .then(onRecorded)
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  const bar = running && now >= 0 ? Math.floor(now / (4 * beatMs)) : -1;
  const k = Math.floor(Math.max(0, bar) / 2);
  const listening = bar >= 0 && bar % 2 === 0;
  const lastJudged = results.length ? results[results.length - 1] : undefined;
  const plan = phrases.flatMap((p, i) => p.notes.map((n) => `${(playback.answers[i] / beatMs + n.beat).toFixed(2)}:${n.pitch}`)).join(",");
  const names = (p: (typeof phrases)[number]) => p.notes.map((n) => pitchName(n.pitch, prefs.noteNames)).join(" — ");
  return (
    <main
      className="chord-drill echo-drill"
      data-echo-phase={phase}
      data-echo-t0={running ? String(t0.current) : ""}
      data-echo-beat-ms={beatMs}
      data-echo-plan={plan}
      data-echo-done={phase === "done" ? (passed ? "passed" : "failed") : ""}
      data-echo-ok={ok}
    >
      <div className="piece-bar">
        <button className="ghost" onClick={onBack} title="Esc">
          {back}
        </button>
        <div className="piece-name">Повтори за мной · {level.title}</div>
        <span className="chip">
          {KEY_NAMES[tonic]} · {SCALES[level.scale].name.toLowerCase()} · {level.bpm} уд/мин
        </span>
      </div>
      {playError.notice}
      <section className="card chord-card">
        {phase === "done" ? (
          <div className="summary-inline">
            <h2>{passed ? "Засчитано ✓" : "Серия сыграна"}</h2>
            <div className="summary-stats">
              <div>
                <div className={`big ${passed ? "good" : ""}`}>
                  {ok} из {ECHO_SERIES}
                </div>
                <div className="muted">фраз повторено верно</div>
              </div>
            </div>
            {!passed && <p className="hint">Для зачёта — от {Math.round(ECHO_PASS * ECHO_SERIES)} фраз. Слушай фразу целиком, повторяй с той же доли.</p>}
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
                <div className="chord-symbol">{phase === "count" ? Math.max(1, Math.ceil(-now / beatMs)) : bar < 0 ? "▶" : listening ? "Слушай…" : "Повтори!"}</div>
                <div className="muted">{running && bar >= 0 ? `фраза ${Math.min(k + 1, ECHO_SERIES)} из ${ECHO_SERIES} · ${phrases[Math.min(k, ECHO_SERIES - 1)].chord}` : `Фраза ${level.notes} нот, повтор — в следующем такте`}</div>
              </div>
              {last && <div className="jam-last">{pitchName(last.pitch, prefs.noteNames)}</div>}
            </div>
            <div className="root-results">
              {phrases.map((_, i) => (
                <span key={i} className={`root-dot root${results[i]?.ok ? " ok" : results[i] ? " bad" : results.length > i ? " miss" : ""}`} />
              ))}
            </div>
            {lastJudged !== undefined && !lastJudged?.ok && (
              <p className="hint" data-echo-hint>
                {lastJudged === null ? "Не услышал ответа." : !lastJudged.pitches ? "Не те ноты." : "Ноты верные, но не в ритм."} Было: {names(phrases[results.length - 1])}
              </p>
            )}
            <div className="summary-actions">
              {running ? (
                <button
                  onClick={() => {
                    void api.midiPreviewStop().catch(() => {});
                    setPhase("idle");
                  }}
                >
                  ■ Стоп
                </button>
              ) : (
                <button className="primary" onClick={start} data-echo-start>
                  ▶ Старт
                </button>
              )}
            </div>
          </>
        )}
      </section>
    </main>
  );
}

function storedMix(): JamMix {
  try {
    return { ...DEFAULT_MIX, ...JSON.parse(localStorage.getItem("mt-jam-mix") ?? "{}") };
  } catch {
    return DEFAULT_MIX;
  }
}

/** Урок импровизации — для курса (громкость аккомпанемента — как в разделе «Джем»). */
export function JamLessonRun({ lesson, instrument, onBack, onRecorded }: { lesson: JamLesson; instrument: JamInstrument; onBack: () => void; onRecorded: () => void }) {
  const [seed, setSeed] = useState(freshSeed);
  return (
    <JamSession key={seed} setup={lesson.setup} instrument={instrument} mix={storedMix()} lesson={lesson} seed={seed} onAgain={() => setSeed((s) => s + 1)} onBack={onBack} onRecorded={onRecorded} />
  );
}

/** «Повтори за мной» по ступени — для курса. */
export function EchoRun({ level, instrument, onBack, onRecorded }: { level: EchoLevel; instrument: JamInstrument; onBack: () => void; onRecorded: () => void }) {
  const [seed, setSeed] = useState(freshSeed);
  return <EchoDrill key={seed} level={level} seed={seed} instrument={instrument} mix={storedMix()} onAgain={() => setSeed((s) => s + 1)} onBack={onBack} onRecorded={onRecorded} />;
}
