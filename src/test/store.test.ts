import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Ядро заменено заглушкой: проверяем только, что и когда хранилище ему отправляет.
const handlers: Record<string, (p: unknown) => void> = {};
const setPrefs = vi.fn(async (_prefs: unknown) => {});
vi.mock("../api", () => ({
  api: {
    setPrefs: (p: unknown) => setPrefs(p),
    getState: async () => ({
      prefs: { noteNames: "solfege", piece: { tempo: 0.8 } },
      audioConfig: {},
      customSoundfont: null,
      devices: { inputs: [], outputs: [], pads: [] },
      audio: null,
      audioDevices: { asio: [], system: [] },
    }),
  },
  listen: async (event: string, cb: (p: unknown) => void) => {
    handlers[event] = cb;
    return () => {};
  },
}));

const { useApp } = await import("../store");

describe("хранилище интерфейса", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setPrefs.mockClear();
  });
  afterEach(() => vi.useRealTimers());

  it("настройки: первая правка — сразу на диск, серия правок — одной записью в конце", async () => {
    await useApp.getState().init();
    const { setPrefs: set } = useApp.getState();
    set({ noteNames: "latin" });
    expect(setPrefs).toHaveBeenCalledTimes(1);
    for (let t = 0.5; t <= 1.0001; t += 0.05) set({ piece: { ...useApp.getState().prefs.piece, tempo: t } });
    expect(setPrefs).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(200);
    expect(setPrefs).toHaveBeenCalledTimes(2);
    const last = setPrefs.mock.calls[1][0] as unknown as { noteNames: string; piece: { tempo: number } };
    expect(last.noteNames).toBe("latin");
    expect(last.piece.tempo).toBeCloseTo(1.0);
    vi.advanceTimersByTime(500);
    expect(setPrefs).toHaveBeenCalledTimes(2);
  });

  it("отключённое устройство: его зажатые клавиши отпускаются", async () => {
    await useApp.getState().init();
    handlers.midi({ type: "noteOn", note: 60, velocity: 90, device: "Пианино" });
    handlers.midi({ type: "noteOn", note: 64, velocity: 90, device: "Клавиатура" });
    expect(Object.keys(useApp.getState().held)).toEqual(["60", "64"]);
    handlers.devices({ inputs: [{ name: "Пианино", connected: false }, { name: "Клавиатура", connected: true }], outputs: [], pads: [] });
    expect(Object.keys(useApp.getState().held)).toEqual(["64"]);
  });
});
