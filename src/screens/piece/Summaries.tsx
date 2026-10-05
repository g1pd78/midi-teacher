// Итоги попытки: ожидание, ритм, упражнения.

import type { PieceSummary, RhythmSummary } from "../../api";
import { PASS_DYNAMICS } from "../../lib/drums";
import { PASS_ACCURACY, PASS_TIMING_SD_MS, type Evaluation } from "../../lib/exercises";
import { grooveTendency, worstSlot, type GrooveStats } from "../../lib/groove";
import { formatTime, percent } from "./helpers";
import type { WaitResult } from "./types";

export function WaitSummary({ summary, onAgain, onBack }: { summary: PieceSummary; onAgain: () => void; onBack: () => void }) {
  return (
    <div className="summary-overlay">
      <div className="summary card">
        <h2>Пьеса сыграна</h2>
        <div className="summary-stats">
          <div>
            <div className={`big ${summary.errors === 0 ? "good" : ""}`}>{summary.errors}</div>
            <div className="muted">ошибок</div>
          </div>
          <div>
            <div className="big">{formatTime(summary.durationMs)}</div>
            <div className="muted">время</div>
          </div>
        </div>
        <Trouble measures={summary.troubleMeasures} />
        <div className="summary-actions">
          <button className="primary" onClick={onAgain}>
            Ещё раз
          </button>
          <button className="ghost" onClick={onBack}>
            К списку пьес
          </button>
        </div>
      </div>
    </div>
  );
}

export function RhythmSummaryPanel({ summary, onAgain, onClose }: { summary: RhythmSummary; onAgain: () => void; onClose: () => void }) {
  const tendency =
    summary.hits === 0
      ? ""
      : summary.meanDeltaMs > 25
        ? `чаще опаздываешь (в среднем на ${summary.meanDeltaMs} мс)`
        : summary.meanDeltaMs < -25
          ? `чаще спешишь (в среднем на ${-summary.meanDeltaMs} мс)`
          : "ровно, без спешки и опозданий";
  return (
    <div className="summary-overlay">
      <div className="summary card">
        <h2>Сыграно в темпе</h2>
        <div className="summary-stats">
          <div>
            <div className={`big ${summary.accuracy >= 0.9 ? "good" : summary.accuracy < 0.6 ? "bad" : ""}`}>{percent(summary.accuracy)}</div>
            <div className="muted">
              нот сыграно ({summary.hits} из {summary.requiredNotes})
            </div>
          </div>
          <div>
            <div className="big">±{summary.meanAbsDeltaMs} мс</div>
            <div className="muted">отклонение от ритма</div>
          </div>
        </div>
        <div className="grades">
          <span className="chip small good">точно: {summary.perfect}</span>
          <span className="chip small">нормально: {summary.good}</span>
          <span className="chip small warn-chip">неточно: {summary.poor}</span>
          <span className="chip small warn">пропущено: {summary.misses}</span>
          <span className="chip small warn">лишних: {summary.extras}</span>
        </div>
        {tendency && <p className="hint">Ритм: {tendency}.</p>}
        <Trouble measures={summary.troubleMeasures} />
        <div className="summary-actions">
          <button className="primary" onClick={onAgain}>
            Ещё раз
          </button>
          <button className="ghost" onClick={onClose}>
            Закрыть
          </button>
        </div>
      </div>
    </div>
  );
}

/** Итог упражнения в режиме ожидания (чтение с листа): верные ноты с первой попытки. */
export function ExerciseWaitSummary({
  result,
  need,
  next,
  onAgain,
  onTempo,
  onBack,
  backLabel,
}: {
  result: WaitResult;
  need: number;
  next: { label: string; go: () => void } | null;
  onAgain: () => void;
  onTempo: () => void;
  onBack: () => void;
  backLabel?: string;
}) {
  return (
    <div className="summary-overlay">
      <div className="summary card exercise-summary" data-wait-result={result.passed ? "passed" : "failed"}>
        <h2>{result.passed ? "Засчитано ✓" : "Сыграно"}</h2>
        <div className="summary-stats">
          <div>
            <div className={`big ${result.accuracy >= need ? "good" : result.accuracy < 0.7 ? "bad" : ""}`}>{percent(result.accuracy)}</div>
            <div className="muted">нот без ошибки</div>
          </div>
          <div>
            <div className={`big ${result.errors === 0 ? "good" : ""}`}>{result.errors}</div>
            <div className="muted">ошибок</div>
          </div>
          <div>
            <div className="big">{formatTime(result.durationMs)}</div>
            <div className="muted">время</div>
          </div>
        </div>
        {!result.passed && <p className="hint">Для зачёта — от {percent(need)} нот без ошибки.</p>}
        {result.passed && <p className="hint">Теперь попробуй сыграть её в темпе — так засчитывается и ритм.</p>}
        <div className="summary-actions">
          {next && (
            <button className="primary" onClick={next.go}>
              {next.label}
            </button>
          )}
          <button onClick={onTempo}>В темпе</button>
          <button onClick={onAgain}>Ещё раз</button>
          <button className="ghost" onClick={onBack}>
            {backLabel ? "К списку" : "К упражнениям"}
          </button>
        </div>
      </div>
    </div>
  );
}

export function ExerciseSummary({
  ev,
  tempo,
  pass,
  grooveDrums,
  backLabel,
  next,
  onAgain,
  onBack,
  onClose,
}: {
  ev: Evaluation;
  tempo: number;
  pass?: { accuracy: number; timingSdMs: number };
  grooveDrums?: boolean;
  backLabel?: string;
  next: { label: string; go: () => void } | null;
  onAgain: () => void;
  onBack: () => void;
  onClose: () => void;
}) {
  const needAcc = pass?.accuracy ?? PASS_ACCURACY;
  const needSd = pass?.timingSdMs ?? PASS_TIMING_SD_MS;
  const reasons: string[] = [];
  if (ev.accuracy < needAcc) reasons.push(`точность от ${percent(needAcc)}`);
  if (ev.timingSdMs > needSd) reasons.push(`ровнее ритм (разброс до ±${needSd} мс)`);
  if (tempo < 0.999) reasons.push("темп от 100%");
  const dyn = ev.dynamics;
  const dynTotal = dyn ? dyn.accents.total + dyn.ghosts.total : 0;
  if (dyn && dynTotal && dyn.sensitive && dyn.share < PASS_DYNAMICS) reasons.push("акценты громче, тихие ноты тише");
  const maxV = Math.max(1, ...ev.byFinger.map((b) => b.velocity));
  return (
    <div className="summary-overlay">
      <div className="summary card exercise-summary">
        <h2>{ev.passed ? "Засчитано ✓" : "Упражнение сыграно"}</h2>
        <div className="summary-stats">
          <div>
            <div className={`big ${ev.accuracy >= needAcc ? "good" : ev.accuracy < 0.7 ? "bad" : ""}`}>{percent(ev.accuracy)}</div>
            <div className="muted">верных нот</div>
          </div>
          <div>
            <div className={`big ${ev.timingSdMs <= needSd ? "good" : ""}`}>±{ev.timingSdMs} мс</div>
            <div className="muted">ровность ритма</div>
          </div>
          {dyn && dynTotal ? (
            <div data-dynamics={`${dyn.accents.hit + dyn.ghosts.hit}/${dynTotal}`}>
              <div className={`big ${dyn.sensitive && dyn.share >= PASS_DYNAMICS ? "good" : ""}`}>
                {dyn.sensitive ? percent(dyn.share) : "—"}
              </div>
              <div className="muted">сила удара</div>
            </div>
          ) : (
            <div>
              <div className="big">{percent(ev.loudness)}</div>
              <div className="muted">ровность громкости</div>
            </div>
          )}
        </div>
        {dyn && dynTotal > 0 && (
          <p className="hint">
            {dyn.sensitive
              ? [
                  dyn.accents.total ? `Акценты громче остальных: ${dyn.accents.hit} из ${dyn.accents.total}.` : "",
                  dyn.ghosts.total ? `Тихие ноты тише остальных: ${dyn.ghosts.hit} из ${dyn.ghosts.total}.` : "",
                ]
                  .filter(Boolean)
                  .join(" ")
              : "Пэды передают одну и ту же силу удара — акценты и тихие ноты не оцениваются."}
          </p>
        )}
        {ev.groove && <GrooveBlock groove={ev.groove} drums={grooveDrums ?? true} />}
        {!ev.passed && reasons.length > 0 && <p className="hint">Для зачёта нужно: {reasons.join(", ")}.</p>}
        {ev.passed && !pass && <p className="hint">Следующее упражнение открыто.</p>}
        {ev.crossingMs !== null && ev.otherMs !== null && ev.crossingMs > ev.otherMs + 20 && (
          <p className="hint">
            На подкладывании и перекладывании пальцев отклонение в среднем {ev.crossingMs} мс, на остальных нотах — {ev.otherMs} мс.
            Потренируй эти места медленнее.
          </p>
        )}
        {ev.byFinger.length > 1 && (
          <div className="finger-bars" title="Средняя сила нажатия каждым пальцем">
            {ev.byFinger.map((b) => (
              <div key={b.finger} className={`finger-bar${ev.weakFinger?.finger === b.finger ? " weak" : ""}`}>
                <div className="bar">
                  <div style={{ height: `${(b.velocity / maxV) * 100}%` }} />
                </div>
                <span>{b.finger}</span>
              </div>
            ))}
            <span className="muted finger-bars-note">
              {ev.weakFinger
                ? `${ev.weakFinger.finger}-й палец звучит тише остальных на ${Math.round((1 - ev.weakFinger.ratio) * 100)}%.`
                : "Пальцы звучат примерно одинаково."}
            </span>
          </div>
        )}
        <div className="summary-actions">
          {next && ev.passed ? (
            <button className="primary" onClick={next.go}>
              {next.label}
            </button>
          ) : (
            <button className="primary" onClick={onAgain}>
              Ещё раз
            </button>
          )}
          {next && ev.passed ? (
            <button onClick={onAgain}>Ещё раз</button>
          ) : next ? (
            <button onClick={next.go}>{next.label}</button>
          ) : null}
          <button className="ghost" onClick={onClose}>
            Закрыть
          </button>
          <button className="ghost" onClick={onBack}>
            {backLabel ? "К списку" : "К упражнениям"}
          </button>
        </div>
      </div>
    </div>
  );
}

export function Trouble({ measures }: { measures: { measure: number; errors: number }[] }) {
  if (!measures.length) return null;
  return (
    <div className="trouble">
      <span className="muted">Трудные такты: </span>
      {measures.slice(0, 6).map((m) => (
        <span key={m.measure} className="chip small">
          такт {m.measure} — {m.errors}
        </span>
      ))}
    </div>
  );
}

/** Грув: раньше/позже барабанов в среднем и полоски отклонений по местам в такте (вверх — позже, вниз — раньше). */
export function GrooveBlock({ groove, drums }: { groove: GrooveStats; drums: boolean }) {
  const cap = 80;
  const worst = worstSlot(groove);
  return (
    <div className="groove-block" data-groove-mean={groove.meanMs}>
      <p className="hint">
        {grooveTendency(groove, drums)}
        {worst && ` Заметнее всего — на «${worst.label === "·" ? "шестнадцатых" : worst.label}»: ${worst.meanMs > 0 ? "+" : ""}${worst.meanMs} мс.`}
      </p>
      <div className="groove-bars" title="Среднее отклонение по местам в такте: вверх — позже, вниз — раньше">
        {groove.slots.map((s) => {
          const h = (Math.min(cap, Math.abs(s.meanMs)) / cap) * 50;
          const tone = Math.abs(s.meanMs) <= 15 ? "ok" : Math.abs(s.meanMs) <= 40 ? "mid" : "bad";
          return (
            <div key={s.slot} className="groove-col" title={`${s.count} нот, ${s.meanMs > 0 ? "+" : ""}${s.meanMs} мс`}>
              <div className="groove-track">
                <div className={`groove-bar ${tone} ${s.meanMs >= 0 ? "late" : "early"}`} style={{ height: `${h}%` }} />
              </div>
              <span className="groove-label">{s.label}</span>
            </div>
          );
        })}
      </div>
      <div className="groove-legend muted">
        <span>↑ позже</span>
        <span>↓ раньше</span>
      </div>
    </div>
  );
}
