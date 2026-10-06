import { useRef, useState } from "react";
import { api, openUrl, type InputInfo, type SoundRoute } from "../api";
import { Piano } from "../components/Piano";
import { fullName } from "../lib/notes";
import { deviceColor, useApp, useMidi } from "../store";

type Step = "piano" | "keyboard" | "hear" | "range" | "done";

const FLEXASIO_URL = "https://github.com/dechamps/FlexASIO/releases";

interface RangeState {
  device: string;
  phase: "low" | "high";
  low?: number;
}

export function Wizard() {
  const { devices, held, prefs, setPrefs, audio, audioDevices, pressScreenKey } = useApp();
  const [step, setStep] = useState<Step>("piano");
  const [piano, setPiano] = useState<string | null>(null);
  const [pianoOut, setPianoOut] = useState<string | null>(null);
  const [keyboard, setKeyboard] = useState<string | null>(null);
  const [ranges, setRanges] = useState<RangeState[]>([]);
  // Маршруты, выбранные в мастере: снимок устройств с ядра приходит асинхронно.
  const chosen = useRef<Record<string, SoundRoute>>({});

  const info = (name: string | null): InputInfo | undefined => devices.inputs.find((d) => d.name === name);

  const setRoute = (name: string, route: SoundRoute, range?: [number, number] | null) => {
    chosen.current[name] = route;
    const current = info(name)?.settings ?? { enabled: true, route, range: null };
    void api.setInput(name, { ...current, route, range: range === undefined ? current.range : range });
  };

  const startRanges = (list: (string | null)[]) => {
    const queue = list.filter((d): d is string => !!d).map((device) => ({ device, phase: "low" as const }));
    setRanges(queue);
    setStep(queue.length ? "range" : "done");
  };

  const chooseKeyboard = (name: string | null) => {
    setKeyboard(name);
    if (name) {
      const route: SoundRoute = pianoOut ? { kind: "output", port: pianoOut } : { kind: "internal" };
      setRoute(name, route);
    }
    void api.setAppRoute(pianoOut ? { kind: "output", port: pianoOut } : { kind: "internal" }, 0);
    if (name && pianoOut) setStep("hear");
    else startRanges([name, piano]);
  };

  useMidi((ev) => {
    if (ev.type !== "noteOn") return;
    if (step === "piano") {
      const out = info(ev.device)?.matchingOutput ?? null;
      setPiano(ev.device);
      setPianoOut(out);
      setRoute(ev.device, { kind: "silent" });
      setStep("keyboard");
    } else if (step === "keyboard" && ev.device !== piano) {
      chooseKeyboard(ev.device);
    } else if (step === "range" && ranges[0]?.device === ev.device) {
      const [cur, ...rest] = ranges;
      if (cur.phase === "low") {
        setRanges([{ ...cur, phase: "high", low: ev.note }, ...rest]);
      } else {
        const lo = Math.min(cur.low!, ev.note);
        const hi = Math.max(cur.low!, ev.note);
        setRoute(cur.device, chosen.current[cur.device] ?? info(cur.device)?.settings.route ?? { kind: "internal" }, [lo, hi]);
        setRanges(rest);
        if (rest.length === 0) setStep("done");
      }
    }
  });

  const finish = () => setPrefs({ wizardDone: true });

  const highlight = Object.fromEntries(
    Object.entries(held).map(([n, h]) => [n, { color: deviceColor(h.device, devices) }]),
  );
  // Подсказка про ASIO нужна, только если что-то будет звучать встроенным синтезатором.
  const usesInternal =
    Object.values(chosen.current).some((r) => r.kind === "internal") || devices.appRoute.kind === "internal";
  const needsAsioHint = audio?.asioSupported && audioDevices.asio.length === 0 && usesInternal;
  const connected = devices.inputs.filter((d) => d.connected);

  return (
    <div className="wizard">
      <div className="wizard-card card">
        <div className="wizard-progress">
          {(["piano", "keyboard", "range", "done"] as const).map((s, i) => (
            <span key={s} className={stepIndex(step) >= i ? "dot on" : "dot"} />
          ))}
        </div>

        {step === "piano" && (
          <>
            <h1>Подключим инструменты</h1>
            <p className="lead">Нажми любую клавишу на <b>цифровом пианино</b>.</p>
            <DeviceList inputs={connected} />
            <div className="wizard-actions">
              <button className="ghost" onClick={() => setStep("keyboard")}>
                У меня нет цифрового пианино
              </button>
            </div>
          </>
        )}

        {step === "keyboard" && (
          <>
            <h1>Теперь MIDI-клавиатура</h1>
            {piano && (
              <p className="found">
                Пианино: <b>{piano}</b>
                {pianoOut ? " — звучит само, через него же будет звучать клавиатура." : " — выход не найден, звук клавиатуры пойдёт из компьютера."}
              </p>
            )}
            <p className="lead">Нажми любую клавишу на <b>MIDI-клавиатуре</b>.</p>
            <div className="wizard-actions">
              <button className="ghost" onClick={() => chooseKeyboard(null)}>
                У меня только пианино
              </button>
            </div>
          </>
        )}

        {step === "hear" && (
          <>
            <h1>Проверим звук</h1>
            <p className="lead">
              Поиграй на <b>{keyboard}</b>. Звук идёт из пианино <b>{piano}</b>?
            </p>
            <p className="hint">Если не слышно: проверь громкость пианино.</p>
            <div className="wizard-actions">
              <button className="primary" onClick={() => startRanges([keyboard, piano])}>
                Да, слышно
              </button>
              <button
                className="ghost"
                onClick={() => {
                  if (keyboard) setRoute(keyboard, { kind: "internal" });
                  void api.setAppRoute({ kind: "internal" }, 0);
                  startRanges([keyboard, piano]);
                }}
              >
                Нет, пусть звучит из компьютера
              </button>
            </div>
          </>
        )}

        {step === "range" && ranges[0] && (
          <>
            <h1>Размер клавиатуры</h1>
            <p className="lead">
              На <b style={{ color: deviceColor(ranges[0].device, devices) }}>{ranges[0].device}</b> нажми{" "}
              <b>{ranges[0].phase === "low" ? "самую левую" : "самую правую"}</b> клавишу.
            </p>
            {ranges[0].low !== undefined && (
              <p className="found">Самая левая: {fullName(ranges[0].low, prefs.noteNames)}</p>
            )}
            <p className="hint">Так приложение предупредит, если пьеса не помещается на клавиатуре.</p>
            <div className="wizard-actions">
              <button
                className="ghost"
                onClick={() => {
                  const rest = ranges.slice(1);
                  setRanges(rest);
                  if (rest.length === 0) setStep("done");
                }}
              >
                Пропустить
              </button>
            </div>
          </>
        )}

        {step === "done" && (
          <>
            <h1>Готово</h1>
            <ul className="summary">
              {piano && (
                <li>
                  Пианино <b>{piano}</b>: звучит само
                </li>
              )}
              {keyboard && (
                <li>
                  MIDI-клавиатура <b>{keyboard}</b>:{" "}
                  {chosen.current[keyboard]?.kind === "output" ? "звучит через пианино" : "звук из компьютера"}
                </li>
              )}
              {devices.inputs
                .filter((d) => d.settings.range)
                .map((d) => (
                  <li key={d.name}>
                    {d.name}: {d.settings.range![1] - d.settings.range![0] + 1} клавиш
                  </li>
                ))}
            </ul>
            {needsAsioHint && (
              <div className="notice info">
                Для быстрого звука из компьютера нужен ASIO-драйвер. Бесплатный вариант — FlexASIO.{" "}
                <button className="link" onClick={() => void openUrl(FLEXASIO_URL)}>
                  Скачать FlexASIO
                </button>
                . Без него звук тоже работает, но с небольшой задержкой.
              </div>
            )}
            <p className="hint">Всё это можно поменять в разделе «Устройства и звук».</p>
            <div className="wizard-actions">
              <button className="primary" onClick={finish}>
                Начать
              </button>
            </div>
          </>
        )}
      </div>

      <div className="wizard-piano">
        <Piano naming={prefs.noteNames} highlight={highlight} onPress={pressScreenKey} lights={false} />
      </div>
    </div>
  );
}

function stepIndex(step: Step): number {
  return { piano: 0, keyboard: 1, hear: 1, range: 2, done: 3 }[step];
}

function DeviceList({ inputs }: { inputs: InputInfo[] }) {
  if (inputs.length === 0)
    return <p className="hint">Пока ничего не подключено. Подключи инструмент по USB — он появится здесь сам.</p>;
  return (
    <p className="hint">
      Подключено: {inputs.map((d) => d.name).join(", ")}
    </p>
  );
}
