import { useEffect, useMemo, useState } from "react";
import { api, type ExerciseAttempt, type PieceProgress, type Progress as ProgressData, type TrainerOverview } from "../api";
import type { ExerciseStatView } from "../lib/exercises";
import { READ_LEVELS, readLevelPassed } from "../lib/reading";
import { RHYTHM_LEVELS, rhythmLevelPassed } from "../lib/rhythm";
import { LEVELS, minutesByDay } from "../lib/practice";
import { keyLabel } from "../lib/notes";
import { useApp } from "../store";

const DAYS = 28;
const WEEKDAY = ["вс", "пн", "вт", "ср", "чт", "пт", "сб"];

function minutesText(m: number): string {
  if (m < 1) return m > 0 ? "меньше минуты" : "0 мин";
  if (m < 60) return `${Math.round(m)} мин`;
  const h = Math.floor(m / 60);
  const rest = Math.round(m % 60);
  return rest ? `${h} ч ${rest} мин` : `${h} ч`;
}

function dateText(secs: number | null): string {
  if (!secs) return "—";
  const d = new Date(secs * 1000);
  const today = new Date();
  const days = Math.round((new Date(today.toDateString()).getTime() - new Date(d.toDateString()).getTime()) / 86_400_000);
  if (days === 0) return "сегодня";
  if (days === 1) return "вчера";
  return d.toLocaleDateString("ru-RU", { day: "numeric", month: "long" });
}

export function Progress({ onOpenPiece }: { onOpenPiece: (id: string) => void }) {
  const naming = useApp((s) => s.prefs.noteNames);
  const [data, setData] = useState<ProgressData | null>(null);
  const [trainer, setTrainer] = useState<TrainerOverview | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.progressOverview().then(setData).catch((e) => setError(String(e)));
    api.trainerOverview().then(setTrainer).catch(() => {});
  }, []);

  const days = useMemo(() => (data ? minutesByDay(data.play, DAYS) : []), [data]);
  const maxDay = Math.max(15, ...days.map((d) => d.minutes));
  const today = days[days.length - 1]?.minutes ?? 0;
  const week = days.slice(-7).reduce((s, d) => s + d.minutes, 0);
  const activeDays = days.filter((d) => d.minutes >= 1).length;

  return (
    <main className="progress">
      {error && <div className="notice warn">Прогресс недоступен: {error}</div>}

      <section className="card">
        <h2 className="section-h">Занятия по дням</h2>
        <div className="progress-totals">
          <div>
            <b>{minutesText(today)}</b>
            <span className="muted">сегодня</span>
          </div>
          <div>
            <b>{minutesText(week)}</b>
            <span className="muted">за 7 дней</span>
          </div>
          <div>
            <b>{activeDays}</b>
            <span className="muted">дней с занятиями за 4 недели</span>
          </div>
        </div>
        <div className="day-bars" data-days={days.length}>
          {days.map((d) => (
            <div key={d.key} className="day" title={`${d.date.toLocaleDateString("ru-RU", { day: "numeric", month: "long" })}: ${minutesText(d.minutes)}`}>
              <div className="day-bar">
                <div style={{ height: `${(d.minutes / maxDay) * 100}%` }} className={d.minutes >= 1 ? "on" : ""} />
              </div>
              <span className={d.date.getDay() === 1 ? "day-label strong" : "day-label"}>
                {d.date.getDay() === 1 || d === days[days.length - 1] ? `${d.date.getDate()}` : WEEKDAY[d.date.getDay()].slice(0, 1)}
              </span>
            </div>
          ))}
        </div>
        <p className="hint">Считается время, когда ты играешь на инструменте с открытым приложением (паузы до 30 секунд — тоже игра).</p>
      </section>

      <section className="card">
        <h2 className="section-h">Пьесы</h2>
        {data && data.pieces.length === 0 && <p className="muted">Пока ни одной пьесы. Открой пьесу в разделе «Пьесы» и начни разучивать.</p>}
        <div className="progress-pieces">
          {data?.pieces.map((p) => (
            <PieceRow key={p.id} piece={p} onOpen={() => onOpenPiece(p.id)} />
          ))}
        </div>
        <LevelLegend />
      </section>

      <section className="card">
        <h2 className="section-h">Трудные такты</h2>
        <p className="hint">Ошибки по тактам за последние 4 недели. На нотах то же самое включается переключателем «Трудные такты».</p>
        {data && !data.pieces.some((p) => p.heat.length) && <p className="muted">Ошибок пока не набралось.</p>}
        {data?.pieces
          .filter((p) => p.heat.length)
          .map((p) => (
            <HeatRow key={p.id} piece={p} onOpen={() => onOpenPiece(p.id)} />
          ))}
      </section>

      <section className="card">
        <h2 className="section-h">Тренажёр нот</h2>
        {trainer ? <TrainerStats overview={trainer} naming={naming} /> : <p className="muted">Загрузка…</p>}
      </section>

      <section className="card" data-progress-drills>
        <h2 className="section-h">Чтение с листа и ритм</h2>
        <DrillStats />
      </section>
    </main>
  );
}

function PieceRow({ piece, onOpen }: { piece: PieceProgress; onOpen: () => void }) {
  const learned = piece.fragments.filter((f) => f.learned).length;
  return (
    <div className="progress-piece">
      <div className="progress-piece-head">
        <button className="link piece-link" onClick={onOpen}>
          {piece.title}
        </button>
        <span className="muted">
          {piece.learned ? "выучена наизусть" : `выучено фрагментов: ${learned} из ${piece.fragments.length}`} · проходов{" "}
          {piece.activity.attempts} · {minutesText(piece.activity.minutes)} · {dateText(piece.activity.lastAt ?? piece.openedAt)}
        </span>
      </div>
      <FragmentStrip piece={piece} />
    </div>
  );
}

/** Полоса фрагментов пьесы: ширина по числу тактов, цвет по уровню. */
export function FragmentStrip({ piece, compact }: { piece: Pick<PieceProgress, "fragments" | "measures">; compact?: boolean }) {
  return (
    <div className={`frag-strip${compact ? " compact" : ""}`}>
      {piece.fragments.map((f, i) => (
        <div
          key={f.from}
          className={`frag lvl-${f.learned ? "done" : f.started ? f.level : "none"}`}
          style={{ flexGrow: f.to - f.from + 1 }}
          title={`Фрагмент ${i + 1}, такты ${f.from}–${f.to}: ${f.learned ? "выучен" : f.started ? `уровень ${f.level} «${LEVELS[f.level].title}»` : "не начат"}`}
        >
          {!compact && <span>{i + 1}</span>}
        </div>
      ))}
    </div>
  );
}

function LevelLegend() {
  return (
    <div className="level-legend">
      <span>
        <i className="frag lvl-none" /> не начат
      </span>
      {LEVELS.map((l) => (
        <span key={l.id}>
          <i className={`frag lvl-${l.id}`} /> {l.id} {l.short.toLowerCase()}
        </span>
      ))}
      <span>
        <i className="frag lvl-done" /> выучен
      </span>
    </div>
  );
}

function HeatRow({ piece, onOpen }: { piece: PieceProgress; onOpen: () => void }) {
  const byMeasure = new Map(piece.heat.map((h) => [h.measure, h.errors]));
  const max = Math.max(1, ...piece.heat.map((h) => h.errors));
  const top = [...piece.heat].sort((a, b) => b.errors - a.errors).slice(0, 4);
  return (
    <div className="heat-row">
      <div className="progress-piece-head">
        <button className="link piece-link" onClick={onOpen}>
          {piece.title}
        </button>
        <span className="muted">труднее всего: {top.map((t) => `такт ${t.measure} (${t.errors})`).join(", ")}</span>
      </div>
      <div className="heat-strip">
        {Array.from({ length: piece.measures }, (_, i) => {
          const e = byMeasure.get(i + 1) ?? 0;
          return (
            <div
              key={i}
              className="heat-cell"
              title={`Такт ${i + 1}: ошибок ${e}`}
              style={{ background: e ? `rgba(255, 92, 92, ${0.2 + (0.75 * e) / max})` : undefined }}
            >
              {(i + 1) % 4 === 1 && <span>{i + 1}</span>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function TrainerStats({ overview, naming }: { overview: TrainerOverview; naming: "solfege" | "latin" }) {
  const sessions = overview.levelStats.reduce((s, l) => s + l.sessions, 0);
  const notes = [...overview.noteStats].filter((n) => n.attempts >= 1);
  const mastered = notes.filter((n) => n.accuracy >= overview.passAccuracy && n.avgReactionMs <= overview.passReactionMs).length;
  const byClef = (clef: "treble" | "bass") => notes.filter((n) => n.clef === clef).sort((a, b) => a.midi - b.midi);
  return (
    <>
      <div className="progress-totals">
        <div>
          <b>
            {overview.unlocked} из {overview.levels.length}
          </b>
          <span className="muted">ступеней открыто</span>
        </div>
        <div>
          <b>{sessions}</b>
          <span className="muted">серий сыграно</span>
        </div>
        <div>
          <b>
            {mastered} из {notes.length}
          </b>
          <span className="muted">нот узнаёшь уверенно</span>
        </div>
      </div>
      {(["treble", "bass"] as const).map((clef) =>
        byClef(clef).length ? (
          <div key={clef} className="note-grid">
            <span className="muted">{clef === "treble" ? "Скрипичный ключ" : "Басовый ключ"}</span>
            <div>
              {byClef(clef).map((n) => (
                <span
                  key={n.midi}
                  className={`chip small note-stat ${n.accuracy >= overview.passAccuracy ? "good" : n.accuracy < 0.7 ? "warn" : "warn-chip"}`}
                  title={`${Math.round(n.accuracy * 100)}% верно, ${(n.avgReactionMs / 1000).toFixed(1)} с`}
                >
                  {keyLabel(n.midi, naming)} · {Math.round(n.accuracy * 100)}%
                </span>
              ))}
            </div>
          </div>
        ) : null,
      )}
      {!notes.length && <p className="muted">Серий пока не было.</p>}
    </>
  );
}

const DRILL_DAYS = 14;

/** Чтение с листа и ритм: пройденные ступени, попытки по дням за две недели. */
function DrillStats() {
  const [stats, setStats] = useState<ExerciseStatView[] | null>(null);
  const [hist, setHist] = useState<{ read: ExerciseAttempt[]; rhythm: ExerciseAttempt[] } | null>(null);
  useEffect(() => {
    const since = Math.floor(Date.now() / 1000) - DRILL_DAYS * 86400;
    api.exerciseStats().then(setStats).catch(() => setStats([]));
    Promise.all([api.exerciseHistory("read-", since), api.exerciseHistory("rhythm-", since)])
      .then(([read, rhythm]) => setHist({ read, rhythm }))
      .catch(() => setHist({ read: [], rhythm: [] }));
  }, []);
  if (!stats || !hist) return <p className="muted">Загрузка…</p>;
  const readPassed = READ_LEVELS.filter((l) => readLevelPassed(stats, l.id)).length;
  const rhythmPassed = RHYTHM_LEVELS.filter((l) => rhythmLevelPassed(stats, l)).length;
  const days = Array.from({ length: DRILL_DAYS }, (_, i) => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - (DRILL_DAYS - 1 - i));
    const from = d.getTime() / 1000;
    const to = from + 86400;
    const inDay = (a: ExerciseAttempt) => a.finishedAt >= from && a.finishedAt < to;
    return { date: d, read: hist.read.filter(inDay), rhythm: hist.rhythm.filter(inDay) };
  });
  const max = Math.max(4, ...days.map((d) => d.read.length + d.rhythm.length));
  const acc = (list: ExerciseAttempt[]) => (list.length ? Math.round((list.reduce((s, a) => s + a.accuracy, 0) / list.length) * 100) : null);
  const readAcc = acc(hist.read);
  const rhythmAcc = acc(hist.rhythm);
  return (
    <>
      <div className="progress-totals">
        <div>
          <b>
            {readPassed} из {READ_LEVELS.length}
          </b>
          <span className="muted">ступеней чтения пройдено</span>
        </div>
        <div>
          <b>
            {hist.read.filter((a) => a.passed).length} из {hist.read.length}
          </b>
          <span className="muted">мелодий засчитано за 2 недели{readAcc !== null ? ` · в среднем ${readAcc}%` : ""}</span>
        </div>
        <div>
          <b>
            {rhythmPassed} из {RHYTHM_LEVELS.length}
          </b>
          <span className="muted">ступеней ритма пройдено</span>
        </div>
        <div>
          <b>
            {hist.rhythm.filter((a) => a.passed).length} из {hist.rhythm.length}
          </b>
          <span className="muted">ритмов засчитано за 2 недели{rhythmAcc !== null ? ` · в среднем ${rhythmAcc}%` : ""}</span>
        </div>
      </div>
      <div className="day-bars drill-bars">
        {days.map((d) => (
          <div
            key={d.date.getTime()}
            className="day"
            title={`${d.date.toLocaleDateString("ru-RU", { day: "numeric", month: "long" })}: мелодий ${d.read.length}, ритмов ${d.rhythm.length}`}
          >
            <div className="day-bar stacked">
              <div className="on rhythm" style={{ height: `${(d.rhythm.length / max) * 100}%` }} />
              <div className="on" style={{ height: `${(d.read.length / max) * 100}%` }} />
            </div>
            <span className="day-label">{d.date.getDate()}</span>
          </div>
        ))}
      </div>
      <p className="hint">
        <span className="legend-dot read" /> мелодии с листа · <span className="legend-dot rhythm" /> ритмы. Ступени — во вкладке «Тренажёры».
      </p>
    </>
  );
}
