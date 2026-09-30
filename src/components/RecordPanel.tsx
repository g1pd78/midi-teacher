import { useEffect, useState } from "react";
import { api, type RecordStatus } from "../api";
import { recordingName } from "../lib/midi";

const METERS = [2, 3, 4];

/**
 * Запись своей игры в MIDI-файл библиотеки: темп, размер, метроном и отсчёт такта.
 * Запись потом открывается как любая MIDI-пьеса (ноты строятся с выравниванием по сетке).
 */
export function RecordPanel({ onClose, onSaved }: { onClose: () => void; onSaved: (file: string) => void }) {
  const [bpm, setBpm] = useState(80);
  const [beats, setBeats] = useState(4);
  const [metronome, setMetronome] = useState(true);
  const [countIn, setCountIn] = useState(true);
  const [status, setStatus] = useState<RecordStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const active = !!status?.recording;

  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => void api.recordStatus().then(setStatus), 200);
    return () => window.clearInterval(id);
  }, [active]);
  // Ушли с экрана посреди записи — запись отменяется.
  useEffect(() => () => void api.recordStop("", false), []);

  const start = async () => {
    setError(null);
    await api.recordStart(bpm, beats, metronome, countIn);
    setStatus(await api.recordStatus());
  };
  const stop = async (save: boolean) => {
    try {
      const file = await api.recordStop(recordingName(new Date()), save);
      setStatus(null);
      if (file) onSaved(file);
      else if (save) setError("Не сыграно ни одной ноты — записывать нечего.");
    } catch (e) {
      setError(String(e));
    }
  };

  const beatMs = 60000 / bpm;
  const elapsed = status?.elapsedMs ?? 0;
  const counting = active && elapsed < 0;
  const beat = Math.floor(elapsed / beatMs);
  const bar = Math.floor(beat / beats) + 1;
  const sec = Math.max(0, Math.floor(elapsed / 1000));

  return (
    <div className="card record-panel" data-recording={active ? "1" : "0"}>
      {!active ? (
        <>
          <div className="record-row">
            <label>
              Темп
              <input type="number" min={40} max={200} value={bpm} onChange={(e) => setBpm(Math.max(40, Math.min(200, Number(e.target.value) || 80)))} />
              уд/мин
            </label>
            <span className="segmented" title="Размер: долей в такте">
              {METERS.map((m) => (
                <button key={m} className={beats === m ? "on" : ""} onClick={() => setBeats(m)}>
                  {m}/4
                </button>
              ))}
            </span>
            <label className="toggle">
              <input type="checkbox" checked={countIn} onChange={(e) => setCountIn(e.target.checked)} /> Отсчёт такта
            </label>
            <label className="toggle">
              <input type="checkbox" checked={metronome} onChange={(e) => setMetronome(e.target.checked)} /> Метроном
            </label>
          </div>
          <p className="hint">
            Играй на любом подключённом инструменте. Темп и размер записываются в файл, поэтому ноты потом лягут по тактам.
            Играй под метроном — так выравнивание по сетке будет точнее.
          </p>
          <div className="buttons">
            <button className="primary" onClick={() => void start()} data-record-start>
              ● Начать запись
            </button>
            <button onClick={onClose}>Закрыть</button>
          </div>
        </>
      ) : (
        <>
          <div className="record-row">
            <span className="record-dot" />
            {counting ? (
              <b>Отсчёт: {Math.ceil(-elapsed / beatMs)}…</b>
            ) : (
              <b>
                Запись · такт {bar} · {Math.floor(sec / 60)}:{String(sec % 60).padStart(2, "0")}
              </b>
            )}
            <span className="muted">нот: {status?.notes ?? 0}</span>
          </div>
          <div className="buttons">
            <button className="primary" onClick={() => void stop(true)} data-record-stop>
              ■ Стоп и сохранить
            </button>
            <button onClick={() => void stop(false)}>Отменить</button>
          </div>
        </>
      )}
      {error && <div className="notice warn">{error}</div>}
    </div>
  );
}
