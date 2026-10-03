import { useEffect, useRef, useState } from "react";
import { api, type GuitarState, type Instrument, type PitchReading } from "../api";
import { nearestString, stringChoices, TUNING_PRESETS, TUNINGS, sameTuning, tuningLabel } from "../lib/guitar";
import { octaveOf, pitchName, type NoteNaming } from "../lib/notes";

export const IN_TUNE_CENTS = 5;

/** Ноты строя по струнам: приложение само понимает, какую струну дёрнули; настроенные отмечены ✓. */
export function TunerStrings({ target, pitch, naming }: { target: number[]; pitch: PitchReading | null; naming: NoteNaming }) {
  const near = pitch ? nearestString(pitch.hz, target) : null;
  const [done, setDone] = useState<Set<number>>(new Set());
  const key = target.join(",");
  useEffect(() => setDone(new Set()), [key]);
  const ok = !!(near && pitch && pitch.midi === target[near.index] && Math.abs(pitch.cents) <= IN_TUNE_CENTS);
  useEffect(() => {
    if (ok && near && !done.has(near.index)) setDone(new Set([...done, near.index]));
  }, [ok, near, done]);
  return (
    <div className="tuner-strings" data-tuner-target={key} data-tuned={[...done].sort().join(",")}>
      {target.map((m, k) => {
        const active = near?.index === k;
        const here = active && ok;
        return (
          <span key={k} className={`tuner-string${active ? " active" : ""}${here || done.has(k) ? " ok" : ""}`} data-string={k}>
            {pitchName(m, naming)}
            <sub>{octaveOf(m)}</sub>
            {active && near && !here && <small>{near.cents > 0 ? "ниже" : "выше"}</small>}
            {(here || done.has(k)) && <small>✓</small>}
          </span>
        );
      })}
    </div>
  );
}

/** Стрелка тюнера: нота, отклонение в центах. */
export function TunerGauge({ pitch, naming, idle }: { pitch: PitchReading | null; naming: NoteNaming; idle: string }) {
  const inTune = !!pitch && Math.abs(pitch.cents) <= IN_TUNE_CENTS;
  return (
    <>
      <div className="tuner-note">
        {pitch ? (
          <>
            <span className={inTune ? "in-tune" : ""}>{pitchName(pitch.midi, naming)}</span>
            <sub>{octaveOf(pitch.midi)}</sub>
          </>
        ) : (
          <span className="muted tuner-idle">{idle}</span>
        )}
      </div>
      <div className="tuner-gauge">
        <div className="tuner-zone" />
        <div className="tuner-tick" style={{ left: "50%" }} />
        {pitch && <div className={`tuner-needle${inTune ? " in-tune" : ""}`} style={{ left: `${50 + Math.max(-50, Math.min(50, pitch.cents))}%` }} />}
      </div>
      <div className="tuner-scale muted">
        <span>−50</span>
        <span>0</span>
        <span>+50 центов</span>
      </div>
      <div className="tuner-readout muted">
        {pitch ? `${pitch.hz.toFixed(1)} Гц · ${pitch.cents > 0 ? "+" : ""}${Math.round(pitch.cents)} центов` : " "}
      </div>
    </>
  );
}

/** Выбор строя: готовые, свой по струнам, каподастр. */
export function TuningPicker({
  instrument,
  tuning,
  capo,
  naming,
  onChange,
}: {
  instrument: Instrument;
  tuning: number[];
  capo: number;
  naming: NoteNaming;
  onChange: (tuning: number[], capo: number) => void;
}) {
  const presets = TUNING_PRESETS[instrument];
  const preset = presets.find((p) => sameTuning(p.notes, tuning));
  const [custom, setCustom] = useState(!preset);
  const showStrings = custom || !preset;
  return (
    <div className="tuning-picker" data-tuning-picker data-tuning={tuning.join(",")} data-capo={capo}>
      <div className="guitar-row">
        <label>
          Строй
          <select
            value={showStrings ? "custom" : preset!.id}
            onChange={(e) => {
              if (e.target.value === "custom") return setCustom(true);
              setCustom(false);
              onChange(presets.find((p) => p.id === e.target.value)!.notes, capo);
            }}
            data-tuning-select
          >
            {presets.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
            <option value="custom">Свой по струнам…</option>
          </select>
        </label>
        <label>
          Каподастр
          <select value={capo} onChange={(e) => onChange(tuning, Number(e.target.value))} data-capo-select>
            {Array.from({ length: 10 }, (_, k) => (
              <option key={k} value={k}>
                {k ? `${k} лад` : "нет"}
              </option>
            ))}
          </select>
        </label>
      </div>
      {showStrings && (
        <div className="tuning-strings">
          {tuning.map((m, k) => (
            <label key={k} title={`Струна ${tuning.length - k}`}>
              <small className="muted">{tuning.length - k}</small>
              <select
                value={m}
                onChange={(e) => onChange(tuning.map((x, i) => (i === k ? Number(e.target.value) : x)), capo)}
                data-tuning-string={k}
              >
                {stringChoices(instrument, k).map((n) => (
                  <option key={n} value={n}>
                    {pitchName(n, naming)}
                    {octaveOf(n)}
                  </option>
                ))}
              </select>
            </label>
          ))}
        </div>
      )}
      <p className="hint">
        {tuningLabel(tuning, capo, instrument)}
        {!sameTuning(tuning, TUNINGS[instrument]) || capo
          ? ". Табы пьес раскладываются под этот строй; песни Rocksmith с другим строем предложат перестроиться или переложить табы."
          : "."}
      </p>
    </div>
  );
}

/**
 * Настройка под строй пьесы: тюнер со струнами нужного строя (с каподастром — звучащие ноты).
 * «Сохранить как мой строй» запоминает строй и каподастр в настройках гитары.
 */
export function RetunePanel({
  instrument,
  tuning,
  capo,
  naming,
  onSaved,
  onClose,
}: {
  instrument: Instrument;
  tuning: number[];
  capo: number;
  naming: NoteNaming;
  onSaved: () => void;
  onClose: () => void;
}) {
  const [state, setState] = useState<GuitarState | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    const tick = () => void api.guitarState().then((s) => alive.current && setState(s)).catch(() => {});
    tick();
    const id = window.setInterval(tick, 70);
    return () => {
      alive.current = false;
      window.clearInterval(id);
    };
  }, []);
  const target = tuning.map((m) => m + capo);
  const pitch = state?.status.pitch ?? null;
  const save = async () => {
    if (!state) return;
    await api.guitarSet({ ...state.config, instrument, tuning: sameTuning(tuning, TUNINGS[instrument]) ? null : tuning, capo });
    onSaved();
  };
  return (
    <div className="card tuner retune" data-retune>
      <div className="section-row">
        <h2>Настрой {instrument === "bass" ? "бас" : "гитару"}: {tuningLabel(tuning, capo, instrument)}</h2>
        <button className="small" onClick={onClose}>
          Закрыть
        </button>
      </div>
      {capo > 0 && <p className="hint">Сначала поставь каподастр на {capo} лад — тюнер ждёт звучащие ноты с каподастром.</p>}
      <TunerGauge pitch={pitch} naming={naming} idle={state?.config.enabled ? "дёрни открытую струну" : "включи вход на экране «Гитара»"} />
      <TunerStrings target={target} pitch={pitch} naming={naming} />
      <div className="buttons">
        <button className="primary" onClick={() => void save()} disabled={!state} data-retune-save>
          Готово — это мой строй
        </button>
      </div>
    </div>
  );
}
