// Выполнить код Strudel без звука: для проверки уроков, «Код → ноты» и тестов. Живой запуск со звуком —
// в engine.ts (там партии собирает repl Strudel; здесь — так же, но сами).

import { beforeEvalMt, installMt } from "./mt";

/* eslint-disable @typescript-eslint/no-explicit-any */
export type Pattern = any;

export interface StrudelMods {
  core: any;
  transpiler: (code: string, options?: unknown) => unknown;
}

let mods: Promise<StrudelMods> | null = null;

/** Пакеты без звука и интерфейса (работают и под Node в тестах). */
export function loadStrudelCore(): Promise<StrudelMods> {
  mods ??= (async () => {
    const [core, mini, tonal, tr] = await Promise.all([
      import("@strudel/core"),
      import("@strudel/mini"),
      import("@strudel/tonal"),
      import("@strudel/transpiler"),
    ]);
    const mt = installMt(core);
    await core.evalScope(core, mini, tonal, mt, {
      // В repl Strudel эти функции объявляет он сам; для разового выполнения — свои.
      setcps: (c: number) => {
        lastCps = Number(c);
      },
      setcpm: (c: number) => {
        lastCps = Number(c) / 60;
      },
      hush: () => core.silence,
      // Ползунки — из пакета редактора; без него — просто начальное значение.
      slider: (value: number) => core.pure(value),
      sliderWithID: (_id: string, value: number) => core.pure(value),
      samples: async () => {},
    });
    return { core, transpiler: tr.transpiler };
  })();
  return mods;
}

let lastCps = 0.5;

export interface Evaluated {
  pattern: Pattern;
  /** Именованные партии: «drums», «melody», «$0»… */
  parts: Record<string, Pattern>;
  /** Темп из setcps/setcpm (циклов в секунду), по умолчанию 0,5. */
  cps: number;
}

/** Выполнить код и собрать партии, как это делает repl Strudel (если партии есть, звучат только они). */
export async function evalCode(code: string): Promise<Evaluated> {
  const { core, transpiler } = await loadStrudelCore();
  const parts: Record<string, Pattern> = {};
  let counter = 0;
  const saved = core.Pattern.prototype.p;
  core.Pattern.prototype.p = function (this: Pattern, id: unknown) {
    if (typeof id === "string" && (id.startsWith("_") || id.endsWith("_"))) return this;
    const name = typeof id === "string" && id.includes("$") ? `${id}${counter++}` : String(id);
    parts[name] = this;
    return this;
  };
  beforeEvalMt(core);
  lastCps = 0.5;
  try {
    const { pattern } = await core.evaluate(code, transpiler);
    const tagged = Object.entries(parts).map(([name, p]) => p.withValue((v: any) => (v && typeof v === "object" ? { ...v, mtPart: name } : v)));
    const result = tagged.length ? core.stack(...tagged) : pattern;
    if (!core.isPattern?.(result) && !(result && typeof result.queryArc === "function")) throw new Error("код не вернул паттерн");
    return { pattern: result, parts, cps: lastCps };
  } finally {
    core.Pattern.prototype.p = saved;
  }
}
