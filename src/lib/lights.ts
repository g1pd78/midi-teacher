// Подсветка клавиш: что горит на ленте над клавиатурой. Источник — подсказки экранной клавиатуры (те же
// клавиши и цвета, что на экране), нажатые клавиши не подсвечиваются. Плата «MIDI Teacher Lights»
// принимает ноты на 16-м канале: номер — клавиша, сила — цвет; настройка — SysEx (см. hardware/key-lights).

/** Цвета платы (сила ноты); +16 — тускло. */
export const LIGHT = { right: 1, left: 2, good: 3, bad: 4, warn: 5, neutral: 6, violet: 7 } as const;
export const LIGHT_DIM = 16;

/** Цвет ленты в CSS — для предпросмотра на экране. */
export const LIGHT_CSS: Record<number, string> = {
  1: "#5AA9FF",
  2: "#FFB454",
  3: "#4CC38A",
  4: "#FF5C5C",
  5: "#F2C94C",
  6: "#E6E6E6",
  7: "#C792EA",
};

const BY_HEX: Record<string, number> = {
  "#5aa9ff": LIGHT.right,
  "#ffb454": LIGHT.left,
  "#4cc38a": LIGHT.good,
  "#ff5c5c": LIGHT.bad,
  "#f2c94c": LIGHT.warn,
  "#c792ea": LIGHT.violet,
};

export interface KeyHighlight {
  color: string;
  strength?: number;
  /** Клавиша нажата сейчас — на ленте не показываем (рука и так на ней). */
  held?: boolean;
}

/** Подсказки клавиатуры → (клавиша, цвет платы); слабые подсказки — тускло. */
export function lightsFromHighlight(h: Record<number, KeyHighlight>): [number, number][] {
  const out: [number, number][] = [];
  for (const [k, v] of Object.entries(h)) {
    if (!v || v.held) continue;
    const c = BY_HEX[v.color.trim().toLowerCase()] ?? LIGHT.neutral;
    out.push([Number(k), c + ((v.strength ?? 1) < 0.35 ? LIGHT_DIM : 0)]);
  }
  return out.sort((a, b) => a[0] - b[0]);
}

export function lightsKey(keys: [number, number][]): string {
  return keys.map(([n, c]) => `${n}:${c}`).join(",");
}

// --- Геометрия: центр клавиши в долях белой клавиши (как на настоящей клавиатуре) ---

const WHITE_OF_PC = [0, -1, 1, -1, 2, 3, -1, 4, -1, 5, -1, 6];
/** Сдвиг центра чёрной клавиши от границы белых (в долях белой): у групп из двух и трёх чёрных — по-разному. */
const BLACK_OFFSET: Record<number, number> = { 1: -0.1, 3: 0.1, 6: -0.15, 8: 0, 10: 0.15 };

export function keyCenter(note: number): number {
  const oct = Math.floor(note / 12);
  const pc = note % 12;
  const w = WHITE_OF_PC[pc];
  if (w >= 0) return oct * 7 + w + 0.5;
  const left = WHITE_OF_PC[pc - 1];
  return oct * 7 + left + 1 + BLACK_OFFSET[pc];
}

/** Светодиод над клавишей по калибровке крайних клавиш (линейно по центрам клавиш). */
export function ledOf(note: number, cal: LightsCalibration): number {
  const a = keyCenter(cal.lowNote);
  const b = keyCenter(cal.highNote);
  const t = b === a ? 0 : (keyCenter(note) - a) / (b - a);
  return Math.round(cal.lowLed + t * (cal.highLed - cal.lowLed));
}

export interface LightsCalibration {
  lowNote: number;
  lowLed: number;
  highNote: number;
  highLed: number;
}

// --- SysEx настройки платы: F0 7D 4D 54 <команда> … F7 (7D — некоммерческий производитель) ---

const HEAD = [0xf0, 0x7d, 0x4d, 0x54];
const u14 = (v: number) => [v & 0x7f, (v >> 7) & 0x7f];

export const sysex = {
  /** Калибровка: крайние клавиши и их светодиоды (плата сохраняет у себя). */
  calibrate: (c: LightsCalibration) => [...HEAD, 0x01, c.lowNote & 0x7f, ...u14(c.lowLed), c.highNote & 0x7f, ...u14(c.highLed), 0xf7],
  /** Режим указки: горит один светодиод (для калибровки). */
  pointer: (led: number, color: number = LIGHT.neutral) => [...HEAD, 0x02, ...u14(led), color & 0x7f, 0xf7],
  /** Проверка: огонёк пробегает по всей ленте. */
  test: () => [...HEAD, 0x03, 0xf7],
  /** Выйти из режима указки — снова горят клавиши. */
  pointerOff: () => [...HEAD, 0x04, 0xf7],
};
