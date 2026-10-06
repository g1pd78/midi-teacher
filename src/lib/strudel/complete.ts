// Автодополнение и справка в редакторе кода: функции Strudel (основные — по-русски), звуки внутри
// s("…"), банки, лады. Разбор контекста — чистые функции (тесты), расширение CodeMirror — внизу.

import { autocompletion, type Completion, type CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import { hoverTooltip, type EditorView } from "@codemirror/view";
import strudelDocs from "./strudelDocs.json";
import { DOCS_RU } from "./docsRu";

interface EnDoc {
  n: string;
  s?: string[];
  d?: string;
  p?: string[];
  x?: string;
}

export interface DocEntry {
  name: string;
  /** Описание по-русски (основные функции). */
  ru?: string;
  /** Описание Strudel по-английски. */
  en?: string;
  example?: string;
  params?: string[];
  synonyms?: string[];
  /** Только в MIDI Teacher. */
  mt?: boolean;
}

const EN = new Map<string, EnDoc>();
for (const d of strudelDocs as EnDoc[]) {
  EN.set(d.n, d);
  for (const s of d.s ?? []) if (!EN.has(s)) EN.set(s, d);
}

/** Справка по имени функции (с учётом синонимов). */
export function docFor(name: string): DocEntry | null {
  const en = EN.get(name);
  // Синоним (lp → lpf) получает русское описание основного имени.
  const ru = DOCS_RU[name] ?? (en ? DOCS_RU[en.n] : undefined);
  if (!ru && !en) return null;
  return {
    name,
    ru: ru?.d,
    en: en?.d,
    example: ru?.x ?? en?.x,
    params: en?.p,
    synonyms: en ? [en.n, ...(en.s ?? [])].filter((s) => s !== name) : undefined,
    mt: ru?.mt,
  };
}

/** Все функции для автодополнения: из справки Strudel и наши. Русские — выше в списке. */
export function functionNames(): string[] {
  return [...new Set([...EN.keys(), ...Object.keys(DOCS_RU)])].sort();
}

export type CompletionKind = "function" | "sound" | "bank" | "scale" | "scaleMode";

/** Что дополнять по тексту строки до курсора; `word` — уже набранная часть. */
export function contextAt(before: string): { kind: CompletionKind; word: string } | null {
  const quotes = (before.match(/"/g) ?? []).length + (before.match(/'/g) ?? []).length;
  const inString = quotes % 2 === 1;
  if (inString) {
    const word = /[\w#-]*$/.exec(before)![0];
    if (/\b(?:s|sound)\(\s*["'][^"']*$/.test(before)) return { kind: "sound", word: /[\w-]*$/.exec(before)![0] };
    if (/\.bank\(\s*["'][^"']*$/.test(before)) return { kind: "bank", word };
    if (/\bscale\(\s*["'][^"']*:[\w:-]*$/.test(before)) return { kind: "scaleMode", word: /[\w-]*$/.exec(before)![0] };
    if (/\bscale\(\s*["'][^"']*$/.test(before)) return { kind: "scale", word };
    return null;
  }
  const m = /(?:^|[^\w$])([A-Za-z_$][\w$]*)$/.exec(before);
  if (m) return { kind: "function", word: m[1] };
  if (/\.$/.test(before)) return { kind: "function", word: "" };
  return null;
}

/** Звуки по набранному началу: «bd», «gm_pi…», свои сэмплы. Без вариантов вида bd:3. */
export function soundOptions(names: string[], word: string): string[] {
  const w = word.toLowerCase();
  return [...new Set(names)].filter((n) => n.toLowerCase().startsWith(w)).sort((a, b) => a.length - b.length || a.localeCompare(b));
}

/** Банки — приставки звуков вида «RolandTR909_bd». */
export function bankOptions(names: string[], word: string): string[] {
  const banks = new Set<string>();
  for (const n of names) {
    const i = n.lastIndexOf("_");
    if (i > 0 && !n.startsWith("gm_")) banks.add(n.slice(0, i));
  }
  return [...banks].filter((b) => b.toLowerCase().startsWith(word.toLowerCase())).sort();
}

export const SCALE_TONICS = ["C", "C#", "Db", "D", "D#", "Eb", "E", "F", "F#", "Gb", "G", "G#", "Ab", "A", "A#", "Bb", "B"];
export const SCALE_MODES = [
  "major",
  "minor",
  "dorian",
  "phrygian",
  "lydian",
  "mixolydian",
  "locrian",
  "harmonic minor",
  "melodic minor",
  "major pentatonic",
  "minor pentatonic",
  "blues",
  "chromatic",
  "whole tone",
];

// --- Расширение CodeMirror ---

function docNode(doc: DocEntry): HTMLElement {
  const box = document.createElement("div");
  box.className = "code-doc";
  const h = document.createElement("div");
  h.className = "code-doc-name";
  h.textContent = doc.params?.length ? `${doc.name}(${doc.params.join(", ")})` : doc.name;
  box.append(h);
  if (doc.mt) {
    const b = document.createElement("div");
    b.className = "code-doc-mt";
    b.textContent = "только в MIDI Teacher — на strudel.cc этой функции нет";
    box.append(b);
  }
  const text = doc.ru ?? doc.en;
  if (text) {
    const p = document.createElement("p");
    p.textContent = text;
    if (!doc.ru) p.lang = "en";
    box.append(p);
  }
  if (doc.synonyms?.length) {
    const s = document.createElement("div");
    s.className = "code-doc-syn";
    s.textContent = `Другие имена: ${doc.synonyms.join(", ")}`;
    box.append(s);
  }
  if (doc.example) {
    const pre = document.createElement("pre");
    pre.textContent = doc.example;
    box.append(pre);
  }
  return box;
}

/** Автодополнение и справка по наведению. `sounds` — имена загруженных звуков (меняются по ходу). */
export function strudelAssist(sounds: () => string[]) {
  const fnNames = functionNames();
  const fnOptions: Completion[] = fnNames.map((name) => {
    const doc = docFor(name)!;
    return {
      label: name,
      type: "function",
      detail: doc.mt ? "MIDI Teacher" : undefined,
      boost: doc.ru ? 2 : 0,
      info: () => docNode(doc),
    };
  });

  const source = (ctx: CompletionContext): CompletionResult | null => {
    const line = ctx.state.doc.lineAt(ctx.pos);
    const before = line.text.slice(0, ctx.pos - line.from);
    const c = contextAt(before);
    if (!c) return null;
    if (c.kind === "function" && !c.word && !ctx.explicit && !before.endsWith(".")) return null;
    const from = ctx.pos - c.word.length;
    const opts = (list: string[], type: string, detail?: string): Completion[] => list.slice(0, 300).map((label) => ({ label, type, detail }));
    if (c.kind === "function") return { from, options: fnOptions, validFor: /^[\w$]*$/ };
    if (c.kind === "sound") return { from, options: opts(soundOptions(sounds(), c.word), "constant", "звук"), validFor: /^[\w-]*$/ };
    if (c.kind === "bank") return { from, options: opts(bankOptions(sounds(), c.word), "constant", "банк") };
    if (c.kind === "scale") return { from, options: opts(SCALE_TONICS.map((t) => `${t}:`), "constant", "тоника") };
    return { from, options: SCALE_MODES.map((m) => ({ label: m.replace(/ /g, ":"), type: "constant", detail: "лад" })) };
  };

  const hover = hoverTooltip((view: EditorView, pos: number) => {
    const line = view.state.doc.lineAt(pos);
    const at = pos - line.from;
    const text = line.text;
    let a = at;
    let b = at;
    while (a > 0 && /[\w$]/.test(text[a - 1])) a--;
    while (b < text.length && /[\w$]/.test(text[b])) b++;
    if (a === b) return null;
    // В строке (мини-нотация) не подсказываем.
    const quotes = (text.slice(0, a).match(/["']/g) ?? []).length;
    if (quotes % 2 === 1) return null;
    const doc = docFor(text.slice(a, b));
    if (!doc) return null;
    return { pos: line.from + a, end: line.from + b, above: true, create: () => ({ dom: docNode(doc) }) };
  });

  return [autocompletion({ override: [source], icons: false, activateOnTyping: true }), hover];
}
