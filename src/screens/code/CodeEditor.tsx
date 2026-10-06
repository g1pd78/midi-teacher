import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api, inTauri, listen, PADS_DEVICE } from "../../api";
import { Piano } from "../../components/Piano";
import { chordName, type Chord } from "../../lib/chords";
import { classify, highlightPcs, jamTips, type JamStats } from "../../lib/jam";
import { LiveCode } from "../../lib/strudel/engine";
import type { CodeNote } from "../../lib/strudel/haps";
import { chordFromNotes, chordFromValue, estimateKey, keyPcs, parseScale, type Key } from "../../lib/strudel/harmony";
import { YouJudge, judgeTips, type JudgeSummary } from "../../lib/strudel/judge";
import { feedLive, liveMonitor, onLive } from "../../lib/strudel/live";
import { evalInfo, partLabel, type EvalInfo, type PanelSettings } from "../../lib/strudel/mt";
import { useApp } from "../../store";

export interface CodePanel extends PanelSettings {
  /** Подсветка звуков аккорда и лада для импровизации. */
  improv?: boolean;
  /** Засчитывать ноту «моей партии» в любой октаве. */
  anyOctave?: boolean;
}

export interface CodeEditorHandle {
  live: LiveCode;
  evaluate: () => Promise<void>;
  stop: () => void;
  code: () => string;
  setCode: (code: string) => void;
  summary: () => JudgeSummary;
  /** Мои нажатия за последний запуск (в циклах от начала) — для WAV «с моей игрой». */
  played: () => CodeNote[];
}

const KB_LOW = 36;
const KB_HIGH = 96;
const NOTE_KEYS = ["C", "C♯", "D", "E♭", "E", "F", "F♯", "G", "A♭", "A", "B♭", "B"];
const SCALE_NAME: Record<string, string> = {
  major: "мажор",
  minor: "минор",
  dorian: "дорийский",
  mixolydian: "миксолидийский",
  minpenta: "минорная пентатоника",
  majpenta: "мажорная пентатоника",
  blues: "блюз",
};

/** Редактор Strudel со звуком, панелью «Играть поверх кода» и клавиатурой с подсказками. */
export function CodeEditor({
  initialCode,
  onCodeChange,
  panel,
  onPanelChange,
  compact = false,
  toolbar,
  onReady,
  onSummary,
  onImprov,
}: {
  initialCode: string;
  onCodeChange?: (code: string) => void;
  panel: CodePanel;
  onPanelChange?: (p: CodePanel) => void;
  /** Без правой панели (уроки курса). */
  compact?: boolean;
  /** Дополнительные кнопки в строке управления. */
  toolbar?: ReactNode;
  onReady?: (h: CodeEditorHandle) => void;
  /** Итог игры поверх кода — при остановке. */
  onSummary?: (s: JudgeSummary) => void;
  /** Итог импровизации (нот всего и в аккорде/ладу) — при остановке. */
  onImprov?: (s: { total: number; inKey: number }) => void;
}) {
  const { prefs } = useApp();
  const root = useRef<HTMLDivElement>(null);
  const panelRef = useRef(panel);
  panelRef.current = panel;
  const [state, setState] = useState({ started: false, error: null as string | null, pending: false, dirty: false });
  const [info, setInfo] = useState<EvalInfo>({ parts: [], harmony: null, hasYou: false });
  const [loading, setLoading] = useState(true);
  const [highlight, setHighlight] = useState<Record<number, { color: string; strength?: number }>>({});
  const [score, setScore] = useState<JudgeSummary | null>(null);
  const [improvStats, setImprovStats] = useState<JamStats | null>(null);
  const [nowChord, setNowChord] = useState<Chord | null>(null);
  const [key, setKey] = useState<Key | null>(null);
  const [monitor, setMonitor] = useState(liveMonitor());
  const liveRef = useRef<LiveCode | null>(null);
  const judge = useRef(new YouJudge(!!panel.anyOctave));
  const improv = useRef<{ chord: number; scale: number; out: number; total: number }>({ chord: 0, scale: 0, out: 0, total: 0 });
  const flashes = useRef(new Map<number, { color: string; until: number }>());
  const playedRef = useRef<CodeNote[]>([]);
  const heldRef = useRef(new Map<number, CodeNote>());
  const keyRef = useRef<Key | null>(null);
  const chordRef = useRef<Chord | null>(null);
  const onCodeChangeRef = useRef(onCodeChange);
  onCodeChangeRef.current = onCodeChange;
  const onSummaryRef = useRef(onSummary);
  onSummaryRef.current = onSummary;
  const onImprovRef = useRef(onImprov);
  onImprovRef.current = onImprov;

  const resetScore = () => {
    judge.current = new YouJudge(!!panelRef.current.anyOctave);
    improv.current = { chord: 0, scale: 0, out: 0, total: 0 };
    setScore(null);
    setImprovStats(null);
  };

  // Редактор: создаётся один раз.
  useEffect(() => {
    const live = new LiveCode({
      onState: (s) => {
        setState({ started: s.started, error: s.error, pending: s.pending, dirty: s.dirty });
        onCodeChangeRef.current?.(s.code);
      },
      onEvaluated: (i) => {
        setInfo({ ...i, parts: [...i.parts] });
        // Лад: из панели, из harmony() в коде или по нотам первых 8 циклов.
        const fromText = parseScale(panelRef.current.scale ?? "") ?? parseScale(i.harmony?.scale ?? "");
        const k = fromText ?? estimateKey(live.notes(0, 8).filter((n) => !n.you));
        keyRef.current = k;
        setKey(k);
      },
    });
    liveRef.current = live;
    // Для проверок в браузере (без ядра): доступ к движку и оценке.
    if (!inTauri) (window as unknown as { __mtCode?: unknown }).__mtCode = { live, judge: () => judge.current };
    let alive = true;
    if (root.current)
      void live
        .mount(root.current, initialCode, () => panelRef.current)
        .then(() => {
          if (!alive) return live.destroy();
          setLoading(false);
          onReady?.({
            live,
            evaluate: () => live.evaluate(),
            stop: () => live.stop(),
            code: () => live.code,
            setCode: (c) => live.setCode(c),
            summary: () => judge.current.summary(),
            played: () => playedRef.current.slice(),
          });
        })
        .catch((e) => setState((s) => ({ ...s, error: `Strudel не загрузился: ${e}` })));
    return () => {
      alive = false;
      live.destroy();
      liveRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Смена партий в панели — применить к звучащему коду.
  const panelKey = `${panel.myPart ?? ""}|${panel.echoPart ?? ""}|${panel.kbTranspose ? 1 : 0}|${panel.scale ?? ""}|${panel.harmony ?? ""}`;
  const firstPanel = useRef(true);
  useEffect(() => {
    if (firstPanel.current) {
      firstPanel.current = false;
      return;
    }
    resetScore();
    if (liveRef.current?.started) void liveRef.current.evaluate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panelKey]);

  // Остановка — итог.
  const wasStarted = useRef(false);
  useEffect(() => {
    if (wasStarted.current && !state.started) {
      const s = judge.current.summary();
      if (s.expected > 0) {
        setScore(s);
        onSummaryRef.current?.(s);
        if (s.expected >= 8)
          void api
            .exerciseRecord({ exercise: "code-play", tempo: 1, accuracy: s.accuracy, timingSdMs: Math.abs(s.meanDeltaMs), loudness: 1, passed: s.accuracy >= 0.85 })
            .catch(() => {});
      }
      const im = improv.current;
      if (im.total) onImprovRef.current?.({ total: im.total, inKey: im.chord + im.scale });
      if (im.total >= 8)
        void api
          .exerciseRecord({ exercise: "code-improv", tempo: 1, accuracy: (im.chord + im.scale) / im.total, timingSdMs: 0, loudness: 1, passed: im.out / im.total < 0.25 })
          .catch(() => {});
    }
    if (!wasStarted.current && state.started) {
      resetScore();
      playedRef.current = [];
      heldRef.current.clear();
    }
    wasStarted.current = state.started;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.started]);

  // Нажатия: живые данные для kb()/midin(), оценка «моей партии» и импровизации.
  useEffect(() => {
    let off: (() => void) | null = null;
    let alive = true;
    void listen("midi", (e) => {
      if (e.device === PADS_DEVICE) return;
      feedLive(e);
      const live = liveRef.current;
      if (e.type === "controlChange" || !live?.started) return;
      const cycle = live.cycleOfCoreTime(e.timeUs) ?? live.nowCycle();
      if (cycle === null) return;
      if (e.type === "noteOff") {
        const n = heldRef.current.get(e.note);
        if (n) n.dur = Math.max(0.01, cycle - n.begin);
        heldRef.current.delete(e.note);
        return;
      }
      const played: CodeNote = { begin: cycle, dur: 0.25, midi: e.note, drum: false, s: "piano", n: 0, part: null, you: false, gain: e.velocity / 127 };
      playedRef.current.push(played);
      heldRef.current.set(e.note, played);
      const p = panelRef.current;
      const youActive = !!(p.myPart || p.echoPart || evalInfo().hasYou);
      let color = "#9aa4b2";
      if (youActive) {
        const r = judge.current.play(e.note, cycle, live.cps);
        color = r.kind === "good" ? "#4CC38A" : r.kind === "ok" ? "#F2C94C" : "#FF5C5C";
      } else if (p.improv || p.harmony || evalInfo().harmony) {
        const k = keyRef.current;
        const cls = classify(e.note, chordRef.current, k ? keyPcs(k) : []);
        improv.current[cls]++;
        improv.current.total++;
        color = cls === "chord" ? "#4CC38A" : cls === "scale" ? "#5AA9FF" : "#FFB454";
      }
      flashes.current.set(e.note, { color, until: performance.now() + 250 });
    }).then((f) => (alive ? (off = f) : f()));
    const offMon = onLive(() => setMonitor(liveMonitor()));
    return () => {
      alive = false;
      off?.();
      offMon();
    };
  }, []);

  // Подсказки: каждые 50 мс — ближайшие ноты «моей партии», аккорд и лад, вспышки нажатий.
  useEffect(() => {
    const t = window.setInterval(() => {
      const live = liveRef.current;
      const h: Record<number, { color: string; strength?: number }> = {};
      const now = live?.started ? live.nowCycle() : null;
      if (live && now !== null) {
        const p = panelRef.current;
        const ahead = live.notes(now - 0.15, now + 1.5);
        const you = ahead.filter((n) => n.you && n.midi !== null && !n.drum);
        if (you.length) {
          judge.current.expect(you.map((n) => ({ begin: n.begin, midi: n.midi! })), live.cps);
          // Ближайшая группа нот — ярко, следующая — бледно.
          const upcoming = you.filter((n) => n.begin >= now - 0.05).sort((a, b) => a.begin - b.begin);
          const first = upcoming[0]?.begin;
          for (const n of upcoming) {
            const near = first !== undefined && n.begin - first < 0.02;
            if (h[n.midi!] && (h[n.midi!].strength ?? 1) >= 0.9) continue;
            h[n.midi!] = { color: "#5AA9FF", strength: near ? 1 : 0.35 };
          }
        }
        judge.current.tick(now);
        const wantsHarmony = !you.length && (p.improv || p.harmony || evalInfo().harmony);
        if (wantsHarmony) {
          const cyc = Math.floor(now);
          let chord: Chord | null = null;
          const hp = p.harmony ? null : evalInfo().harmony?.chords;
          if (p.harmony) chord = chordAtText(p.harmony, now);
          else if (hp) {
            try {
              const hap = hp.queryArc(now, now + 0.001)[0];
              chord = hap ? chordFromValue(hap.value) : null;
            } catch {
              chord = null;
            }
          } else chord = chordFromNotes(live.notes(cyc, cyc + 1));
          chordRef.current = chord;
          setNowChord((old) => (old?.symbol === chord?.symbol ? old : chord));
          const k = keyRef.current;
          const pcs = highlightPcs(chord, k ? keyPcs(k) : []);
          for (let m = KB_LOW; m <= KB_HIGH; m++) {
            const c = pcs.get(m % 12);
            if (c) h[m] = c === "chord" ? { color: "#4CC38A", strength: 0.7 } : { color: "#5AA9FF", strength: 0.25 };
          }
        }
        setScore(judge.current.summary().expected ? judge.current.summary() : null);
        const im = improv.current;
        if (im.total) setImprovStats({ total: im.total, chord: im.chord, scale: im.scale, out: im.out, phrases: 0 });
      }
      const tNow = performance.now();
      for (const [note, f] of flashes.current) {
        if (f.until < tNow) flashes.current.delete(note);
        else h[note] = { color: f.color, strength: 1 };
      }
      setHighlight((old) => (sameHighlight(old, h) ? old : h));
    }, 50);
    return () => window.clearInterval(t);
  }, []);

  const set = (p: Partial<CodePanel>) => onPanelChange?.({ ...panel, ...p });
  const parts = info.parts;
  const showYou = !!(panel.myPart || panel.echoPart || info.hasYou);
  const tips = useMemo(() => (score ? judgeTips(score) : []), [score]);

  return (
    <div className={compact ? "code-editor compact" : "code-editor"} data-code-editor data-code-started={state.started ? "1" : "0"}>
      <div className="code-toolbar">
        <button className="primary" onClick={() => void liveRef.current?.evaluate()} disabled={loading} data-code-play title="Ctrl+Enter">
          {state.started ? (state.dirty ? "▶ Применить" : "↻ Заново") : "▶ Играть"}
        </button>
        <button onClick={() => liveRef.current?.stop()} disabled={!state.started} data-code-stop title="Ctrl+.">
          ■ Стоп
        </button>
        {toolbar}
        {loading && <span className="muted">Загрузка Strudel…</span>}
        {state.pending && <span className="muted">запуск…</span>}
      </div>
      <div className="code-body">
        <div className="code-main">
          <div className="code-cm" ref={root} data-code-cm />
          {state.error && (
            <div className="code-error" data-code-error>
              <b>Ошибка в коде:</b> {translateError(state.error)}
            </div>
          )}
        </div>
        {!compact && (
          <aside className="code-panel" data-code-panel>
            <h3>Играть поверх кода</h3>
            <label className="field-row">
              <span>Моя партия</span>
              <select value={panel.myPart ?? ""} onChange={(e) => set({ myPart: e.target.value || null, echoPart: e.target.value === panel.echoPart ? null : panel.echoPart })} data-code-mypart>
                <option value="">— нет —</option>
                {parts.map((p) => (
                  <option key={p} value={p}>
                    {partLabel(p)}
                  </option>
                ))}
              </select>
            </label>
            <label className="field-row">
              <span>Повтори за мной</span>
              <select value={panel.echoPart ?? ""} onChange={(e) => set({ echoPart: e.target.value || null, myPart: e.target.value === panel.myPart ? null : panel.myPart })} data-code-echo>
                <option value="">— нет —</option>
                {parts.map((p) => (
                  <option key={p} value={p}>
                    {partLabel(p)}
                  </option>
                ))}
              </select>
            </label>
            {!parts.length && <p className="hint">Партии появятся после запуска: дай им имена — <code>melody: note(…)</code>.</p>}
            <label className="check">
              <input type="checkbox" checked={!!panel.anyOctave} onChange={(e) => set({ anyOctave: e.target.checked })} /> Засчитывать в любой октаве
            </label>
            <label className="check">
              <input type="checkbox" checked={!!panel.improv} onChange={(e) => set({ improv: e.target.checked })} data-code-improv /> Импровизация: подсветить аккорд и лад
            </label>
            {(panel.improv || panel.harmony || info.harmony) && (
              <>
                <label className="field-row">
                  <span>Аккорды</span>
                  <input value={panel.harmony ?? ""} placeholder="по нотам кода" onChange={(e) => set({ harmony: e.target.value })} data-code-harmony />
                </label>
                <label className="field-row">
                  <span>Лад</span>
                  <input value={panel.scale ?? ""} placeholder={key ? `${NOTE_KEYS[key.tonic]}:${key.scale}` : "A:minor"} onChange={(e) => set({ scale: e.target.value })} />
                </label>
                <p className="hint" data-code-now-chord>
                  Сейчас: {nowChord ? chordName(nowChord) : "—"}
                  {key ? ` · лад ${NOTE_KEYS[key.tonic]} ${SCALE_NAME[key.scale] ?? key.scale}` : ""}
                </p>
              </>
            )}
            <label className="check">
              <input type="checkbox" checked={!!panel.kbTranspose} onChange={(e) => set({ kbTranspose: e.target.checked })} /> Транспонировать клавишей (от «до» первой октавы)
            </label>
            {showYou && score && (
              <div className="code-score" data-code-score={Math.round(score.accuracy * 100)}>
                <b>{Math.round(score.accuracy * 100)}%</b> вовремя · точно {score.good}, близко {score.ok}, пропущено {score.misses}, лишних {score.extras}
                {!state.started && tips.map((t) => <p key={t} className="hint">{t}</p>)}
              </div>
            )}
            {improvStats && !showYou && (
              <div className="code-score" data-code-improv-stats={improvStats.total}>
                Нот: {improvStats.total} — аккорд {improvStats.chord}, лад {improvStats.scale}, мимо {improvStats.out}
                {!state.started && jamTips(improvStats).map((t) => <p key={t} className="hint">{t}</p>)}
              </div>
            )}
            <details className="code-monitor">
              <summary>Что присылает устройство</summary>
              {monitor.length ? (
                <ul data-code-monitor>
                  {monitor.map((m, i) => (
                    <li key={i}>
                      <span className="muted">{m.device}:</span> {m.text}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="hint">Нажми клавишу или покрути ручку — здесь появятся номера нот и CC для kb() и midin().</p>
              )}
            </details>
          </aside>
        )}
      </div>
      <div className="code-piano">
        <Piano low={KB_LOW} high={KB_HIGH} highlight={highlight} naming={prefs.noteNames} />
      </div>
    </div>
  );
}

function sameHighlight(a: Record<number, { color: string; strength?: number }>, b: Record<number, { color: string; strength?: number }>) {
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  return ka.every((k) => b[Number(k)] && b[Number(k)].color === a[Number(k)].color && b[Number(k)].strength === a[Number(k)].strength);
}

/** Аккорд в момент `cycle` по строке панели «<Am F C G>» или «Am F C G» (по одному на цикл). */
function chordAtText(text: string, cycle: number): Chord | null {
  const list = text
    .replace(/[<>[\]]/g, " ")
    .split(/[\s,|]+/)
    .filter(Boolean);
  if (!list.length) return null;
  return chordFromValue(list[((Math.floor(cycle) % list.length) + list.length) % list.length]);
}

/** Частые ошибки Strudel — по-русски, с исходным текстом. */
export function translateError(msg: string): string {
  const m = msg.replace(/^Error:\s*/, "");
  const rules: [RegExp, (r: RegExpExecArray) => string][] = [
    [/(\w+) is not defined/, (r) => `«${r[1]}» не найдено — опечатка в имени функции или переменной?`],
    [/sound (\S+) not found/i, (r) => `звук ${r[1]} не найден — проверь имя (встроенные: bd, sd, hh, piano, gm_…) или включи стандартные наборы.`],
    [/Unexpected token/, () => "синтаксическая ошибка — проверь скобки и кавычки."],
    [/is not a function/, () => "это не функция — проверь имя метода после точки."],
  ];
  for (const [re, f] of rules) {
    const r = re.exec(m);
    if (r) return `${f(r)} (${m})`;
  }
  return m;
}
