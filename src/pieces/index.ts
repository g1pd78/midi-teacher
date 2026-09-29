// Встроенная библиотека: пьесы из общественного достояния, по возрастанию сложности.

import ode from "./ode-to-joy.musicxml?raw";
import minuet from "./minuet-g-anh114.musicxml?raw";

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
    id: "builtin:ode-to-joy",
    title: "Ода к радости",
    composer: "Л. ван Бетховен",
    level: "Начальный",
    description:
      "Мелодия в позиции «до» правой рукой, левая держит простой бас. Аппликатура указана. Хорошая первая пьеса.",
    data: ode,
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
];
