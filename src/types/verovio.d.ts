// Минимальные типы для пакета verovio (в нём нет своих .d.ts).

declare module "verovio/wasm" {
  const createVerovioModule: () => Promise<unknown>;
  export default createVerovioModule;
}

declare module "verovio/esm" {
  export class VerovioToolkit {
    constructor(module: unknown);
    setOptions(options: Record<string, unknown>): void;
    loadData(data: string): boolean | number;
    renderToSVG(page?: number): string;
    getPageCount(): number;
    getLog(): string;
  }
}
