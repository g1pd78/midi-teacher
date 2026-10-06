// Повторение с интервалами: выученное возвращается через 1, 3, 7, 14 и 30 дней. Ничего не хранится
// отдельно — сроки считаются по истории попыток: день, когда выучено, и дни повторений после срока
// (удачное повторение — следующий интервал, неудачное — снова через день). Игра до срока не мешает.

import type { Journal } from "../api";
import { COURSE, stepRecordIds, type CourseInstrument, type CourseLesson, type CourseStep } from "./course";
import { DRUM_EXERCISE_BY_ID } from "./drums";
import { DRUM_SONG_BY_ID, drumSongTitle } from "./drumSongs";
import { EXERCISE_BY_ID } from "./exercises";
import { GTR_EXERCISE_BY_ID } from "./guitarExercises";
import { todayKey } from "./plan";

export const INTERVALS = [1, 3, 7, 14, 30];
/** Отрезок пьесы выучен: уровень «В темпе» и выше с точностью от 90%. */
export const LEARNED_LEVEL = 3;
export const GOOD_ACCURACY = 0.9;

export type ReviewTarget =
  | { kind: "fragment"; piece: string; from: number; to: number }
  | { kind: "step"; step: CourseStep; instrument: CourseInstrument }
  | { kind: "lesson"; lesson: CourseLesson; instrument: CourseInstrument };

export interface ReviewItem {
  key: string;
  title: string;
  /** Где: «Упражнения», «Пьеса», «Курс». */
  group: string;
  learnedOn: string;
  /** Сколько удачных повторений после того, как выучено. */
  stage: number;
  due: string;
  target: ReviewTarget;
}

const DAY = 86400000;
const addDays = (date: string, n: number) => new Date(Date.parse(`${date}T12:00:00Z`) + n * DAY).toISOString().slice(0, 10);
export const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / DAY);
const dayOf = (secs: number) => todayKey(new Date(secs * 1000));

/**
 * Срок по истории: `learned` — день, когда выучено; `days` — дни игры после него с результатом (была ли
 * удачная попытка). Повторение засчитывается только в день срока или позже.
 */
export function schedule(learned: string, days: Map<string, boolean>): { stage: number; due: string } {
  let stage = 0;
  let due = addDays(learned, INTERVALS[0]);
  for (const d of [...days.keys()].sort()) {
    if (d <= learned || d < due) continue;
    stage = days.get(d) ? Math.min(stage + 1, INTERVALS.length - 1) : 0;
    due = addDays(d, INTERVALS[stage]);
  }
  return { stage, due };
}

/** День → была ли удачная попытка (по списку пар «секунды, удачно»). */
function byDay(list: [number, boolean][]): Map<string, boolean> {
  const out = new Map<string, boolean>();
  for (const [t, ok] of list) {
    const d = dayOf(t);
    out.set(d, (out.get(d) ?? false) || ok);
  }
  return out;
}

function exerciseInfo(id: string): { title: string; group: string; step: CourseStep; instrument: CourseInstrument } | null {
  const ex = EXERCISE_BY_ID.get(id);
  if (ex) return { title: ex.title, group: "Упражнения", step: { kind: "exercise", id }, instrument: "piano" };
  const g = GTR_EXERCISE_BY_ID.get(id);
  if (g) return { title: g.title, group: g.instrument === "bass" ? "Бас" : "Гитара", step: { kind: "gtr", id }, instrument: g.instrument };
  const d = DRUM_EXERCISE_BY_ID.get(id);
  if (d) return { title: d.title, group: "Барабаны", step: { kind: "drum", id }, instrument: "drums" };
  const s = DRUM_SONG_BY_ID.get(id);
  if (s) return { title: `Песня на барабанах: ${drumSongTitle(s)}`, group: "Барабаны", step: { kind: "dsong", id }, instrument: "drums" };
  return null;
}

/** Всё выученное со сроками (история — с самого начала). */
export function reviewItems(j: Journal, pieceTitle: (id: string) => string = (id) => id): ReviewItem[] {
  const out: ReviewItem[] = [];

  // Упражнения: выучено в день первого «Засчитано».
  const exHist = new Map<string, [number, boolean][]>();
  for (const e of j.exercises) exHist.set(e.exercise, [...(exHist.get(e.exercise) ?? []), [e.finishedAt, e.passed]]);
  for (const [id, hist] of exHist) {
    const info = exerciseInfo(id);
    const first = hist.find(([, ok]) => ok);
    if (!info || !first) continue;
    const learnedOn = dayOf(first[0]);
    const s = schedule(learnedOn, byDay(hist));
    out.push({ key: `ex:${id}`, title: info.title, group: info.group, learnedOn, ...s, target: { kind: "step", step: info.step, instrument: info.instrument } });
  }

  // Отрезки пьес: выучено, когда сыгран на уровне «В темпе» или «По памяти» с точностью от 90%.
  const frag = new Map<string, Journal["attempts"]>();
  for (const a of j.attempts) {
    const k = `${a.piece}|${a.from}|${a.to}`;
    frag.set(k, [...(frag.get(k) ?? []), a]);
  }
  for (const list of frag.values()) {
    const first = list.find((a) => (a.level ?? 0) >= LEARNED_LEVEL && a.accuracy >= GOOD_ACCURACY);
    if (!first) continue;
    const learnedOn = dayOf(first.finishedAt);
    const s = schedule(learnedOn, byDay(list.map((a) => [a.finishedAt, a.accuracy >= GOOD_ACCURACY])));
    const a = list[0];
    out.push({
      key: `frag:${a.piece}:${a.from}-${a.to}`,
      title: `${a.title || pieceTitle(a.piece)}, такты ${a.from}–${a.to}`,
      group: "Пьеса",
      learnedOn,
      ...s,
      target: { kind: "fragment", piece: a.piece, from: a.from, to: a.to },
    });
  }

  // Уроки курса: выучено в день, когда засчитан последний шаг; повторение — удачный шаг урока.
  const firstPass = new Map<string, number>();
  const anyRecord = new Map<string, number>();
  const passDays = new Map<string, [number, boolean][]>();
  for (const e of j.exercises) {
    if (!anyRecord.has(e.exercise)) anyRecord.set(e.exercise, e.finishedAt);
    if (e.passed && !firstPass.has(e.exercise)) firstPass.set(e.exercise, e.finishedAt);
    passDays.set(e.exercise, [...(passDays.get(e.exercise) ?? []), [e.finishedAt, e.passed]]);
  }
  for (const t of j.trainer) {
    const id = `trainer-${t.level}`;
    if (t.passed && !firstPass.has(id)) firstPass.set(id, t.finishedAt);
    passDays.set(id, [...(passDays.get(id) ?? []), [t.finishedAt, t.passed]]);
  }
  for (const instrument of Object.keys(COURSE) as CourseInstrument[]) {
    for (const lesson of COURSE[instrument].flatMap((m) => m.lessons)) {
      let doneAt = 0;
      let complete = true;
      const hist: [number, boolean][] = [];
      for (const step of lesson.steps) {
        const ids = stepRecordIds(step, instrument);
        const when = Math.min(...ids.map((id) => (step.kind === "theory" ? anyRecord.get(id) : firstPass.get(id)) ?? Infinity));
        if (!Number.isFinite(when)) {
          complete = false;
          break;
        }
        doneAt = Math.max(doneAt, when);
        if (step.kind !== "theory") for (const id of ids) hist.push(...(passDays.get(id) ?? []));
      }
      if (!complete || !doneAt) continue;
      const learnedOn = dayOf(doneAt);
      const s = schedule(learnedOn, byDay(hist));
      out.push({ key: `lesson:${lesson.id}`, title: `Урок курса: ${lesson.title}`, group: "Курс", learnedOn, ...s, target: { kind: "lesson", lesson, instrument } });
    }
  }
  return out;
}

/** Что повторить сегодня: срок наступил; сначала самые просроченные. */
export function dueToday(items: ReviewItem[], today = todayKey()): ReviewItem[] {
  return items.filter((i) => i.due <= today).sort((a, b) => a.due.localeCompare(b.due) || a.title.localeCompare(b.title));
}

export function stageText(i: ReviewItem, today = todayKey()): string {
  const ago = daysBetween(i.learnedOn, today);
  const late = daysBetween(i.due, today);
  return `выучено ${ago} дн. назад · повторений: ${i.stage}${late > 0 ? ` · просрочено на ${late} дн.` : ""}`;
}
