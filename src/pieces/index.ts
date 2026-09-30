// Встроенная библиотека: пьесы из общественного достояния, по возрастанию сложности.
// Файлы генерирует scripts/gen_pieces.py (там же — источники каждой мелодии).

import twinkle from "./twinkle.musicxml?raw";
import jacques from "./frere-jacques.musicxml?raw";
import lune from "./au-clair-de-la-lune.musicxml?raw";
import ode from "./ode-to-joy.musicxml?raw";
import bereza from "./vo-pole-bereza.musicxml?raw";
import bells from "./jingle-bells.musicxml?raw";
import kalinka from "./kalinka.musicxml?raw";
import brahms from "./brahms-lullaby.musicxml?raw";
import oldFrench from "./old-french-song.musicxml?raw";
import minuet from "./minuet-g-anh114.musicxml?raw";
import minuetGm from "./minuet-gm-anh115.musicxml?raw";

export interface BuiltinPiece {
  id: string;
  title: string;
  composer: string;
  level: string;
  description: string;
  data: string;
}

export const BUILTIN_PIECES: BuiltinPiece[] = [
  {
    id: "builtin:twinkle",
    title: "Ах, скажу я вам, мама",
    composer: "Французская народная песня",
    level: "Самое начало",
    description: "Та самая «Twinkle, Twinkle, Little Star». Четверти и половинные, до мажор, левая рука — один бас на такт.",
    data: twinkle,
  },
  {
    id: "builtin:frere-jacques",
    title: "Братец Яков",
    composer: "Французская народная песня",
    level: "Самое начало",
    description: "Короткая песенка-канон: каждая фраза повторяется дважды. Первые восьмые.",
    data: jacques,
  },
  {
    id: "builtin:au-clair",
    title: "При свете луны",
    composer: "Французская народная песня",
    level: "Самое начало",
    description: "Спокойная мелодия в пяти нотах «до–соль» второй октавы, целые и половинные ноты.",
    data: lune,
  },
  {
    id: "builtin:ode-to-joy",
    title: "Ода к радости",
    composer: "Л. ван Бетховен",
    level: "Начальный",
    description:
      "Мелодия в позиции «до» правой рукой, левая держит простой бас. Аппликатура указана. Хорошая первая пьеса.",
    data: ode,
  },
  {
    id: "builtin:vo-pole-bereza",
    title: "Во поле берёза стояла",
    composer: "Русская народная песня",
    level: "Начальный",
    description: "Ля минор, 2/4, восьмые и четверть с точкой. Левая рука — басовые ноты по гармонии.",
    data: bereza,
  },
  {
    id: "builtin:jingle-bells",
    title: "Бубенчики",
    composer: "Дж. Пьерпонт (припев «Jingle Bells»)",
    level: "Начальный",
    description: "Припев в до мажоре: повторяющиеся ноты, четверть с точкой и восьмая.",
    data: bells,
  },
  {
    id: "builtin:kalinka",
    title: "Калинка (припев)",
    composer: "И. Ларионов",
    level: "Начальный",
    description: "Ре минор, затакт, пунктирный ритм. Играется дважды, левая рука чередует ля и ре.",
    data: kalinka,
  },
  {
    id: "builtin:brahms-lullaby",
    title: "Колыбельная",
    composer: "Й. Брамс, op. 49 №4",
    level: "Лёгкий",
    description: "Знаменитая колыбельная в до мажоре (в оригинале ми-бемоль), 3/4, затакт.",
    data: brahms,
  },
  {
    id: "builtin:old-french-song",
    title: "Старинная французская песенка",
    composer: "П. И. Чайковский, op. 39 №16",
    level: "Лёгкий",
    description: "Из «Детского альбома». Соль минор, 2/4; мелодия полностью, в левой руке упрощённый бас.",
    data: oldFrench,
  },
  {
    id: "builtin:minuet-g",
    title: "Менуэт соль мажор",
    composer: "Кр. Петцольд, BWV Anh. 114",
    level: "Лёгкий",
    description:
      "Из «Нотной тетради Анны Магдалены Бах». Две самостоятельные руки, соль мажор, 3/4. Издание Mutopia (общественное достояние), без украшений.",
    data: minuet,
  },
  {
    id: "builtin:minuet-gm",
    title: "Менуэт соль минор",
    composer: "Кр. Петцольд, BWV Anh. 115",
    level: "Средний",
    description: "Пара к менуэту соль мажор: соль минор, 3/4, левая рука уходит в низкий регистр. Издание Mutopia №76, без украшений.",
    data: minuetGm,
  },
];
