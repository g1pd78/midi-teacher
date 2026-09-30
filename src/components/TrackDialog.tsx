import { useEffect, useState } from "react";
import { api, type MidiInfo, type TrackRole } from "../api";
import { ROLES, hasPlayable, instrumentName, keyName } from "../lib/midi";
import { keyLabel } from "../lib/notes";
import { useApp } from "../store";

/**
 * Окно дорожек MIDI-файла: что играю я (правая, левая, обе руки), что звучит
 * аккомпанементом, что выключить. Дорожку можно прослушать.
 */
export function TrackDialog({
  fileId,
  info,
  initial,
  onApply,
  onCancel,
}: {
  fileId: string;
  info: MidiInfo;
  initial: TrackRole[] | null;
  onApply: (roles: TrackRole[]) => void;
  onCancel: () => void;
}) {
  const naming = useApp((s) => s.prefs.noteNames);
  const [roles, setRoles] = useState<TrackRole[]>(() =>
    initial && initial.length === info.tracks.length ? initial : info.tracks.map((t) => t.role),
  );
  const [playing, setPlaying] = useState<number | null>(null);

  // Прослушивание останавливается само через несколько секунд или при закрытии окна.
  useEffect(() => {
    if (playing === null) return;
    const t = window.setTimeout(() => setPlaying(null), 8500);
    return () => window.clearTimeout(t);
  }, [playing]);
  useEffect(() => () => void api.midiPreviewStop(), []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onCancel();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  const preview = (i: number) => {
    if (playing === i) {
      void api.midiPreviewStop();
      setPlaying(null);
    } else {
      void api.midiPreview(fileId, i);
      setPlaying(i);
    }
  };
  const setRole = (i: number, r: TrackRole) => setRoles((rs) => rs.map((x, k) => (k === i ? r : x)));
  const ok = hasPlayable(roles);
  const min = Math.floor(info.durationSec / 60);
  const sec = String(Math.round(info.durationSec % 60)).padStart(2, "0");

  return (
    <div className="theory-modal" data-track-dialog>
      <div className="card track-dialog">
        <h2>Дорожки файла</h2>
        <p className="muted">
          {Math.round(info.bpm)} ударов в минуту · размер {info.meter[0]}/{info.meter[1]} ·{" "}
          {keyName(info.keyFifths, info.keyMinor)}
          {info.keyFromFile ? "" : " (определена по нотам)"} · {min}:{sec}
        </p>
        <p className="hint">
          Выбери, что играешь ты. «Обе» — приложение само разделит дорожку на руки по высоте (потом можно поправить
          в режиме «Руки…»). Аккомпанемент звучит вместе с тобой, но на нотах не показывается.
        </p>
        <div className="track-list">
          {info.tracks.map((t, i) => (
            <div key={i} className={`track-row${roles[i] === "off" ? " off" : ""}`} data-track={i}>
              <button
                className={`small track-play${playing === i ? " on" : ""}`}
                onClick={() => preview(i)}
                title={playing === i ? "Остановить" : "Послушать начало дорожки"}
              >
                {playing === i ? "■" : "▶"}
              </button>
              <div className="track-info">
                <b>{t.name || `Дорожка ${i + 1}`}</b>
                <span className="muted">
                  {instrumentName(t)} · канал {t.channel} · нот: {t.notes}
                  {t.notes > 0 && !t.drums && ` · ${keyLabel(t.low, naming)}–${keyLabel(t.high, naming)}`}
                </span>
              </div>
              <div className="segmented track-roles">
                {ROLES.map((r) => (
                  <button
                    key={r.role}
                    className={roles[i] === r.role ? "on" : ""}
                    title={r.title}
                    disabled={t.drums && r.role !== "off" && r.role !== "accompany"}
                    onClick={() => setRole(i, r.role)}
                    data-role={r.role}
                  >
                    {r.label}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
        {!ok && <div className="notice warn">Выбери хотя бы одну дорожку для правой, левой или обеих рук.</div>}
        <div className="summary-actions">
          <button onClick={onCancel}>Отмена</button>
          <button className="primary" disabled={!ok} onClick={() => onApply(roles)} data-apply>
            Открыть ноты
          </button>
        </div>
      </div>
    </div>
  );
}
