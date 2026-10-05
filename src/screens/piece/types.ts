// Что открывает экран пьесы: источник нот и упражнение.

import type { AccompNote, KeyMap, PieceInstrument } from "../../api";
import type { Evaluation } from "../../lib/exercises";
import type { SongFormat } from "../../lib/filesong";
import type { Hints } from "../../lib/reading";

export interface PieceSource {
  id: string;
  title: string;
  load: () => Promise<{ data: string | ArrayBuffer; zip: boolean }>;
  /** MIDI-файл библиотеки: ноты строятся из него с выбранными дорожками. */
  midi?: string;
  /** Сопоставление нажатий (песни по буквам: аккорды в любой октаве). */
  keyMap?: KeyMap;
  /** Надпись кнопки «назад» (песни по буквам — «← Аккорды»). */
  backLabel?: string;
  /** Песня с партиями из библиотеки (Rocksmith, Guitar Pro, текстовый таб): выбираешь партию, остальные звучат. */
  songFile?: { id: string; format: SongFormat };
  /** Что звучит вместе с учеником (упражнения под барабаны). */
  accompaniment?: AccompNote[];
  /** Инструмент задан заранее (песня боем — гитара). */
  instrument?: PieceInstrument;
  /** Полоса над нотами (схемы аккордов песни). */
  banner?: React.ReactNode;
}

/** Упражнение: тот же экран игры, но своя оценка (ровность ритма и громкости) и свои кнопки. */
export interface ExerciseContext {
  id: string;
  /** Место в разминке дня: «2 из 4». */
  playlist?: { index: number; total: number; label?: string };
  next?: { label: string; go: () => void } | null;
  onRecorded?: (ev: Evaluation) => void;
  /**
   * Барабанное упражнение: дорожка по барабанам и пэды вместо клавиатуры.
   * Ритм: однолинейный стан, дорожка из одной-двух строк, стучать любой клавишей или пэдом.
   * Гитара/бас: табы и гриф.
   */
  instrument?: "drums" | "rhythm" | "guitar" | "bass";
  /** Подсказка перед игрой (позиция, пальцы). */
  hint?: string;
  /** Подсказки ступени (чтение с листа): начальные значения переключателей. */
  hints?: Hints;
  /** Сопоставление нажатий с нотами (ритм: любая клавиша / по рукам). */
  keyMap?: KeyMap;
  /** Свои пороги зачёта вместо упражнений (95% и ±60 мс). */
  pass?: { accuracy: number; timingSdMs: number };
  /** Зачёт и в режиме ожидания: результат пишется под этим id (точность без ошибок нажатий). */
  waitRecord?: string;
  /** Режим при открытии; «только в темпе» — без переключателя режима (ритм). */
  defaultMode?: "wait" | "rhythm";
  rhythmOnly?: boolean;
  /** Кнопка «▶ Послушать»: приложение играет всё само. */
  listen?: boolean;
  /** Надпись кнопки «назад». */
  backLabel?: string;
}

/** Результат упражнения в режиме ожидания. */
export interface WaitResult {
  accuracy: number;
  errors: number;
  durationMs: number;
  passed: boolean;
}
