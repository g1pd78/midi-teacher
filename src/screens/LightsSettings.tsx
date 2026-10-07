import { useEffect, useRef, useState } from "react";
import { api, listen, PADS_DEVICE, type LightsLink, type LightsSettings } from "../api";
import { useLights, usePublishLights } from "../components/LightsBridge";
import { LIGHT, LIGHT_CSS, LIGHT_DIM, signalWord, sysex } from "../lib/lights";
import { fullName, keyboardLayout } from "../lib/notes";
import { useApp } from "../store";

/** Настройки → «Подсветка клавиш»: плата, яркость, проверка, калибровка и предпросмотр огоньков. */
export function LightsSection() {
  const { devices, prefs } = useApp();
  const lights: LightsSettings = devices.lights ?? { enabled: true, port: null, brightness: 25, showPresses: true };
  const [wizard, setWizard] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const save = (next: Partial<LightsSettings>) => void api.setLightsSettings({ ...lights, ...next });
  // Статус радио приходит только с подключённой платы (без платы — из сквозного теста).
  const link = devices.lightsLink ?? null;
  const port = devices.lightsPort ?? (link ? "MIDI Teacher Lights" : null);
  const connected = !!port;
  const how = !link ? "" : link.link === "wired" ? " — по проводу" : link.link === "online" ? " — по радио через свисток" : " — лента не отвечает";

  return (
    <section className="card" data-lights-section data-lights-connected={connected ? "1" : "0"}>
      <h2>Подсветка клавиш</h2>
      <p className="hint">
        Светодиодная лента над клавишами показывает, куда нажимать: следующие клавиши в пьесе (правая рука — голубым, левая —
        янтарным), подсказки тренажёров, звуки аккорда. Нужна плата «MIDI Teacher Lights» (ESP32-S3 по USB) — что купить, как собрать и
        прошить, описано в папке hardware/key-lights проекта.
      </p>
      <div className="field">
        <span>Плата</span>
        <span className="lights-status">
          <span className={!connected ? "chip" : link?.link === "lost" ? "chip warn" : "chip good"} data-lights-status data-lights-link={link?.link ?? "none"}>
            {connected ? `${port}${how}` : "не найдена"}
          </span>
          <label className="switch" title="Включить подсветку">
            <input type="checkbox" checked={lights.enabled} onChange={(e) => save({ enabled: e.target.checked })} data-lights-enabled />
            <span />
          </label>
        </span>
      </div>
      <div className="field">
        <span>Выход</span>
        <select value={lights.port ?? ""} onChange={(e) => save({ port: e.target.value || null })} data-lights-port>
          <option value="">Найти «MIDI Teacher Lights» сам</option>
          {devices.outputs.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <span>Яркость {lights.brightness}%</span>
        <input type="range" min={5} max={60} step={5} value={Math.min(60, lights.brightness)} onChange={(e) => save({ brightness: Number(e.target.value) })} data-lights-brightness />
      </div>
      <label className="check">
        <input type="checkbox" checked={lights.showPresses} onChange={(e) => save({ showPresses: e.target.checked })} data-lights-presses /> Показывать мои
        нажатия (в занятиях — тускло, вне занятий — ярко)
      </label>
      <div className="field">
        <span>Проверка</span>
        <span className="buttons">
          <button
            onClick={() =>
              void api.lightsSend(sysex.test()).then((ok) => setNote(ok ? "Огонёк пробегает по ленте слева направо." : "Плата не отвечает — проверь подключение."))
            }
            disabled={!connected}
            data-lights-test
          >
            ▶ Проверить
          </button>
          <button onClick={() => setWizard(true)} disabled={!connected || wizard} data-lights-calibrate>
            Настроить по клавишам…
          </button>
        </span>
      </div>
      {note && <p className="hint">{note}</p>}
      {connected && <RadioBlock link={link} />}
      {wizard && <Calibration naming={prefs.noteNames} onDone={() => setWizard(false)} />}
      <LightsPreview />
    </section>
  );
}

/** «Без провода»: качество связи, связка свистка с лентой. */
function RadioBlock({ link }: { link: LightsLink | null }) {
  if (!link) {
    return (
      <div className="lights-radio" data-lights-radio="none">
        <b>Без провода</b>
        <p className="hint">
          Плата не сообщает о радио. Чтобы огоньки шли на ленту без провода через свисток, обнови прошивку платы — файл
          MIDI-Teacher-Lights-esp32s3 из той же сборки, что и приложение.
        </p>
      </div>
    );
  }
  const paired = link.link !== "wired";
  const word = signalWord(link.rssi);
  const searching = link.pairing === "searching";
  return (
    <div className="lights-radio" data-lights-radio={link.pairing}>
      <b>Без провода</b>
      {link.link === "online" && (
        <p className="muted" data-lights-quality>
          Сигнал {word ? `${word} (${link.rssi} дБм)` : "неизвестен"} · потери {link.loss}%
          {word === "слабый" || link.loss >= 10 ? " — поставь свисток ближе к пианино или на удлинитель, на виду" : ""}
        </p>
      )}
      {link.link === "lost" && <p className="hint">Лента не отвечает: проверь блок питания ленты и что свисток вставлен в компьютер.</p>}
      <p className="hint">
        Свисток — вторая плата ESP32-S3 в USB компьютера — передаёт огоньки ленте по радио. Чтобы связать: выключи и включи блок
        питания ленты, затем в течение 2 минут нажми «Связать с лентой».
      </p>
      <div className="buttons">
        <button onClick={() => void api.lightsSend(sysex.pair())} disabled={searching} data-lights-pair>
          {paired ? "Связать заново" : "Связать с лентой"}
        </button>
        {paired && (
          <button className="ghost" onClick={() => void api.lightsSend(sysex.unpair())} data-lights-unpair>
            Забыть ленту
          </button>
        )}
      </div>
      {searching && <p className="muted">Ищу ленту…</p>}
      {link.pairing === "done" && <p className="muted">Связано: огоньки идут на ленту по радио.</p>}
      {link.pairing === "notFound" && (
        <p className="hint">Лента не нашлась: выключи и включи её питание и в течение 2 минут нажми «Связать» ещё раз.</p>
      )}
    </div>
  );
}

/** Что горело бы на ленте — полоска огоньков над схемой 88 клавиш. */
export function LightsPreview() {
  const lit = new Map(useLights());
  const keys = keyboardLayout(21, 108);
  return (
    <div className="lights-preview" data-lights-preview={[...lit.keys()].join(",")}>
      <span className="muted">Сейчас на ленте:</span>
      <div className="lights-strip">
        {keys.map((k) => {
          const c = lit.get(k.note);
          const color = c ? (LIGHT_CSS[c % LIGHT_DIM] ?? LIGHT_CSS[LIGHT.neutral]) : undefined;
          return (
            <span
              key={k.note}
              className={`lights-dot${k.black ? " black" : ""}${c ? " on" : ""}`}
              style={{ left: `${(k.x + k.width / 2) * 100}%`, ...(color ? { background: color, color, opacity: c! >= LIGHT_DIM ? 0.45 : 1 } : {}) }}
            />
          );
        })}
      </div>
      {lit.size === 0 && <span className="muted">ничего (огоньки загораются в пьесах, тренажёрах, аккордах и джеме)</span>}
    </div>
  );
}

type Step = { kind: "low" | "high"; led: number } | { kind: "check" };

/** Калибровка: огонёк ставится стрелками над крайними клавишами, затем — нажатие этой клавиши. */
function Calibration({ naming, onDone }: { naming: "solfege" | "latin"; onDone: () => void }) {
  const [step, setStep] = useState<Step>({ kind: "low", led: 0 });
  const low = useRef<{ note: number; led: number } | null>(null);
  const [last, setLast] = useState<number | null>(null);
  const stepRef = useRef(step);
  stepRef.current = step;
  // На проверке над нажатой клавишей горит зелёный огонёк — через общий мост, как у экранной клавиатуры.
  usePublishLights(last !== null ? { [last]: { color: LIGHT_CSS[LIGHT.good] } } : {}, step.kind === "check");

  useEffect(() => {
    if (step.kind !== "check") void api.lightsSend(sysex.pointer(step.led, step.kind === "low" ? LIGHT.left : LIGHT.right));
  }, [step]);
  useEffect(
    () => () => {
      void api.lightsSend(sysex.pointerOff());
    },
    [],
  );

  useEffect(() => {
    let off: (() => void) | null = null;
    let alive = true;
    void listen("midi", (e) => {
      if (e.type !== "noteOn" || e.device === PADS_DEVICE) return;
      const s = stepRef.current;
      if (s.kind === "low") {
        low.current = { note: e.note, led: s.led };
        // 88 клавиш ≈ 1,23 м: на ленте 160 светодиодов/м это около 195 светодиодов.
        setStep({ kind: "high", led: s.led + 195 });
      } else if (s.kind === "high" && low.current) {
        const cal = { lowNote: low.current.note, lowLed: low.current.led, highNote: e.note, highLed: s.led };
        if (cal.highNote <= cal.lowNote) return;
        void api.lightsSend(sysex.calibrate(cal)).then(() => api.lightsSend(sysex.pointerOff()));
        setStep({ kind: "check" });
      } else if (s.kind === "check") {
        setLast(e.note);
      }
    }).then((f) => (alive ? (off = f) : f()));
    return () => {
      alive = false;
      off?.();
    };
  }, []);

  const move = (d: number) => setStep((s) => (s.kind === "check" ? s : { ...s, led: Math.max(0, Math.min(1023, s.led + d)) }));
  return (
    <div className="lights-wizard" data-lights-wizard={step.kind}>
      {step.kind !== "check" ? (
        <>
          <b>{step.kind === "low" ? "Шаг 1. Самая левая клавиша" : "Шаг 2. Самая правая клавиша"}</b>
          <p className="hint">
            Стрелками поставь огонёк ровно над {step.kind === "low" ? "самой левой" : "самой правой"} клавишей пианино, затем нажми эту клавишу.
          </p>
          <div className="buttons">
            <button onClick={() => move(-10)}>« 10</button>
            <button onClick={() => move(-1)}>‹</button>
            <span className="chip">светодиод {step.led}</span>
            <button onClick={() => move(1)}>›</button>
            <button onClick={() => move(10)}>10 »</button>
          </div>
        </>
      ) : (
        <>
          <b>Шаг 3. Проверка</b>
          <p className="hint">Нажми любую клавишу — над ней загорится огонёк. Если промахивается, настрой заново.</p>
          {last !== null && <p className="muted">Нажата: {fullName(last, naming)}</p>}
        </>
      )}
      <div className="buttons">
        <button className={step.kind === "check" ? "primary" : "ghost"} onClick={onDone} data-lights-wizard-done>
          {step.kind === "check" ? "Готово" : "Отмена"}
        </button>
      </div>
    </div>
  );
}
