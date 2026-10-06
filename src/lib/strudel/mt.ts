// Наши расширения Strudel (только в MIDI Teacher) и настройки панели «Код».
//
// - Партии: имена `melody: …` (и `$:` → «$0», «$1»…) собираются при каждом запуске; каждое событие помечается
//   `mtPart`. Панель может назначить партию «моей» (не звучит, подсвечивается и оценивается) или «Повтори за мной».
// - `.you()` — то же из кода; `echo(pat)` — фраза на чётных циклах, на нечётных — ваш повтор;
//   `harmony("<Am F C G>", "A:minor")` — гармония для импровизации (сама не звучит);
//   `kb(устройство?)` — последняя нота/сила/нажатие с MIDI-входа; `midin(устройство?)` — ручки (как на strudel.cc).

import { liveCc, liveKb } from "./live";

/* eslint-disable @typescript-eslint/no-explicit-any */
type Core = any;
type Pattern = any;

export interface PanelSettings {
  /** Имя партии, которую играю я (не звучит, подсветка и оценка). */
  myPart?: string | null;
  /** Партия для «Повтори за мной». */
  echoPart?: string | null;
  /** Аккорды для импровизации, мини-нотация: «<Am F C G>»; пусто — по звучащим нотам. */
  harmony?: string;
  /** Лад для импровизации: «A:minor», «C:major»…; пусто — определить по нотам. */
  scale?: string;
  /** Транспонировать все звучащие ноты на (последняя нота с клавиатуры − 60). */
  kbTranspose?: boolean;
}

export interface EvalInfo {
  /** Имена партий в порядке появления. */
  parts: string[];
  /** Гармония из кода (`harmony()`), если объявлена. */
  harmony: { chords: Pattern | null; scale: string | null } | null;
  /** В коде есть `.you()` или `echo()`. */
  hasYou: boolean;
}

let info: EvalInfo = { parts: [], harmony: null, hasYou: false };
let panel: PanelSettings = {};
let counter = 0;

export const evalInfo = () => info;
export const setPanel = (p: PanelSettings) => {
  panel = p;
};

const asObject = (v: unknown) => (v !== null && typeof v === "object" ? v : { value: v });

/** Строка в двойных кавычках транспилятор Strudel превращает в паттерн — достаём из него текст. */
export function asText(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === "string") return v;
  const p = v as { queryArc?: (a: number, b: number) => { value: unknown }[] };
  if (typeof p.queryArc === "function") {
    const first = p.queryArc(0, 1)[0]?.value;
    if (first === undefined) return undefined;
    // «A:minor:pentatonic» в мини-нотации — список ["A", "minor", "pentatonic"].
    if (Array.isArray(first)) return first.join(":");
    return String(typeof first === "object" ? ((first as { value?: unknown }).value ?? "") : first);
  }
  return String(v);
}

/** Партия «$0» → «Партия 1» для панели. */
export const partLabel = (name: string) => (/^\$\d+$/.test(name) ? `Партия ${Number(name.slice(1)) + 1}` : name);

let scope: Record<string, unknown> | null = null;

/** Один раз: методы паттерна; возвращает функции для области eval. */
export function installMt(core: Core): Record<string, unknown> {
  if (scope) return scope;
  const { Pattern, signal, silence, pure, mini } = core;

  Pattern.prototype.you = function (this: Pattern) {
    info.hasYou = true;
    return this.withValue((v: unknown) => ({ ...asObject(v), mtYou: true }));
  };

  const echo = (pat: Pattern) => {
    info.hasYou = true;
    return echoize(core, pat);
  };

  const harmony = (chords: string | Pattern, scale?: string | Pattern) => {
    const pat = typeof chords === "string" ? mini(chords) : chords ?? null;
    info.harmony = { chords: pat, scale: asText(scale) ?? null };
    return silence;
  };

  const kb = (dev?: string | Pattern) => {
    const device = asText(dev);
    return {
      note: signal(() => liveKb(device).note),
      vel: signal(() => liveKb(device).vel),
      gate: signal(() => (liveKb(device).gate ? 1 : 0)),
    };
  };

  // Как на strudel.cc: const cc = await midin('устройство'); …lpf(cc(74).range(200, 4000))
  const midin = async (dev?: string | Pattern) => {
    const device = asText(dev);
    return (n: number | Pattern, chan?: number | Pattern) =>
      signal(() => liveCc(device, Number(asText(n)), chan === undefined ? undefined : Number(asText(chan))));
  };

  scope = { echo, harmony, kb, midin, pure };
  return scope;
}

/** Перед каждым запуском: сбросить сведения и обернуть `.p()` (его заново ставит repl Strudel). */
export function beforeEvalMt(core: Core) {
  const { Pattern } = core;
  info = { parts: [], harmony: null, hasYou: false };
  counter = 0;
  const orig = Pattern.prototype.p;
  if (!orig || orig.__mt) return;
  const wrapped = function (this: Pattern, id: unknown) {
    if (typeof id === "string" && (id.startsWith("_") || id.endsWith("_"))) return orig.call(this, id);
    const name = typeof id === "string" && id.includes("$") ? `${id}${counter++}` : String(id);
    if (!info.parts.includes(name)) info.parts.push(name);
    let pat: Pattern = this.withValue((v: unknown) => ({ ...asObject(v), mtPart: name }));
    if (panel.echoPart === name) pat = echoize(core, pat);
    else if (panel.myPart === name) pat = pat.withValue((v: any) => ({ ...v, mtYou: true }));
    if (panel.kbTranspose && panel.myPart !== name) pat = transposeByKb(pat);
    return orig.call(pat, id);
  };
  (wrapped as any).__mt = true;
  Pattern.prototype.p = wrapped;
}

/**
 * «Повтори за мной»: фраза k (цикл k исходной партии) звучит на цикле 2k, а на цикле 2k+1 — та же фраза
 * как «моя» (не звучит, оценивается). Так ни одна фраза не теряется, даже у `<a b c>`.
 */
export function echoize(core: Core, pat: Pattern): Pattern {
  return new core.Pattern((state: any) => {
    const out: any[] = [];
    for (const span of state.span.spanCycles) {
      const c = span.begin.sam().valueOf();
      const k = Math.floor(c / 2);
      const sub = pat.late(c - k).query(state.setSpan(span));
      out.push(...(c % 2 === 1 ? sub.map((h: any) => h.withValue((v: unknown) => ({ ...asObject(v), mtYou: true, mtEcho: true }))) : sub));
    }
    return out;
  });
}

/** Ноты партии сдвигаются на (последняя нота с клавиатуры − 60); ударные (без note/n) не трогаем. */
function transposeByKb(pat: Pattern): Pattern {
  return pat.withValue((v: any) => {
    const shift = liveKb().note - 60;
    if (!shift || v.note === undefined) return v;
    return typeof v.note === "number" ? { ...v, note: v.note + shift } : v;
  });
}

/** Событие — партия ученика (не звучит). */
export const isYou = (v: unknown) => !!(v && typeof v === "object" && (v as { mtYou?: boolean }).mtYou);
