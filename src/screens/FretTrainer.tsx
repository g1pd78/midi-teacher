import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../api";
import type { ExerciseStatView } from "../lib/exercises";
import {
  FRET_LEVELS,
  FRET_PASS_ACCURACY,
  FRET_PASS_TIME_MS,
  FRET_SERIES,
  fretLevelId,
  fretSeries,
  fretUnlocked,
  judgeFret,
  stringNumber,
  type FretLevel,
} from "../lib/fretboard";
import { openTuning, tuningLabel } from "../lib/guitar";
import type { GtrInstrument } from "../lib/guitarExercises";
import { octaveOf, pitchName } from "../lib/notes";
import { spell } from "../lib/tabsong";
import { renderSvg } from "../lib/verovio";
import { verovioOptions } from "../lib/staffOptions";
import { Fretboard, type FretMark } from "../components/Fretboard";
import { PADS_DEVICE } from "../api";
import { deviceColor, useApp, useMidi } from "../store";
import { LevelCard } from "../components/LevelCard";
import { useBackLabel } from "../components/BackLabel";

const MODE_NAME = { find: "найди на струне", staff: "нота на стане", place: "точка на грифе", all: "все места" } as const;

/** «Тренажёры» → «Гриф»: где какая нота на гитаре и басе. */
export function FretTrainer({ tabs }: { tabs: React.ReactNode }) {
  const [instrument, setInstrument] = useState<GtrInstrument>("guitar");
  const [tuning, setTuning] = useState<number[] | null>(null);
  const [stats, setStats] = useState<ExerciseStatView[]>([]);
  const [drill, setDrill] = useState<{ level: FretLevel; seed: number } | null>(null);
  const reload = useCallback(() => void api.exerciseStats().then(setStats).catch(() => setStats([])), []);
  useEffect(reload, [reload]);
  useEffect(() => {
    api
      .guitarState()
      .then((g) => {
        setInstrument(g.config.instrument);
        setTuning(openTuning(g.config));
      })
      .catch(() => setTuning(openTuning({ instrument: "guitar", tuning: null })));
  }, []);
  const choose = (i: GtrInstrument) => {
    setInstrument(i);
    void api
      .guitarState()
      .then((g) => setTuning(openTuning({ instrument: i, tuning: g.config.instrument === i ? g.config.tuning : null })))
      .catch(() => setTuning(openTuning({ instrument: i, tuning: null })));
  };

  if (drill && tuning)
    return (
      <FretDrill
        key={`${instrument}-${drill.level.id}-${drill.seed}`}
        instrument={instrument}
        level={drill.level}
        tuning={tuning}
        seed={drill.seed}
        onAgain={() => setDrill({ ...drill, seed: drill.seed + 1 })}
        onBack={() => {
          setDrill(null);
          reload();
        }}
        onRecorded={reload}
      />
    );

  const open = fretUnlocked(stats, instrument);
  return (
    <main className="exercises trainers" data-fret-trainer={instrument}>
      {tabs}
      <section className="card">
        <h1>Гриф</h1>
        <span className="segmented" data-fret-instrument>
          <button className={instrument === "guitar" ? "on" : ""} onClick={() => choose("guitar")}>
            Гитара
          </button>
          <button className={instrument === "bass" ? "on" : ""} onClick={() => choose("bass")}>
            Бас
          </button>
        </span>
        <p className="hint">
          Где какая нота на грифе{tuning ? ` (строй: ${tuningLabel(tuning, 0, instrument)})` : ""}. Играешь на {instrument === "bass" ? "басу" : "гитаре"} —
          приложение слушает звук. Серия — {FRET_SERIES} заданий; зачёт — от {Math.round(FRET_PASS_ACCURACY * 100)}% с первой попытки и в среднем до{" "}
          {FRET_PASS_TIME_MS / 1000} с на задание. Через несколько секунд раздумья — подсказка на грифе. Звук не говорит, на какой
          струне сыграно, поэтому засчитывается нужная высота.
        </p>
      </section>
      <section className="card ex-category" data-category="fretboard">
        <div className="drum-list">
          {FRET_LEVELS[instrument].map((l) => {
            const st = stats.find((s) => s.exercise === fretLevelId(instrument, l.id));
            const passed = !!st?.passed;
            const isOpen = l.id <= open;
            return (
              <LevelCard
                key={l.id}
                n={l.id}
                title={l.title}
                hint={`${MODE_NAME[l.mode]} · ${l.description}`}
                status={st ? `Серий: ${st.attempts}, лучшая ${Math.round(st.bestAccuracy * 100)}%` : "Ещё не играл"}
                passed={passed}
                open={isOpen}
                current={l.id === open && !passed}
                disabled={!tuning}
                onClick={() => setDrill({ level: l, seed: Math.floor(Date.now() / 1000) % 100000 })}
                data={{ "fret-level": l.id }}
              />
            );
          })}
        </div>
      </section>
    </main>
  );
}

const HINT_AFTER_MS = 4000;

export function FretDrill({
  instrument,
  level,
  tuning,
  seed,
  onAgain,
  onBack,
  onRecorded,
}: {
  instrument: GtrInstrument;
  level: FretLevel;
  tuning: number[];
  seed: number;
  onAgain: () => void;
  onBack: () => void;
  onRecorded: () => void;
}) {
  const back = useBackLabel("← Гриф");
  const { prefs, held, devices } = useApp();
  const naming = prefs.noteNames;
  const series = useMemo(() => fretSeries(level, tuning, seed), [level, tuning, seed]);
  const [index, setIndex] = useState(0);
  const [target, setTarget] = useState(0);
  const [results, setResults] = useState<{ first: boolean; ms: number }[]>([]);
  const [flash, setFlash] = useState<"ok" | "wrong" | null>(null);
  const [hint, setHint] = useState(false);
  const [solved, setSolved] = useState<string | null>(null);
  const missed = useRef(false);
  const since = useRef(performance.now());
  const done = index >= series.length;
  const prompt = series[Math.min(index, series.length - 1)];
  const strings = tuning.length;

  // Новое задание: подсказка — через несколько секунд.
  useEffect(() => {
    missed.current = false;
    since.current = performance.now();
    setHint(false);
    const t = window.setTimeout(() => setHint(true), HINT_AFTER_MS);
    return () => window.clearTimeout(t);
  }, [index]);

  // Нажатия — по событиям (короткий щипок может начаться и закончиться между отрисовками).
  const onNote = (played: number) => {
    if (done || flash === "ok") return;
    if (judgeFret(prompt, target, played, level, tuning)) {
      if (target + 1 < prompt.targets.length) {
        setTarget(target + 1);
        return;
      }
      const ms = performance.now() - since.current;
      setResults((r) => [...r, { first: !missed.current, ms }]);
      setSolved(`${pitchName(prompt.targets[0].pitch, naming)}${octaveOf(prompt.targets[0].pitch)}`);
      setFlash("ok");
      setTimeout(() => {
        setFlash(null);
        setSolved(null);
        setTarget(0);
        setIndex((i) => i + 1);
      }, 650);
    } else {
      missed.current = true;
      setFlash("wrong");
      setTimeout(() => setFlash((f) => (f === "wrong" ? null : f)), 400);
    }
  };
  const handler = useRef(onNote);
  handler.current = onNote;
  useMidi((ev) => {
    if (ev.type === "noteOn" && ev.device !== PADS_DEVICE) handler.current(ev.note);
  });

  // Итог — один раз.
  const recorded = useRef(false);
  const accuracy = results.length ? results.filter((r) => r.first).length / results.length : 0;
  const avgMs = results.length ? results.reduce((s, r) => s + r.ms, 0) / results.length : 0;
  const passed = done && accuracy >= FRET_PASS_ACCURACY && avgMs <= FRET_PASS_TIME_MS;
  useEffect(() => {
    if (!done || recorded.current) return;
    recorded.current = true;
    void api
      .exerciseRecord({ exercise: fretLevelId(instrument, level.id), tempo: 1, accuracy, timingSdMs: Math.round(avgMs), loudness: 1, passed })
      .then(onRecorded)
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [done]);

  // Гриф: цели, найденные места, подсказка, что звучит.
  const marks: FretMark[] = [];
  if (!done) {
    prompt.targets.forEach((t, i) => {
      if (prompt.mode === "all" && i < target) marks.push({ string: t.string, fret: t.fret, color: "#4CC38A", strength: 0.9, label: "✓" });
    });
    const cur = prompt.targets[target];
    if (prompt.mode === "place") marks.push({ string: cur.string, fret: cur.fret, color: flash === "ok" ? "#4CC38A" : "#5AA9FF", strength: 1, label: solved ? pitchName(cur.pitch, naming) : "?" });
    else if (hint || solved) marks.push({ string: cur.string, fret: cur.fret, color: solved ? "#4CC38A" : "#5AA9FF", strength: solved ? 0.95 : 0.45, label: String(cur.fret) });
  }
  for (const [k, h] of Object.entries(held)) {
    const pitch = Number(k);
    const s = [...tuning.keys()].reverse().find((i) => pitch - tuning[i] >= 0 && pitch - tuning[i] <= 15);
    if (s !== undefined) marks.push({ string: s, fret: pitch - tuning[s], color: flash === "wrong" ? "#FF5C5C" : deviceColor(h.device, devices), strength: 0.8 });
  }
  const cur = prompt.targets[target];
  const name = pitchName(cur.pitch, naming);
  const task =
    prompt.mode === "find"
      ? `${name[0].toUpperCase() + name.slice(1)} · ${stringNumber(cur.string, strings)}-я струна`
      : prompt.mode === "all"
        ? `Все ${name}: ${stringNumber(cur.string, strings)}-я струна (${target + 1} из ${prompt.targets.length})`
        : prompt.mode === "place"
          ? solved
            ? `Это ${name}`
            : "Сыграй точку на грифе"
          : hint || solved
            ? `${name[0].toUpperCase() + name.slice(1)} — ${stringNumber(cur.string, strings)}-я струна, ${cur.fret} лад`
            : "Сыграй ноту со стана";

  return (
    <main className="chord-drill fret-drill" data-fret-index={index} data-fret-target={target} data-fret-done={done ? (passed ? "passed" : "failed") : ""} data-fret-pitch={done ? "" : cur.pitch}>
      <div className="piece-bar">
        <button className="ghost" onClick={onBack} title="Esc">
          {back}
        </button>
        <div className="piece-name">
          Гриф · {level.title}
        </div>
        <span className="chip">
          {Math.min(index + 1, series.length)} / {series.length}
        </span>
      </div>
      {!done ? (
        <section className={`card chord-card${flash ? ` flash-${flash}` : ""}`}>
          <div className="chord-name fret-task">{task}</div>
          {prompt.mode === "staff" && <NoteStaff pitch={cur.pitch} bass={instrument === "bass"} />}
          {!hint && !solved && prompt.mode !== "place" && <div className="muted chord-wait">Подсказка на грифе — через несколько секунд</div>}
        </section>
      ) : (
        <section className="card chord-card summary-inline">
          <h2>{passed ? "Засчитано ✓" : "Серия сыграна"}</h2>
          <div className="summary-stats">
            <div>
              <div className={`big ${accuracy >= FRET_PASS_ACCURACY ? "good" : ""}`}>{Math.round(accuracy * 100)}%</div>
              <div className="muted">с первой попытки</div>
            </div>
            <div>
              <div className={`big ${avgMs <= FRET_PASS_TIME_MS ? "good" : ""}`}>{(avgMs / 1000).toFixed(1).replace(".", ",")} с</div>
              <div className="muted">в среднем на задание</div>
            </div>
          </div>
          {!passed && (
            <p className="hint">
              Для зачёта — от {Math.round(FRET_PASS_ACCURACY * 100)}% с первой попытки и до {FRET_PASS_TIME_MS / 1000} с на задание.
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
      <section className="fret-board-wrap">
        <Fretboard tuning={tuning} frets={Math.max(5, Math.min(15, level.frets[1] + 1))} naming={naming} marks={marks} />
      </section>
    </main>
  );
}

/** Нота на стане для гитары/баса: скрипичный (басовый) ключ с «8» — звучит на октаву ниже записи. */
function NoteStaff({ pitch, bass }: { pitch: number; bass: boolean }) {
  const [svg, setSvg] = useState("");
  const mei = useMemo(() => {
    const sp = spell(pitch, 0);
    const acc = sp.alter ? ` accid="${sp.alter > 0 ? "s" : "f"}"` : "";
    const clef = bass ? `clef.shape="F" clef.line="4" clef.dis="8" clef.dis.place="below"` : `clef.shape="G" clef.line="2" clef.dis="8" clef.dis.place="below"`;
    return (
      `<?xml version="1.0" encoding="UTF-8"?><mei xmlns="http://www.music-encoding.org/ns/mei" meiversion="5.0"><music><body><mdiv><score>` +
      `<scoreDef meter.count="4" meter.unit="4" meter.form="invis"><staffGrp><staffDef n="1" lines="5" ${clef}/></staffGrp></scoreDef>` +
      `<section><measure n="1" right="invis"><staff n="1"><layer n="1"><note dur="1" pname="${sp.pname}" oct="${sp.oct + 1}"${acc}/></layer></staff></measure></section></score></mdiv></body></music></mei>`
    );
  }, [pitch, bass]);
  useEffect(() => {
    let alive = true;
    renderSvg(mei, verovioOptions("single", 1))
      .then((s) => alive && setSvg(s))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [mei]);
  return <div className="chord-staff" dangerouslySetInnerHTML={{ __html: svg }} />;
}
