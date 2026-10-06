// Модуль курса «Музыка кодом» (Strudel): 21 урок. В каждом — теория, задание, стартовый код, ответ и
// проверка. Проверка сравнивает события кода за несколько циклов (начало и звук/нота, без громкости и
// эффектов) или требует нужные функции; уроки «Играть с кодом» засчитываются по игре поверх кода.

import { evalCode } from "./strudel/evaluate";
import { patternNotes, type CodeNote } from "./strudel/haps";
import { portableCode } from "./strudel/portable";

export type LessonCheck =
  /** Звучит так же, как ответ (за `cycles` циклов). */
  | { kind: "same"; cycles: number }
  /** В коде есть все `uses` (регулярные выражения), и он звучит; `test` — доп. условие на события и темп. */
  | { kind: "uses"; uses: RegExp[]; test?: (n: CodeNote[], ctx: { cps: number; parts: string[] }) => string | null; cycles?: number }
  /** Сыграть «свою партию» поверх кода: точность не ниже `accuracy`, нот не меньше `minNotes`. */
  | { kind: "play"; accuracy: number; minNotes: number }
  /** Импровизация: нот не меньше `minNotes`, в аккорде и ладу — не меньше `inKey`. */
  | { kind: "improv"; minNotes: number; inKey: number }
  /** Код без функций MIDI Teacher после «Для strudel.cc» и звучит. */
  | { kind: "portable" };

export interface CodeLesson {
  id: string;
  title: string;
  /** Теория: абзацы; `код` в обратных кавычках. */
  theory: string[];
  task: string;
  starter: string;
  answer: string;
  hints: string[];
  check: LessonCheck;
  /** Работает и на strudel.cc (иначе — только в MIDI Teacher). */
  portable: boolean;
}

const L = (l: Omit<CodeLesson, "portable"> & { portable?: boolean }): CodeLesson => ({ portable: true, ...l });

export const CODE_LESSONS: CodeLesson[] = [
  // --- 1. Ритм и мини-нотация ---
  L({
    id: "code-1",
    title: "Цикл и звук",
    theory: [
      "Strudel играет циклами: один цикл — это такт, он повторяется по кругу. `setcps(0.5)` — полцикла в секунду, то есть такт длится 2 секунды.",
      "`s(\"bd sd\")` — последовательность звуков в кавычках делит цикл поровну: `bd` (бочка) на первую половину, `sd` (малый) — на вторую. `hh` — закрытый хэт, `oh` — открытый, `cp` — хлопок.",
      "Ctrl+Enter — играть и применить изменения, Ctrl+. — стоп. Меняй код прямо во время игры.",
    ],
    task: "Сделай бит из четырёх долей: бочка, хэт, малый, хэт.",
    starter: `setcps(0.5)\n\n$: s("bd sd")\n`,
    answer: `setcps(0.5)\n\n$: s("bd hh sd hh")\n`,
    hints: ["Четыре звука в одних кавычках через пробел — каждый получит четверть цикла."],
    check: { kind: "same", cycles: 2 },
  }),
  L({
    id: "code-2",
    title: "Паузы и деление",
    theory: [
      "`~` — пауза: она занимает место, как звук, но тишина. `s(\"bd ~ sd ~\")` — бочка и малый через паузу.",
      "Квадратные скобки делят долю: `[sd sd]` — два малых в одной доле, `[hh hh hh]` — три хэта (триоль).",
    ],
    task: "Бочка на 1-ю долю, пауза, два малых на 3-ю долю, пауза: «bd ~ [sd sd] ~».",
    starter: `setcps(0.5)\n\n$: s("bd ~ sd ~")\n`,
    answer: `setcps(0.5)\n\n$: s("bd ~ [sd sd] ~")\n`,
    hints: ["Замени третий звук на скобки с двумя малыми внутри."],
    check: { kind: "same", cycles: 2 },
  }),
  L({
    id: "code-3",
    title: "Быстрее, медленнее, по очереди",
    theory: [
      "`*` ускоряет: `hh*8` — восемь хэтов за цикл. `/` замедляет: `cp/2` — хлопок раз в два цикла.",
      "Запятая складывает слои в одну строку: `s(\"bd*2, hh*8\")`.",
      "Угловые скобки — по очереди, по одному на цикл: `<sd cp>` — в первом цикле малый, во втором хлопок.",
    ],
    task: "Слои: бочка дважды за цикл; на 2-ю и 4-ю доли — по очереди малый и хлопок; хэт восьмыми.",
    starter: `setcps(0.5)\n\n$: s("bd*2")\n`,
    answer: `setcps(0.5)\n\n$: s("bd*2, ~ <sd cp> ~ <sd cp>, hh*8")\n`,
    hints: ["Три слоя через запятую.", "Второй слой: «~ <sd cp> ~ <sd cp>»."],
    check: { kind: "same", cycles: 4 },
  }),
  L({
    id: "code-4",
    title: "Длина, повтор, случай",
    theory: [
      "`@` растягивает: `bd@3 sd` — бочка занимает три части из четырёх. `!` повторяет: `hh!4` — то же, что `hh hh hh hh`.",
      "`?` — звук то есть, то нет (случайно, но одинаково при каждом запуске): `hh*8?`.",
    ],
    task: "Бочка на три четверти и малый в конце; отдельным слоем — восемь хэтов через «!».",
    starter: `setcps(0.5)\n\n$: s("bd sd")\n`,
    answer: `setcps(0.5)\n\n$: s("bd@3 sd, hh!8")\n`,
    hints: ["«bd@3 sd» и «hh!8» через запятую."],
    check: { kind: "same", cycles: 2 },
  }),
  L({
    id: "code-5",
    title: "Евклидовы ритмы",
    theory: [
      "`bd(3,8)` — три удара как можно ровнее распределены по восьми клеткам. Так устроены многие ритмы мира: (3,8) — тресильо, (5,8) — синкопа в латине.",
      "Третье число сдвигает узор: `bd(3,8,2)`.",
    ],
    task: "Бочка (3,8) и хэт (5,8) в двух слоях.",
    starter: `setcps(0.5)\n\n$: s("bd*4")\n`,
    answer: `setcps(0.5)\n\n$: s("bd(3,8), hh(5,8)")\n`,
    hints: ["В скобках после звука: удары и клетки."],
    check: { kind: "same", cycles: 2 },
  }),
  // --- 2. Ноты и лады ---
  L({
    id: "code-6",
    title: "Ноты",
    theory: [
      "`note(\"c4 e4 g4\")` — ноты по буквам: c — до, d — ре, e — ми, f — фа, g — соль, a — ля, b — си. Цифра — октава: c4 — до первой октавы (середина клавиатуры). Диез — `#`, бемоль — `b`: `f#4`, `bb3`.",
      "`.s(\"piano\")` — каким звуком играть. Есть `gm_epiano1`, `gm_acoustic_bass`, `sawtooth`, `triangle`…",
    ],
    task: "Сыграй до–ми–соль и до второй октавы роялем.",
    starter: `setcps(0.5)\n\n$: note("c4").s("piano")\n`,
    answer: `setcps(0.5)\n\n$: note("c4 e4 g4 c5").s("piano")\n`,
    hints: ["До второй октавы — c5."],
    check: { kind: "same", cycles: 2 },
  }),
  L({
    id: "code-7",
    title: "Ступени и лад",
    theory: [
      "`n(\"0 2 4\").scale(\"C:major\")` — ступени лада вместо нот: 0 — тоника, 2 — третья ступень, 4 — пятая. Лад задаётся «тоника:название»: `A:minor`, `D:dorian`, `E:minor:pentatonic`.",
      "Удобно менять тональность одним словом: те же ступени в `F:major` зазвучат от фа.",
    ],
    task: "Первые пять ступеней ля минора вверх и обратно вниз: 0 1 2 3 4 3 2 1.",
    starter: `setcps(0.5)\n\n$: n("0 2 4").scale("C:major").s("piano")\n`,
    answer: `setcps(0.5)\n\n$: n("0 1 2 3 4 3 2 1").scale("A:minor").s("piano")\n`,
    hints: ["Поменяй лад на «A:minor» и ступени на «0 1 2 3 4 3 2 1»."],
    check: { kind: "same", cycles: 2 },
  }),
  L({
    id: "code-8",
    title: "Аккорды",
    theory: [
      "`chord(\"<Am F C G>\").voicing()` — аккорды по буквам, по одному на цикл, а `voicing()` сам раскладывает звуки удобно, без скачков.",
      "Обозначения: `Am` — минор, `G7` — септаккорд, `C^7` — большой мажорный септаккорд, `Bo` — уменьшённый, `Dsus` — с квартой.",
    ],
    task: "Квадрат «Am F C G».",
    starter: `setcps(0.5)\n\n$: chord("<C Am F G>").voicing().s("gm_epiano1")\n`,
    answer: `setcps(0.5)\n\n$: chord("<Am F C G>").voicing().s("gm_epiano1")\n`,
    hints: ["Поменяй порядок аккордов внутри < >."],
    check: { kind: "same", cycles: 4 },
  }),
  L({
    id: "code-9",
    title: "Бас от основного тона",
    theory: [
      "Бас чаще всего играет основной тон аккорда — букву аккорда, но низко: к `Am` — `a1` или `a2`.",
      "Партии получают имена: `chords: …` и `bass: …` звучат вместе. Без имени — `$:`.",
    ],
    task: "Добавь к аккордам «Am F C G» партию bass: основные тона низко — a1, f1, c2, g1 (так бас не прыгает).",
    starter: `setcps(0.5)\n\nchords: chord("<Am F C G>").voicing().s("gm_epiano1")\n`,
    answer: `setcps(0.5)\n\nchords: chord("<Am F C G>").voicing().s("gm_epiano1")\nbass: note("<a1 f1 c2 g1>").s("gm_acoustic_bass")\n`,
    hints: ["Основные тона: a, f, c, g.", "Ответ: note(\"<a1 f1 c2 g1>\") — так бас не прыгает."],
    check: { kind: "same", cycles: 4 },
  }),
  // --- 3. Звук ---
  L({
    id: "code-10",
    title: "Варианты звука и свои сэмплы",
    theory: [
      "У звука бывает несколько вариантов: `hh:0`, `hh:1`, `sd:1`. Свои сэмплы — папка «Документы\\MIDI Teacher\\Сэмплы»: подпапка — имя звука, файлы — варианты (`whatUneed:0`, `whatUneed:1`).",
      "Свои записи (гитара, треки) — банк `rec`: `s(\"rec:0\")`. На strudel.cc свои сэмплы подключаются строкой `samples(…)`.",
    ],
    task: "Хэт восьмыми, чередуя варианты 0 и 1.",
    starter: `setcps(0.5)\n\n$: s("hh*8")\n`,
    answer: `setcps(0.5)\n\n$: s("hh:0 hh:1 hh:0 hh:1 hh:0 hh:1 hh:0 hh:1")\n`,
    hints: ["Можно и короче: s(\"[hh:0 hh:1]*4\")."],
    check: { kind: "same", cycles: 2 },
  }),
  L({
    id: "code-11",
    title: "Фильтр, эхо, отражения, ползунки",
    theory: [
      "`.lpf(800)` — фильтр срезает высокие частоты выше 800 Гц. `.delay(0.4)` — эхо, `.room(0.6)` — отражения зала, `.gain(0.8)` — громкость.",
      "`slider(800, 200, 4000)` вместо числа — ползунок прямо в коде: крути мышью во время игры.",
    ],
    task: "Поставь на басовую линию фильтр с ползунком и добавь эхо или отражения.",
    starter: `setcps(0.5)\n\n$: note("a1 [a1 c2] e1 [g1 a1]").s("sawtooth")\n`,
    answer: `setcps(0.5)\n\n$: note("a1 [a1 c2] e1 [g1 a1]").s("sawtooth").lpf(slider(800, 200, 4000)).room(0.4)\n`,
    hints: [".lpf(slider(800, 200, 4000))", "И .delay(0.3) или .room(0.5)."],
    check: { kind: "uses", uses: [/\.lpf\(\s*slider\(/, /\.(delay|room)\(/] },
  }),
  L({
    id: "code-12",
    title: "Синтезаторы и огибающая",
    theory: [
      "Без сэмплов звук делают синтезаторы: `sawtooth` (пила, ярко), `square` (квадрат, «8-бит»), `triangle` (мягко), `sine` (чистый тон).",
      "Огибающая — как звук начинается и затихает: `.attack(0.1)` — нарастание, `.decay(0.2)` и `.sustain(0.5)` — спад и уровень, `.release(0.8)` — хвост после отпускания.",
    ],
    task: "Сделай мягкий пэд: синтезатор triangle или sawtooth с медленным нарастанием и долгим хвостом.",
    starter: `setcps(0.3)\n\n$: chord("<Am F>").voicing().s("sawtooth")\n`,
    answer: `setcps(0.3)\n\n$: chord("<Am F>").voicing().s("triangle").attack(0.5).release(1.5).gain(0.6)\n`,
    hints: [".attack(0.5) и .release(1.5)."],
    check: { kind: "uses", uses: [/\.s\(\s*"(sawtooth|square|triangle|sine)"/, /\.attack\(/, /\.release\(/] },
  }),
  // --- 4. Структура и жанры ---
  L({
    id: "code-13",
    title: "Партии и превращения",
    theory: [
      "Трек — несколько именованных партий. Превращения меняют партию со временем: `.every(4, x => x.fast(2))` — каждый 4-й цикл вдвое быстрее; `.rev()` — задом наперёд; `.sometimes(x => x.speed(2))` — иногда; `.jux(rev)` — справа задом наперёд.",
    ],
    task: "Сделай трек из трёх партий и примени хотя бы одно превращение (every, sometimes, rev или jux).",
    starter: `setcps(0.5)\n\ndrums: s("bd sd")\n`,
    answer: `setcps(0.5)\n\ndrums: s("bd*2, ~ sd, hh*8").every(4, x => x.fast(2))\nbass: note("<a1 f1>").s("gm_acoustic_bass")\nlead: n("0 2 4 7").scale("A:minor").s("triangle").jux(rev)\n`,
    hints: ["Три строки вида «имя: …».", "Например, .every(4, x => x.fast(2)) у барабанов."],
    check: {
      kind: "uses",
      uses: [/\.(every|sometimes|rev|jux|often|rarely)\(/],
      test: (_n, c) => (c.parts.length >= 3 ? null : "Нужно три партии с именами (или $:)."),
    },
  }),
  L({
    id: "code-14",
    title: "Хаус",
    theory: [
      "Хаус: темп около 120–126 ударов в минуту, бочка на каждую долю («четыре на пол»), открытый хэт на слабые доли (между бочками), хлопок на 2 и 4.",
      "`setcpm(124/4)` — 124 доли в минуту при четырёх долях в цикле.",
    ],
    task: "Собери хаус-бит: setcpm(124/4), бочка четвертями, открытый хэт между ними, хлопок на 2 и 4.",
    starter: `setcps(0.5)\n\n$: s("bd")\n`,
    answer: `setcpm(124 / 4)\n\n$: s("bd*4, ~ oh ~ oh ~ oh ~ oh, ~ cp ~ cp")\n`,
    hints: ["Хэт: «~ oh» четыре раза, то есть «[~ oh]*4».", "Хлопок: «~ cp ~ cp»."],
    check: {
      kind: "uses",
      uses: [/setcpm\(|setcps\(/],
      test: (n, c) => {
        const at = (s: string) => n.filter((x) => x.s?.split(":")[0] === s && x.begin < 1).map((x) => Math.round(x.begin * 8) / 8);
        if (Math.abs(c.cps * 240 - 124) > 4) return "Темп — около 124 долей в минуту: setcpm(124 / 4).";
        if (at("bd").join() !== "0,0.25,0.5,0.75") return "Бочка — на каждую долю (bd*4).";
        if (!at("oh").includes(0.125) || !at("oh").includes(0.625)) return "Открытый хэт — между бочками.";
        if (at("cp").join() !== "0.25,0.75") return "Хлопок — на 2-ю и 4-ю доли.";
        return null;
      },
    },
  }),
  L({
    id: "code-15",
    title: "Драм-н-бейс",
    theory: [
      "Драм-н-бейс: быстро, около 170–175 ударов в минуту, ритм «брейкбит»: бочка на 1 и на «и» 3-й доли, малый на 2 и 4. Бас — длинные низкие ноты.",
      "Шестнадцать клеток в цикле удобно писать в квадратных скобках: `[bd ~ ~ ~ ~ ~ ~ ~ ~ ~ bd ~ ~ ~ ~ ~]`.",
    ],
    task: "Бит: setcpm(174/4), бочка на 1 и на «и» 3-й доли, малый на 2 и 4, хэт восьмыми; бас — одна нота на цикл.",
    starter: `setcps(0.5)\n\n$: s("bd sd")\n`,
    answer: `setcpm(174 / 4)\n\ndrums: s("[bd ~ ~ ~ ~ ~ ~ ~ ~ ~ bd ~ ~ ~ ~ ~], ~ sd ~ sd, hh*8")\nbass: note("<e1 g1 a1 c2>").s("gm_synth_bass_1").lpf(500)\n`,
    hints: ["Бочка на клетках 1 и 11 из 16.", "Бас: note(\"<e1 g1 a1 c2>\")."],
    check: {
      kind: "uses",
      uses: [/setcpm\(|setcps\(/],
      test: (n, c) => {
        if (c.cps * 240 < 160) return "Темп — около 174 долей в минуту: setcpm(174 / 4).";
        const at = (s: string) => n.filter((x) => x.s?.split(":")[0] === s && x.begin < 1).map((x) => Math.round(x.begin * 16) / 16);
        if (at("bd").join() !== "0,0.625") return "Бочка — на 1-ю долю и на «и» 3-й доли (клетки 1 и 11 из 16).";
        if (at("sd").join() !== "0.25,0.75") return "Малый — на 2-ю и 4-ю доли.";
        if (!n.some((x) => !x.drum && x.midi !== null && x.midi < 48)) return "Добавь низкий бас (первая-вторая октава).";
        return null;
      },
    },
  }),
  L({
    id: "code-16",
    title: "Эмбиент и строение трека",
    theory: [
      "Эмбиент — медленно, много пространства: `setcps(0.15)`, пэды с `.room(0.8)`, редкие ноты по ладу.",
      "Строение трека: `<…>` с длинными циклами, `.mask(\"<0 0 1 1>\")` — партия вступает с третьего цикла, `arrange([4, a], [4, stack(a, b)])` — части по очереди.",
    ],
    task: "Медленный трек (cps не больше 0,3) с отражениями (room) и партией, которая вступает не сразу (mask или arrange).",
    starter: `setcps(0.2)\n\npad: chord("<Cmaj7 Am7>").voicing().s("gm_pad_warm")\n`,
    answer: `setcps(0.2)\n\npad: chord("<C^7 Am7 F^7 G>").voicing().s("gm_pad_warm").room(0.8)\nbells: n("<0 2 4 6>*2").scale("C:major").s("gm_celesta").room(0.6).mask("<0 0 1 1>")\n`,
    hints: [".room(0.8) у пэда.", "Вторая партия с .mask(\"<0 0 1 1>\")."],
    check: {
      kind: "uses",
      uses: [/\.room\(/, /\.mask\(|arrange\(/],
      test: (_n, c) => (c.cps <= 0.3 ? null : "Сделай медленнее: setcps(0.2)."),
    },
  }),
  // --- 5. Играть с кодом ---
  L({
    id: "code-17",
    title: "Своя партия",
    theory: [
      "Партию можно не слушать, а играть самому: `.you()` (только в MIDI Teacher) — партия не звучит, её ноты подсвечиваются на клавиатуре, а игра оценивается. Во вкладке «Код» то же самое — в панели «Моя партия», и код остаётся чистым Strudel.",
    ],
    task: "Запусти код и сыграй мелодию по подсветке: 80% вовремя, хотя бы 8 нот. Потом «Стоп».",
    starter: `setcps(0.35)\n\ndrums: s("bd ~ sd ~, hh*4").gain(0.7)\nbass: note("<c2 g1 a1 f1>").s("gm_acoustic_bass")\nmelody: note("<[e4 d4 c4 d4] [e4 e4 e4 ~] [d4 d4 d4 ~] [e4 g4 g4 ~]>").s("piano").you()\n`,
    answer: "",
    hints: ["Играй, когда клавиша загорается ярко; бледная — следующая.", "Можно замедлить: setcps(0.25)."],
    check: { kind: "play", accuracy: 0.8, minNotes: 8 },
    portable: false,
  }),
  L({
    id: "code-18",
    title: "Импровизация по гармонии",
    theory: [
      "`harmony(\"<Am F C G>\", \"A:minor\")` (только в MIDI Teacher) — сама не звучит, а подсказывает: зелёные клавиши — звуки аккорда, голубые — лад. Ноты аккорда на сильную долю звучат устойчиво, остальные звуки лада — переходы.",
    ],
    task: "Импровизируй: хотя бы 16 нот, из них 75% — в аккорде или ладу. Потом «Стоп».",
    starter: `setcps(0.4)\n\nharmony("<Am F C G>", "A:minor")\ndrums: s("bd ~ sd ~, hh*8").gain(0.7)\nbass: note("<a1 f1 c2 g1>").s("gm_acoustic_bass")\nchords: chord("<Am F C G>").voicing().s("gm_epiano1").struct("~ x ~ x").gain(0.4)\n`,
    answer: "",
    hints: ["Начни с нот аккорда (зелёные) на первую долю.", "Делай паузы между фразами."],
    check: { kind: "improv", minNotes: 16, inKey: 0.75 },
    portable: false,
  }),
  L({
    id: "code-19",
    title: "Повтори за мной",
    theory: [
      "`echo(pattern)` (только в MIDI Teacher): цикл — код играет фразу, следующий цикл — твоя очередь повторить её. Подсказка загорается, когда ты повторяешь.",
    ],
    task: "Повтори фразы: 75% вовремя, хотя бы 8 нот. Потом «Стоп».",
    starter: `setcps(0.35)\n\nbeat: s("bd ~ ~ ~, ~ ~ sd ~, hh*4").gain(0.6)\nphrase: echo(note("<[c4 e4 g4 ~] [g4 f4 e4 d4] [c4 ~ e4 c4] [d4 b3 c4 ~]>").s("piano"))\n`,
    answer: "",
    hints: ["Слушай фразу целиком и повторяй со следующей бочки."],
    check: { kind: "play", accuracy: 0.75, minNotes: 8 },
    portable: false,
  }),
  L({
    id: "code-20",
    title: "Ручки, клавиши и свой трек",
    theory: [
      "`const cc = await midin()` — ручки MIDI-устройства, как на strudel.cc: `.lpf(cc(74).range(200, 4000))`. Номер ручки покажет «Что присылает устройство» во вкладке «Код».",
      "`kb().note` (только в MIDI Teacher) — последняя нажатая клавиша: `.add(kb().note.sub(60))` транспонирует партию от «до» первой октавы.",
    ],
    task: "Собери свой трек: хотя бы две партии и управление с клавиатуры — midin() или kb().",
    starter: `setcps(0.5)\n\nconst cc = await midin()\n\n$: s("bd*2, ~ sd, hh*8")\n`,
    answer: `setcps(0.5)\n\nconst cc = await midin()\n\n$: s("bd*2, ~ sd, hh*8")\n$: note("a2 [a2 c3] e2 [g2 a2]").s("sawtooth").lpf(cc(74).range(200, 4000))\n`,
    hints: ["Вторая партия с .lpf(cc(74).range(200, 4000))."],
    check: {
      kind: "uses",
      uses: [/midin\(|kb\(/],
      test: (_n, c) => (c.parts.length >= 2 ? null : "Нужно хотя бы две партии."),
    },
  }),
  // --- 6. Переезд на strudel.cc ---
  L({
    id: "code-21",
    title: "Переезд на strudel.cc",
    theory: [
      "Язык тот же: всё, что ты писал, работает на strudel.cc. Отличаются только функции MIDI Teacher (`.you()`, `echo()`, `harmony()`, `kb()`) и звук сэмплов: на сайте `bd`, `sd` звучат оригинальными драм-машинами.",
      "Кнопка «Для strudel.cc» во вкладке «Код» копирует версию без наших функций; свои сэмплы на сайте — через `samples({…}, \"https://raw.githubusercontent.com/…\")`, если выложить папку на GitHub. Документация — strudel.cc/learn, сообщество — club.tidalcycles.org.",
    ],
    task: "Сделай трек, который работает на strudel.cc без правок: ни одной функции MIDI Teacher, хотя бы две партии.",
    starter: `setcps(0.5)\n\nharmony("<Am F>", "A:minor")\n$: s("bd sd")\n$: note("a3 c4").you()\n`,
    answer: `setcps(0.5)\n\n$: s("bd sd, hh*4")\n$: note("<a3 c4 e4 c4>").s("piano")\n`,
    hints: ["Убери harmony() и .you()."],
    check: { kind: "portable" },
  }),
];

export const CODE_LESSON_BY_ID = new Map(CODE_LESSONS.map((l) => [l.id, l]));

export interface CheckResult {
  ok: boolean;
  message: string;
}

/** Ключ события для сравнения: начало (до 1/48 цикла) и звук/нота. */
const eventKey = (n: CodeNote) => `${Math.round(n.begin * 48)}|${n.drum || n.midi === null ? `${n.s ?? ""}:${n.n}` : n.midi}`;

/** Проверка урока по коду (уроки «Играть с кодом» засчитываются по игре — см. playCheck). */
export async function checkLesson(lesson: CodeLesson, code: string): Promise<CheckResult> {
  const c = lesson.check;
  if (c.kind === "play" || c.kind === "improv") return { ok: false, message: "Запусти код и сыграй — урок засчитается после «Стоп»." };
  let mine;
  try {
    mine = await evalCode(code);
  } catch (e) {
    return { ok: false, message: `Код не выполняется: ${(e as Error)?.message ?? e}` };
  }
  const parts = Object.keys(mine.parts);
  if (c.kind === "portable") {
    if (/\.you\s*\(|(?<![\w.])(echo|harmony|kb)\s*\(/.test(code)) return { ok: false, message: "В коде остались функции MIDI Teacher (.you, echo, harmony, kb)." };
    if (portableCode(code).length && parts.length < 2) return { ok: false, message: "Нужно хотя бы две партии." };
    return patternNotes(mine.pattern, 0, 1).length ? { ok: true, message: "Готово: этот код можно вставить на strudel.cc." } : { ok: false, message: "Код молчит." };
  }
  const cycles = c.kind === "same" ? c.cycles : (c.cycles ?? 2);
  const notes = patternNotes(mine.pattern, 0, cycles).filter((n) => !n.you);
  if (!notes.length) return { ok: false, message: "Код молчит — проверь, что партии звучат." };
  if (c.kind === "same") {
    const want = await evalCode(lesson.answer);
    const a = patternNotes(want.pattern, 0, cycles).map(eventKey).sort();
    const b = notes.map(eventKey).sort();
    if (a.join() === b.join()) return { ok: true, message: "Верно — звучит как надо!" };
    const missing = a.filter((k) => !b.includes(k)).length;
    const extra = b.filter((k) => !a.includes(k)).length;
    return { ok: false, message: `Пока не то: не хватает ${missing}, лишних ${extra} событий за ${cycles} цикл(а). Сравни с заданием.` };
  }
  for (const re of c.uses) if (!re.test(code)) return { ok: false, message: `Не хватает: ${humanRe(re)}.` };
  const extra = c.test?.(notes, { cps: mine.cps, parts });
  if (extra) return { ok: false, message: extra };
  return { ok: true, message: "Готово!" };
}

function humanRe(re: RegExp): string {
  const s = re.source;
  if (s.includes("lpf") && s.includes("slider")) return ".lpf(slider(…))";
  if (s.includes("delay")) return ".delay(…) или .room(…)";
  if (s.includes("attack")) return ".attack(…)";
  if (s.includes("release")) return ".release(…)";
  if (s.includes("sawtooth")) return "синтезатор: .s(\"sawtooth\"), \"square\", \"triangle\" или \"sine\"";
  if (s.includes("every")) return "превращение: every, sometimes, rev или jux";
  if (s.includes("setcpm")) return "темп: setcpm(…)";
  if (s.includes("room")) return ".room(…)";
  if (s.includes("mask")) return ".mask(…) или arrange(…)";
  if (s.includes("midin")) return "midin() или kb()";
  return s;
}

/** Уроки с игрой: засчитать по итогу игры поверх кода. */
export function playCheck(lesson: CodeLesson, r: { you?: { accuracy: number; expected: number } | null; improv?: { total: number; inKey: number } | null }): CheckResult | null {
  const c = lesson.check;
  if (c.kind === "play" && r.you) {
    if (r.you.expected < c.minNotes) return { ok: false, message: `Мало нот: ${r.you.expected} из ${c.minNotes}. Поиграй дольше.` };
    const ok = r.you.accuracy >= c.accuracy;
    return { ok, message: ok ? `Засчитано: ${Math.round(r.you.accuracy * 100)}% вовремя.` : `${Math.round(r.you.accuracy * 100)}% — нужно ${Math.round(c.accuracy * 100)}%. Ещё раз, можно медленнее.` };
  }
  if (c.kind === "improv" && r.improv) {
    if (r.improv.total < c.minNotes) return { ok: false, message: `Мало нот: ${r.improv.total} из ${c.minNotes}.` };
    const share = r.improv.inKey / r.improv.total;
    const ok = share >= c.inKey;
    return { ok, message: ok ? `Засчитано: ${Math.round(share * 100)}% нот в гармонии.` : `${Math.round(share * 100)}% нот в гармонии — нужно ${Math.round(c.inKey * 100)}%. Держись зелёных и голубых клавиш.` };
  }
  return null;
}
