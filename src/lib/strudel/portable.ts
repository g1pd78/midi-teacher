// «Копировать для strudel.cc»: убрать или заменить наши функции, добавить загрузку своих сэмплов,
// перенести настройки панели в комментарии. Остальной код — как есть: язык тот же.

import type { PanelSettings } from "./mt";
import { partLabel } from "./mt";

/** Скобочное выражение от позиции `open` (там «(»): индекс закрывающей скобки. */
function closing(text: string, open: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === "\\") i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") quote = ch;
    else if (ch === "(") depth++;
    else if (ch === ")" && --depth === 0) return i;
  }
  return -1;
}

/** Заменить вызовы `name(…)` функцией от аргументов. */
function replaceCalls(text: string, name: string, f: (args: string) => string): string {
  const re = new RegExp(`(?<![\\w.$])${name}\\s*\\(`, "g");
  let out = "";
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const open = m.index + m[0].length - 1;
    const end = closing(text, open);
    if (end < 0) break;
    out += text.slice(last, m.index) + f(text.slice(open + 1, end));
    last = end + 1;
    re.lastIndex = end + 1;
  }
  return out + text.slice(last);
}

export interface PortableOptions {
  panel?: PanelSettings;
  /** Свои сэмплы: имя звука → файлы (из папки «Сэмплы»). */
  userSamples?: Record<string, string[]>;
}

export function portableCode(code: string, opts: PortableOptions = {}): string {
  let text = code;
  // harmony(...) — только подсказка для импровизации: в комментарий.
  text = text.replace(/^[ \t]*harmony\s*\(.*\)\s*;?[ \t]*$/gm, (line) => `// ${line.trim()}  (только в MIDI Teacher)`);
  // .you() — партия просто звучит.
  text = text.replace(/\.you\s*\(\s*\)/g, "");
  // echo(x) → x (фраза каждый цикл).
  text = replaceCalls(text, "echo", (args) => args);
  // kb(...).note / .vel / .gate → постоянные значения.
  text = text.replace(/(?<![\w.$])kb\s*\([^()]*\)\s*\.\s*(note|vel|gate)/g, (_, f: string) => (f === "note" ? "pure(60)" : f === "vel" ? "pure(0.8)" : "pure(1)"));

  const head: string[] = ["// Из MIDI Teacher. Код совместим со strudel.cc."];
  const p = opts.panel ?? {};
  if (p.myPart) head.push(`// В MIDI Teacher партию «${partLabel(p.myPart)}» играл я — здесь она звучит.`);
  if (p.echoPart) head.push(`// «Повтори за мной» был на партии «${partLabel(p.echoPart)}».`);
  if (p.harmony || p.scale) head.push(`// Гармония для импровизации: ${[p.harmony, p.scale].filter(Boolean).join(", ")}`);

  const used = Object.entries(opts.userSamples ?? {}).filter(([name]) => new RegExp(`["\\s,\\[<]${name}(?:[:\\s"\\],>*!@]|$)`).test(text));
  if (used.length) {
    head.push("// Свои сэмплы: выложи папку «Сэмплы» на GitHub и поправь адрес ниже.");
    const map = used.map(([name, files]) => `  ${/^[A-Za-z_$][\w$]*$/.test(name) ? name : JSON.stringify(name)}: ${JSON.stringify(files)}`).join(",\n");
    head.push(`samples({\n${map}\n}, "https://raw.githubusercontent.com/ИМЯ/РЕПОЗИТОРИЙ/main/")`);
  }
  return `${head.join("\n")}\n\n${text.trimStart()}`;
}
