import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, listen, PADS_DEVICE, type PadBinding } from "../api";
import type { ExerciseStatView } from "../lib/exercises";
import {
  DRUMS,
  DRUM_CATEGORIES,
  DRUM_EXERCISES,
  drumMei,
  drumStats,
  drumUnlocked,
  type DrumExercise,
} from "../lib/drums";
import { DRUM_SONGS, drumSongBars, drumSongTitle, drumSongTs, type DrumSong } from "../lib/drumSongs";
import { partChart, songAccompaniment } from "../lib/tabsong";
import { DrumPads } from "../components/DrumPads";
import { useApp } from "../store";
import { PieceView } from "./PieceView";
import { drumScoreToCode } from "../lib/strudel/fromApp";

/**
 * Барабаны на пэдах MIDI-клавиатуры: мастер назначения пэдов, грувы и рудименты.
 * Упражнения играются на общем экране игры в режиме барабанов.
 */
export function Drums() {
  const { devices, audio } = useApp();
  const [stats, setStats] = useState<ExerciseStatView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [run, setRun] = useState<DrumExercise | null>(null);
  const [song, setSong] = useState<DrumSong | null>(null);
  const [wizard, setWizard] = useState(false);

  const reload = useCallback(() => {
    api
      .exerciseStats()
      .then((s) => {
        setStats(drumStats(s));
        setError(null);
      })
      .catch((e) => setError(String(e)));
  }, []);
  useEffect(reload, [reload]);

  const passed = useMemo(() => new Set(stats.filter((s) => s.passed).map((s) => s.exercise)), [stats]);
  const open = useMemo(() => drumUnlocked(passed), [passed]);
  const statOf = useMemo(() => new Map(stats.map((s) => [s.exercise, s])), [stats]);
  const pads = devices.pads ?? [];
  const padLabels = useMemo(() => new Map(pads.map((p) => [p.drum, `пэд ${p.note}`])), [pads]);
  const [held, setHeld] = useState<Set<number>>(new Set());
  useEffect(() => {
    let off: (() => void) | null = null;
    let alive = true;
    void listen("midi", (e) => {
      if (e.device !== PADS_DEVICE) return;
      setHeld((h) => {
        const next = new Set(h);
        if (e.type === "noteOn") next.add(e.note);
        else if (e.type === "noteOff") next.delete(e.note);
        return next;
      });
    }).then((f) => (alive ? (off = f) : f()));
    return () => {
      alive = false;
      off?.();
    };
  }, []);

  // Источник нот — один объект на время игры, иначе экран игры перезапустится.
  const source = useMemo(
    () => (run ? { id: `exercise:${run.id}`, title: run.title, load: async () => ({ data: drumMei(run.build(), { title: run.title }), zip: false }) } : null),
    [run],
  );

  if (run && source) {
    const list = DRUM_EXERCISES.filter((e) => e.category === run.category);
    const following = list[list.indexOf(run) + 1] ?? null;
    return (
      <PieceView
        key={run.id}
        source={source}
        onBack={() => {
          setRun(null);
          reload();
        }}
        exercise={{
          id: run.id,
          instrument: "drums",
          toCode: () => ({ name: run.title, text: drumScoreToCode(run.build(), run.title) }),
          next: following ? { label: "Следующее упражнение", go: () => setRun(following) } : null,
          onRecorded: reload,
        }}
      />
    );
  }

  if (song)
    return (
      <DrumSongView
        def={song}
        onBack={() => {
          setSong(null);
          reload();
        }}
      />
    );

  if (wizard) return <PadWizard initial={pads} onDone={() => setWizard(false)} />;

  return (
    <main className="exercises drums">
      <section className="card">
        <div className="drums-head">
          <div>
            <h1>Барабаны</h1>
            <p className="hint">
              Играй на пэдах MIDI-клавиатуры: каждому пэду назначается барабан установки, звук — из компьютера. Грувы и
              рудименты открываются по очереди, как упражнения: засчитывается от 95% верных ударов, ровный ритм (разброс до
              ±60 мс), темп от 100%, а где есть акценты и тихие ноты — и сила удара.
            </p>
          </div>
        </div>
        <div className="drums-pads-row">
          <DrumPads expected={new Set()} held={held} labels={padLabels} onHit={(d) => void api.hitDrum(d.gm, 100)} />
          <div className="drums-pads-info">
            <b data-pads-count={pads.length}>
              {pads.length ? `Пэды назначены: ${pads.length} из ${DRUMS.length}` : "Пэды ещё не назначены"}
            </b>
            <p className="hint">
              {pads.length
                ? "Ударь по пэду — подсветится его барабан. Можно бить и мышью по пэдам на экране."
                : "Мастер попросит ударить по пэду для каждого барабана. Пока пэды не назначены, можно играть мышью по пэдам на экране."}
            </p>
            <button className={pads.length ? "" : "primary"} onClick={() => setWizard(true)} data-pad-wizard>
              {pads.length ? "Назначить заново…" : "Назначить пэды…"}
            </button>
            {!audio?.gm && <p className="notice warn">GM-банк не загружен — вместо барабанов звучит щелчок метронома.</p>}
          </div>
        </div>
      </section>
      {error && <div className="notice warn">Результаты упражнений недоступны: {error}</div>}

      {DRUM_CATEGORIES.map((c) => {
        const list = DRUM_EXERCISES.filter((e) => e.category === c.id);
        const done = list.filter((e) => passed.has(e.id)).length;
        return (
          <section key={c.id} className="card ex-category" data-category={`drum-${c.id}`}>
            <div className="ex-category-head">
              <h2 className="section-h">{c.title}</h2>
              <span className="muted">
                засчитано {done} из {list.length}
              </span>
            </div>
            <p className="hint">{c.description}</p>
            <div className="drum-list">
              {list.map((e) => {
                const st = statOf.get(e.id);
                const isOpen = open.has(e.id);
                const isPassed = passed.has(e.id);
                return (
                  <button
                    key={e.id}
                    className={`drum-item${isPassed ? " passed" : isOpen ? " open" : ""}`}
                    disabled={!isOpen}
                    onClick={() => setRun(e)}
                    data-exercise={e.id}
                    title={
                      st
                        ? `Попыток: ${st.attempts}, лучшая точность ${Math.round(st.bestAccuracy * 100)}%, ритм ±${Math.round(st.lastTimingSdMs)} мс`
                        : isOpen
                          ? "Ещё не играл"
                          : "Откроется, когда будет засчитано предыдущее"
                    }
                  >
                    <span className="drum-item-title">
                      {isPassed && "✓ "}
                      {e.title}
                    </span>
                    <span className="drum-item-hint">{e.hint}</span>
                  </button>
                );
              })}
            </div>
          </section>
        );
      })}

      <section className="card ex-category" data-category="drum-songs">
        <div className="ex-category-head">
          <h2 className="section-h">Песни</h2>
          <span className="muted">
            засчитано {DRUM_SONGS.filter((d) => passed.has(d.id)).length} из {DRUM_SONGS.length}
          </span>
        </div>
        <p className="hint">
          Партия барабанов к песне: грув, сбивки в конце фраз и тарелка в последнем такте. Приложение играет мелодию, аккорды и
          бас — держи темп вместе с ними. Все песни открыты сразу.
        </p>
        <div className="drum-list">
          {DRUM_SONGS.map((d) => (
            <button key={d.id} className={`drum-item${passed.has(d.id) ? " passed" : " open"}`} onClick={() => setSong(d)} data-drum-song={d.id}>
              <span className="drum-item-title">
                {passed.has(d.id) && "✓ "}
                {drumSongTitle(d)}
              </span>
              <span className="drum-item-hint">
                {d.hint} Тактов: {drumSongBars(d)}.
              </span>
            </button>
          ))}
        </div>
      </section>
    </main>
  );
}

/** Песня на барабанах: партия на пэдах, мелодия, аккорды и бас — аккомпанемент. */
export function DrumSongView({ def, onBack, backLabel }: { def: DrumSong; onBack: () => void; backLabel?: string }) {
  const source = useMemo(() => {
    const ts = drumSongTs(def);
    return {
      id: `drumsong:${def.id}`,
      title: drumSongTitle(def),
      load: async () => ({ data: partChart(ts, 0).mei, zip: false }),
      accompaniment: songAccompaniment(ts, 0),
    };
  }, [def]);
  return <PieceView key={source.id} source={source} onBack={onBack} exercise={{ id: def.id, instrument: "drums", hint: def.hint, backLabel }} />;
}

/**
 * Мастер «ударь по пэду для…»: по очереди для каждого барабана ловит нажатие
 * (устройство, канал, нота). Пока мастер открыт, пэды звучат как обычные клавиши.
 */
function PadWizard({ initial, onDone }: { initial: PadBinding[]; onDone: () => void }) {
  const [step, setStep] = useState(0);
  const [bindings, setBindings] = useState<(PadBinding | null)[]>(() => DRUMS.map(() => null));
  const [warn, setWarn] = useState<string | null>(null);

  // Снимаем назначения, чтобы пэды приходили «как есть»; «Отмена» вернёт прежние.
  useEffect(() => {
    void api.setDrumPads([]);
  }, []);

  // Обработчик событий один на всё время мастера — читает свежие шаг и назначения через ссылки.
  const stepRef = useRef(step);
  stepRef.current = step;
  const bindingsRef = useRef(bindings);
  bindingsRef.current = bindings;
  useEffect(() => {
    let off: (() => void) | null = null;
    let alive = true;
    void listen("midi", (e) => {
      if (e.type !== "noteOn" || e.device === PADS_DEVICE) return;
      const s = stepRef.current;
      if (s >= DRUMS.length) return;
      const b = bindingsRef.current;
      const same = b.findIndex((x) => x && x.device === e.device && x.channel === e.channel && x.note === e.note);
      if (same >= 0 && same !== s) {
        setWarn(`Этот пэд уже назначен: ${DRUMS[same].name}. Ударь по другому.`);
        return;
      }
      setWarn(null);
      const next = [...b];
      next[s] = { device: e.device, channel: e.channel, note: e.note, drum: DRUMS[s].gm };
      bindingsRef.current = next;
      stepRef.current = s + 1;
      setBindings(next);
      setStep(s + 1);
    }).then((f) => (alive ? (off = f) : f()));
    return () => {
      alive = false;
      off?.();
    };
  }, []);

  const finish = (list: PadBinding[]) => {
    void api.setDrumPads(list).then(onDone);
  };
  const done = step >= DRUMS.length;
  const current = DRUMS[Math.min(step, DRUMS.length - 1)];
  const chosen = bindings.filter((b): b is PadBinding => !!b);

  return (
    <main className="exercises drums">
      <section className="card pad-wizard" data-pad-step={done ? "done" : current.id}>
        <h1>Назначение пэдов</h1>
        {!done ? (
          <>
            <p className="pad-wizard-ask">
              Ударь по пэду для барабана <b style={{ color: current.color }}>{current.name}</b>
              <span className="muted"> · {step + 1} из {DRUMS.length}</span>
            </p>
            <p className="hint">
              Можно пропустить барабан, если пэдов меньше. Пэд не обязательно должен быть «барабанным» — подойдёт любая
              клавиша.
            </p>
            {warn && <div className="notice warn">{warn}</div>}
          </>
        ) : (
          <p className="pad-wizard-ask">Готово: назначено {chosen.length} из {DRUMS.length}.</p>
        )}
        <ol className="pad-wizard-list">
          {DRUMS.map((d, i) => (
            <li key={d.id} className={i === step ? "current" : bindings[i] ? "set" : ""}>
              <span className="dot" style={{ background: d.color }} />
              {d.name}
              <span className="muted">
                {bindings[i] ? ` — ${bindings[i]!.device}, канал ${bindings[i]!.channel + 1}, нота ${bindings[i]!.note}` : i < step ? " — пропущен" : ""}
              </span>
            </li>
          ))}
        </ol>
        <div className="summary-actions">
          {!done && (
            <button onClick={() => setStep((s) => s + 1)} data-pad-skip>
              Пропустить
            </button>
          )}
          {step > 0 && (
            <button
              onClick={() => {
                setBindings((b) => b.map((x, i) => (i === step - 1 ? null : x)));
                setStep((s) => s - 1);
              }}
            >
              Назад
            </button>
          )}
          <button className="primary" disabled={!chosen.length} onClick={() => finish(chosen)} data-pad-save>
            Сохранить
          </button>
          <button className="ghost" onClick={() => finish(initial)}>
            Отмена
          </button>
        </div>
      </section>
    </main>
  );
}
