import { useApp } from "../store";

/** Важные сообщения: откат ASIO → WASAPI, занятые устройства, ошибки звука. */
export function Notices() {
  const { audio, devices } = useApp();
  const items: { kind: "warn" | "info"; text: string }[] = [];

  if (audio?.error) items.push({ kind: "warn", text: `Встроенный звук не работает: ${audio.error}` });
  if (audio?.notice) items.push({ kind: "info", text: audio.notice });
  for (const d of devices.inputs) {
    if (d.available && d.error) items.push({ kind: "warn", text: `${d.name}: ${d.error}` });
  }
  if (items.length === 0) return null;

  return (
    <div className="notices">
      {items.map((n, i) => (
        <div key={i} className={`notice ${n.kind}`}>
          {n.text}
        </div>
      ))}
    </div>
  );
}
