// Свои уроки и план по дням из YAML/JSON (формат «midi-teacher/plan@1»): то, что составил Claude или сам
// ученик. Шаг урока — ссылка на задание приложения, как в курсе; приложение проверяет ссылки и показывает
// ошибки построчно. Каталог заданий для Claude строится из тех же таблиц, что и проверка.

import { parse } from "yaml";
import { BUILTIN_PIECES } from "../pieces";
import { BASS_STYLES, type BassStyle } from "./bassline";
import { ROOT_LEVELS } from "./bassRoot";
import { CHORD_LEVELS } from "./chordDrill";
import { CODE_LESSONS } from "./codeLessons";
import { COURSE, courseLessons, stepExists, stepRecordIds, stepTitle, type CourseInstrument, type CourseLesson, type CourseStep } from "./course";
import { DRUM_EXERCISES } from "./drums";
import { DRUM_SONGS } from "./drumSongs";
import { EAR_LEVELS, earLevelId } from "./ear";
import { EXERCISES } from "./exercises";
import { FRET_LEVELS } from "./fretboard";
import { GTR_CHORD_LEVELS } from "./guitarChordDrill";
import { GTR_EXERCISES } from "./guitarExercises";
import { ECHO_LEVELS, JAM_LESSONS } from "./jam";
import { READ_LEVELS } from "./reading";
import { RHYTHM_BY_KEY } from "./rhythm";
import { BUILTIN_SONGS, type Style } from "./songs";
import { patternsFor } from "./strum";
import { CARDS } from "./theory";

export const PLAN_FORMAT = "midi-teacher/plan@1";
export const PLAN_FILE = "план.yaml";

export interface PlanStep {
  step: CourseStep;
  /** Цель и пояснение из файла — показываются у шага. */
  note?: string;
  target?: string;
}

export interface PlanLesson extends CourseLesson {
  planSteps: PlanStep[];
}

export interface PlanDay {
  date: string;
  lessons: string[];
  course: string[];
  steps: PlanStep[];
  note?: string;
}

export interface Plan {
  title: string;
  goal?: string;
  instrument: CourseInstrument;
  lessons: PlanLesson[];
  days: PlanDay[];
}

export interface PlanParse {
  plan: Plan | null;
  errors: string[];
  warnings: string[];
}

const INSTRUMENTS: CourseInstrument[] = ["piano", "guitar", "bass", "drums", "code"];
const STYLES: Style[] = ["block", "oompah", "alberti"];

/** Ключ шага в файле → шаг курса (id дополняются привычными приставками). */
export function stepFromYaml(o: Record<string, unknown>): CourseStep | string {
  const str = (v: unknown) => (v === undefined || v === null ? "" : String(v).trim());
  const num = (v: unknown) => Number(v);
  const pre = (p: string, v: string) => (v.startsWith(p) ? v : p + v);
  if ("theory" in o) return { kind: "theory", card: str(o.theory) };
  if ("notes" in o) return { kind: "notes", level: num(o.notes) };
  if ("exercise" in o) return { kind: "exercise", id: str(o.exercise) };
  if ("guitar" in o || "gtr" in o) return { kind: "gtr", id: str(o.guitar ?? o.gtr) };
  if ("drum" in o) return { kind: "drum", id: pre("drum-", str(o.drum)) };
  if ("read" in o) return { kind: "read", level: num(o.read) };
  if ("rhythm" in o) return { kind: "rhythm", key: pre("rhythm-", str(o.rhythm)) };
  if ("chords" in o) return { kind: "chords", level: num(o.chords) };
  if ("guitar_chords" in o) return { kind: "gchord", level: num(o.guitar_chords) };
  if ("fret" in o) return { kind: "fret", level: num(o.fret) };
  if ("ear" in o) return { kind: "ear", id: pre("ear-", str(o.ear)) };
  if ("root" in o) return { kind: "root", level: num(o.root) };
  if ("echo" in o) return { kind: "echo", level: num(o.echo) };
  if ("jam" in o) return { kind: "jam", lesson: num(o.jam) };
  if ("piece" in o) {
    const hands = str(o.hands);
    if (hands && !["right", "left", "both"].includes(hands)) return `hands: «${hands}» — нужно right, left или both`;
    return { kind: "piece", id: pre("builtin:", str(o.piece)), hands: (hands || undefined) as "right" | "left" | "both" | undefined };
  }
  if ("song" in o) {
    const style = str(o.style);
    if (style && !STYLES.includes(style as Style)) return `style: «${style}» — нужно block, oompah или alberti`;
    return {
      kind: "song",
      id: pre("builtin-", str(o.song)),
      style: (style || undefined) as Style | undefined,
      strum: str(o.strum) || undefined,
      bass: (str(o.bass) || undefined) as BassStyle | undefined,
    };
  }
  if ("drum_song" in o) return { kind: "dsong", id: pre("drum-song-", str(o.drum_song)) };
  if ("code" in o) return { kind: "code", id: pre("code-", str(o.code)) };
  return `непонятный шаг: ${Object.keys(o).join(", ") || "пусто"}`;
}

/** Шаг курса → запись в файле (обратное к `stepFromYaml`, короткие id). */
export function stepToYaml(s: CourseStep): Record<string, string | number> {
  switch (s.kind) {
    case "theory":
      return { theory: s.card };
    case "notes":
      return { notes: s.level };
    case "exercise":
      return { exercise: s.id };
    case "gtr":
      return { guitar: s.id };
    case "drum":
      return { drum: s.id.replace(/^drum-/, "") };
    case "read":
      return { read: s.level };
    case "rhythm":
      return { rhythm: s.key.replace(/^rhythm-/, "") };
    case "chords":
      return { chords: s.level };
    case "gchord":
      return { guitar_chords: s.level };
    case "fret":
      return { fret: s.level };
    case "ear":
      return { ear: s.id.replace(/^ear-/, "") };
    case "root":
      return { root: s.level };
    case "echo":
      return { echo: s.level };
    case "jam":
      return { jam: s.lesson };
    case "piece":
      return s.hands ? { piece: s.id.replace(/^builtin:/, ""), hands: s.hands } : { piece: s.id.replace(/^builtin:/, "") };
    case "song": {
      const out: Record<string, string> = { song: s.id.replace(/^builtin-/, "") };
      if (s.style) out.style = s.style;
      if (s.strum) out.strum = s.strum;
      if (s.bass) out.bass = s.bass;
      return out;
    }
    case "dsong":
      return { drum_song: s.id.replace(/^drum-song-/, "") };
    case "code":
      return { code: s.id.replace(/^code-/, "") };
  }
}

const isDate = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
const asList = (v: unknown): unknown[] => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);

function parseSteps(raw: unknown, where: string, instrument: CourseInstrument, errors: string[]): PlanStep[] {
  const out: PlanStep[] = [];
  asList(raw).forEach((item, i) => {
    const at = `${where}[${i + 1}]`;
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      errors.push(`${at}: шаг должен быть записью вида «exercise: major-C-rh»`);
      return;
    }
    const o = item as Record<string, unknown>;
    const step = stepFromYaml(o);
    if (typeof step === "string") {
      errors.push(`${at}: ${step}`);
      return;
    }
    if (!stepExists(step, instrument)) {
      errors.push(`${at}: нет такого задания — ${JSON.stringify(stepToYaml(step))} (${instrument})`);
      return;
    }
    const target = o.target && typeof o.target === "object" ? targetText(o.target as Record<string, unknown>) : o.target ? String(o.target) : undefined;
    out.push({ step, note: o.note ? String(o.note) : undefined, target });
  });
  return out;
}

function targetText(t: Record<string, unknown>): string {
  const parts: string[] = [];
  if (t.tempo !== undefined) parts.push(`темп ${Math.round(Number(t.tempo) * (Number(t.tempo) <= 2 ? 100 : 1))}%`);
  if (t.accuracy !== undefined) parts.push(`точность ${Math.round(Number(t.accuracy) * (Number(t.accuracy) <= 1 ? 100 : 1))}%`);
  for (const [k, v] of Object.entries(t)) if (k !== "tempo" && k !== "accuracy") parts.push(`${k}: ${String(v)}`);
  return parts.join(", ");
}

/** Текст файла (YAML или JSON) → план; ошибки и предупреждения — по-русски, с местом в файле. */
export function parsePlan(text: string): PlanParse {
  const errors: string[] = [];
  const warnings: string[] = [];
  let doc: unknown;
  try {
    doc = parse(text);
  } catch (e) {
    return { plan: null, errors: [`не читается как YAML/JSON: ${(e as Error).message.split("\n")[0]}`], warnings };
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return { plan: null, errors: ["ожидается запись с полями title, lessons, plan"], warnings };
  const d = doc as Record<string, unknown>;
  if (d.format && d.format !== PLAN_FORMAT) warnings.push(`format: «${String(d.format)}», ожидается «${PLAN_FORMAT}» — читаю как есть`);
  const instrument = (d.instrument ? String(d.instrument) : "piano") as CourseInstrument;
  if (!INSTRUMENTS.includes(instrument)) return { plan: null, errors: [`instrument: «${instrument}» — нужно piano, guitar, bass или drums`], warnings };
  const known = new Set(["format", "title", "goal", "instrument", "lessons", "plan"]);
  for (const k of Object.keys(d)) if (!known.has(k)) warnings.push(`поле «${k}» не используется`);

  const lessons: PlanLesson[] = [];
  const ids = new Set<string>();
  asList(d.lessons).forEach((raw, i) => {
    const at = `lessons[${i + 1}]`;
    if (!raw || typeof raw !== "object") {
      errors.push(`${at}: урок должен быть записью с id, title и steps`);
      return;
    }
    const l = raw as Record<string, unknown>;
    const id = l.id ? String(l.id) : `lesson-${i + 1}`;
    if (!l.id) warnings.push(`${at}: нет id — назван «${id}»`);
    if (ids.has(id)) errors.push(`${at}: id «${id}» повторяется`);
    ids.add(id);
    const planSteps = parseSteps(l.steps, `${at}.steps`, instrument, errors);
    if (!asList(l.steps).length) errors.push(`${at}: в уроке нет шагов`);
    lessons.push({ id, title: l.title ? String(l.title) : id, goal: l.goal ? String(l.goal) : "", steps: planSteps.map((s) => s.step), planSteps });
  });

  const courseIds = new Set(courseLessons(instrument).map((l) => l.id));
  const days: PlanDay[] = [];
  asList(d.plan).forEach((raw, i) => {
    const at = `plan[${i + 1}]`;
    if (!raw || typeof raw !== "object") {
      errors.push(`${at}: день должен быть записью с date`);
      return;
    }
    const p = raw as Record<string, unknown>;
    const date = p.date instanceof Date ? p.date.toISOString().slice(0, 10) : String(p.date ?? "");
    if (!isDate(date)) {
      errors.push(`${at}: date «${date}» — нужна дата ГГГГ-ММ-ДД`);
      return;
    }
    const dayLessons = asList(p.lesson ?? p.lessons).map(String);
    for (const l of dayLessons) if (!ids.has(l)) errors.push(`${at}: нет урока «${l}» в lessons`);
    const course = asList(p.course).map(String);
    for (const c of course) if (!courseIds.has(c)) errors.push(`${at}: нет урока курса «${c}» (${instrument})`);
    const steps = parseSteps(p.steps, `${at}.steps`, instrument, errors);
    if (!dayLessons.length && !course.length && !steps.length && !p.note) warnings.push(`${at}: пустой день`);
    days.push({ date, lessons: dayLessons, course, steps, note: p.note ? String(p.note) : undefined });
  });
  days.sort((a, b) => a.date.localeCompare(b.date));
  if (!lessons.length && !days.length) errors.push("нет ни уроков (lessons), ни дней плана (plan)");

  if (errors.length) return { plan: null, errors, warnings };
  return { plan: { title: d.title ? String(d.title) : "Мой план", goal: d.goal ? String(d.goal) : undefined, instrument, lessons, days }, errors, warnings };
}

/** Шаги дня плана: свои уроки, уроки курса и отдельные шаги — по порядку. */
export function dayPlanSteps(plan: Plan, day: PlanDay): PlanStep[] {
  const out: PlanStep[] = [];
  for (const id of day.lessons) out.push(...(plan.lessons.find((l) => l.id === id)?.planSteps ?? []));
  for (const id of day.course) out.push(...(COURSE[plan.instrument].flatMap((m) => m.lessons).find((l) => l.id === id)?.steps.map((step) => ({ step })) ?? []));
  out.push(...day.steps);
  return out;
}

export function todayKey(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// --- Каталог для Claude ---

export interface CatalogGroup {
  title: string;
  /** Как писать шаг: «exercise: <id>». */
  key: string;
  items: { yaml: Record<string, string | number>; title: string }[];
}

/** Что можно указать в шагах для инструмента: группы с примерами записи и названиями. */
export function planCatalog(instrument: CourseInstrument): CatalogGroup[] {
  const g = (title: string, key: string, steps: CourseStep[]): CatalogGroup => ({
    title,
    key,
    items: steps.filter((s) => stepExists(s, instrument)).map((s) => ({ yaml: stepToYaml(s), title: stepTitle(s, instrument).replace(/^[^:]+: /, "") })),
  });
  const theory = g("Карточки теории", "theory", CARDS.map((c) => ({ kind: "theory", card: c.id })));
  const ear = g("Слух", "ear", EAR_LEVELS.map((l) => ({ kind: "ear", id: earLevelId(l) })));
  const echo = g("Повтори за мной", "echo", ECHO_LEVELS.map((l) => ({ kind: "echo", level: l.id })));
  const jam = g("Уроки импровизации", "jam", JAM_LESSONS.map((l) => ({ kind: "jam", lesson: l.id })));
  const rhythm = g("Ритм", "rhythm", [...RHYTHM_BY_KEY.keys()].map((key) => ({ kind: "rhythm", key })));
  const songs = (o: (s: (typeof BUILTIN_SONGS)[number]) => Partial<Extract<CourseStep, { kind: "song" }>>[]) =>
    BUILTIN_SONGS.flatMap((s) => o(s).map((x) => ({ kind: "song" as const, id: s.id, ...x })));
  switch (instrument) {
    case "piano":
      return [
        theory,
        g("Тренажёр нот (ступени)", "notes", Array.from({ length: 9 }, (_, i) => ({ kind: "notes", level: i + 1 }))),
        g("Упражнения", "exercise", EXERCISES.map((e) => ({ kind: "exercise", id: e.id }))),
        g("Чтение с листа", "read", READ_LEVELS.map((l) => ({ kind: "read", level: l.id }))),
        rhythm,
        g("Аккорды", "chords", CHORD_LEVELS.map((l) => ({ kind: "chords", level: l.id }))),
        g("Пьесы (hands: right | left | both)", "piece", BUILTIN_PIECES.map((p) => ({ kind: "piece", id: p.id }))),
        g("Песни по буквам (style: block | oompah | alberti)", "song", songs(() => STYLES.map((style) => ({ style })))),
        ear,
        echo,
        jam,
      ];
    case "guitar":
      return [
        theory,
        g("Упражнения и пьесы для гитары", "guitar", GTR_EXERCISES.filter((e) => e.instrument === "guitar").map((e) => ({ kind: "gtr", id: e.id }))),
        g("Аккорды на гитаре", "guitar_chords", GTR_CHORD_LEVELS.map((l) => ({ kind: "gchord", level: l.id }))),
        g("Гриф", "fret", FRET_LEVELS.guitar.map((l) => ({ kind: "fret", level: l.id }))),
        g("Песни боем (strum)", "song", songs((s) => patternsFor(s).map((p) => ({ strum: p.id })))),
        ear,
        echo,
        jam,
      ];
    case "bass":
      return [
        theory,
        g("Упражнения для баса", "guitar", GTR_EXERCISES.filter((e) => e.instrument === "bass").map((e) => ({ kind: "gtr", id: e.id }))),
        g("Найди основной тон", "root", ROOT_LEVELS.map((l) => ({ kind: "root", level: l.id }))),
        g("Гриф", "fret", FRET_LEVELS.bass.map((l) => ({ kind: "fret", level: l.id }))),
        g("Басовые линии к песням (bass)", "song", songs(() => BASS_STYLES.map((b) => ({ bass: b.id })))),
        ear,
        echo,
        jam,
      ];
    case "drums":
      return [
        theory,
        g("Грувы и рудименты", "drum", DRUM_EXERCISES.map((e) => ({ kind: "drum", id: e.id }))),
        g("Песни на барабанах", "drum_song", DRUM_SONGS.map((d) => ({ kind: "dsong", id: d.id }))),
        rhythm,
        ear,
      ];
    case "code":
      return [g("Уроки «Музыка кодом» (Strudel)", "code", CODE_LESSONS.map((l) => ({ kind: "code", id: l.id })))];
  }
}

/** Каталог текстом (строка — запись шага и название): для запроса к Claude. */
export function catalogText(instrument: CourseInstrument): string {
  const lines: string[] = [];
  for (const grp of planCatalog(instrument)) {
    lines.push(`### ${grp.title}`);
    for (const it of grp.items)
      lines.push(
        `- ${Object.entries(it.yaml)
          .map(([k, v]) => `${k}: ${v}`)
          .join(", ")} — ${it.title}`,
      );
  }
  lines.push("### Уроки курса (в дне плана: course: <id>)");
  for (const m of COURSE[instrument]) for (const l of m.lessons) lines.push(`- ${l.id} — ${m.title}: ${l.title}`);
  return lines.join("\n");
}

/** Название записи статистики по id (для дневника): ищем шаг каталога или курса с таким id результата. */
let titleIndex: Map<string, string> | null = null;
export function recordTitle(id: string): string {
  if (!titleIndex) {
    titleIndex = new Map();
    for (const inst of INSTRUMENTS) {
      const steps = [...planCatalog(inst).flatMap((g) => g.items.map((it) => stepFromYaml(it.yaml) as CourseStep)), ...courseLessons(inst).flatMap((l) => l.steps)];
      for (const s of steps) for (const rid of stepRecordIds(s, inst)) if (!titleIndex.has(rid)) titleIndex.set(rid, stepTitle(s, inst));
    }
  }
  return titleIndex.get(id) ?? id;
}
