import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, listen, type LibraryItem, type PlayInfo, type Song, type SongSummary, type TrackKind } from "../api";
import { ClockSync } from "../lib/transport";
import {
  GRIDS,
  INSTRUMENTS,
  KIND_NAME,
  addTake,
  barMs,
  hasNotes,
  newSong,
  newTrack,
  placedNotes,
  position,
} from "../lib/studio";

/**
 * «Студия»: свой трек из дорожек. Каждую партию записываешь поверх уже записанных
 * (они звучат, метроном считает), можно переписать кусок, выбрать лучший дубль,
 * выровнять ритм, свести громкости и сохранить трек в MIDI и WAV.
 */
export function Studio() {
  const [list, setList] = useState<SongSummary[]>([]);
  const [song, setSong] = useState<Song | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    api
      .studioList()
      .then(setList)
      .catch((e) => setError(String(e)));
  }, []);
  useEffect(reload, [reload]);

  if (song)
    return (
      <SongEditor
        initial={song}
        onBack={() => {
          setSong(null);
          reload();
        }}
      />
    );
  return <SongList list={list} error={error} onOpen={setSong} onChanged={reload} />;
}

function SongList({
  list,
  error,
  onOpen,
  onChanged,
}: {
  list: SongSummary[];
  error: string | null;
  onOpen: (s: Song) => void;
  onChanged: () => void;
}) {
  const [form, setForm] = useState<"new" | "midi" | null>(null);
  const [name, setName] = useState("Мой трек");
  const [bpm, setBpm] = useState(100);
  const [meter, setMeter] = useState("4/4");
  const [bars, setBars] = useState(16);
  const [midi, setMidi] = useState<LibraryItem[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    if (form !== "midi") return;
    api
      .libraryList()
      .then((l) => setMidi(l.items.filter((i) => i.format === "midi")))
      .catch(() => setMidi([]));
  }, [form]);

  const open = async (file: string) => {
    try {
      onOpen(await api.studioLoad(file));
    } catch (e) {
      setBusy(String(e));
    }
  };

  return (
    <main className="studio">
      <section className="card">
        <h1>Студия</h1>
        <p className="hint">
          Собери трек из своих партий. Записываешь дорожку за дорожкой — уже записанные звучат, метроном считает такт.
          Ошибки не страшны: можно переписать только кусок, выбрать лучший дубль или выровнять ритм по сетке. Готовый
          трек сохраняется в MIDI (все дорожки) и в WAV (послушать или отправить).
        </p>
        <div className="studio-actions">
          <button className="primary" onClick={() => setForm(form === "new" ? null : "new")} data-studio-new>
            + Новый трек
          </button>
          <button onClick={() => setForm(form === "midi" ? null : "midi")} data-studio-from-midi>
            Из MIDI-песни…
          </button>
        </div>
        {form === "new" && (
          <div className="studio-form">
            <label>
              Название <input value={name} onChange={(e) => setName(e.target.value)} data-song-name />
            </label>
            <label>
              Темп <input type="number" min={40} max={220} value={bpm} onChange={(e) => setBpm(Number(e.target.value))} /> уд/мин
            </label>
            <label>
              Размер{" "}
              <select value={meter} onChange={(e) => setMeter(e.target.value)}>
                {["4/4", "3/4", "2/4", "6/8"].map((m) => (
                  <option key={m}>{m}</option>
                ))}
              </select>
            </label>
            <label>
              Тактов <input type="number" min={1} max={400} value={bars} onChange={(e) => setBars(Number(e.target.value))} />
            </label>
            <button
              className="primary"
              data-studio-create
              onClick={() => {
                const [a, b] = meter.split("/").map(Number);
                const s = newSong(name, Math.min(220, Math.max(40, bpm || 100)), [a, b], Math.max(1, bars || 16));
                onOpen({ ...s, tracks: [newTrack("keys", [])] });
              }}
            >
              Создать
            </button>
          </div>
        )}
        {form === "midi" && (
          <div className="studio-form">
            {midi.length ? (
              <div className="studio-midi-list">
                {midi.map((m) => (
                  <button
                    key={m.id}
                    data-studio-midi={m.title}
                    onClick={() =>
                      void api
                        .studioFromMidi(m.id)
                        .then(onOpen)
                        .catch((e) => setBusy(String(e)))
                    }
                  >
                    {m.title}
                  </button>
                ))}
              </div>
            ) : (
              <span className="muted">В «Моих файлах» нет MIDI-песен — добавь .mid на вкладке «Пьесы».</span>
            )}
            <p className="hint">Дорожки песни станут дорожками трека с дублем «Оригинал» — их можно переписать своей игрой.</p>
          </div>
        )}
        {busy && <div className="notice warn">{busy}</div>}
      </section>
      {error && <div className="notice warn">Треки недоступны: {error}</div>}
      <section className="card">
        <h2 className="section-h">Мои треки</h2>
        {list.length === 0 && <p className="muted">Пока пусто.</p>}
        <div className="studio-songs">
          {list.map((s) => (
            <div key={s.file} className="studio-song" data-studio-song={s.name}>
              <button className="studio-song-open" onClick={() => void open(s.file)}>
                <b>{s.name}</b>
                <span className="muted">
                  {Math.round(s.bpm)} уд/мин · {s.bars} так. · дорожек: {s.tracks}
                </span>
              </button>
              <button
                className="ghost small"
                title="Удалить трек"
                onClick={() => {
                  if (window.confirm(`Удалить трек «${s.name}»?`)) void api.studioDelete(s.file).then(onChanged);
                }}
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      </section>
    </main>
  );
}

type Mode = { kind: "idle" } | { kind: "play"; info: PlayInfo } | { kind: "record"; info: PlayInfo; track: number; punch: [number, number] | null };

function SongEditor({ initial, onBack }: { initial: Song; onBack: () => void }) {
  const [song, setSong] = useState<Song>(initial);
  const [selected, setSelected] = useState(0);
  const [mode, setMode] = useState<Mode>({ kind: "idle" });
  const [fromBar, setFromBar] = useState(1);
  const [metronome, setMetronome] = useState(true);
  const [countIn, setCountIn] = useState(true);
  const [punchOn, setPunchOn] = useState(false);
  const [punch, setPunch] = useState<[number, number]>([1, 2]);
  const [toast, setToast] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const clock = useRef(new ClockSync());

  // Автосохранение (через полсекунды после изменения).
  const saved = useRef(JSON.stringify(initial));
  useEffect(() => {
    const text = JSON.stringify(song);
    if (text === saved.current && song.file) return;
    const id = setTimeout(() => {
      api
        .studioSave(song)
        .then((s) => {
          saved.current = JSON.stringify(s);
          if (s.file !== song.file) setSong((cur) => ({ ...cur, file: s.file }));
        })
        .catch((e) => setToast(`Трек не сохранён: ${e}`));
    }, 500);
    return () => clearTimeout(id);
  }, [song]);

  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), 3500);
    return () => clearTimeout(id);
  }, [toast]);

  // Доиграли до конца.
  useEffect(() => {
    let off: (() => void) | null = null;
    let alive = true;
    void listen("studio", (e) => {
      if (e === "ended") setMode((m) => (m.kind === "play" ? { kind: "idle" } : m));
    }).then((f) => (alive ? (off = f) : f()));
    return () => {
      alive = false;
      off?.();
      void api.studioStop();
    };
  }, []);

  const update = (patch: Partial<Song>) => setSong((s) => ({ ...s, ...patch }));
  const updateTrack = (i: number, patch: Partial<Song["tracks"][number]>) =>
    setSong((s) => ({ ...s, tracks: s.tracks.map((t, k) => (k === i ? { ...t, ...patch } : t)) }));

  const play = async () => {
    await clock.current.sync();
    const info = await api.studioPlay(song, fromBar, null, metronome, countIn);
    setMode({ kind: "play", info });
  };
  const record = async () => {
    if (!song.tracks[selected]) return;
    await clock.current.sync();
    const p: [number, number] | null = punchOn ? [Math.min(punch[0], punch[1]), Math.max(punch[0], punch[1])] : null;
    // Перезапись куска — с такта до него, чтобы войти в ритм.
    const start = p ? Math.max(1, p[0] - 1) : fromBar;
    const info = await api.studioPlay(song, start, { track: selected, punch: p }, metronome, countIn);
    setMode({ kind: "record", info, track: selected, punch: p });
  };
  const stop = async () => {
    const rec = await api.studioStop();
    if (mode.kind === "record") {
      if (rec && rec.notes.length) {
        setSong((s) => addTake(s, mode.track, rec, mode.punch));
        setToast(`Записан дубль: нот ${rec.notes.length}`);
      } else setToast("Ничего не записано: не было ни одной ноты.");
    }
    setMode({ kind: "idle" });
  };

  // Пробел — играть / стоп.
  const keyRef = useRef<(e: KeyboardEvent) => void>(() => {});
  keyRef.current = (e) => {
    const tag = (e.target as HTMLElement)?.tagName;
    if (tag === "INPUT" || tag === "SELECT") return;
    if (e.code === "Space") {
      e.preventDefault();
      if (document.activeElement instanceof HTMLButtonElement) document.activeElement.blur();
      void (mode.kind === "idle" ? play() : stop());
    }
  };
  useEffect(() => {
    const f = (e: KeyboardEvent) => keyRef.current(e);
    window.addEventListener("keydown", f);
    return () => window.removeEventListener("keydown", f);
  }, []);

  const exportMidi = async () => {
    try {
      setToast(`MIDI сохранён в «Мои файлы»: ${await api.studioExportMidi(song)}`);
    } catch (e) {
      setToast(`MIDI не сохранён: ${e}`);
    }
  };
  const exportWav = async () => {
    setBusy(true);
    try {
      setToast(`WAV сохранён: ${await api.studioExportWav(song)}`);
    } catch (e) {
      setToast(`WAV не сохранён: ${e}`);
    } finally {
      setBusy(false);
    }
  };

  const nowMs = () => (mode.kind === "idle" ? (fromBar - 1) * barMs(song) : mode.info.fromMs + (clock.current.nowUs() - mode.info.startUs) / 1000);
  const [pos, setPos] = useState({ bar: 1, beat: 1, counting: false });
  useEffect(() => {
    if (mode.kind === "idle") {
      setPos({ bar: fromBar, beat: 1, counting: false });
      return;
    }
    const tick = () => {
      const ms = nowMs();
      const counting = ms < mode.info.fromMs;
      setPos({ ...position(song, ms), counting });
    };
    // Сразу, без задержки: иначе после «Записать» мелькало бы «не отсчёт».
    tick();
    const id = setInterval(tick, 80);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, fromBar, song.bpm]);

  const recording = mode.kind === "record";
  const locked = hasNotes(song);

  return (
    <main className="studio editor" data-studio-mode={mode.kind}>
      <div className="studio-bar">
        <button className="ghost" onClick={onBack}>
          ← Треки
        </button>
        <input className="studio-title" value={song.name} onChange={(e) => update({ name: e.target.value })} />
        <label title={locked ? "Темп меняется только в пустом треке — иначе ноты съедут с тактов" : "Темп трека"}>
          Темп{" "}
          <input
            type="number"
            min={40}
            max={220}
            value={song.bpm}
            disabled={locked}
            onChange={(e) => update({ bpm: Math.min(220, Math.max(40, Number(e.target.value) || 100)) })}
          />
        </label>
        <span className="muted">
          {song.meter[0]}/{song.meter[1]} · тактов
        </span>
        <input type="number" min={1} max={400} value={song.bars} onChange={(e) => update({ bars: Math.max(1, Number(e.target.value) || 1) })} />
        <span className="spacer" />
        <button onClick={() => void exportMidi()} data-export-midi>
          Сохранить MIDI
        </button>
        <button onClick={() => void exportWav()} disabled={busy} data-export-wav>
          {busy ? "Свожу…" : "Сохранить WAV"}
        </button>
      </div>

      <div className="studio-transport">
        {mode.kind === "idle" ? (
          <>
            <button className="primary" onClick={() => void play()} title="Пробел" data-studio-play>
              ▶ Играть
            </button>
            <button className="rec-btn" onClick={() => void record()} disabled={!song.tracks.length} data-studio-record>
              ● Записать «{song.tracks[selected]?.name ?? "—"}»
            </button>
          </>
        ) : (
          <button className={recording ? "rec-btn on" : ""} onClick={() => void stop()} title="Пробел" data-studio-stop>
            ■ Стоп
          </button>
        )}
        <span className="studio-pos" data-studio-pos={`${pos.bar}:${pos.beat}`} data-counting={pos.counting ? "1" : "0"}>
          {pos.counting ? "отсчёт…" : `такт ${pos.bar} · доля ${pos.beat}`}
        </span>
        <label>
          с такта{" "}
          <input type="number" min={1} max={song.bars} value={fromBar} disabled={mode.kind !== "idle"} onChange={(e) => setFromBar(Math.max(1, Number(e.target.value) || 1))} />
        </label>
        <label className="toggle">
          <input type="checkbox" checked={metronome} onChange={(e) => setMetronome(e.target.checked)} /> Метроном
        </label>
        <label className="toggle">
          <input type="checkbox" checked={countIn} onChange={(e) => setCountIn(e.target.checked)} /> Отсчёт такта
        </label>
        <label className="toggle" title="Записать только эти такты: остальное в дубле останется как было">
          <input type="checkbox" checked={punchOn} onChange={(e) => setPunchOn(e.target.checked)} data-punch /> Переписать такты
        </label>
        {punchOn && (
          <span className="punch-fields">
            <input type="number" min={1} max={song.bars} value={punch[0]} onChange={(e) => setPunch([Math.max(1, Number(e.target.value) || 1), punch[1]])} data-punch-from />
            –
            <input type="number" min={1} max={song.bars} value={punch[1]} onChange={(e) => setPunch([punch[0], Math.max(1, Number(e.target.value) || 1)])} data-punch-to />
          </span>
        )}
      </div>

      <Timeline song={song} selected={selected} nowMs={nowMs} playing={mode.kind !== "idle"} punch={punchOn ? punch : null} onPickBar={(b) => mode.kind === "idle" && setFromBar(b)} />

      <section className="studio-tracks">
        {song.tracks.map((t, i) => (
          <div key={t.id} className={`studio-track${i === selected ? " selected" : ""}`} data-studio-track={i}>
            <label className="studio-track-pick" title="Эта дорожка записывается по «● Записать»">
              <input type="radio" checked={i === selected} onChange={() => setSelected(i)} />
            </label>
            <input className="studio-track-name" value={t.name} onChange={(e) => updateTrack(i, { name: e.target.value })} />
            <span className="chip small">{KIND_NAME[t.kind]}</span>
            {t.kind !== "drums" ? (
              <select
                value={t.program === null ? "app" : String(t.program)}
                onChange={(e) => updateTrack(i, { program: e.target.value === "app" ? null : Number(e.target.value) })}
                title="Инструмент дорожки"
              >
                {INSTRUMENTS.filter((x) => x.kinds.includes(t.kind) || x.program === t.program).map((x) => (
                  <option key={String(x.program)} value={x.program === null ? "app" : x.program}>
                    {x.name}
                  </option>
                ))}
                {t.program !== null && !INSTRUMENTS.some((x) => x.program === t.program) && <option value={t.program}>Программа {t.program + 1}</option>}
              </select>
            ) : (
              <span className="muted">установка GM</span>
            )}
            <label className="studio-vol" title="Громкость">
              <input type="range" min={0} max={1} step={0.05} value={t.volume} onChange={(e) => updateTrack(i, { volume: Number(e.target.value) })} />
            </label>
            <button className={`small${t.mute ? " on warn-on" : ""}`} onClick={() => updateTrack(i, { mute: !t.mute })} title="Выключить дорожку">
              M
            </button>
            <button className={`small${t.solo ? " on" : ""}`} onClick={() => updateTrack(i, { solo: !t.solo })} title="Только эта дорожка (соло)">
              S
            </button>
            <select value={t.active} onChange={(e) => updateTrack(i, { active: Number(e.target.value) })} disabled={!t.takes.length} title="Какой дубль звучит" data-takes>
              {t.takes.length === 0 && <option>нет дублей</option>}
              {t.takes.map((k, ki) => (
                <option key={k.id} value={ki}>
                  {k.name}
                  {k.accuracy !== null ? ` · ${Math.round(k.accuracy * 100)}% к оригиналу` : ""}
                </option>
              ))}
            </select>
            <select value={t.grid} onChange={(e) => updateTrack(i, { grid: Number(e.target.value) })} title="Выровнять ритм по сетке (запись не меняется)" data-grid>
              {GRIDS.map((g) => (
                <option key={g.grid} value={g.grid}>
                  {g.name}
                </option>
              ))}
            </select>
            {t.grid > 0 && (
              <label className="studio-strength" title="Сила выравнивания">
                <input type="range" min={0.2} max={1} step={0.1} value={t.strength} onChange={(e) => updateTrack(i, { strength: Number(e.target.value) })} />
                {Math.round(t.strength * 100)}%
              </label>
            )}
            <button
              className="ghost small"
              title="Удалить дорожку"
              disabled={mode.kind !== "idle"}
              onClick={() => {
                if (t.takes.length && !window.confirm(`Удалить дорожку «${t.name}» со всеми дублями?`)) return;
                setSong((s) => ({ ...s, tracks: s.tracks.filter((_, k) => k !== i) }));
                setSelected((x) => Math.max(0, Math.min(x, song.tracks.length - 2)));
              }}
            >
              ✕
            </button>
          </div>
        ))}
        <div className="studio-add">
          <span className="muted">+ дорожка:</span>
          {(["keys", "drums", "bass", "guitar", "other"] as TrackKind[]).map((k) => (
            <button
              key={k}
              className="small"
              disabled={mode.kind !== "idle"}
              onClick={() => {
                setSong((s) => ({ ...s, tracks: [...s.tracks, newTrack(k, s.tracks)] }));
                setSelected(song.tracks.length);
              }}
              data-add-track={k}
            >
              {KIND_NAME[k]}
            </button>
          ))}
        </div>
        <p className="hint">
          Барабаны — на пэдах, гитара и бас — по звуку (вкладка «Гитара», вход включён), клавишные — на любой клавиатуре.
          Записывается всё, что приходит, на выбранную дорожку.
        </p>
      </section>
      {toast && <div className="toast studio-toast">{toast}</div>}
    </main>
  );
}

/** Лента: такты, ноты дорожек (высота — внутри строки дорожки), курсор и перезаписываемый кусок. */
function Timeline({
  song,
  selected,
  nowMs,
  playing,
  punch,
  onPickBar,
}: {
  song: Song;
  selected: number;
  nowMs: () => number;
  playing: boolean;
  punch: [number, number] | null;
  onPickBar: (bar: number) => void;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const placed = useMemo(() => song.tracks.map((t) => placedNotes(song, t)), [song]);
  const props = useRef({ song, selected, nowMs, playing, punch, placed });
  props.current = { song, selected, nowMs, playing, punch, placed };

  useEffect(() => {
    const canvas = ref.current!;
    const ctx = canvas.getContext("2d")!;
    let raf = 0;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const { song, selected, nowMs, playing, punch, placed } = props.current;
      const dpr = window.devicePixelRatio || 1;
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = "#101216";
      ctx.fillRect(0, 0, w, h);
      const total = song.bars * barMs(song);
      const x = (ms: number) => (ms / total) * w;
      const rows = Math.max(1, song.tracks.length);
      const rowH = h / rows;
      if (punch) {
        const a = Math.min(punch[0], punch[1]);
        const b = Math.max(punch[0], punch[1]);
        ctx.fillStyle = "rgba(255, 92, 92, 0.13)";
        ctx.fillRect(x((a - 1) * barMs(song)), 0, x((b - a + 1) * barMs(song)), h);
      }
      ctx.fillStyle = "#1e2128";
      ctx.fillRect(0, selected * rowH, w, rowH);
      for (let b = 0; b <= song.bars; b++) {
        ctx.fillStyle = b % 4 === 0 ? "#3a3f4c" : "#24282f";
        ctx.fillRect(Math.round(x(b * barMs(song))), 0, 1, h);
      }
      ctx.font = "10px Inter, sans-serif";
      ctx.fillStyle = "#6b7280";
      for (let b = 0; b < song.bars; b += song.bars > 32 ? 4 : 1) ctx.fillText(String(b + 1), x(b * barMs(song)) + 3, 10);
      placed.forEach((notes, i) => {
        if (!notes.length) return;
        const ps = notes.map((n) => n.pitch);
        const lo = Math.min(...ps);
        const hi = Math.max(...ps);
        const t = song.tracks[i];
        ctx.fillStyle = t.mute ? "#3a3f4c" : ["#5aa9ff", "#ffb454", "#4cc38a", "#c38bff", "#ff7a7a", "#ffd166"][i % 6];
        for (const n of notes) {
          const y = i * rowH + 14 + (hi === lo ? 0.5 : 1 - (n.pitch - lo) / (hi - lo)) * (rowH - 20);
          ctx.fillRect(x(n.startMs), y - 1.5, Math.max(2, x(n.durMs)), 3);
        }
      });
      if (playing) {
        ctx.fillStyle = "#e6e6e6";
        ctx.fillRect(Math.round(x(Math.max(0, nowMs()))), 0, 2, h);
      }
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <canvas
      ref={ref}
      className="studio-timeline"
      style={{ height: Math.max(90, song.tracks.length * 46) }}
      onClick={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        onPickBar(Math.min(song.bars, Math.floor(((e.clientX - r.left) / r.width) * song.bars) + 1));
      }}
      title="Клик — играть с этого такта"
      data-studio-timeline
    />
  );
}
