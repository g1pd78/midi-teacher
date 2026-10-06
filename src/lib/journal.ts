// Дневник занятий (формат «midi-teacher/journal@1»): что и сколько играл по дням — из истории попыток
// в базе (упражнения, отрезки пьес, тренажёр нот, время игры). Пишется в YAML по неделям и вместе с
// описанием формата плана и каталогом заданий копируется в запрос для Claude.

import { stringify } from "yaml";
import type { Journal } from "../api";
import type { CourseInstrument } from "./course";
import { PLAN_FORMAT, catalogText, recordTitle, todayKey } from "./plan";

export const JOURNAL_FORMAT = "midi-teacher/journal@1";
export const GOAL_FILE = "цель.yaml";

export interface Goal {
  text: string;
  minutesPerDay: number | null;
}

export interface DiaryFragment {
  bars: string;
  level: number | null;
  attempts: number;
  bestAccuracy: number;
  tempo: number;
  hardBars: number[];
}

export interface DiaryDay {
  date: string;
  minutes: number;
  pieces: { id: string; title: string; fragments: DiaryFragment[] }[];
  exercises: { id: string; title: string; attempts: number; bestAccuracy: number; passed: boolean; tempo: number }[];
  trainer: { level: number; series: number; bestAccuracy: number; passed: boolean }[];
}

const dayOf = (secs: number) => todayKey(new Date(secs * 1000));
const round2 = (x: number) => Math.round(x * 100) / 100;

/** История → дни (новые сверху), только дни, когда что-то играли. */
export function diaryDays(j: Journal): DiaryDay[] {
  const days = new Map<string, DiaryDay>();
  const day = (key: string) => {
    let d = days.get(key);
    if (!d) days.set(key, (d = { date: key, minutes: 0, pieces: [], exercises: [], trainer: [] }));
    return d;
  };
  for (const [bucket, secs] of j.play) day(dayOf(bucket)).minutes += secs / 60;
  for (const a of j.attempts) {
    const d = day(dayOf(a.finishedAt));
    let p = d.pieces.find((x) => x.id === a.piece);
    if (!p) d.pieces.push((p = { id: a.piece, title: a.title, fragments: [] }));
    const bars = `${a.from}-${a.to}`;
    let f = p.fragments.find((x) => x.bars === bars);
    if (!f) p.fragments.push((f = { bars, level: a.level, attempts: 0, bestAccuracy: 0, tempo: 0, hardBars: [] }));
    f.attempts++;
    f.level = Math.max(f.level ?? 0, a.level ?? 0) || f.level;
    f.bestAccuracy = Math.max(f.bestAccuracy, a.accuracy);
    f.tempo = Math.max(f.tempo, a.tempo);
    f.hardBars = [...new Set([...f.hardBars, ...a.hard])].sort((x, y) => x - y);
  }
  for (const e of j.exercises) {
    const d = day(dayOf(e.finishedAt));
    let x = d.exercises.find((y) => y.id === e.exercise);
    if (!x) d.exercises.push((x = { id: e.exercise, title: recordTitle(e.exercise), attempts: 0, bestAccuracy: 0, passed: false, tempo: 0 }));
    x.attempts++;
    x.bestAccuracy = Math.max(x.bestAccuracy, e.accuracy);
    x.passed ||= e.passed;
    x.tempo = Math.max(x.tempo, e.tempo);
  }
  for (const t of j.trainer) {
    const d = day(dayOf(t.finishedAt));
    let x = d.trainer.find((y) => y.level === t.level);
    if (!x) d.trainer.push((x = { level: t.level, series: 0, bestAccuracy: 0, passed: false }));
    x.series++;
    x.bestAccuracy = Math.max(x.bestAccuracy, t.notes ? t.firstTry / t.notes : 0);
    x.passed ||= t.passed;
  }
  return [...days.values()].map((d) => ({ ...d, minutes: Math.round(d.minutes) })).sort((a, b) => b.date.localeCompare(a.date));
}

/** Неделя ISO: «2026-W41». */
export function isoWeek(date: string): string {
  const d = new Date(`${date}T12:00:00Z`);
  const dow = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - dow + 3);
  const year = d.getUTCFullYear();
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const week = 1 + Math.round(((d.getTime() - jan4.getTime()) / 86400000 - 3 + ((jan4.getUTCDay() + 6) % 7)) / 7);
  return `${year}-W${String(week).padStart(2, "0")}`;
}

/** Дни → YAML дневника (снейк-кейс полей, доли — с двумя знаками). */
export function diaryYaml(days: DiaryDay[], goal: Goal | null, from: string, to: string): string {
  const doc = {
    format: JOURNAL_FORMAT,
    from,
    to,
    ...(goal && (goal.text || goal.minutesPerDay) ? { goal: { text: goal.text || undefined, minutes_per_day: goal.minutesPerDay ?? undefined } } : {}),
    days: [...days]
      .sort((a, b) => a.date.localeCompare(b.date))
      .map((d) => ({
        date: d.date,
        minutes: d.minutes,
        ...(d.pieces.length
          ? {
              pieces: d.pieces.map((p) => ({
                id: p.id,
                title: p.title,
                fragments: p.fragments.map((f) => ({
                  bars: f.bars,
                  ...(f.level !== null ? { level: f.level } : {}),
                  attempts: f.attempts,
                  best_accuracy: round2(f.bestAccuracy),
                  tempo: round2(f.tempo),
                  ...(f.hardBars.length ? { hard_bars: f.hardBars } : {}),
                })),
              })),
            }
          : {}),
        ...(d.exercises.length
          ? { exercises: d.exercises.map((e) => ({ id: e.id, title: e.title, attempts: e.attempts, best_accuracy: round2(e.bestAccuracy), tempo: round2(e.tempo), passed: e.passed })) }
          : {}),
        ...(d.trainer.length ? { note_trainer: d.trainer.map((t) => ({ level: t.level, series: t.series, best_accuracy: round2(t.bestAccuracy), passed: t.passed })) } : {}),
      })),
  };
  return stringify(doc, { lineWidth: 0 });
}

/** Недельные файлы: имя «2026-W41.yaml» → текст. */
export function weeklyFiles(days: DiaryDay[], goal: Goal | null): Map<string, string> {
  const byWeek = new Map<string, DiaryDay[]>();
  for (const d of days) {
    const w = isoWeek(d.date);
    byWeek.set(w, [...(byWeek.get(w) ?? []), d]);
  }
  const out = new Map<string, string>();
  for (const [w, list] of byWeek) {
    const dates = list.map((d) => d.date).sort();
    out.set(`${w}.yaml`, diaryYaml(list, goal, dates[0], dates[dates.length - 1]));
  }
  return out;
}

export function goalFromYaml(doc: unknown): Goal | null {
  if (!doc || typeof doc !== "object") return null;
  const g = doc as Record<string, unknown>;
  const m = Number(g.minutes_per_day);
  return { text: g.text ? String(g.text) : "", minutesPerDay: Number.isFinite(m) && m > 0 ? m : null };
}

export function goalYaml(goal: Goal): string {
  return stringify({ text: goal.text, minutes_per_day: goal.minutesPerDay ?? undefined }, { lineWidth: 0 });
}

const INST_NAME: Record<CourseInstrument, string> = { piano: "фортепиано", guitar: "гитара", bass: "бас", drums: "барабаны", code: "музыка кодом (Strudel)" };

/** Описание формата плана для Claude (тот же текст лежит в docs/journal-format.md). */
export function planFormatText(instrument: CourseInstrument): string {
  return `Формат плана — YAML (или JSON с теми же полями):

\`\`\`yaml
format: ${PLAN_FORMAT}
title: "Короткое название плана"
goal: "Чего хотим добиться"          # необязательно
instrument: ${instrument}             # piano | guitar | bass | drums
lessons:                              # свои уроки: 4–8 шагов, 20–30 минут
  - id: week1-a                       # латиница, цифры, дефис
    title: "Название урока"
    goal: "Чему учит урок"
    steps:
      - theory: staff                 # шаг — одна запись из каталога ниже
      - exercise: major-C-rh
        target: { tempo: 0.8, accuracy: 0.95 }   # необязательно: цель, показывается у шага
        note: "Медленно, следить за 4-м пальцем"  # необязательно
      - piece: fur-elise
        hands: right
plan:                                 # что делать по дням
  - date: 2026-10-07                  # ГГГГ-ММ-ДД
    lesson: week1-a                   # свой урок (или список)
  - date: 2026-10-08
    course: piano-17                  # урок курса приложения (или список)
    steps:                            # и/или отдельные шаги
      - ear: interval-2
    note: "Короткий день — 15 минут"
\`\`\`

Шаг засчитывается по правилам приложения (упражнение — «Засчитано», пьеса — сыграна в режиме ожидания почти без ошибок, теория — прочитана). Используй только записи из каталога.`;
}

/** Запрос для Claude: просьба, цель, формат, каталог для инструмента, дневник. */
export function claudePrompt(o: { instrument: CourseInstrument; goal: Goal | null; diary: string; weeks: number; planWeeks: number }): string {
  const goal = o.goal && (o.goal.text || o.goal.minutesPerDay) ? `${o.goal.text || "—"}${o.goal.minutesPerDay ? `; занимаюсь около ${o.goal.minutesPerDay} минут в день` : ""}` : "не указана — предложи сам по дневнику";
  return `Я учусь играть (${INST_NAME[o.instrument]}) в приложении MIDI Teacher. Ниже — моя цель, дневник занятий за последние ${o.weeks} нед. и каталог заданий приложения.
Составь план занятий на ${o.planWeeks} нед. начиная с ${todayKey()}: свои уроки и план по дням. Учитывай, что получается и что даётся трудно (best_accuracy, hard_bars, passed), чередуй новое и повторение, не перегружай.
Ответь одним блоком YAML в формате ниже, без пояснений вокруг.

## Цель
${goal}

## ${planFormatText(o.instrument)}

## Каталог заданий (${INST_NAME[o.instrument]})
${catalogText(o.instrument)}

## Дневник
\`\`\`yaml
${o.diary.trimEnd()}
\`\`\`
`;
}
