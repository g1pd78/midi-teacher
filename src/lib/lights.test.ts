import { describe, expect, it } from "vitest";
import { LIGHT, LIGHT_DIM, keyCenter, ledOf, lightsFrame, lightsFromHighlight, lightsKey, signalWord, statusSysex, sysex, withPresses } from "./lights";

describe("lightsFromHighlight", () => {
  it("переводит цвета экрана в цвета платы, пропускает нажатые и тусклит слабые подсказки", () => {
    const keys = lightsFromHighlight({
      64: { color: "#5AA9FF" },
      48: { color: "#ffb454", strength: 0.8 },
      60: { color: "#5AA9FF", held: true },
      67: { color: "#4CC38A", strength: 0.3 },
      70: { color: "#FF5C5C" },
      72: { color: "var(--accent)" },
    });
    expect(keys).toEqual([
      [48, LIGHT.left],
      [64, LIGHT.right],
      [67, LIGHT.good + LIGHT_DIM],
      [70, LIGHT.bad],
      [72, LIGHT.neutral],
    ]);
    expect(lightsKey(keys)).toBe("48:2,64:1,67:19,70:4,72:6");
  });

  it("пустая подсветка — лента гаснет", () => {
    expect(lightsFromHighlight({})).toEqual([]);
  });
});

describe("геометрия клавиш", () => {
  it("белые клавиши стоят ровно через одну, октава — семь белых", () => {
    expect(keyCenter(60)).toBe(5 * 7 + 0.5);
    expect(keyCenter(62) - keyCenter(60)).toBe(1);
    expect(keyCenter(72) - keyCenter(60)).toBe(7);
  });

  it("чёрные клавиши — между соседними белыми, со сдвигом как на клавиатуре", () => {
    for (const n of [61, 63, 66, 68, 70]) {
      expect(keyCenter(n)).toBeGreaterThan(keyCenter(n - 1));
      expect(keyCenter(n)).toBeLessThan(keyCenter(n + 1));
    }
    expect(keyCenter(61)).toBeLessThan(keyCenter(60) + 1); // до-диез ближе к до
    expect(keyCenter(70)).toBeGreaterThan(keyCenter(69) + 0.5); // си-бемоль ближе к си
  });

  it("светодиод над клавишей — по калибровке крайних клавиш", () => {
    const cal = { lowNote: 21, lowLed: 3, highNote: 108, highLed: 175 };
    expect(ledOf(21, cal)).toBe(3);
    expect(ledOf(108, cal)).toBe(175);
    const c4 = ledOf(60, cal);
    expect(c4).toBeGreaterThan(70);
    expect(c4).toBeLessThan(85);
    // Соседние клавиши не попадают на один светодиод при ~2 светодиодах на белую клавишу.
    for (let n = 22; n <= 108; n++) expect(ledOf(n, cal)).toBeGreaterThan(ledOf(n - 1, cal));
  });

  it("лента наоборот (справа налево) — светодиоды убывают", () => {
    const cal = { lowNote: 36, lowLed: 120, highNote: 96, highLed: 0 };
    expect(ledOf(36, cal)).toBe(120);
    expect(ledOf(96, cal)).toBe(0);
    expect(ledOf(60, cal)).toBeLessThan(ledOf(48, cal));
  });
});

describe("SysEx платы", () => {
  it("калибровка: ноты и 14-битные номера светодиодов", () => {
    expect(sysex.calibrate({ lowNote: 21, lowLed: 3, highNote: 108, highLed: 175 })).toEqual([
      0xf0, 0x7d, 0x4d, 0x54, 0x01, 21, 3, 0, 108, 175 & 0x7f, 1, 0xf7,
    ]);
  });

  it("указка, проверка и выход из указки", () => {
    expect(sysex.pointer(300, LIGHT.left)).toEqual([0xf0, 0x7d, 0x4d, 0x54, 0x02, 300 & 0x7f, 2, LIGHT.left, 0xf7]);
    expect(sysex.test()).toEqual([0xf0, 0x7d, 0x4d, 0x54, 0x03, 0xf7]);
    expect(sysex.pointerOff()).toEqual([0xf0, 0x7d, 0x4d, 0x54, 0x04, 0xf7]);
  });

  it("все байты данных — семибитные", () => {
    for (const msg of [sysex.calibrate({ lowNote: 0, lowLed: 1023, highNote: 127, highLed: 16383 }), sysex.pointer(9999, 7)])
      for (const b of msg.slice(1, -1)) expect(b).toBeLessThan(0x80);
  });
});

describe("кадр и мои нажатия", () => {
  it("кадр: яркость и все горящие клавиши по порядку — те же байты, что шлёт ядро", () => {
    expect(lightsFrame(25, [[67, 2], [60, 1]])).toEqual([0xf0, 0x7d, 0x4d, 0x54, 0x10, 32, 60, 1, 67, 2, 0xf7]);
    expect(lightsFrame(25, [])).toEqual([0xf0, 0x7d, 0x4d, 0x54, 0x10, 32, 0xf7]);
    for (const b of lightsFrame(100, [[108, LIGHT.violet + LIGHT_DIM]]).slice(1, -1)) expect(b).toBeLessThan(0x80);
  });

  it("мои нажатия: в занятии тускло, вне занятий ярко, подсказка важнее, можно выключить", () => {
    const hints: [number, number][] = [[60, LIGHT.right]];
    expect(withPresses(hints, [60, 64], true, true)).toEqual([
      [60, LIGHT.right],
      [64, LIGHT.neutral + LIGHT_DIM],
    ]);
    expect(withPresses([], [64], true, false)).toEqual([[64, LIGHT.neutral]]);
    expect(withPresses(hints, [64], false, true)).toEqual(hints);
  });

  it("заранее в темпе — тусклым (слабая подсказка)", () => {
    expect(lightsFromHighlight({ 62: { color: "#5AA9FF", strength: 0.2 } })).toEqual([[62, LIGHT.right + LIGHT_DIM]]);
  });
});

describe("радио", () => {
  it("команды связки и статус как в прошивке", () => {
    expect(sysex.status()).toEqual([0xf0, 0x7d, 0x4d, 0x54, 0x05, 0xf7]);
    expect(sysex.pair()).toEqual([0xf0, 0x7d, 0x4d, 0x54, 0x06, 0xf7]);
    expect(sysex.unpair()).toEqual([0xf0, 0x7d, 0x4d, 0x54, 0x07, 0xf7]);
    // Тот же статус проверяет g++-тест прошивки (radio_core_test.cpp).
    expect(statusSysex(1, 2, -58, 3)).toEqual([0xf0, 0x7d, 0x4d, 0x54, 0x20, 1, 1, 2, 58, 3, 0xf7]);
    expect(statusSysex(0, 0, 0, 250)).toEqual([0xf0, 0x7d, 0x4d, 0x54, 0x20, 1, 0, 0, 0, 100, 0xf7]);
  });

  it("сигнал словами", () => {
    expect(signalWord(-50)).toBe("хороший");
    expect(signalWord(-67)).toBe("хороший");
    expect(signalWord(-75)).toBe("средний");
    expect(signalWord(-80)).toBe("средний");
    expect(signalWord(-90)).toBe("слабый");
    expect(signalWord(null)).toBeNull();
    expect(signalWord(0)).toBeNull();
  });
});
