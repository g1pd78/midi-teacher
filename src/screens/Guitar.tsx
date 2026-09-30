import { useCallback, useEffect, useRef, useState } from "react";
import { api, type Calibration, type GuitarConfig, type GuitarState } from "../api";
import { octaveOf, pitchName } from "../lib/notes";
import { nearestString, TUNINGS } from "../lib/guitar";
import { useApp } from "../store";

const LEVEL_MIN_DB = -60;
const IN_TUNE_CENTS = 5;
const RECORD_SECS = 20;

function pct(db: number): number {
  return Math.max(0, Math.min(100, ((db - LEVEL_MIN_DB) / -LEVEL_MIN_DB) * 100));
}

/** Имя записи: «Гитара 30.09 14-05-33». */
function recordName(instrument: "guitar" | "bass"): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${instrument === "bass" ? "Бас" : "Гитара"} ${p(d.getDate())}.${p(d.getMonth() + 1)} ${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

/** Экран «Гитара»: подключение, прослушивание себя, тюнер, калибровка задержки, запись входа. */
export function Guitar() {
  const naming = useApp((s) => s.prefs.noteNames);
  const audio = useApp((s) => s.audio);
  const [state, setState] = useState<GuitarState | null>(null);
  const [outMs, setOutMs] = useState<number | null>(null);
  const [calib, setCalib] = useState<{ running: boolean; result: Calibration | null; failed: boolean }>({
    running: false,
    result: null,
    failed: false,
  });
  const [error, setError] = useState<string | null>(null);
  // Последние отправленные настройки: опрос не должен затирать то, что только что изменили.
  const pending = useRef<GuitarConfig | null>(null);

  useEffect(() => {
    let alive = true;
    const tick = () =>
      api
        .guitarState()
        .then((s) => {
          if (!alive) return;
          if (pending.current) s = { ...s, config: pending.current };
          setState(s);
        })
        .catch((e) => alive && setError(String(e)));
    void tick();
    const id = window.setInterval(tick, 70);
    const meters = window.setInterval(
      () => void api.getAudioMeters().then((m) => alive && setOutMs(m.outputLatencyMs)).catch(() => {}),
      1000,
    );
    void api.guitarInputs().catch(() => {});
    return () => {
      alive = false;
      window.clearInterval(id);
      window.clearInterval(meters);
    };
  }, []);

  const set = useCallback(
    (patch: Partial<GuitarConfig>) => {
      if (!state) return;
      const next = { ...state.config, ...patch };
      pending.current = next;
      setState({ ...state, config: next });
      api
        .guitarSet(next)
        .catch((e) => setError(String(e)))
        .finally(() => {
          if (pending.current === next) pending.current = null;
        });
    },
    [state],
  );

  if (!state) return <main className="guitar">{error ? <div className="notice warn">{error}</div> : "Загрузка…"}</main>;
  const { config: c, status: st, inputs } = state;
  const input = inputs.find((i) => i.name === c.device);
  const channels = input?.channels ?? st.channels ?? 1;
  const inMs = st.running && st.sampleRate ? (st.bufferFrames / st.sampleRate) * 1000 : null;
  const monitorMs = inMs !== null && outMs !== null ? Math.round(inMs * 2 + outMs) : null;
  const tuning = TUNINGS[c.instrument];
  const pitch = st.pitch;
  const near = pitch ? nearestString(pitch.hz, tuning) : null;
  const rec = st.recording;
  const recording = rec && !rec.path && !rec.error;

  const calibrate = async () => {
    setCalib({ running: true, result: null, failed: false });
    try {
      const r = await api.guitarCalibrate(100, 8);
      setCalib({ running: false, result: r, failed: !r });
    } catch (e) {
      setError(String(e));
      setCalib({ running: false, result: null, failed: true });
    }
  };

  return (
    <main className="guitar" data-guitar>
      <section className="guitar-col">
        <div className="card">
          <div className="section-row">
            <h2>Гитара и бас</h2>
            <span className="segmented">
              <button className={c.instrument === "guitar" ? "on" : ""} onClick={() => set({ instrument: "guitar" })} data-instrument="guitar">
                Гитара
              </button>
              <button className={c.instrument === "bass" ? "on" : ""} onClick={() => set({ instrument: "bass" })} data-instrument="bass">
                Бас
              </button>
            </span>
          </div>
          <label className="toggle">
            <input type="checkbox" checked={c.enabled} onChange={(e) => set({ enabled: e.target.checked })} data-enable />
            Слушать вход
          </label>
          <div className="guitar-row">
            <label>
              Вход
              <select
                value={c.device ?? ""}
                onChange={(e) => set({ device: e.target.value || null, channel: 0 })}
                disabled={!c.enabled}
              >
                <option value="">По умолчанию</option>
                {inputs.map((i) => (
                  <option key={i.name} value={i.name}>
                    {i.name === "ASIO" ? "ASIO — входы драйвера вывода" : i.name}
                  </option>
                ))}
              </select>
            </label>
            {channels > 1 && (
              <label>
                Канал
                <select value={c.channel} onChange={(e) => set({ channel: Number(e.target.value) })} disabled={!c.enabled}>
                  {Array.from({ length: channels }, (_, k) => (
                    <option key={k} value={k}>
                      {k + 1}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <button className="small" onClick={() => void api.guitarInputs().catch((e) => setError(String(e)))}>
              Обновить
            </button>
          </div>
          {c.enabled && st.running && (
            <p className="muted small-text">
              {st.device} · {Math.round(st.sampleRate / 100) / 10} кГц{inMs !== null && st.bufferFrames > 0 && ` · буфер ${st.bufferFrames} (${inMs.toFixed(1)} мс)`}
            </p>
          )}
          {c.enabled && st.error && <div className="notice warn">{st.error}</div>}
          <div className="vu" title="Уровень входа">
            <div className={`vu-bar${st.levelDb > -6 ? " hot" : ""}`} style={{ width: `${pct(st.levelDb)}%` }} />
            <div className="vu-peak" style={{ left: `${pct(st.peakDb)}%` }} />
          </div>
          <div className="guitar-row">
            <label className="grow">
              Усиление
              <input
                type="range"
                min={-12}
                max={18}
                step={1}
                value={Math.round(20 * Math.log10(c.gain))}
                onChange={(e) => set({ gain: 10 ** (Number(e.target.value) / 20) })}
              />
              <b>{Math.round(20 * Math.log10(c.gain))} дБ</b>
            </label>
          </div>
          {st.clipping && <div className="notice warn">Слишком громко — сигнал упирается в предел. Убавь усиление.</div>}
          <p className="hint">
            <b>Real Tone Cable:</b> гитара кабелем в USB, во «Вход» выбери устройство вроде «Rocksmith Guitar Adapter».
            Громкость звукоснимателя на гитаре — на максимум, педали и перегруз — выключи: распознаванию нужен чистый
            сигнал.
          </p>
        </div>

        <div className="card">
          <h2>Слышать себя</h2>
          <label className="toggle">
            <input type="checkbox" checked={c.monitor} onChange={(e) => set({ monitor: e.target.checked })} disabled={!c.enabled} data-monitor />
            Звук гитары в колонках/наушниках
          </label>
          <div className="guitar-row">
            <span className="segmented">
              <button className={c.tone === "clean" ? "on" : ""} onClick={() => set({ tone: "clean" })}>
                Чистый
              </button>
              <button className={c.tone === "drive" ? "on" : ""} onClick={() => set({ tone: "drive" })}>
                Лёгкий перегруз
              </button>
            </span>
            <label className="grow">
              Громкость
              <input type="range" min={0} max={1.5} step={0.05} value={c.monitorVolume} onChange={(e) => set({ monitorVolume: Number(e.target.value) })} />
            </label>
          </div>
          {monitorMs !== null && (
            <p className={monitorMs > 25 ? "notice info" : "muted small-text"}>
              Задержка прослушивания ≈ {monitorMs} мс (вывод: {audio?.backend ?? "?"}).
              {monitorMs > 25 &&
                " Заметно? Включи вывод звука через ASIO (FlexASIO или ASIO4ALL) в «Настройки → Устройства и звук» и выбери здесь вход «ASIO» — задержка станет 5–10 мс."}
            </p>
          )}
          <p className="hint">Перегруз — только для слуха: ноты приложение слушает по чистому сигналу.</p>
        </div>
      </section>

      <section className="guitar-col">
        <div className="card tuner" data-midi={pitch?.midi ?? ""} data-cents={pitch ? Math.round(pitch.cents) : ""}>
          <h2>Тюнер</h2>
          <div className="tuner-note">
            {pitch ? (
              <>
                <span className={Math.abs(pitch.cents) <= IN_TUNE_CENTS ? "in-tune" : ""}>{pitchName(pitch.midi, naming)}</span>
                <sub>{octaveOf(pitch.midi)}</sub>
              </>
            ) : (
              <span className="muted tuner-idle">{c.enabled || st.running ? "сыграй открытую струну" : "включи «Слушать вход»"}</span>
            )}
          </div>
          <div className="tuner-gauge">
            <div className="tuner-zone" />
            <div className="tuner-tick" style={{ left: "50%" }} />
            {pitch && (
              <div
                className={`tuner-needle${Math.abs(pitch.cents) <= IN_TUNE_CENTS ? " in-tune" : ""}`}
                style={{ left: `${50 + Math.max(-50, Math.min(50, pitch.cents))}%` }}
              />
            )}
          </div>
          <div className="tuner-scale muted">
            <span>−50</span>
            <span>0</span>
            <span>+50 центов</span>
          </div>
          <div className="tuner-readout muted">
            {pitch ? `${pitch.hz.toFixed(1)} Гц · ${pitch.cents > 0 ? "+" : ""}${Math.round(pitch.cents)} центов` : " "}
          </div>
          <div className="tuner-strings">
            {tuning.map((m, k) => {
              const active = near?.index === k;
              const ok = active && pitch && pitch.midi === m && Math.abs(pitch.cents) <= IN_TUNE_CENTS;
              return (
                <span key={k} className={`tuner-string${active ? " active" : ""}${ok ? " ok" : ""}`} data-string={k}>
                  {pitchName(m, naming)}
                  <sub>{octaveOf(m)}</sub>
                  {active && near && !ok && <small>{near.cents > 0 ? "ниже" : "выше"}</small>}
                  {ok && <small>✓</small>}
                </span>
              );
            })}
          </div>
          <p className="hint">
            Стандартный строй: {c.instrument === "bass" ? "Ми Ля Ре Соль (4 струны)" : "Ми Ля Ре Соль Си Ми (6 струн)"}. Под струной
            подсказка: «выше» — подтяни колок, «ниже» — отпусти.
          </p>
        </div>

        <div className="card">
          <h2>Калибровка задержки</h2>
          <p className="hint">
            Приложение сыграет 8 щелчков. На каждый ударь по заглушённой струне (ладонь на струнах). Так приложение узнает,
            насколько звук с гитары приходит позже, и будет точно оценивать ритм.
          </p>
          <div className="guitar-row">
            <button className="primary" disabled={!st.running || calib.running} onClick={() => void calibrate()} data-calibrate>
              {calib.running ? "Щелчки… бей на каждый" : "▶ Начать"}
            </button>
            <span className="muted">
              Сейчас: {c.latencyMs !== null ? `${Math.round(c.latencyMs)} мс` : "не откалибровано"}
            </span>
          </div>
          {calib.result && (
            <div className={calib.result.spreadMs > 30 ? "notice warn" : "notice info"}>
              Задержка входа {Math.round(calib.result.offsetMs)} мс, разброс ±{Math.round(calib.result.spreadMs)} мс (попаданий{" "}
              {calib.result.matched} из {calib.result.total}).
              {calib.result.spreadMs > 30 ? " Большой разброс — попробуй ещё раз, ровнее." : ""}
              <span className="buttons">
                <button className="small primary" onClick={() => set({ latencyMs: calib.result!.offsetMs })}>
                  Сохранить
                </button>
              </span>
            </div>
          )}
          {calib.failed && <div className="notice warn">Удары не услышаны. Проверь уровень входа и бей чуть сильнее.</div>}
        </div>

        <div className="card">
          <h2>Запись для проверки</h2>
          <p className="hint">
            Запиши {RECORD_SECS} секунд: открытые струны по очереди, гамму, любой рифф. Пришли файл — по нему я настрою
            распознавание нот под твою гитару и кабель.
          </p>
          <div className="guitar-row">
            {recording ? (
              <>
                <div className="vu grow">
                  <div className="vu-bar rec" style={{ width: `${(rec!.elapsedSec / rec!.totalSec) * 100}%` }} />
                </div>
                <button className="small" onClick={() => void api.guitarStopRecord()}>
                  ■ Стоп
                </button>
              </>
            ) : (
              <button
                disabled={!st.running}
                onClick={() => void api.guitarRecord(recordName(c.instrument), RECORD_SECS).catch((e) => setError(String(e)))}
                data-guitar-record
              >
                ● Записать {RECORD_SECS} с
              </button>
            )}
          </div>
          {rec?.path && (
            <div className="notice info">
              Сохранено: <code>{rec.path}</code>{" "}
              <button className="small" onClick={() => void api.libraryOpenFolder()}>
                Открыть папку
              </button>
            </div>
          )}
          {rec?.error && <div className="notice warn">{rec.error}</div>}
        </div>
        {error && <div className="notice warn">{error}</div>}
      </section>
    </main>
  );
}
