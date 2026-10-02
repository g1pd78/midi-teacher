import { useEffect, useRef, useState } from "react";
import { api, type TakeInfo } from "../api";
import { recordingName } from "../lib/midi";

function clock(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/**
 * Запись своей игры прямо в пьесе или упражнении: ● — пишем всё, что играешь
 * (клавиши, педаль, пэды), ■ — дубль, который можно прослушать, сохранить в «Мои файлы»
 * или выбросить.
 */
export function RecordTake({ title, bpm, beatsPerBar, onSaved }: { title: string; bpm: number; beatsPerBar: number; onSaved: (msg: string) => void }) {
  const [recording, setRecording] = useState(false);
  const [status, setStatus] = useState({ elapsedMs: 0, notes: 0 });
  const [take, setTake] = useState<TakeInfo | null>(null);
  const [playing, setPlaying] = useState(false);
  const [busy, setBusy] = useState(false);
  const playTimer = useRef<number | null>(null);

  useEffect(() => {
    if (!recording) return;
    const id = setInterval(() => void api.recordStatus().then((s) => setStatus({ elapsedMs: s.elapsedMs, notes: s.notes })), 400);
    return () => clearInterval(id);
  }, [recording]);

  // Уход с экрана: недописанную запись и несохранённый дубль — выбросить.
  const state = useRef({ recording, take });
  state.current = { recording, take };
  useEffect(
    () => () => {
      if (state.current.recording) void api.recordTakeStop().then(() => api.recordTakeDiscard());
      else if (state.current.take) void api.recordTakeDiscard();
      if (playTimer.current) clearTimeout(playTimer.current);
    },
    [],
  );

  const start = async () => {
    setTake(null);
    // Без отсчёта и щелчков: темп и метроном — у самой пьесы; запись начинается с первой ноты.
    await api.recordStart(bpm, beatsPerBar, false, false);
    setStatus({ elapsedMs: 0, notes: 0 });
    setRecording(true);
  };
  const stop = async () => {
    setRecording(false);
    const t = await api.recordTakeStop();
    if (!t) onSaved("Ничего не записано: не было ни одной ноты.");
    setTake(t);
  };
  const stopPlay = () => {
    void api.midiPreviewStop();
    setPlaying(false);
    if (playTimer.current) clearTimeout(playTimer.current);
  };
  const play = () => {
    if (!take) return;
    void api.recordTakePlay();
    setPlaying(true);
    playTimer.current = window.setTimeout(() => setPlaying(false), take.durationMs + 800);
  };
  const save = async () => {
    setBusy(true);
    stopPlay();
    try {
      const file = await api.recordTakeSave(`${title} — ${recordingName(new Date()).replace(/^Запись /, "")}`);
      onSaved(`Запись сохранена в «Мои файлы»: ${file}`);
      setTake(null);
    } catch (e) {
      onSaved(`Запись не сохранена: ${e}`);
    } finally {
      setBusy(false);
    }
  };
  const discard = () => {
    stopPlay();
    void api.recordTakeDiscard();
    setTake(null);
  };

  return (
    <span className="record-take">
      <button
        className={`rec-btn${recording ? " on" : ""}`}
        onClick={() => void (recording ? stop() : start())}
        title={recording ? "Остановить запись" : "Записать свою игру: потом можно прослушать и сохранить"}
        data-record-take={recording ? "on" : "off"}
      >
        {recording ? `■ ${clock(status.elapsedMs)} · ${status.notes}` : "●"}
      </button>
      {take && (
        <span className="take-panel" data-take={take.notes}>
          <span className="muted">
            Запись: {take.notes} нот, {clock(take.durationMs)}
          </span>
          <button className="small" onClick={playing ? stopPlay : play} data-take-play>
            {playing ? "■ Стоп" : "▶ Прослушать"}
          </button>
          <button className="small primary" disabled={busy} onClick={() => void save()} data-take-save>
            Сохранить
          </button>
          <button className="small ghost" onClick={discard} title="Выбросить запись">
            ✕
          </button>
        </span>
      )}
    </span>
  );
}
