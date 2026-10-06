// Примеры во вкладке «Код». Всё, кроме помеченного «только в MIDI Teacher», работает и на strudel.cc.

export interface CodeExample {
  id: string;
  title: string;
  /** Что показывает пример — одна фраза. */
  about: string;
  /** Использует наши функции или панель (на strudel.cc без правок не заработает). */
  mtOnly?: boolean;
  code: string;
}

/** Первый трек нового пользователя: барабаны, бас и мелодия — партии с именами, синтезаторы звучат всегда. */
export const FIRST_TRACK = `// Мой первый трек. Ctrl+Enter — играть, Ctrl+. — стоп. Меняй и слушай.
setcps(0.5)

drums: s("bd ~ sd ~, hh*8").gain(0.8)
bass: note("<a1 f1 c2 g1>").s("sawtooth").lpf(600)
melody: note("a3 c4 e4 c4").s("triangle").gain(0.6)
`;

export const EXAMPLES: CodeExample[] = [
  {
    id: "first",
    title: "Первый бит",
    about: "Бочка, малый и хэт — три партии в одном цикле.",
    code: `// Ctrl+Enter — играть, Ctrl+. — стоп
setcps(0.5)

$: s("bd ~ bd ~")
$: s("~ sd ~ sd")
$: s("hh*8").gain(0.6)
`,
  },
  {
    id: "house",
    title: "Хаус",
    about: "Ровная бочка, открытый хэт на слабую долю, басовая линия и аккорды.",
    code: `setcpm(124 / 4)

drums: s("bd*4, ~ oh ~ oh, ~ cp").gain(0.9)
bass: note("<a1 a1 f1 g1>*4").s("gm_synth_bass_1").lpf(900)
chords: chord("<Am Am F G>").voicing().s("gm_epiano1").struct("~ x ~ x").gain(0.5)
`,
  },
  {
    id: "ambient",
    title: "Эмбиент",
    about: "Медленные аккорды, отражения и редкие ноты по ладу.",
    code: `setcps(0.2)

pad: chord("<Cmaj7 Am7 Fmaj7 G>").voicing().s("gm_pad_warm").room(0.8).gain(0.5)
bells: n("<0 2 4 [6 4]>*2").scale("C:major").s("gm_celesta").delay(0.4).room(0.6).sometimes(x => x.add(note(12)))
`,
  },
  {
    id: "play-melody",
    title: "Играй мелодию",
    about: "Партия «melody» отмечена в панели как моя: она не звучит, а подсвечивается — играй её на клавишах.",
    mtOnly: true,
    code: `// В панели справа «Моя партия» = melody. Подсвеченные клавиши — то, что нужно сыграть.
setcps(0.4)

drums: s("bd ~ sd ~, hh*4").gain(0.7)
bass: note("<c2 a1 f1 g1>").s("gm_acoustic_bass")
melody: note("<[e4 d4 c4 d4] [e4 e4 e4 ~] [d4 d4 d4 ~] [e4 g4 g4 ~]>").s("piano")
`,
  },
  {
    id: "echo",
    title: "Повтори за мной",
    about: "Код играет фразу, следующий цикл — твоя очередь. echo() — только в MIDI Teacher.",
    mtOnly: true,
    code: `setcps(0.35)

beat: s("bd ~ ~ ~, ~ ~ sd ~, hh*4").gain(0.6)
phrase: echo(note("<[c4 e4 g4 ~] [g4 f4 e4 d4] [c4 ~ e4 c4] [d4 b3 c4 ~]>").s("piano"))
`,
  },
  {
    id: "improv",
    title: "Импровизация на блюз",
    about: "Аккомпанемент и гармония: подсвечены звуки аккорда и лада, импровизируй.",
    mtOnly: true,
    code: `setcps(0.45)

harmony("<A7 A7 D7 A7 E7 D7 A7 E7>", "A:minor:pentatonic")
drums: s("bd ~ [~ bd] ~, ~ sd ~ sd, hh*8").gain(0.7)
bass: note("<a1 a1 d2 a1 e2 d2 a1 e2>").s("gm_electric_bass_finger").struct("x ~ x x")
comp: chord("<A7 A7 D7 A7 E7 D7 A7 E7>").voicing().s("gm_epiano1").struct("~ x ~ x").gain(0.45)
`,
  },
  {
    id: "knobs",
    title: "Ручки и клавиши",
    about: "midin() — как на strudel.cc (ручка CC 74 — фильтр); kb() — транспонирование клавишей (только в MIDI Teacher).",
    mtOnly: true,
    code: `setcps(0.5)

const cc = await midin()  // любое устройство; можно midin("Arturia")

$: s("bd*2, ~ sd, hh*8").gain(0.7)
$: note("a2 [a2 c3] e2 [g2 a2]").add(kb().note.sub(60))
  .s("sawtooth").lpf(cc(74).range(200, 4000)).gain(0.5)
`,
  },
  {
    id: "my-samples",
    title: "Свои сэмплы",
    about: "Папка «Сэмплы»: подпапка — имя звука, файлы — его варианты (:0, :1…). rec — свои записи.",
    code: `// Положи WAV в «Документы\\MIDI Teacher\\Сэмплы\\whatUneed\\» и нажми «Обновить звуки»
setcps(0.5)

$: s("whatUneed:0 ~ whatUneed:1 ~").chop(4)
$: s("bd*4").gain(0.8)
`,
  },
];

export const EXAMPLE_BY_ID = new Map(EXAMPLES.map((e) => [e.id, e]));
