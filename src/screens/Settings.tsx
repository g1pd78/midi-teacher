import { useEffect, useState } from "react";
import {
  api,
  exportBackup,
  importBackup,
  openUrl,
  pickSoundfont,
  type AudioBackend,
  type AudioMeters,
  type InputInfo,
  type SoundRoute,
} from "../api";
import { Notices } from "../components/Notices";
import { fullName, keyLabel } from "../lib/notes";
import { deviceColor, useApp, useMidi } from "../store";

const FLEXASIO_URL = "https://github.com/dechamps/FlexASIO/releases";

function routeValue(r: SoundRoute): string {
  return r.kind === "output" ? `output:${r.port}` : r.kind;
}

function parseRoute(v: string): SoundRoute {
  if (v.startsWith("output:")) return { kind: "output", port: v.slice(7) };
  return { kind: v as "internal" | "silent" };
}

export function Settings() {
  return (
    <main className="settings">
      <Notices />
      <div className="settings-grid">
        <div className="settings-col">
          <InputsSection />
          <AppSoundSection />
          <InterfaceSection />
        </div>
        <div className="settings-col">
          <SynthSection />
          <MonitorSection />
          <BackupSection />
          <AboutSection />
        </div>
      </div>
    </main>
  );
}

function InputsSection() {
  const { devices } = useApp();
  return (
    <section className="card">
      <h2>MIDI-входы</h2>
      <p className="hint">Все инструменты подключаются сами. Для каждого выбери, откуда брать звук.</p>
      {devices.inputs.length === 0 && <p className="muted">Ничего не найдено. Подключи инструмент по USB.</p>}
      {devices.inputs.map((d) => (
        <InputRow key={d.name} input={d} />
      ))}
    </section>
  );
}

function InputRow({ input }: { input: InputInfo }) {
  const { devices, prefs } = useApp();
  const [calibrating, setCalibrating] = useState<null | { low?: number }>(null);
  const s = input.settings;
  const update = (patch: Partial<typeof s>) => void api.setInput(input.name, { ...s, ...patch });

  useMidi((ev) => {
    if (!calibrating || ev.type !== "noteOn" || ev.device !== input.name) return;
    if (calibrating.low === undefined) setCalibrating({ low: ev.note });
    else {
      update({ range: [Math.min(calibrating.low, ev.note), Math.max(calibrating.low, ev.note)] });
      setCalibrating(null);
    }
  });

  const status = !input.available
    ? { text: "не подключено", cls: "off" }
    : input.error
      ? { text: "ошибка", cls: "warn" }
      : input.connected
        ? { text: "подключено", cls: "on" }
        : { text: "выключено", cls: "off" };

  return (
    <div className="device-row">
      <div className="device-head">
        <span className="dot" style={{ background: deviceColor(input.name, devices) }} />
        <span className="device-name">{input.name}</span>
        <span className={`status ${status.cls}`}>{status.text}</span>
        <label className="switch" title="Использовать это устройство">
          <input type="checkbox" checked={s.enabled} onChange={(e) => update({ enabled: e.target.checked })} />
          <span />
        </label>
      </div>
      {input.error && <div className="device-error">{input.error}</div>}
      <div className="field">
        <span>Звук</span>
        <select value={routeValue(s.route)} onChange={(e) => update({ route: parseRoute(e.target.value) })}>
          <option value="silent">Звучит само (цифровое пианино)</option>
          <option value="internal">Встроенный синтезатор</option>
          {devices.outputs.map((o) => (
            <option key={o} value={`output:${o}`}>
              Через {o}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <span>Диапазон</span>
        {calibrating ? (
          <span className="calibrate">
            Нажми {calibrating.low === undefined ? "самую левую" : "самую правую"} клавишу…{" "}
            <button className="link" onClick={() => setCalibrating(null)}>
              отмена
            </button>
          </span>
        ) : (
          <span>
            {s.range
              ? `${keyLabel(s.range[0], prefs.noteNames)} – ${keyLabel(s.range[1], prefs.noteNames)} (${s.range[1] - s.range[0] + 1} клавиш)`
              : "не задан"}{" "}
            <button className="link" onClick={() => setCalibrating({})} disabled={!input.connected}>
              определить
            </button>
          </span>
        )}
      </div>
    </div>
  );
}

function AppSoundSection() {
  const { devices } = useApp();
  return (
    <section className="card">
      <h2>Звук приложения</h2>
      <p className="hint">
        Экранная клавиатура, вторая рука в пьесах, «Слушать» и аккомпанемент. Метроном всегда звучит из компьютера.
      </p>
      <div className="field">
        <span>Куда</span>
        <select
          value={routeValue(devices.appRoute)}
          onChange={(e) => void api.setAppRoute(parseRoute(e.target.value), devices.appChannel)}
        >
          <option value="internal">Встроенный синтезатор</option>
          {devices.outputs.map((o) => (
            <option key={o} value={`output:${o}`}>
              Через {o}
            </option>
          ))}
          <option value="silent">Без звука</option>
        </select>
      </div>
      {devices.appRoute.kind === "output" && (
        <div className="field">
          <span>MIDI-канал</span>
          <select
            value={devices.appChannel}
            onChange={(e) => void api.setAppRoute(devices.appRoute, Number(e.target.value))}
          >
            {Array.from({ length: 16 }, (_, i) => (
              <option key={i} value={i}>
                {i + 1}
              </option>
            ))}
          </select>
        </div>
      )}
      <div className="field">
        <span>Проверка</span>
        <span>
          <button onClick={() => void testAppSound()}>▶ Проверить звук</button>{" "}
          <span className="muted">до–ми–соль–до так, как звучит вторая рука</span>
        </span>
      </div>
    </section>
  );
}

/** Арпеджио через «звук приложения» с той же силой нажатия, что у второй руки. */
async function testAppSound() {
  for (const note of [60, 64, 67, 72]) {
    await api.playNote(note, 70, true);
    await new Promise((r) => setTimeout(r, 280));
    await api.playNote(note, 0, false);
  }
}

function SynthSection() {
  const { audio, audioConfig, audioDevices, setAudioConfig, refreshAudioDevices, customSoundfont, devices } = useApp();
  const [meters, setMeters] = useState<AudioMeters | null>(null);
  const [sfBusy, setSfBusy] = useState<string | null>(null);

  useEffect(() => {
    void refreshAudioDevices();
    const id = setInterval(() => void api.getAudioMeters().then(setMeters), 500);
    return () => clearInterval(id);
  }, [refreshAudioDevices]);

  const deviceList = audio?.backend === "ASIO" ? audioDevices.asio : audioDevices.system;
  const loadSf = async (path: string | null) => {
    setSfBusy("Загрузка SoundFont…");
    try {
      await api.loadSoundfont(path);
      setSfBusy(null);
    } catch (e) {
      setSfBusy(`Ошибка: ${e}`);
    }
  };

  return (
    <section className="card">
      <h2>Встроенный синтезатор</h2>
      {audio && (
        <div className="stats">
          <Stat label="Состояние" value={audio.suspended ? "отдыхает" : audio.running ? "работает" : "остановлен"} />
          <Stat label="Вывод" value={audio.backend || "—"} />
          <Stat label="Устройство" value={audio.device || "—"} wide />
          <Stat label="Частота" value={audio.sampleRate ? `${audio.sampleRate} Гц` : "—"} />
          <Stat label="Буфер" value={meters?.lastCallbackFrames ? `${meters.lastCallbackFrames} сэмплов` : "—"} />
          <Stat
            label="Задержка вывода"
            value={meters && audio.running ? `${meters.outputLatencyMs.toFixed(1)} мс` : "—"}
            accent={meters && audio.running ? latencyClass(meters.outputLatencyMs) : undefined}
          />
          <Stat label="Прерывания звука" value={meters ? String(meters.xruns) : "—"} />
          <Stat label="Нот сыграно" value={meters ? String(meters.notesPlayed) : "—"} />
          <div className="stat">
            <div className="stat-label">Уровень</div>
            <div className="vu synth-vu" title="Пиковый уровень звука, который уходит в колонки/наушники">
              <div className="vu-bar" style={{ width: `${Math.round(Math.min(1, Math.sqrt(meters?.level ?? 0)) * 100)}%` }} />
            </div>
          </div>
          <Stat label="Звук рояля" value={audio.synth || "—"} wide />
          <Stat label="Аккомпанемент (GM)" value={audio.gm ?? "не загружен — аккомпанемент MIDI звучит роялем"} wide />
        </div>
      )}
      {audio?.suspended && (
        <p className="hint">
          Сейчас весь звук идёт через инструменты, поэтому аудиоустройство освобождено. Синтезатор включится сам, когда
          понадобится.
        </p>
      )}
      {!devices.internalSoundNeeded && !audio?.suspended && <p className="hint">Встроенный звук сейчас не используется.</p>}

      <div className="field">
        <span>Бэкенд</span>
        <select
          value={audioConfig.backend}
          onChange={(e) => setAudioConfig({ backend: e.target.value as AudioBackend, device: null })}
        >
          <option value="auto">Авто (ASIO, если есть)</option>
          <option value="asio" disabled={!audio?.asioSupported}>
            ASIO
          </option>
          <option value="system">WASAPI (системный)</option>
        </select>
      </div>
      <div className="field">
        <span>Устройство</span>
        <select value={audioConfig.device ?? ""} onChange={(e) => setAudioConfig({ device: e.target.value || null })}>
          <option value="">По умолчанию</option>
          {deviceList.map((d) => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <span>Размер буфера</span>
        <select
          value={audioConfig.bufferFrames ?? 0}
          onChange={(e) => setAudioConfig({ bufferFrames: Number(e.target.value) || null })}
        >
          {[32, 64, 128, 256, 512].map((n) => (
            <option key={n} value={n}>
              {n} сэмплов{n === 128 ? " (рекомендуется)" : ""}
            </option>
          ))}
          <option value={0}>Как решит драйвер</option>
        </select>
      </div>
      <div className="field">
        <span>Громкость</span>
        <input
          type="range"
          min={0}
          max={1.5}
          step={0.05}
          value={audioConfig.volume}
          onChange={(e) => setAudioConfig({ volume: Number(e.target.value) })}
        />
      </div>
      <div className="field">
        <span>Звук рояля</span>
        <span className="buttons">
          <button onClick={() => void loadSf(null)}>Встроенный</button>
          <button
            onClick={async () => {
              const p = await pickSoundfont();
              if (p) await loadSf(p);
            }}
          >
            Свой .sf2…
          </button>
          <button onClick={() => void api.useFallbackSynth()}>Простой синтез</button>
        </span>
      </div>
      {customSoundfont && <p className="hint">Свой SoundFont: {customSoundfont}</p>}
      {audio?.synth.includes("YDP") && (
        <p className="hint">YDP Grand Piano © Roberto Gordo Saez (FreePats), лицензия CC BY 3.0.</p>
      )}
      {sfBusy && <p className="hint">{sfBusy}</p>}

      {audio?.asioSupported && audioDevices.asio.length === 0 && (
        <div className="notice info">
          ASIO-драйвер не найден. Для минимальной задержки установи бесплатный FlexASIO{" "}
          <button className="link" onClick={() => void openUrl(FLEXASIO_URL)}>
            (скачать)
          </button>
          , затем выбери «Авто» или «ASIO».
        </div>
      )}
      <p className="hint">
        ASIO обычно занимает звуковую карту целиком: пока приложение играет встроенным звуком, другие программы могут
        молчать.
      </p>
    </section>
  );
}

function latencyClass(ms: number): string {
  return ms <= 10 ? "good" : ms <= 20 ? "ok" : "bad";
}

function Stat({ label, value, wide, accent }: { label: string; value: string; wide?: boolean; accent?: string }) {
  return (
    <div className={`stat${wide ? " wide" : ""}`}>
      <div className="stat-label">{label}</div>
      <div className={`stat-value ${accent ?? ""}`}>{value}</div>
    </div>
  );
}

function InterfaceSection() {
  const { prefs, setPrefs } = useApp();
  return (
    <section className="card">
      <h2>Интерфейс</h2>
      <div className="field">
        <span>Названия нот</span>
        <span className="segmented">
          <button className={prefs.noteNames === "solfege" ? "on" : ""} onClick={() => setPrefs({ noteNames: "solfege" })}>
            До-Ре-Ми
          </button>
          <button className={prefs.noteNames === "latin" ? "on" : ""} onClick={() => setPrefs({ noteNames: "latin" })}>
            C-D-E
          </button>
        </span>
      </div>
      <div className="field">
        <span>Мастер подключения</span>
        <button onClick={() => setPrefs({ wizardDone: false })}>Запустить заново</button>
      </div>
    </section>
  );
}

function MonitorSection() {
  const { log, prefs, devices } = useApp();
  return (
    <section className="card monitor">
      <h2>MIDI-монитор</h2>
      <p className="hint">Последние сообщения с инструментов — для проверки, что всё доходит.</p>
      <div className="log">
        {log.length === 0 && <div className="muted">Пока тихо. Нажми клавишу.</div>}
        {log.map((ev, i) => {
          const next = log[i + 1];
          const dt = next ? ((ev.timeUs - next.timeUs) / 1000).toFixed(1) : "";
          return (
            <div key={`${ev.timeUs}-${i}`} className="log-row">
              <span className="dot" style={{ background: deviceColor(ev.device, devices) }} />
              <span className="log-dev">{ev.device}</span>
              <span className="log-msg">
                {ev.type === "noteOn" && `▼ ${fullName(ev.note, prefs.noteNames)} · ${ev.velocity}`}
                {ev.type === "noteOff" && `▲ ${fullName(ev.note, prefs.noteNames)}`}
                {ev.type === "controlChange" &&
                  (ev.controller === 64 ? `педаль ${ev.value >= 64 ? "нажата" : "отпущена"}` : `CC${ev.controller} = ${ev.value}`)}
              </span>
              <span className="log-dt">{dt && `+${dt} мс`}</span>
            </div>
          );
        })}
      </div>
    </section>
  );
}

const BUILDS_URL = "https://github.com/g1pd78/midi-teacher/actions/workflows/ci.yml?query=branch%3Aclaude%2Fpiano-learning-app-mmhm6f";

/** Резервная копия: настройки, прогресс и треки студии — в один файл и обратно. */
function BackupSection() {
  const [msg, setMsg] = useState<string | null>(null);
  const [restart, setRestart] = useState(false);
  const save = async () => {
    try {
      const r = await exportBackup();
      if (!r) return;
      setMsg(`Сохранено: ${r.path} (прогресс ${r.info.progress ? "есть" : "нет"}, треков студии: ${r.info.songs}).`);
    } catch (e) {
      setMsg(`Не сохранено: ${e}`);
    }
  };
  const load = async () => {
    if (!window.confirm("Восстановить из резервной копии? Текущие настройки и прогресс будут заменены копией после перезапуска.")) return;
    try {
      const info = await importBackup();
      if (!info) return;
      const date = new Date(info.created * 1000).toLocaleString("ru-RU");
      setMsg(`Копия от ${date} готова к восстановлению: треков студии ${info.songs}. Настройки и прогресс заменятся после перезапуска.`);
      setRestart(info.settings || info.progress);
    } catch (e) {
      setMsg(`Не восстановлено: ${e}`);
    }
  };
  return (
    <section className="card" data-backup>
      <h2>Резервная копия</h2>
      <p className="hint">
        Настройки, прогресс (тренажёр, пьесы, упражнения, барабаны) и треки студии — в один файл. Пригодится при
        переустановке или на втором компьютере. Свои ноты и записи лежат в «{"Документы\\MIDI Teacher"}» — их копируй как
        обычную папку.
      </p>
      <div className="studio-actions">
        <button onClick={() => void save()} data-backup-save>
          Сохранить копию…
        </button>
        <button onClick={() => void load()} data-backup-load>
          Восстановить…
        </button>
        {restart && (
          <button className="primary" onClick={() => void api.restartApp()}>
            Перезапустить сейчас
          </button>
        )}
      </div>
      {msg && (
        <p className="hint" data-backup-msg>
          {msg}
        </p>
      )}
    </section>
  );
}

/** Версия: из какого коммита собрано приложение, и где брать новые сборки. */
function AboutSection() {
  const sha = __BUILD_SHA__;
  const date = new Date(__BUILD_DATE__);
  return (
    <section className="card" data-about data-build={sha}>
      <h2>О программе</h2>
      <div className="stats">
        <Stat label="Сборка" value={sha.slice(0, 7)} />
        <Stat label="Дата сборки" value={date.toLocaleDateString("ru-RU")} />
      </div>
      <p className="hint">
        Новые сборки появляются после каждого обновления: страница сборок → последний запуск с зелёной галочкой →
        «Artifacts». Номер сборки там — первые символы коммита (как здесь).
      </p>
      <button onClick={() => void openUrl(BUILDS_URL)} data-builds>
        Открыть страницу сборок
      </button>
    </section>
  );
}

