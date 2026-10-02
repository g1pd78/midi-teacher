import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, PADS_DEVICE } from "../api";
import { Piano } from "../components/Piano";
import type { ExerciseStatView } from "../lib/exercises";
import { chordName, chordNotesText, chordPcs, chordSpelling, bassPc, type Chord } from "../lib/chords";
import {
  CHORD_LEVELS,
  CHORD_PASS_ACCURACY,
  CHORD_PASS_TIME_MS,
  CHORD_SERIES,
  chordKeys,
  chordLevelId,
  chordLevelPassed,
  chordSeries,
  chordUnlocked,
  judgeChord,
  type ChordLevel,
} from "../lib/chordDrill";
import {
  BUILTIN_SONGS,
  KEY_NAMES,
  STYLE_NAME,
  newSong,
  parseChart,
  songMei,
  songSourceId,
  type LeadSong,
  type Style,
} from "../lib/songs";
import { renderSvg } from "../lib/verovio";
import { verovioOptions } from "../lib/staffOptions";
import { deviceColor, useApp } from "../store";
import { PieceView } from "./PieceView";

const STYLES: Style[] = ["block", "oompah", "alberti"];

type View =
  | { kind: "list" }
  | { kind: "drill"; level: ChordLevel; seed: number }
  | { kind: "song"; song: LeadSong; style: Style }
  | { kind: "edit"; song: LeadSong; isNew: boolean };

/** Раздел «Аккорды»: тренажёр аккордов и песни по буквам. */
export function Chords({ tabs }: { tabs: React.ReactNode }) {
  const { prefs, setPrefs } = useApp();
  const [view, setView] = useState<View>({ kind: "list" });
  const [stats, setStats] = useState<ExerciseStatView[]>([]);
  const reload = useCallback(() => {
    api.exerciseStats().then(setStats).catch(() => setStats([]));
  }, []);
  useEffect(reload, [reload]);
  const mySongs = prefs.songs ?? [];
  const saveSong = (song: LeadSong) => {
    const list = mySongs.some((s) => s.id === song.id) ? mySongs.map((s) => (s.id === song.id ? song : s)) : [...mySongs, song];
    setPrefs({ songs: list });
  };
  const removeSong = (id: string) => setPrefs({ songs: mySongs.filter((s) => s.id !== id) });

  // Источник нот песни — один объект на время игры.
  const songSource = useMemo(() => {
    if (view.kind !== "song") return null;
    const { song, style } = view;
    return {
      id: songSourceId(song, style),
      title: `${song.title} · ${STYLE_NAME[style].toLowerCase()}`,
      load: async () => ({ data: songMei(song, style), zip: false }),
      // По буквам: аккорд можно взять в любой октаве и обращении.
      keyMap: song.melody.length ? ("leftAnyOctave" as const) : ("anyOctave" as const),
      backLabel: "← Аккорды",
    };
  }, [view]);

  if (view.kind === "drill")
    return (
      <ChordDrill
        key={`${view.level.id}-${view.seed}`}
        level={view.level}
        seed={view.seed}
        onAgain={() => setView({ ...view, seed: view.seed + 1 })}
        onBack={() => {
          setView({ kind: "list" });
          reload();
        }}
        onRecorded={reload}
      />
    );
  if (view.kind === "song" && songSource) return <PieceView key={songSource.id} source={songSource} onBack={() => setView({ kind: "list" })} />;
  if (view.kind === "edit")
    return (
      <SongEditor
        song={view.song}
        isNew={view.isNew}
        onSave={(s) => {
          saveSong(s);
          setView({ kind: "list" });
        }}
        onPlay={(s) => {
          saveSong(s);
          setView({ kind: "song", song: s, style: s.style });
        }}
        onDelete={
          view.isNew
            ? undefined
            : () => {
                removeSong(view.song.id);
                setView({ kind: "list" });
              }
        }
        onCancel={() => setView({ kind: "list" })}
      />
    );

  const open = chordUnlocked(stats);
  const songRow = (song: LeadSong, own: boolean) => {
    const chart = parseChart(song.chords, song);
    return (
      <div key={song.id} className="song-row" data-song={song.id}>
        <div className="song-info">
          <b>{song.title}</b>
          <span className="muted">
            {song.beats}/{song.unit} · {song.bpm} уд/мин · тактов {chart.bars}
            {song.melody.length ? "" : " · без мелодии"} · {chart.chords.map((c) => c.chord.symbol).filter((s, i, a) => a.indexOf(s) === i).slice(0, 6).join(" ")}
          </span>
        </div>
        <span className="segmented song-styles">
          {STYLES.map((st) => (
            <button key={st} onClick={() => setView({ kind: "song", song, style: st })} data-song-style={st} title={`Играть: ${STYLE_NAME[st].toLowerCase()}`}>
              {STYLE_NAME[st]}
            </button>
          ))}
        </span>
        {own && (
          <button className="small" onClick={() => setView({ kind: "edit", song, isNew: false })} data-song-edit>
            Изменить…
          </button>
        )}
      </div>
    );
  };

  return (
    <main className="exercises trainers chords">
      {tabs}
      <section className="card">
        <h1>Аккорды</h1>
        <p className="hint">
          Тренажёр: появляется буква аккорда — возьми его на клавиатуре (любая октава и обращение; на ступени «Обращения» —
          с указанным басом). Серия — {CHORD_SERIES} аккордов; зачёт — от {Math.round(CHORD_PASS_ACCURACY * 100)}% с первой попытки и в
          среднем до {CHORD_PASS_TIME_MS / 1000} с на аккорд.
        </p>
      </section>
      <section className="card ex-category" data-category="chords">
        <h2 className="section-h">Тренажёр аккордов</h2>
        <div className="drum-list">
          {CHORD_LEVELS.map((l) => {
            const passed = chordLevelPassed(stats, l.id);
            const isOpen = l.id <= open;
            const st = stats.find((s) => s.exercise === chordLevelId(l.id));
            return (
              <button
                key={l.id}
                className={`drum-item${passed ? " passed" : isOpen ? " open" : ""}${l.id === open && !passed ? " current" : ""}`}
                disabled={!isOpen}
                onClick={() => setView({ kind: "drill", level: l, seed: Math.floor(Date.now() / 1000) % 100000 })}
                data-chord-level={l.id}
              >
                <span className="drum-item-title">
                  {passed && "✓ "}
                  {l.id}. {l.title}
                </span>
                <span className="drum-item-hint">{l.description}</span>
                <span className="drum-item-hint muted">
                  {!isOpen
                    ? "Откроется после предыдущей ступени"
                    : st
                      ? `Серий: ${st.attempts}, лучшая ${Math.round(st.bestAccuracy * 100)}%`
                      : "Ещё не играл"}
                </span>
              </button>
            );
          })}
        </div>
      </section>
      <section className="card" data-category="songs">
        <div className="ex-category-head">
          <h2 className="section-h">Песни по буквам</h2>
          <button className="primary" onClick={() => setView({ kind: "edit", song: newSong(`my-${Date.now()}`), isNew: true })} data-song-new>
            + Своя песня
          </button>
        </div>
        <p className="hint">
          Правая рука — мелодия, левая — аккорды по буквам над нотами выбранной фактурой (аккорд целиком, бас + аккорд или
          Альберти). Левая засчитывается в любой октаве и обращении. Песню с аккордами можно сделать из любой пьесы или MIDI:
          открой её → «⋯» → «Аккорды по буквам…».
        </p>
        <div className="song-list">{BUILTIN_SONGS.map((s) => songRow(s, false))}</div>
        <h3 className="songs-mine-h">Мои песни</h3>
        {mySongs.length ? (
          <div className="song-list" data-my-songs>
            {mySongs.map((s) => songRow(s, true))}
          </div>
        ) : (
          <p className="muted">Пока нет. «+ Своя песня» — ввести аккорды текстом.</p>
        )}
      </section>
    </main>
  );
}

// --- Тренажёр аккордов ---

/** Аккорд на стане (подсказка): целые ноты в скрипичном ключе. */
function ChordStaff({ chord, keys }: { chord: Chord; keys: number[] }) {
  const [svg, setSvg] = useState("");
  const mei = useMemo(() => {
    const spelled = [...chordSpelling(chord), ...(chord.bass ? [chord.bass] : [])];
    const SEMI: Record<string, number> = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };
    const notes = keys.map((midi) => {
      const s = spelled.find((x) => (((SEMI[x.letter] + x.alter) % 12) + 12) % 12 === midi % 12)!;
      const oct = Math.round((midi - SEMI[s.letter] - s.alter) / 12) - 1;
      const acc = s.alter ? ` accid="${s.alter === 1 ? "s" : s.alter === -1 ? "f" : s.alter === 2 ? "x" : "ff"}"` : "";
      return `<note pname="${s.letter}" oct="${oct}"${acc}/>`;
    });
    return (
      `<?xml version="1.0" encoding="UTF-8"?><mei xmlns="http://www.music-encoding.org/ns/mei" meiversion="5.0"><music><body><mdiv><score>` +
      `<scoreDef meter.count="4" meter.unit="4" meter.form="invis"><staffGrp><staffDef n="1" lines="5" clef.shape="G" clef.line="2"/></staffGrp></scoreDef>` +
      `<section><measure n="1" right="invis"><staff n="1"><layer n="1"><chord dur="1">${notes.join("")}</chord></layer></staff></measure></section></score></mdiv></body></music></mei>`
    );
  }, [chord, keys]);
  useEffect(() => {
    let alive = true;
    renderSvg(mei, verovioOptions("single", 1))
      .then((s) => alive && setSvg(s))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [mei]);
  return <div className="chord-staff paper" dangerouslySetInnerHTML={{ __html: svg }} />;
}

/** Задержка до подсказки, мс. */
const HINT_MS = 4000;

function ChordDrill({
  level,
  seed,
  onAgain,
  onBack,
  onRecorded,
}: {
  level: ChordLevel;
  seed: number;
  onAgain: () => void;
  onBack: () => void;
  onRecorded: () => void;
}) {
  const { held, devices, prefs } = useApp();
  const series = useMemo(() => chordSeries(level, seed), [level, seed]);
  const [index, setIndex] = useState(0);
  const [results, setResults] = useState<{ first: boolean; ms: number }[]>([]);
  const [flash, setFlash] = useState<"ok" | "wrong" | null>(null);
  const [hint, setHint] = useState(false);
  const [alwaysHint, setAlwaysHint] = useState(false);
  const missed = useRef(false);
  const wrongNow = useRef(false);
  const since = useRef(performance.now());
  const done = index >= series.length;
  const target = series[Math.min(index, series.length - 1)];
  const keys = useMemo(() => chordKeys(target), [target]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onBack();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onBack]);

  // Подсказка после раздумья.
  useEffect(() => {
    setHint(false);
    since.current = performance.now();
    missed.current = false;
    if (done) return;
    const t = setTimeout(() => setHint(true), HINT_MS);
    return () => clearTimeout(t);
  }, [index, done]);

  // Проверка нажатых клавиш (пэды не считаются). Клавиши, зажатые до появления аккорда
  // (прошлый аккорд ещё держится, «зависшая» нота), не учитываются, пока их не отпустят.
  // Повторное нажатие той же клавиши — новая запись в held, значит снова «живая».
  const live = Object.entries(held).filter(([, h]) => h.device !== PADS_DEVICE);
  const allHeld = live.map(([k]) => Number(k));
  const stale = useRef<Map<number, unknown>>(new Map());
  const staleFor = useRef(-1);
  if (staleFor.current !== index) {
    staleFor.current = index;
    stale.current = new Map(live.map(([k, h]) => [Number(k), h]));
  }
  for (const [k, h] of [...stale.current]) if (held[k] !== h) stale.current.delete(k);
  const heldKeys = allHeld.filter((k) => !stale.current.has(k)).sort((a, b) => a - b);
  const heldKey = heldKeys.join(",");
  useEffect(() => {
    if (done || flash === "ok") return;
    if (!heldKeys.length) {
      wrongNow.current = false;
      return;
    }
    const v = judgeChord(target, heldKeys, !!level.inversions);
    if (v === "ok") {
      const ms = performance.now() - since.current;
      setResults((r) => [...r, { first: !missed.current, ms }]);
      setFlash("ok");
      setTimeout(() => {
        setFlash(null);
        setIndex((i) => i + 1);
      }, 450);
    } else if (v === "wrong" && !wrongNow.current) {
      wrongNow.current = true;
      missed.current = true;
      setFlash("wrong");
      setTimeout(() => setFlash((f) => (f === "wrong" ? null : f)), 400);
    }
    // Любое нажатие меняет held (и повторное той же клавиши).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [held, index]);

  // Итог серии — один раз.
  const recorded = useRef(false);
  const accuracy = results.length ? results.filter((r) => r.first).length / results.length : 0;
  const avgMs = results.length ? results.reduce((s, r) => s + r.ms, 0) / results.length : 0;
  const passed = done && accuracy >= CHORD_PASS_ACCURACY && avgMs <= CHORD_PASS_TIME_MS;
  useEffect(() => {
    if (!done || recorded.current) return;
    recorded.current = true;
    void api
      .exerciseRecord({ exercise: chordLevelId(level.id), tempo: 1, accuracy, timingSdMs: Math.round(avgMs), loudness: 1, passed })
      .then(onRecorded)
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [done]);

  const showHint = hint || alwaysHint;
  const highlight: Record<number, { color: string; strength?: number }> = {};
  if (showHint && !done) for (const k of keys) highlight[k] = { color: "#5AA9FF", strength: 0.4 };
  for (const [k, h] of Object.entries(held)) highlight[Number(k)] = { color: flash === "wrong" ? "#FF5C5C" : flash === "ok" ? "#4CC38A" : deviceColor(h.device, devices), strength: 0.85 };

  return (
    <main
      className="chord-drill"
      data-chord-index={index}
      data-chord-done={done ? (passed ? "passed" : "failed") : ""}
      data-held={heldKey}
      data-stale={[...stale.current.keys()].join(",")}
    >
      <div className="piece-bar">
        <button className="ghost" onClick={onBack} title="Esc">
          ← Аккорды
        </button>
        <div className="piece-name">
          Аккорды · {level.title}
        </div>
        <label className="toggle-inline">
          <input type="checkbox" checked={alwaysHint} onChange={(e) => setAlwaysHint(e.target.checked)} /> Сразу показывать ноты
        </label>
        <span className="chip">
          {Math.min(index + 1, series.length)} / {series.length}
        </span>
      </div>
      {!done ? (
        <section
          className={`card chord-card${flash ? ` flash-${flash}` : ""}`}
          data-chord-target={target.symbol}
          data-chord-pcs={chordPcs(target).join(",")}
          data-chord-bass={level.inversions ? bassPc(target) : ""}
        >
          <div className="chord-symbol">{target.symbol}</div>
          <div className="chord-name">{chordName(target)}</div>
          {showHint ? (
            <>
              <div className="chord-notes">{chordNotesText(target)}</div>
              <ChordStaff chord={target} keys={keys} />
            </>
          ) : (
            <div className="muted chord-wait">Возьми аккорд — подсказка через несколько секунд</div>
          )}
        </section>
      ) : (
        <section className="card chord-card summary-inline">
          <h2>{passed ? "Засчитано ✓" : "Серия сыграна"}</h2>
          <div className="summary-stats">
            <div>
              <div className={`big ${accuracy >= CHORD_PASS_ACCURACY ? "good" : ""}`}>{Math.round(accuracy * 100)}%</div>
              <div className="muted">с первой попытки</div>
            </div>
            <div>
              <div className={`big ${avgMs <= CHORD_PASS_TIME_MS ? "good" : ""}`}>{(avgMs / 1000).toFixed(1).replace(".", ",")} с</div>
              <div className="muted">в среднем на аккорд</div>
            </div>
          </div>
          {!passed && (
            <p className="hint">
              Для зачёта — от {Math.round(CHORD_PASS_ACCURACY * 100)}% с первой попытки и до {CHORD_PASS_TIME_MS / 1000} с на аккорд.
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
      <section className="session-piano">
        <Piano low={45} high={84} naming={prefs.noteNames} highlight={highlight} labels="c" />
      </section>
    </main>
  );
}

// --- Редактор своей песни ---

function SongEditor({
  song,
  isNew,
  onSave,
  onPlay,
  onDelete,
  onCancel,
}: {
  song: LeadSong;
  isNew: boolean;
  onSave: (s: LeadSong) => void;
  onPlay: (s: LeadSong) => void;
  onDelete?: () => void;
  onCancel: () => void;
}) {
  const [s, setS] = useState<LeadSong>(song);
  const set = (patch: Partial<LeadSong>) => setS((x) => ({ ...x, ...patch }));
  const chart = parseChart(s.chords, s);
  const meter = `${s.beats}/${s.unit}`;
  const ok = !chart.errors.length && chart.chords.length > 0 && s.title.trim();
  return (
    <main className="exercises song-editor">
      <section className="card">
        <h1>{isNew ? "Своя песня" : "Песня по буквам"}</h1>
        <div className="song-form">
          <label>
            <span>Название</span>
            <input value={s.title} onChange={(e) => set({ title: e.target.value })} data-song-title />
          </label>
          <label>
            <span>Темп</span>
            <input type="number" min={30} max={220} value={s.bpm} onChange={(e) => set({ bpm: Math.max(30, Math.min(220, Number(e.target.value) || 90)) })} />
            <span className="muted">уд/мин</span>
          </label>
          <label>
            <span>Размер</span>
            <span className="segmented">
              {["2/4", "3/4", "4/4", "6/8"].map((m) => (
                <button
                  key={m}
                  className={meter === m ? "on" : ""}
                  onClick={() => {
                    const [b, u] = m.split("/").map(Number);
                    set({ beats: b, unit: u as 4 | 8 });
                  }}
                >
                  {m}
                </button>
              ))}
            </span>
          </label>
          <label>
            <span>Тональность</span>
            <select value={s.fifths} onChange={(e) => set({ fifths: Number(e.target.value) })}>
              {Object.entries(KEY_NAMES)
                .sort((a, b) => Number(a[0]) - Number(b[0]))
                .map(([f, name]) => (
                  <option key={f} value={f}>
                    {name}
                  </option>
                ))}
            </select>
          </label>
          <label>
            <span>Фактура</span>
            <span className="segmented">
              {STYLES.map((st) => (
                <button key={st} className={s.style === st ? "on" : ""} onClick={() => set({ style: st })}>
                  {STYLE_NAME[st]}
                </button>
              ))}
            </span>
          </label>
        </div>
        <label className="song-chords">
          <span>Аккорды по тактам</span>
          <textarea rows={5} value={s.chords} onChange={(e) => set({ chords: e.target.value })} spellCheck={false} data-song-chords />
        </label>
        <p className="hint">
          Такты — через «|»: <code>C | Am | F G | G7</code>. Аккорды такта делят его поровну, «-» — тот же аккорд дальше
          (<code>C - - G</code>). Понимаю: C, Cm, C7, Cmaj7, Cm7, C6, Cdim, Cdim7, Cm7b5, Caug, Csus2, Csus4, C/E; диезы и бемоли — F#, Bb; H — си.
        </p>
        <p className={chart.errors.length ? "notice warn" : "muted"} data-song-parse={chart.errors.length ? "error" : "ok"}>
          {chart.errors.length
            ? `Не понял: ${chart.errors.join(", ")}`
            : `Тактов: ${chart.bars}, аккордов: ${chart.chords.length}${s.melody.length ? `, мелодия: ${s.melody.length} нот` : ""}`}
        </p>
        <p className="hint">
          {s.melody.length ? (
            <>
              Мелодия {s.source ? `из «${s.source}»` : ""} — правая рука, аккорды — левая.{" "}
              <button className="link" onClick={() => set({ melody: [] })}>
                убрать мелодию
              </button>
            </>
          ) : (
            "Без мелодии: правая рука играет аккорды, левая — бас. Мелодию можно взять из пьесы: открой пьесу → «⋯» → «Аккорды по буквам…»."
          )}
        </p>
        <div className="summary-actions">
          <button className="primary" disabled={!ok} onClick={() => onSave({ ...s, title: s.title.trim() })} data-song-save>
            Сохранить
          </button>
          <button disabled={!ok} onClick={() => onPlay({ ...s, title: s.title.trim() })} data-song-play>
            ▶ Играть
          </button>
          {onDelete && (
            <button className="ghost danger" onClick={() => window.confirm(`Удалить «${song.title}»?`) && onDelete()}>
              Удалить
            </button>
          )}
          <button className="ghost" onClick={onCancel}>
            Отмена
          </button>
        </div>
      </section>
    </main>
  );
}
