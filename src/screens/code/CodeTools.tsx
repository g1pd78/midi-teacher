import { useEffect, useRef, useState } from "react";
import { api, listen, PADS_DEVICE } from "../../api";
import { loadEngine, renderWav, toBase64 } from "../../lib/strudel/engine";
import { evalCode } from "../../lib/strudel/evaluate";
import { riffToMini, type Grid, type RiffNote } from "../../lib/strudel/gen";
import { notesToSong, patternNotes } from "../../lib/strudel/haps";
import { partLabel } from "../../lib/strudel/mt";
import { portableCode } from "../../lib/strudel/portable";
import type { CodeEditorHandle, CodePanel } from "./CodeEditor";

type Dialog = "riff" | "notes" | "wav" | null;

/** Кнопки «Записать рифф», «В ноты / MIDI», «WAV», «Для strudel.cc». */
export function CodeTools({
  handle,
  name,
  panel,
  onNote,
  onCreate,
}: {
  handle: () => CodeEditorHandle | null;
  name: string;
  panel: CodePanel;
  onNote: (text: string) => void;
  onCreate: (name: string, text: string) => Promise<string>;
}) {
  const [dialog, setDialog] = useState<Dialog>(null);
  return (
    <>
      <button className="ghost small" onClick={() => setDialog("riff")} data-code-riff>
        ● Записать рифф
      </button>
      <button className="ghost small" onClick={() => setDialog("notes")} data-code-tonotes>
        В ноты / MIDI
      </button>
      <button className="ghost small" onClick={() => setDialog("wav")} data-code-wav>
        WAV
      </button>
      <button
        className="ghost small"
        onClick={() => {
          const h = handle();
          if (!h) return;
          void api
            .codeSampleBanks()
            .catch(() => ({ user: {}, rec: [] }))
            .then((banks) => {
              const text = portableCode(h.code(), { panel, userSamples: banks.user });
              return navigator.clipboard.writeText(text).then(() => onNote("Скопировано: вставь на strudel.cc. Наши функции заменены, свои сэмплы — через samples()."));
            })
            .catch(() => onNote("Не удалось скопировать в буфер обмена."));
        }}
        data-code-portable
        title="Копия кода для strudel.cc: без функций MIDI Teacher"
      >
        Для strudel.cc
      </button>
      {dialog === "riff" && <RiffDialog handle={handle} onClose={() => setDialog(null)} onNote={onNote} />}
      {dialog === "notes" && <NotesDialog handle={handle} name={name} onClose={() => setDialog(null)} onNote={onNote} onCreate={onCreate} />}
      {dialog === "wav" && <WavDialog handle={handle} name={name} panel={panel} onClose={() => setDialog(null)} onNote={onNote} />}
    </>
  );
}

/** Рифф с клавиатуры → note("…") в редактор. Если код играет — запись по его циклам, иначе — с щелчками. */
function RiffDialog({ handle, onClose, onNote }: { handle: () => CodeEditorHandle | null; onClose: () => void; onNote: (t: string) => void }) {
  const [bars, setBars] = useState(2);
  const [grid, setGrid] = useState<Grid>(16);
  const [phase, setPhase] = useState<"idle" | "count" | "rec" | "done">("idle");
  const [beat, setBeat] = useState(0);
  const [result, setResult] = useState<string | null>(null);
  const stop = useRef<(() => void) | null>(null);
  useEffect(() => () => stop.current?.(), []);

  const start = async () => {
    const h = handle();
    if (!h) return;
    const live = h.live;
    const { webaudio } = await loadEngine();
    await webaudio.initAudio?.();
    const ctx = webaudio.getAudioContext();
    const notes: RiffNote[] = [];
    const held = new Map<number, RiffNote>();
    const cps = live.cps || 0.5;
    const endCycle = bars;
    // Часы ядра (время нажатий) → performance.now() → то, что слышно по часам AudioContext.
    const coreOffsetUs = await api.clockNow().then((us) => us - performance.now() * 1000).catch(() => 0);
    const heard = (timeUs: number) => live.audioTimeAtPerf((timeUs - coreOffsetUs) / 1000);
    let toCycle: (timeUs: number) => number | null;
    const now = live.started ? live.nowCycle() : null;
    if (now !== null) {
      // Код играет — он и метроном: запись со следующего цикла.
      const from = Math.ceil(now + 0.1);
      toCycle = (t) => {
        const c = live.cycleAtAudioTime(heard(t));
        return c === null ? null : c - from;
      };
    } else {
      // Щелчки: 4 доли отсчёта, затем такты по 4 доли; 1 цикл = 4 доли.
      const beatSec = 1 / (4 * cps);
      const t0 = ctx.currentTime + 0.3;
      for (let i = 0; i < 4 + bars * 4; i++)
        void webaudio.superdough({ s: "triangle", note: i % 4 === 0 ? 96 : 84, decay: 0.06, sustain: 0, gain: 0.5 }, t0 + i * beatSec, 0.06, cps, 0);
      const startAudio = t0 + 4 * beatSec;
      toCycle = (t) => (heard(t) - startAudio) * cps;
    }
    setPhase("count");
    let off: (() => void) | null = null;
    const unlisten = await listen("midi", (e) => {
      if (e.device === PADS_DEVICE || e.type === "controlChange") return;
      const c = toCycle(e.timeUs);
      if (c === null) return;
      if (e.type === "noteOn") {
        if (c < -0.5 / grid || c >= endCycle) return;
        const n: RiffNote = { begin: Math.max(0, c), dur: 0.25, midi: e.note };
        notes.push(n);
        held.set(e.note, n);
      } else {
        const n = held.get(e.note);
        if (n) n.dur = Math.max(1 / grid, c - n.begin);
        held.delete(e.note);
      }
    });
    off = unlisten;
    const timer = window.setInterval(() => {
      const nowUs = performance.now() * 1000 + coreOffsetUs;
      const c = toCycle(nowUs);
      if (c === null) return;
      setBeat(Math.floor(c * 4));
      setPhase(c < 0 ? "count" : "rec");
      if (c >= endCycle + 0.05) finish();
    }, 40);
    const finish = () => {
      window.clearInterval(timer);
      off?.();
      stop.current = null;
      if (!notes.length) {
        setResult(null);
        setPhase("done");
        return;
      }
      setResult(riffToMini(notes, bars, grid));
      setPhase("done");
    };
    stop.current = finish;
  };

  const insert = () => {
    const h = handle();
    if (!h || !result) return;
    const code = h.code().replace(/\s*$/, "");
    h.setCode(`${code}\n\nriff: ${result}.s("piano")\n`);
    onNote("Рифф добавлен в конец кода партией «riff».");
    onClose();
  };

  return (
    <div className="theory-modal" data-code-riff-dialog={phase}>
      <div className="card theory-modal-card">
        <h2>Записать рифф</h2>
        <p className="hint">
          Если код играет — запись начнётся со следующего цикла (такта). Если нет — сначала 4 щелчка отсчёта. Ноты
          выравниваются по сетке и превращаются в мини-нотацию Strudel.
        </p>
        <div className="field">
          <span>Тактов</span>
          <span className="segmented">
            {[1, 2, 4, 8].map((b) => (
              <button key={b} className={bars === b ? "on" : ""} onClick={() => setBars(b)} disabled={phase === "count" || phase === "rec"}>
                {b}
              </button>
            ))}
          </span>
        </div>
        <div className="field">
          <span>Сетка</span>
          <span className="segmented">
            {([8, 16, 12] as Grid[]).map((g) => (
              <button key={g} className={grid === g ? "on" : ""} onClick={() => setGrid(g)} disabled={phase === "count" || phase === "rec"}>
                {g === 8 ? "восьмые" : g === 16 ? "шестнадцатые" : "триоли"}
              </button>
            ))}
          </span>
        </div>
        {(phase === "count" || phase === "rec") && (
          <p className="code-rec" data-code-rec={phase}>
            {phase === "count" ? `Отсчёт… ${Math.max(1, -beat)}` : `● Запись: доля ${beat + 1} из ${bars * 4}`}
          </p>
        )}
        {phase === "done" && (result ? <pre className="code-result" data-code-riff-result>{result}</pre> : <p className="hint">Нот не было — попробуй ещё раз.</p>)}
        <div className="buttons">
          {phase === "idle" || phase === "done" ? (
            <button className="primary" onClick={() => void start()} data-code-riff-start>
              {phase === "done" ? "Ещё раз" : "Начать"}
            </button>
          ) : (
            <button onClick={() => stop.current?.()}>Стоп</button>
          )}
          {result && (
            <button className="primary" onClick={insert} data-code-riff-insert>
              Вставить в код
            </button>
          )}
          <button className="ghost" onClick={onClose}>
            Закрыть
          </button>
        </div>
      </div>
    </div>
  );
}

/** Партия кода за N циклов → трек Студии, пьеса с нотами или MIDI-файл. */
function NotesDialog({
  handle,
  name,
  onClose,
  onNote,
}: {
  handle: () => CodeEditorHandle | null;
  name: string;
  onClose: () => void;
  onNote: (t: string) => void;
  onCreate: (name: string, text: string) => Promise<string>;
}) {
  const [parts, setParts] = useState<string[] | null>(null);
  const [part, setPart] = useState<string>("");
  const [cycles, setCycles] = useState(8);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const evaluated = useRef<Awaited<ReturnType<typeof evalCode>> | null>(null);

  useEffect(() => {
    const h = handle();
    if (!h) return;
    evalCode(h.code())
      .then((r) => {
        evaluated.current = r;
        const names = Object.keys(r.parts);
        setParts(names);
        setPart(names[0] ?? "");
      })
      .catch((e) => setError(String(e?.message ?? e)));
  }, [handle]);

  const song = () => {
    const r = evaluated.current!;
    const pat = part && r.parts[part] ? r.parts[part].withValue((v: unknown) => (v && typeof v === "object" ? { ...v, mtPart: part } : v)) : r.pattern;
    const notes = patternNotes(pat, 0, cycles);
    return notesToSong(notes, part ? `${name} — ${partLabel(part)}` : name, r.cps, cycles);
  };

  const run = async (what: "studio" | "piece" | "midi") => {
    setBusy(true);
    try {
      const s = song();
      if (!s.tracks.length) throw new Error("в этой партии нет нот");
      if (what === "studio") {
        const saved = await api.studioSave(s);
        onNote(`Трек «${saved.name}» сохранён в Студии.`);
      } else {
        const path = await api.studioExportMidi(s);
        if (what === "piece") {
          await api.libraryImport([path]);
          onNote(`Пьеса «${s.name}» добавлена в библиотеку — открой в «Пьесах»: появится нотный стан.`);
        } else onNote(`MIDI сохранён: ${path}`);
      }
      onClose();
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="theory-modal" data-code-notes-dialog>
      <div className="card theory-modal-card">
        <h2>Код → ноты</h2>
        <p className="hint">Партия кода за несколько циклов (цикл — такт 4/4) становится нотами: трек Студии, пьеса с нотным станом или MIDI-файл.</p>
        {error && <p className="code-error">{error}</p>}
        {parts && (
          <>
            <div className="field">
              <span>Партия</span>
              <select value={part} onChange={(e) => setPart(e.target.value)} data-code-notes-part>
                <option value="">Все вместе</option>
                {parts.map((p) => (
                  <option key={p} value={p}>
                    {partLabel(p)}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <span>Циклов</span>
              <span className="segmented">
                {[4, 8, 16, 32].map((c) => (
                  <button key={c} className={cycles === c ? "on" : ""} onClick={() => setCycles(c)}>
                    {c}
                  </button>
                ))}
              </span>
            </div>
          </>
        )}
        <div className="buttons">
          <button className="primary" onClick={() => void run("piece")} disabled={!parts || busy} data-code-notes-piece>
            Пьеса с нотами
          </button>
          <button onClick={() => void run("studio")} disabled={!parts || busy} data-code-notes-studio>
            В Студию
          </button>
          <button onClick={() => void run("midi")} disabled={!parts || busy}>
            MIDI-файл
          </button>
          <button className="ghost" onClick={onClose}>
            Закрыть
          </button>
        </div>
      </div>
    </div>
  );
}

/** Звук кода за N циклов → WAV в «Треки» (с моей игрой за последний запуск — по желанию). */
function WavDialog({
  handle,
  name,
  panel,
  onClose,
  onNote,
}: {
  handle: () => CodeEditorHandle | null;
  name: string;
  panel: CodePanel;
  onClose: () => void;
  onNote: (t: string) => void;
}) {
  const [cycles, setCycles] = useState(8);
  const [mine, setMine] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const played = handle()?.played() ?? [];

  const run = async () => {
    const h = handle();
    if (!h) return;
    setBusy(true);
    setError(null);
    try {
      const r = await evalCode(h.code());
      // «Моя партия» в WAV не звучит (её играл я); остальное — как в коде.
      const skip = new Set([panel.myPart, panel.echoPart].filter(Boolean) as string[]);
      const pat = skip.size ? r.pattern.filter((hap: { value?: { mtPart?: string } }) => !skip.has(hap.value?.mtPart ?? "")) : r.pattern;
      const wav = await renderWav(pat, cycles, r.cps, mine ? played.filter((n) => n.begin < cycles) : []);
      const path = await api.codeSaveWav(name, toBase64(wav));
      onNote(`WAV сохранён: ${path}`);
      onClose();
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="theory-modal" data-code-wav-dialog>
      <div className="card theory-modal-card">
        <h2>Сохранить звук (WAV)</h2>
        <p className="hint">Рендер без воспроизведения, файл — в «Документы\MIDI Teacher\Треки». Его же можно взять как сэмпл: банк rec.</p>
        {error && <p className="code-error">{error}</p>}
        <div className="field">
          <span>Циклов</span>
          <span className="segmented">
            {[4, 8, 16, 32].map((c) => (
              <button key={c} className={cycles === c ? "on" : ""} onClick={() => setCycles(c)}>
                {c}
              </button>
            ))}
          </span>
        </div>
        <label className="check">
          <input type="checkbox" checked={mine} disabled={!played.length} onChange={(e) => setMine(e.target.checked)} /> С моей игрой за последний запуск
          {!played.length && <span className="muted"> (не было нажатий)</span>}
        </label>
        <div className="buttons">
          <button className="primary" onClick={() => void run()} disabled={busy} data-code-wav-save>
            {busy ? "Рендер…" : "Сохранить"}
          </button>
          <button className="ghost" onClick={onClose}>
            Закрыть
          </button>
        </div>
      </div>
    </div>
  );
}
