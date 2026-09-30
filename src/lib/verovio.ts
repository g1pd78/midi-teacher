// Клиент к воркеру Verovio.

import type { MidiValues, TimemapEntry } from "./score";

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL("./verovio.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (e: MessageEvent<{ id: number; result?: unknown; error?: string }>) => {
      const p = pending.get(e.data.id);
      if (!p) return;
      pending.delete(e.data.id);
      if (e.data.error !== undefined) p.reject(new Error(e.data.error));
      else p.resolve(e.data.result);
    };
  }
  return worker;
}

function call<T>(msg: Record<string, unknown>, transfer: Transferable[] = []): Promise<T> {
  const id = nextId++;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    getWorker().postMessage({ id, ...msg }, transfer);
  });
}

/** MEI → SVG одной страницы (тренажёр). */
export function renderSvg(mei: string, options: Record<string, unknown>): Promise<string> {
  return call<string>({ type: "render", mei, options });
}

/** MusicXML (текст) или MXL (архив) → MEI с постоянными id нот; `transpose` — сдвиг в полутонах. */
export async function loadScore(data: string | ArrayBuffer, zip: boolean, transpose = 0): Promise<string> {
  const r = await call<{ mei: string }>({ type: "load", data, zip, transpose }, data instanceof ArrayBuffer ? [data] : []);
  return r.mei;
}

export interface RenderedScore {
  pages: string[];
  timemap: TimemapEntry[];
  midi: MidiValues;
}

export function renderScore(mei: string, options: Record<string, unknown>): Promise<RenderedScore> {
  return call<RenderedScore>({ type: "renderDoc", mei, options });
}

/** Прогреть Verovio заранее (загрузка WASM занимает до секунды). */
export function warmUpVerovio(): void {
  getWorker();
}
