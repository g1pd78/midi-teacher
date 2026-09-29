// Verovio (WASM, ~7 МБ) работает в отдельном потоке, чтобы не тормозить интерфейс.

import createVerovioModule from "verovio/wasm";
import { VerovioToolkit } from "verovio/esm";

interface Request {
  id: number;
  mei: string;
  options: Record<string, unknown>;
}

const ready = createVerovioModule().then((m) => new VerovioToolkit(m));

self.onmessage = async (e: MessageEvent<Request>) => {
  const { id, mei, options } = e.data;
  try {
    const tk = await ready;
    tk.setOptions(options);
    if (!tk.loadData(mei)) throw new Error(tk.getLog() || "Verovio не принял MEI");
    self.postMessage({ id, svg: tk.renderToSVG(1) });
  } catch (err) {
    self.postMessage({ id, error: String(err) });
  }
};
