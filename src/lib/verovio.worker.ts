// Verovio (WASM, ~7 МБ) работает в отдельном потоке, чтобы не тормозить интерфейс.
//
// Запросы:
//   render     — MEI → SVG одной страницы (тренажёр);
//   load       — MusicXML/MXL → MEI с постоянными xml:id у нот;
//   renderDoc  — MEI → все страницы SVG + временная карта + MIDI-значения нот.

import createVerovioModule from "verovio/wasm";
import { VerovioToolkit } from "verovio/esm";

type Request =
  | { id: number; type?: "render"; mei: string; options: Record<string, unknown> }
  | { id: number; type: "load"; data: string | ArrayBuffer; zip: boolean }
  | { id: number; type: "renderDoc"; mei: string; options: Record<string, unknown> };

type Tk = VerovioToolkit & {
  loadZipDataBuffer(data: ArrayBuffer): boolean | number;
  getMEI(options: object): string;
  renderToTimemap(options: object): { on?: string[] }[];
  getMIDIValuesForElement(id: string): { time: number; duration: number; pitch: number };
  resetXmlIdSeed(seed: number): void;
};

const ready = createVerovioModule().then((m) => new VerovioToolkit(m) as Tk);

self.onmessage = async (e: MessageEvent<Request>) => {
  const req = e.data;
  try {
    const tk = await ready;
    if (req.type === "load") {
      tk.resetXmlIdSeed(1);
      tk.setOptions({ breaks: "none" });
      const ok = req.zip ? tk.loadZipDataBuffer(req.data as ArrayBuffer) : tk.loadData(req.data as string);
      if (!ok) throw new Error(tk.getLog() || "файл не распознан как ноты");
      self.postMessage({ id: req.id, result: { mei: tk.getMEI({}) } });
      return;
    }
    tk.setOptions(req.options);
    if (!tk.loadData(req.mei)) throw new Error(tk.getLog() || "Verovio не принял MEI");
    if (req.type === "renderDoc") {
      const pages: string[] = [];
      for (let p = 1; p <= tk.getPageCount(); p++) pages.push(tk.renderToSVG(p));
      const timemap = tk.renderToTimemap({ includeMeasures: true });
      const midi: Record<string, { time: number; duration: number; pitch: number }> = {};
      for (const entry of timemap) for (const nid of entry.on ?? []) midi[nid] ??= tk.getMIDIValuesForElement(nid);
      self.postMessage({ id: req.id, result: { pages, timemap, midi } });
      return;
    }
    self.postMessage({ id: req.id, result: tk.renderToSVG(1) });
  } catch (err) {
    self.postMessage({ id: req.id, error: String(err) });
  }
};
