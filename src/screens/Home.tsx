import { Piano } from "../components/Piano";
import { Notices } from "../components/Notices";
import { fullName, keyLabel } from "../lib/notes";
import { deviceColor, useApp } from "../store";

const SECTIONS = [
  { title: "Тренажёр нот", text: "Учимся узнавать ноты на нотном стане", stage: "Этап 1" },
  { title: "Пьесы", text: "Интерактивный нотный стан и разучивание", stage: "Этап 2" },
  { title: "Упражнения", text: "Гаммы, арпеджио, пять пальцев", stage: "Этап 5" },
  { title: "Справочник", text: "Длительности, знаки, ключи", stage: "Этап 5" },
  { title: "Прогресс", text: "Статистика занятий", stage: "Этап 4" },
];

export function Home() {
  const { held, lastNote, devices, prefs, pressScreenKey, sustain } = useApp();
  const naming = prefs.noteNames;

  const highlight = Object.fromEntries(
    Object.entries(held).map(([note, h]) => [
      note,
      { color: deviceColor(h.device, devices), strength: 0.55 + (0.45 * h.velocity) / 127 },
    ]),
  );
  const chord = Object.keys(held)
    .map(Number)
    .sort((a, b) => a - b);

  return (
    <main className="home">
      <Notices />
      <section className="now card">
        {lastNote ? (
          <>
            <div className="now-name">{fullName(lastNote.note, naming)}</div>
            <div className="now-meta">
              <span>{keyLabel(lastNote.note, naming === "solfege" ? "latin" : "solfege")}</span>
              <span className="sep">·</span>
              <span>сила {lastNote.velocity}</span>
              <span className="sep">·</span>
              <span style={{ color: deviceColor(lastNote.device, devices) }}>{lastNote.device}</span>
              {sustain && (
                <>
                  <span className="sep">·</span>
                  <span className="pedal">педаль</span>
                </>
              )}
            </div>
            <div className="velocity">
              <div className="velocity-bar" style={{ width: `${(lastNote.velocity / 127) * 100}%` }} />
            </div>
            <div className="chord">
              {chord.map((n) => (
                <span key={n} className="chip small">
                  {keyLabel(n, naming)}
                </span>
              ))}
            </div>
          </>
        ) : (
          <>
            <div className="now-name muted">Нажми любую клавишу</div>
            <div className="now-meta">
              {devices.inputs.some((d) => d.connected)
                ? "На пианино, MIDI-клавиатуре или прямо на экране"
                : "Подключи пианино или MIDI-клавиатуру по USB, приложение найдёт их само"}
            </div>
          </>
        )}
      </section>

      <section className="sections">
        {SECTIONS.map((s) => (
          <div key={s.title} className="section-tile disabled" aria-disabled>
            <div className="section-title">{s.title}</div>
            <div className="section-text">{s.text}</div>
            <div className="section-stage">Скоро · {s.stage}</div>
          </div>
        ))}
      </section>

      <section className="home-piano">
        <Piano naming={naming} highlight={highlight} onPress={pressScreenKey} />
      </section>
    </main>
  );
}
