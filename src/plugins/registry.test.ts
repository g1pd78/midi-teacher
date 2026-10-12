import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: unknown[][] = [];
vi.mock("../api", () => ({
  api: {
    pieceConfirm: (pitch: number, ok: boolean) => (calls.push(["confirm", pitch, ok]), Promise.resolve()),
    pieceConfirmHits: (on: boolean) => (calls.push(["hits", on]), Promise.resolve()),
  },
  listen: () => Promise.resolve(() => {}),
}));

const reg = await import("./registry");

describe("плагины: подтверждение нажатий", () => {
  beforeEach(() => {
    reg.resetRegistry();
    calls.length = 0;
  });

  it("режим включается, пока его просит хоть один плагин", () => {
    reg.setConfirmHits("a", true);
    reg.setConfirmHits("b", true);
    reg.setConfirmHits("a", false);
    expect(reg.snapshot().confirmHits).toBe(true);
    reg.setConfirmHits("b", false);
    expect(calls).toEqual([
      ["hits", true],
      ["hits", false],
    ]);
  });

  it("палец после pending: подтверждение по сверке; без аппликатуры — пропускаем", () => {
    reg.setBridge({ report: (r) => (r.pitch === 61 ? null : { note: { id: "n", pitch: r.pitch, hand: "right", finger: 2, measure: 1 }, ok: r.finger === 2, played: r.finger }) });
    reg.onPieceEvent({ kind: "pending", index: 0, pitch: 60 });
    reg.reportFinger({ pitch: 60, finger: 3 });
    reg.onPieceEvent({ kind: "pending", index: 0, pitch: 61 });
    reg.reportFinger({ pitch: 61, finger: 3 });
    expect(calls).toEqual([
      ["confirm", 60, false],
      ["confirm", 61, true],
    ]);
  });

  it("палец раньше pending — ответ сразу; старый ответ не годится, плагин узнаёт о ждущей ноте", () => {
    reg.setBridge({ report: (r) => ({ note: { id: "n", pitch: r.pitch, hand: "right", finger: 2, measure: 1 }, ok: true, played: r.finger }) });
    const seen: number[] = [];
    reg.onPending((p) => seen.push(p));
    reg.reportFinger({ pitch: 60, finger: 2 }, 1000);
    reg.onPieceEvent({ kind: "pending", index: 0, pitch: 60 }, 1100);
    reg.reportFinger({ pitch: 62, finger: 2 }, 1000);
    reg.onPieceEvent({ kind: "pending", index: 0, pitch: 62 }, 2000);
    expect(calls).toEqual([["confirm", 60, true]]);
    expect(seen).toEqual([62]);
    reg.confirm(62, true);
    reg.confirm(62, true);
    expect(calls).toHaveLength(2);
  });

  it("разделы и окна появляются и убираются", () => {
    const off = reg.addSection({ pluginId: "a", title: "A", mount: () => {} });
    reg.addOverlay({ pluginId: "a", mount: () => {} });
    expect(reg.snapshot().sections).toHaveLength(1);
    off();
    expect(reg.snapshot().sections).toHaveLength(0);
    expect(reg.snapshot().overlays).toHaveLength(1);
  });

  it("шаг пьесы доходит до подписчиков", () => {
    const got: unknown[] = [];
    reg.onStep((s) => got.push(s));
    reg.publishStep({ index: 3, notes: [{ pitch: 60, hand: "right", finger: 1 }] });
    expect(reg.currentStep()?.index).toBe(3);
    reg.publishStep(null);
    expect(got).toHaveLength(2);
  });
});
