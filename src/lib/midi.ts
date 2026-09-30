// Импорт MIDI в интерфейсе: названия инструментов, роли дорожек, правка рук.

import type { AccompNote, HandOverride, PieceNoteIn, TrackInfo, TrackRole } from "../api";

/** Семейства инструментов General MIDI (по 8 программ). */
const GM_FAMILIES = [
  "Фортепиано",
  "Хроматическая перкуссия",
  "Орган",
  "Гитара",
  "Бас",
  "Струнные",
  "Ансамбль",
  "Медные духовые",
  "Язычковые духовые",
  "Флейты",
  "Синтезатор (соло)",
  "Синтезатор (пэд)",
  "Синтезатор (эффекты)",
  "Народные инструменты",
  "Ударные инструменты",
  "Звуковые эффекты",
];

/** Отдельные программы, которые встречаются чаще всего. */
const GM_NAMES: Record<number, string> = {
  0: "Рояль",
  1: "Фортепиано (яркое)",
  4: "Электропиано",
  6: "Клавесин",
  11: "Вибрафон",
  19: "Церковный орган",
  21: "Аккордеон",
  24: "Гитара (нейлон)",
  25: "Гитара (сталь)",
  32: "Акустический бас",
  33: "Бас-гитара",
  40: "Скрипка",
  41: "Альт",
  42: "Виолончель",
  48: "Струнный ансамбль",
  52: "Хор",
  56: "Труба",
  60: "Валторна",
  65: "Альт-саксофон",
  68: "Гобой",
  71: "Кларнет",
  73: "Флейта",
};

export function instrumentName(t: Pick<TrackInfo, "program" | "drums">): string {
  if (t.drums) return "Ударные";
  if (t.program === null) return "Фортепиано";
  return GM_NAMES[t.program] ?? GM_FAMILIES[Math.floor(t.program / 8)] ?? `Программа ${t.program + 1}`;
}

export const ROLES: { role: TrackRole; label: string; title: string }[] = [
  { role: "right", label: "Правая", title: "Играю правой рукой (верхний стан)" },
  { role: "left", label: "Левая", title: "Играю левой рукой (нижний стан)" },
  { role: "both", label: "Обе", title: "Фортепианная дорожка: приложение само разделит её на руки по высоте" },
  { role: "accompany", label: "Аккомп.", title: "Звучит как аккомпанемент, на стане не показывается" },
  { role: "off", label: "Выкл.", title: "Не звучит и не показывается" },
];

/** Хотя бы одна дорожка должна попасть на стан. */
export function hasPlayable(roles: TrackRole[]): boolean {
  return roles.some((r) => r === "right" || r === "left" || r === "both");
}

export const KEY_NAMES_MAJOR: Record<number, string> = {
  [-7]: "до-бемоль мажор",
  [-6]: "соль-бемоль мажор",
  [-5]: "ре-бемоль мажор",
  [-4]: "ля-бемоль мажор",
  [-3]: "ми-бемоль мажор",
  [-2]: "си-бемоль мажор",
  [-1]: "фа мажор",
  0: "до мажор",
  1: "соль мажор",
  2: "ре мажор",
  3: "ля мажор",
  4: "ми мажор",
  5: "си мажор",
  6: "фа-диез мажор",
  7: "до-диез мажор",
};

export const KEY_NAMES_MINOR: Record<number, string> = {
  [-7]: "ля-бемоль минор",
  [-6]: "ми-бемоль минор",
  [-5]: "си-бемоль минор",
  [-4]: "фа минор",
  [-3]: "до минор",
  [-2]: "соль минор",
  [-1]: "ре минор",
  0: "ля минор",
  1: "ми минор",
  2: "си минор",
  3: "фа-диез минор",
  4: "до-диез минор",
  5: "соль-диез минор",
  6: "ре-диез минор",
  7: "ля-диез минор",
};

export function keyName(fifths: number, minor: boolean): string {
  return (minor ? KEY_NAMES_MINOR : KEY_NAMES_MAJOR)[fifths] ?? "";
}

/** Сетка импорта: 12 долей на четверть (как `midifile::DIV`). */
export const DIV = 12;

/**
 * Правка руки для ноты стана. Время ноты (мс в темпе файла) переводится в доли
 * сетки до обрезки пустого начала, высота — до транспонирования: так правка
 * остаётся на месте при смене тона.
 */
export function overrideFor(
  note: { startMs: number; pitch: number; hand: "right" | "left" },
  bpm: number,
  trim: number,
  transpose: number,
): HandOverride {
  return {
    start: Math.round((note.startMs * bpm * DIV) / 60000) + trim,
    pitch: note.pitch - transpose,
    hand: note.hand === "right" ? "left" : "right",
  };
}

/**
 * Перебросить ноту в другую руку. Если нота уже была переброшена, правка
 * снимается (нота возвращается в руку, которую выбрал автоматический делитель).
 */
export function toggleOverride(list: HandOverride[], o: HandOverride): HandOverride[] {
  const rest = list.filter((x) => !(x.start === o.start && x.pitch === o.pitch));
  return rest.length < list.length ? rest : [...rest, o];
}

/** Аккомпанемент как ноты для сессии: играет приложение, от ученика не требуется. */
export function accompNotes(acc: AccompNote[]): PieceNoteIn[] {
  return acc.map((a, i) => ({
    id: `acc${i}`,
    pitch: a.pitch,
    startMs: a.startMs,
    durMs: a.durMs,
    hand: "accomp",
    measure: a.measure,
    channel: a.channel,
    program: a.program,
  }));
}

/** Имя файла записи: «Запись 30.09 14-05». */
export function recordingName(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `Запись ${p(d.getDate())}.${p(d.getMonth() + 1)} ${p(d.getHours())}-${p(d.getMinutes())}`;
}
