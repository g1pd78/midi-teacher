// Курс: путь обучения для фортепиано, гитары, баса и барабанов. Урок — 6–8 шагов из уже готовых
// заданий (карточка теории, упражнение, тренажёр, пьеса или песня, слух, джем); модуль — несколько
// уроков и короткая проверка «я это уже умею». Статус шагов считается по статистике упражнений.

import type { LevelStat } from "../api";
import { BUILTIN_PIECES } from "../pieces";
import { BASS_STYLE_BY_ID, type BassStyle } from "./bassline";
import { ROOT_LEVELS, rootLevelId } from "./bassRoot";
import { CHORD_LEVELS, chordLevelId } from "./chordDrill";
import { DRUM_EXERCISE_BY_ID } from "./drums";
import { EAR_KINDS, EAR_LEVELS, earLevelId } from "./ear";
import { EXERCISE_BY_ID, type ExerciseStatView } from "./exercises";
import { FRET_LEVELS, fretLevelId } from "./fretboard";
import { GTR_CHORD_LEVELS, gtrChordLevelId } from "./guitarChordDrill";
import { GTR_EXERCISE_BY_ID } from "./guitarExercises";
import { ECHO_LEVELS, JAM_LESSONS, echoLevelId, jamLessonId } from "./jam";
import { READ_LEVEL_BY_ID, readId, readWaitId } from "./reading";
import { RHYTHM_BY_KEY } from "./rhythm";
import { BUILTIN_SONGS, STYLE_NAME, type Style } from "./songs";
import { STRUM_BY_ID } from "./strum";
import { CARD_BY_ID } from "./theory";

export type CourseInstrument = "piano" | "guitar" | "bass" | "drums";

/** Инструмент курса (выбор запоминается на этом компьютере). */
export const COURSE_INSTRUMENT_KEY = "mt-course-instrument";
export function storedCourseInstrument(): CourseInstrument {
  try {
    const v = localStorage.getItem(COURSE_INSTRUMENT_KEY);
    return v === "guitar" || v === "bass" || v === "drums" ? v : "piano";
  } catch {
    return "piano";
  }
}

export const COURSE_INSTRUMENTS: { id: CourseInstrument; name: string }[] = [
  { id: "piano", name: "Фортепиано" },
  { id: "guitar", name: "Гитара" },
  { id: "bass", name: "Бас" },
  { id: "drums", name: "Барабаны" },
];

/** Шаг урока — ссылка на готовое задание приложения. */
export type CourseStep =
  | { kind: "theory"; card: string }
  | { kind: "notes"; level: number }
  | { kind: "exercise"; id: string }
  | { kind: "gtr"; id: string }
  | { kind: "drum"; id: string }
  | { kind: "read"; level: number }
  | { kind: "rhythm"; key: string }
  | { kind: "chords"; level: number }
  | { kind: "gchord"; level: number }
  | { kind: "fret"; level: number }
  | { kind: "ear"; id: string }
  | { kind: "root"; level: number }
  | { kind: "echo"; level: number }
  | { kind: "jam"; lesson: number }
  | { kind: "piece"; id: string; hands?: "right" | "left" | "both" }
  | { kind: "song"; id: string; style?: Style; strum?: string; bass?: BassStyle };

export interface CourseLesson {
  /** «piano-3». */
  id: string;
  title: string;
  /** Чему учит урок — одна-две фразы. */
  goal: string;
  steps: CourseStep[];
}

export interface CourseModule {
  id: string;
  title: string;
  description: string;
  lessons: CourseLesson[];
  /** Проверка «я это уже умею»: пройти — и модуль засчитан. */
  check: CourseStep[];
}

// --- Шаги коротко ---

const th = (card: string): CourseStep => ({ kind: "theory", card });
const notes = (level: number): CourseStep => ({ kind: "notes", level });
const ex = (id: string): CourseStep => ({ kind: "exercise", id });
const gtr = (id: string): CourseStep => ({ kind: "gtr", id });
const drum = (id: string): CourseStep => ({ kind: "drum", id: `drum-${id}` });
const read = (level: number): CourseStep => ({ kind: "read", level });
const rhy = (key: string): CourseStep => ({ kind: "rhythm", key: `rhythm-${key}` });
const chords = (level: number): CourseStep => ({ kind: "chords", level });
const gchord = (level: number): CourseStep => ({ kind: "gchord", level });
const fret = (level: number): CourseStep => ({ kind: "fret", level });
const ear = (id: string): CourseStep => ({ kind: "ear", id: `ear-${id}` });
const root = (level: number): CourseStep => ({ kind: "root", level });
const echo = (level: number): CourseStep => ({ kind: "echo", level });
const jam = (lesson: number): CourseStep => ({ kind: "jam", lesson });
const piece = (id: string, hands?: "right" | "left" | "both"): CourseStep => ({ kind: "piece", id: `builtin:${id}`, hands });
const song = (id: string, o: { style?: Style; strum?: string; bass?: BassStyle } = {}): CourseStep => ({ kind: "song", id: `builtin-${id}`, ...o });

function lessons(prefix: string, start: number, list: [string, string, CourseStep[]][]): CourseLesson[] {
  return list.map(([title, goal, steps], i) => ({ id: `${prefix}-${start + i}`, title, goal, steps }));
}

// --- Программа ---

const PIANO: CourseModule[] = [
  {
    id: "piano-m1",
    title: "Знакомство с клавиатурой",
    description: "Нотный стан, позиция «до», первые песенки каждой рукой и вместе.",
    lessons: lessons("piano", 1, [
      [
        "Позиция «до», правая рука",
        "Пять пальцев на до–ре–ми–фа–соль, первые ноты на стане и первая песенка правой рукой.",
        [th("staff"), th("treble-clef"), th("fingering"), notes(1), ex("five-C-updown-right"), rhy("line-1"), piece("twinkle", "right"), ear("interval-1")],
      ],
      [
        "Левая рука и басовый ключ",
        "Та же позиция левой рукой, басовый ключ и аккомпанемент по буквам.",
        [th("bass-clef"), th("durations"), notes(4), ex("five-C-updown-left"), read(1), song("twinkle", { style: "block" }), ear("chord-1")],
      ],
      [
        "Обе руки вместе",
        "Большой нотный стан, обе руки в позиции «до», песенка двумя руками.",
        [th("grand-staff"), th("rests"), ex("five-C-updown-both"), read(2), rhy("line-2"), piece("frere-jacques", "both"), ear("interval-2")],
      ],
    ]),
    check: [ex("five-C-updown-both"), read(2), piece("frere-jacques", "both")],
  },
  {
    id: "piano-m2",
    title: "Ритм и длительности",
    description: "Восьмые, точка, паузы и размер 3/4; первая октава целиком.",
    lessons: lessons("piano", 4, [
      [
        "Восьмые",
        "Две восьмые на долю, считаем «раз-и», новая позиция «соль».",
        [th("eighths"), rhy("line-3"), notes(2), ex("five-G-updown-right"), read(3), piece("au-clair", "both"), ear("rhythm-1")],
      ],
      [
        "Точка и лига",
        "Четверть с точкой, ноты под лигой, «Ода к радости».",
        [th("dot"), th("tie"), rhy("line-4"), ex("five-G-updown-both"), read(7), piece("ode-to-joy", "both"), ear("melody-1")],
      ],
      [
        "Размер 3/4",
        "Вальсовый счёт на три, бас + аккорд левой рукой.",
        [th("meter"), th("barlines"), rhy("line-6"), ex("five-F-updown-both"), song("birthday", { style: "oompah" }), piece("vo-pole-bereza", "both"), echo(1)],
      ],
    ]),
    check: [rhy("line-4"), read(7), piece("ode-to-joy", "both")],
  },
  {
    id: "piano-m3",
    title: "Гаммы и аккорды",
    description: "Мажорные гаммы, знаки при ключе, трезвучия и песни по буквам.",
    lessons: lessons("piano", 7, [
      [
        "Гамма до мажор",
        "Подкладывание первого пальца, аккорды до, фа, соль.",
        [th("chord"), ex("major-C-rh"), ex("major-C-lh"), chords(1), notes(3), song("jingle", { style: "oompah" }), ear("chord-2")],
      ],
      [
        "Диезы, бемоли и соль мажор",
        "Знаки альтерации и при ключе, гамма соль мажор, минорные аккорды.",
        [th("sharp-flat"), th("key-signature"), ex("major-G-rh"), read(8), chords(2), piece("jingle-bells", "both"), ear("degree-1")],
      ],
      [
        "Арпеджио и фактура Альберти",
        "Звуки аккорда по очереди: арпеджио и аккомпанемент Альберти.",
        [ex("arp-C-rh"), ex("major-C-parallel"), chords(3), notes(5), song("lune", { style: "alberti" }), ear("interval-3"), echo(2)],
      ],
    ]),
    check: [ex("major-C-parallel"), chords(3), read(8)],
  },
  {
    id: "piano-m4",
    title: "Две руки независимо",
    description: "Разные ритмы в руках, басовый ключ целиком, обращения аккордов, первый джем.",
    lessons: lessons("piano", 10, [
      [
        "Руки по очереди",
        "Ритм двумя руками, упражнения Ганона, «Калинка».",
        [rhy("hands-1"), ex("hanon-1-both"), notes(6), read(6), piece("kalinka", "both"), ear("interval-4")],
      ],
      [
        "Обращения",
        "Аккорды с другим басом, фа мажор, колыбельная Брамса.",
        [rhy("hands-2"), ex("five-D-updown-both"), chords(6), read(9), piece("brahms-lullaby", "both"), ear("chord-3")],
      ],
      [
        "Динамика и первый джем",
        "Громко-тихо, ля минор, импровизация по нотам гаммы.",
        [th("dynamics"), th("hairpins"), ex("minor-a-rh"), notes(7), piece("old-french-song", "both"), jam(1), echo(3)],
      ],
    ]),
    check: [rhy("hands-2"), chords(6), piece("kalinka", "both")],
  },
  {
    id: "piano-m5",
    title: "Первая классика",
    description: "Менуэты из Нотной тетради Анны Магдалены Бах, штрихи, педаль, септаккорды.",
    lessons: lessons("piano", 13, [
      [
        "Менуэт соль мажор",
        "Штрихи легато и стаккато, фа мажор, чтение двумя руками.",
        [th("slur"), th("staccato"), ex("major-F-parallel"), read(10), piece("minuet-g", "both"), ear("degree-3")],
      ],
      [
        "Менуэт соль минор",
        "Минорная гамма двумя руками, септаккорды, добавочные линейки.",
        [notes(8), ex("minor-a-parallel"), ex("hanon-2-both"), chords(7), piece("minuet-gm", "both"), ear("melody-2")],
      ],
      [
        "Педаль и импровизация",
        "Правая педаль, арпеджио двумя руками, блюзовая импровизация.",
        [th("pedal"), notes(9), ex("arp-a-parallel2"), rhy("hands-3"), jam(2), jam(3), echo(4)],
      ],
    ]),
    check: [read(10), chords(7), piece("minuet-g", "both")],
  },
];

const GUITAR: CourseModule[] = [
  {
    id: "guitar-m1",
    title: "Первые шаги",
    description: "Табулатура, открытые струны, «паучок» и первые аккорды.",
    lessons: lessons("guitar", 1, [
      [
        "Табы и открытые струны",
        "Как читать таб, названия струн, пальцы левой руки.",
        [th("tab"), th("strings-frets"), th("left-fingers"), th("tuning"), fret(1), gtr("gtr-spider-1234-5-60"), ear("interval-1")],
      ],
      [
        "Первые аккорды",
        "Схемы аккордов, Em и Am, удар четвертями.",
        [th("chord-shape"), th("strum"), gchord(1), gtr("gtr-strum-quarters-emam-70"), fret(2), gtr("gtr-spider-1234-5-80"), ear("chord-1")],
      ],
      [
        "Смена аккордов",
        "Аккорды D, G, C, восьмые вниз-вверх, первая песня боем.",
        [gchord(2), gtr("gtr-strum-eighths-emam-70"), fret(3), song("ode", { strum: "quarters" }), gtr("gtr-spider-1324-5-60"), ear("interval-2")],
      ],
    ]),
    check: [gchord(2), gtr("gtr-strum-eighths-emam-70"), fret(3)],
  },
  {
    id: "guitar-m2",
    title: "Ритм правой руки",
    description: "Частые схемы боя, вальс и песни боем.",
    lessons: lessons("guitar", 4, [
      [
        "Бой «четвёрка» и «поп»",
        "Две самые частые схемы: рука ходит восьмыми, удары — по схеме.",
        [rhy("line-3"), gtr("gtr-strum-folk-ame-80"), gtr("gtr-strum-pop-gd-80"), gchord(3), song("twinkle", { strum: "pop" }), ear("rhythm-1")],
      ],
      [
        "Четыре аккорда",
        "C – G – Am – F поп-боем, ровная смена.",
        [gtr("gtr-strum-pop-cgamf-90"), gtr("gtr-strum-quarters-gcdg-80"), fret(4), song("jingle", { strum: "pop" }), gtr("gtr-spider-1243-5-60"), ear("chord-2")],
      ],
      [
        "Вальс",
        "Размер 3/4: вниз сильно, дальше вниз-вверх.",
        [th("meter"), gtr("gtr-strum-waltz-cg7-90"), song("birthday", { strum: "waltz" }), gtr("gtr-spider-diag-5-60"), echo(1), ear("rhythm-2")],
      ],
    ]),
    check: [gtr("gtr-strum-pop-cgamf-90"), gtr("gtr-strum-waltz-cg7-90"), gchord(3)],
  },
  {
    id: "guitar-m3",
    title: "Пентатоника и первое соло",
    description: "Минорная пентатоника, приёмы легато, импровизация под аккомпанемент.",
    lessons: lessons("guitar", 7, [
      [
        "Пентатоника ля минор",
        "Квадрат пентатоники в 5-й позиции и первые фразы в джеме.",
        [gtr("gtr-penta-am-updown"), fret(5), jam(1), th("hammer-pull"), gtr("gtr-spider-1234-1-80"), ear("interval-3")],
      ],
      [
        "Легато и слайды",
        "Хаммер, пулл-офф и слайд; пентатоника тройками.",
        [th("slide"), gtr("gtr-penta-am-threes"), jam(2), echo(2), gtr("gtr-groove-rock-90"), ear("melody-1")],
      ],
      [
        "Рок-рифф и глушение",
        "Глушение ладонью, ми минор в открытой позиции.",
        [th("palm-mute"), gtr("gtr-penta-em-updown"), gtr("gtr-groove-boogie-90"), jam(3), fret(6), ear("degree-1")],
      ],
    ]),
    check: [gtr("gtr-penta-am-threes"), jam(1), gtr("gtr-groove-rock-90")],
  },
  {
    id: "guitar-m4",
    title: "Пауэр-аккорды и баррэ",
    description: "Аккорды для рока, баррэ от 6-й и 5-й струны, регги и арпеджио.",
    lessons: lessons("guitar", 10, [
      [
        "Пауэр-аккорды",
        "Основной тон и квинта, рок-бой.",
        [th("power-chord"), gchord(5), gtr("gtr-strum-rock-e5a5-90"), gtr("gtr-groove-rock-110"), ear("chord-3"), echo(3)],
      ],
      [
        "Баррэ",
        "F и Bm, гамма соль мажор в позиции.",
        [th("barre"), gchord(6), gtr("gtr-scale-g-70"), gtr("gtr-strum-folk-cgamem-90"), fret(7), ear("interval-4")],
      ],
      [
        "Регги и арпеджио",
        "Короткие удары на 2 и 4, звуки аккорда по струнам.",
        [gchord(7), gtr("gtr-strum-reggae-amdm-80"), gtr("gtr-arp-am-8"), jam(4), ear("degree-2")],
      ],
    ]),
    check: [gchord(6), gtr("gtr-strum-rock-e5a5-90"), gtr("gtr-scale-g-70")],
  },
  {
    id: "guitar-m5",
    title: "Гаммы и импровизация",
    description: "Гаммы в позиции, мотив и смена гаммы под аккорд, фанк.",
    lessons: lessons("guitar", 13, [
      [
        "Гамма ля минор",
        "Натуральный минор в позиции, мотив в импровизации.",
        [gtr("gtr-scale-am-70"), fret(8), jam(5), echo(4), ear("melody-2")],
      ],
      [
        "Под каждый аккорд — своя гамма",
        "До мажор в позиции, баррэ от 5-й струны, блюз со сменой гаммы.",
        [gtr("gtr-scale-c-70"), gchord(8), jam(6), gtr("gtr-arp-c-8"), ear("degree-3")],
      ],
      [
        "Фанк и шестнадцатые",
        "Шестнадцатые правой рукой, фанковый рифф.",
        [gtr("gtr-groove-funk-80"), gtr("gtr-strum-sixteenths-emam-60"), gchord(9), echo(5), ear("rhythm-3")],
      ],
    ]),
    check: [gtr("gtr-scale-am-70"), jam(5), gtr("gtr-groove-funk-80")],
  },
];

const BASS: CourseModule[] = [
  {
    id: "bass-m1",
    title: "Первые шаги",
    description: "Табы, пальцы правой руки, основной тон под барабаны.",
    lessons: lessons("bass", 1, [
      [
        "Табы и пальцы i–m",
        "Как читать таб, открытые струны, чередование пальцев правой руки.",
        [th("tab"), th("strings-frets"), th("finger-alt"), fret(1), gtr("bass-tech-alternate-70"), gtr("bass-spider-1234-5-60"), ear("interval-1")],
      ],
      [
        "Основной тон",
        "Восьмые по основным тонам вместе с бочкой, найди основной тон по букве.",
        [th("groove"), fret(2), gtr("bass-groove-roots-90"), root(1), song("ode", { bass: "roots" }), gtr("bass-spider-1324-5-60"), ear("chord-1")],
      ],
      [
        "Тон и квинта",
        "Квинта — на соседней струне на два лада выше; басовая линия по аккордам.",
        [th("bass-line"), root(2), gtr("bass-groove-rootfifth-80"), song("twinkle", { bass: "rootfifth" }), gtr("bass-tech-short-80"), ear("interval-2")],
      ],
    ]),
    check: [gtr("bass-groove-roots-90"), root(2), gtr("bass-groove-rootfifth-80")],
  },
  {
    id: "bass-m2",
    title: "Грув",
    description: "Вместе с бочкой, октавы, проходящие ноты.",
    lessons: lessons("bass", 4, [
      [
        "Вместе с бочкой",
        "Бас и бочка — один удар; оценка «раньше или позже барабанов».",
        [rhy("line-3"), gtr("bass-groove-kick-85"), root(3), song("jingle", { bass: "roots" }), ear("rhythm-1")],
      ],
      [
        "Октавы",
        "Диско-октавы и форма «тон — квинта — октава».",
        [gtr("bass-groove-octaves-100"), gtr("bass-shape-r58-70"), root(4), fret(3), echo(1), ear("chord-2")],
      ],
      [
        "Проходящие ноты",
        "Нота на полтона к следующему аккорду; хаммер и пулл-офф.",
        [gtr("bass-groove-motown-90"), song("lune", { bass: "passing" }), th("hammer-pull"), gtr("bass-tech-hammer-70"), ear("rhythm-2")],
      ],
    ]),
    check: [gtr("bass-groove-kick-85"), gtr("bass-groove-octaves-100"), root(4)],
  },
  {
    id: "bass-m3",
    title: "Формы и гаммы",
    description: "Трезвучия и септаккорды на грифе, пентатоника, шаффл.",
    lessons: lessons("bass", 7, [
      [
        "Мажорное трезвучие",
        "Терция и квинта от основного тона, пентатоника ля минор.",
        [gtr("bass-shape-major-70"), gtr("bass-penta-am-updown"), root(5), jam(1), ear("degree-1")],
      ],
      [
        "Минор и буги",
        "Минорное трезвучие, гамма соль мажор, буги-линия.",
        [gtr("bass-shape-minor-70"), gtr("bass-scale-g-70"), gtr("bass-groove-boogie-90"), fret(4), ear("interval-3")],
      ],
      [
        "Шаффл и септаккорд",
        "«Длинная — короткая» триолью, септима в форме, walking bass.",
        [th("triplet"), gtr("bass-groove-shuffle-80"), gtr("bass-shape-seventh-70"), song("jingle", { bass: "walking" }), echo(2)],
      ],
    ]),
    check: [gtr("bass-shape-minor-70"), gtr("bass-groove-boogie-90"), root(5)],
  },
  {
    id: "bass-m4",
    title: "Стили",
    description: "Регги, синкопы, фанк, слэп; басовые линии по слуху.",
    lessons: lessons("bass", 10, [
      [
        "Регги и слайды",
        "Пауза на «раз», глубокие короткие ноты; основной тон по слуху.",
        [gtr("bass-groove-reggae-75"), th("slide"), gtr("bass-tech-slide-70"), root(6), jam(2), ear("degree-2")],
      ],
      [
        "Синкопы",
        "Ритм 3-3-2, арпеджио, walking bass в блюзе.",
        [rhy("line-5"), gtr("bass-groove-sync-85"), gtr("bass-arp-am-8"), song("birthday", { bass: "walking" }), ear("melody-1")],
      ],
      [
        "Фанк и слэп",
        "Глушёные ноты, большой палец и поп.",
        [th("dead-note"), th("slap"), gtr("bass-groove-funk-80"), gtr("bass-tech-slap-75"), jam(3), echo(3)],
      ],
    ]),
    check: [gtr("bass-groove-sync-85"), gtr("bass-groove-funk-80"), root(6)],
  },
];

const DRUMS: CourseModule[] = [
  {
    id: "drums-m1",
    title: "Пэды и доли",
    description: "Четверти и восьмые, первый рок-бит, одиночные удары руками.",
    lessons: lessons("drums", 1, [
      [
        "Четверти",
        "Бочка, малый и хэт ровно по долям; одиночные удары.",
        [th("durations"), th("meter"), rhy("line-1"), drum("groove-quarters"), drum("groove-hh-quarters"), drum("rud-singles8"), ear("rhythm-1")],
      ],
      [
        "Рок-бит",
        "Хэт восьмыми, бочка и малый — рок-бит; двойки.",
        [th("eighths"), rhy("line-3"), drum("groove-rock"), drum("rud-doubles8"), ear("rhythm-2")],
      ],
      [
        "Бочка на «и» и паузы",
        "Бочка между долями, поп-бит, паузы.",
        [th("rests"), rhy("line-2"), drum("groove-rock-and"), drum("groove-pop"), drum("rud-accents"), ear("rhythm-3")],
      ],
    ]),
    check: [drum("groove-rock"), drum("groove-pop"), rhy("line-3")],
  },
  {
    id: "drums-m2",
    title: "Акценты и шестнадцатые",
    description: "Сила удара, открытый хэт, парадидл, тихие ноты.",
    lessons: lessons("drums", 4, [
      [
        "Акценты",
        "Громкие и обычные удары по хэту; одиночные шестнадцатыми.",
        [th("accent"), drum("groove-hh-accents"), drum("rud-singles16"), rhy("line-7"), ear("rhythm-4")],
      ],
      [
        "Открытый хэт и парадидл",
        "Открыть хэт на «и», парадидл: П-Л-П-П Л-П-Л-Л.",
        [drum("groove-open-hh"), drum("rud-paradiddle"), rhy("line-5"), drum("rud-doubles16"), echo(1)],
      ],
      [
        "Тихие ноты",
        "Призрачные удары по малому, райд и крэш.",
        [th("dynamics"), drum("groove-ghosts"), drum("rud-paradiddle-acc"), drum("groove-ride"), ear("rhythm-2")],
      ],
    ]),
    check: [drum("groove-hh-accents"), drum("rud-paradiddle"), drum("groove-ghosts")],
  },
  {
    id: "drums-m3",
    title: "Грув и сбивки",
    description: "Шестнадцатые на хэте, фанк, шаффл, сбивки по томам.",
    lessons: lessons("drums", 7, [
      [
        "Фанк",
        "Хэт шестнадцатыми, бочка шестнадцатыми.",
        [drum("groove-hh16"), drum("groove-funk"), rhy("line-8"), ear("rhythm-3")],
      ],
      [
        "Шаффл и триоли",
        "Счёт триолями, шаффл.",
        [th("triplet"), drum("rud-triplets"), drum("groove-shuffle"), echo(2)],
      ],
      [
        "Сбивки",
        "Сбивка по томам и крэш на «раз», одиночные по барабанам.",
        [th("repeat"), drum("groove-fill-toms"), drum("groove-fill-crash"), drum("rud-around"), rhy("line-6")],
      ],
    ]),
    check: [drum("groove-funk"), drum("groove-shuffle"), drum("groove-fill-crash")],
  },
];

export const COURSE: Record<CourseInstrument, CourseModule[]> = { piano: PIANO, guitar: GUITAR, bass: BASS, drums: DRUMS };

export function courseLessons(instrument: CourseInstrument): CourseLesson[] {
  return COURSE[instrument].flatMap((m) => m.lessons);
}

// --- Шаг: запись, название, проверка ---

/** Инструмент фрагмента «гриф/повтори/джем» для шага курса. */
const stringInst = (i: CourseInstrument) => (i === "bass" ? "bass" : "guitar");
const jamInst = (i: CourseInstrument) => (i === "drums" ? "piano" : i);

/** Id результата шага в статистике упражнений. */
export function stepRecordIds(step: CourseStep, instrument: CourseInstrument): string[] {
  switch (step.kind) {
    case "theory":
      return [`course-theory-${step.card}`];
    case "notes":
      return [`trainer-${step.level}`];
    case "exercise":
    case "gtr":
    case "drum":
    case "ear":
      return [step.id];
    case "read":
      return [readId(step.level), readWaitId(step.level)];
    case "rhythm":
      return [step.key];
    case "chords":
      return [chordLevelId(step.level)];
    case "gchord":
      return [gtrChordLevelId(step.level)];
    case "fret":
      return [fretLevelId(stringInst(instrument), step.level)];
    case "root":
      return [rootLevelId(step.level)];
    case "echo":
      return [echoLevelId(jamInst(instrument), step.level)];
    case "jam":
      return [jamLessonId(jamInst(instrument), step.lesson)];
    case "piece":
      return [`course-piece-${step.id.replace(/^builtin:/, "")}`];
    case "song":
      return [songRecordId(step)];
  }
}

export function songRecordId(step: Extract<CourseStep, { kind: "song" }>): string {
  // Песня басом пишет результат сама: bassline-<песня>-<стиль>.
  if (step.bass) return `bassline-${step.id}-${step.bass}`;
  const variant = step.strum ? `strum-${step.strum}` : step.bass ? `bass-${step.bass}` : (step.style ?? "block");
  return `course-song-${step.id.replace(/^builtin-/, "")}-${variant}`;
}

/** Что ещё нужно для статуса: результаты упражнений и ступени тренажёра нот. */
export interface CourseProgress {
  stats: ExerciseStatView[];
  trainer: LevelStat[];
}

/** Шаг засчитан: результат с зачётом (у теории — прочитана, у тренажёра нот — ступень пройдена). */
export function stepDone(step: CourseStep, instrument: CourseInstrument, p: CourseProgress): boolean {
  if (step.kind === "notes") return p.trainer.some((l) => l.level === step.level && l.passed);
  const ids = stepRecordIds(step, instrument);
  return p.stats.some((s) => ids.includes(s.exercise) && (s.passed || step.kind === "theory"));
}

/** Шаг сделан сегодня (для шага дня на главной). */
export function stepPlayedSince(step: CourseStep, instrument: CourseInstrument, p: CourseProgress, since: number): boolean {
  if (step.kind === "notes") return false;
  const ids = stepRecordIds(step, instrument);
  return p.stats.some((s) => ids.includes(s.exercise) && s.lastAt >= since);
}

export function lessonDone(lesson: CourseLesson, instrument: CourseInstrument, p: CourseProgress): boolean {
  return lesson.steps.every((s) => stepDone(s, instrument, p));
}

export function moduleDone(m: CourseModule, instrument: CourseInstrument, p: CourseProgress): boolean {
  return m.lessons.every((l) => lessonDone(l, instrument, p)) || m.check.every((s) => stepDone(s, instrument, p));
}

export type LessonState = "done" | "current" | "open" | "locked";

/**
 * Состояния уроков: модуль открыт, когда предыдущий засчитан (уроками или проверкой); внутри модуля —
 * по порядку. «current» — первый незасчитанный из открытых.
 */
export function lessonStates(instrument: CourseInstrument, p: CourseProgress): Map<string, LessonState> {
  const out = new Map<string, LessonState>();
  let moduleOpen = true;
  let currentSet = false;
  for (const m of COURSE[instrument]) {
    const skipped = m.check.every((s) => stepDone(s, instrument, p));
    let prevDone = true;
    for (const l of m.lessons) {
      const done = lessonDone(l, instrument, p);
      let state: LessonState;
      if (done) state = "done";
      // Модуль засчитан проверкой: его уроки открыты, но текущий урок — дальше.
      else if (moduleOpen && skipped) state = "open";
      else if (moduleOpen && prevDone) state = currentSet ? "open" : "current";
      else state = "locked";
      if (state === "current") currentSet = true;
      out.set(l.id, state);
      prevDone = done;
    }
    moduleOpen = moduleOpen && moduleDone(m, instrument, p);
  }
  return out;
}

/** Модуль открыт (можно пройти проверку «я это уже умею»). */
export function moduleOpen(instrument: CourseInstrument, moduleId: string, p: CourseProgress): boolean {
  for (const m of COURSE[instrument]) {
    if (m.id === moduleId) return true;
    if (!moduleDone(m, instrument, p)) return false;
  }
  return false;
}

/** Текущий урок: первый незасчитанный открытый (или последний, если всё пройдено). */
export function currentLesson(instrument: CourseInstrument, p: CourseProgress): CourseLesson {
  const states = lessonStates(instrument, p);
  const all = courseLessons(instrument);
  return all.find((l) => states.get(l.id) === "current") ?? all[all.length - 1];
}

/**
 * Повторение в начале урока: одно упражнение из пройденных раньше уроков — каждый день другое.
 * У первого урока повторения нет.
 */
export function reviewStep(instrument: CourseInstrument, lessonId: string, p: CourseProgress, day: string): CourseStep | null {
  const all = courseLessons(instrument);
  const idx = all.findIndex((l) => l.id === lessonId);
  const pool = all
    .slice(0, Math.max(0, idx))
    .flatMap((l) => l.steps)
    .filter((s) => ["exercise", "gtr", "drum", "read", "rhythm", "chords", "gchord", "fret"].includes(s.kind) && stepDone(s, instrument, p));
  const unique = pool.filter((s, i) => pool.findIndex((x) => JSON.stringify(x) === JSON.stringify(s)) === i);
  if (!unique.length) return null;
  const dayNo = Math.floor(Date.parse(`${day}T00:00:00Z`) / 86_400_000) || 0;
  return unique[(dayNo + idx) % unique.length];
}

/** Название шага для списка урока. */
export function stepTitle(step: CourseStep, instrument: CourseInstrument): string {
  switch (step.kind) {
    case "theory":
      return `Теория: ${CARD_BY_ID.get(step.card)?.title ?? step.card}`;
    case "notes":
      return `Тренажёр нот: ступень ${step.level}`;
    case "exercise":
      return `Упражнение: ${EXERCISE_BY_ID.get(step.id)?.title ?? step.id}`;
    case "gtr":
      return `Упражнение: ${GTR_EXERCISE_BY_ID.get(step.id)?.title.replace(/ \((гитара|бас)\)$/, "") ?? step.id}`;
    case "drum":
      return `Барабаны: ${DRUM_EXERCISE_BY_ID.get(step.id)?.title ?? step.id}`;
    case "read":
      return `Чтение с листа: ${READ_LEVEL_BY_ID.get(step.level)?.title ?? step.level}`;
    case "rhythm":
      return `Ритм: ${RHYTHM_BY_KEY.get(step.key)?.title ?? step.key}`;
    case "chords":
      return `Аккорды: ${CHORD_LEVELS.find((l) => l.id === step.level)?.title ?? step.level}`;
    case "gchord":
      return `Аккорды на гитаре: ${GTR_CHORD_LEVELS.find((l) => l.id === step.level)?.title ?? step.level}`;
    case "fret":
      return `Гриф: ${FRET_LEVELS[stringInst(instrument)].find((l) => l.id === step.level)?.title ?? step.level}`;
    case "ear": {
      const l = EAR_LEVELS.find((x) => earLevelId(x) === step.id);
      return `Слух: ${l ? `${EAR_KINDS.find((k) => k.id === l.kind)?.title.toLowerCase()} — ${l.title}` : step.id}`;
    }
    case "root":
      return `Найди основной тон: ${ROOT_LEVELS.find((l) => l.id === step.level)?.title ?? step.level}`;
    case "echo":
      return `Повтори за мной: ${ECHO_LEVELS.find((l) => l.id === step.level)?.title ?? step.level}`;
    case "jam":
      return `Джем: ${JAM_LESSONS.find((l) => l.id === step.lesson)?.title ?? step.lesson}`;
    case "piece": {
      const pc = BUILTIN_PIECES.find((x) => x.id === step.id);
      const hands = step.hands === "right" ? " (правой рукой)" : step.hands === "left" ? " (левой рукой)" : step.hands === "both" ? " (двумя руками)" : "";
      return `Пьеса: ${pc?.title ?? step.id}${hands}`;
    }
    case "song": {
      const s = BUILTIN_SONGS.find((x) => x.id === step.id);
      const how = step.strum ? `боем «${STRUM_BY_ID.get(step.strum)?.name ?? step.strum}»` : step.bass ? `бас: ${BASS_STYLE_BY_ID.get(step.bass)?.name.toLowerCase() ?? step.bass}` : STYLE_NAME[step.style ?? "block"].toLowerCase();
      return `Песня: ${s?.title ?? step.id} — ${how}`;
    }
  }
}

/** Все ли ссылки шагов ведут на существующие задания (для тестов). */
export function stepExists(step: CourseStep, instrument: CourseInstrument): boolean {
  switch (step.kind) {
    case "theory":
      return CARD_BY_ID.has(step.card);
    case "notes":
      return step.level >= 1 && step.level <= 9;
    case "exercise":
      return EXERCISE_BY_ID.has(step.id);
    case "gtr":
      return GTR_EXERCISE_BY_ID.get(step.id)?.instrument === stringInst(instrument);
    case "drum":
      return DRUM_EXERCISE_BY_ID.has(step.id);
    case "read":
      return READ_LEVEL_BY_ID.has(step.level);
    case "rhythm":
      return RHYTHM_BY_KEY.has(step.key);
    case "chords":
      return CHORD_LEVELS.some((l) => l.id === step.level);
    case "gchord":
      return GTR_CHORD_LEVELS.some((l) => l.id === step.level);
    case "fret":
      return FRET_LEVELS[stringInst(instrument)].some((l) => l.id === step.level);
    case "ear":
      return EAR_LEVELS.some((l) => earLevelId(l) === step.id);
    case "root":
      return ROOT_LEVELS.some((l) => l.id === step.level);
    case "echo":
      return ECHO_LEVELS.some((l) => l.id === step.level);
    case "jam":
      return JAM_LESSONS.some((l) => l.id === step.lesson);
    case "piece":
      return BUILTIN_PIECES.some((p) => p.id === step.id);
    case "song": {
      const s = BUILTIN_SONGS.find((x) => x.id === step.id);
      if (!s) return false;
      if (step.strum) return STRUM_BY_ID.get(step.strum)?.beats === s.beats;
      if (step.bass) return BASS_STYLE_BY_ID.has(step.bass);
      return true;
    }
  }
}
