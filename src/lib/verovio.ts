// Клиент к воркеру Verovio: `renderSvg(mei, options)` → строка SVG.

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, { resolve: (svg: string) => void; reject: (e: Error) => void }>();

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL("./verovio.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (e: MessageEvent<{ id: number; svg?: string; error?: string }>) => {
      const p = pending.get(e.data.id);
      if (!p) return;
      pending.delete(e.data.id);
      if (e.data.error !== undefined) p.reject(new Error(e.data.error));
      else p.resolve(e.data.svg ?? "");
    };
  }
  return worker;
}

export function renderSvg(mei: string, options: Record<string, unknown>): Promise<string> {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    getWorker().postMessage({ id, mei, options });
  });
}

/** Прогреть Verovio заранее (загрузка WASM занимает до секунды). */
export function warmUpVerovio(): void {
  getWorker();
}
