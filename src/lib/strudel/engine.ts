// Живой Strudel во вкладке «Код»: редактор (StrudelMirror), звук (superdough), наш вывод (партия ученика
// не звучит, а отмечается), перевод времени нажатий в циклы, подгрузка сэмплов заранее и офлайн-рендер WAV.
// Все пакеты Strudel грузятся лениво — только при открытии вкладки.

import { StateEffect } from "@codemirror/state";
import { convertFileSrc } from "@tauri-apps/api/core";
import { api, inTauri } from "../../api";
import { ClockSync } from "../transport";
import { loadStrudelCore, type Pattern } from "./evaluate";
import { beforeEvalMt, evalInfo, installMt, isYou, setPanel, type EvalInfo, type PanelSettings } from "./mt";
import { patternNotes, type CodeNote } from "./haps";
import { strudelAssist } from "./complete";
import { builtinSampleMap, NET_ALIAS_MAP, NET_SAMPLE_MAPS, proxiedMap, userSampleMap, type SampleBanks } from "./sounds";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface Engine {
  core: any;
  webaudio: any;
  codemirror: any;
  draw: any;
  transpiler: any;
}

let engine: Promise<Engine> | null = null;
let soundsReady: Promise<void> | null = null;

/** 10 мс тишины (WAV) — заглушка сэмплов в браузере без ядра. */
const SILENT_WAV = (() => {
  const n = 441;
  const b = new Uint8Array(44 + n * 2);
  const v = new DataView(b.buffer);
  const w = (o: number, s: string) => [...s].forEach((c, i) => (b[o + i] = c.charCodeAt(0)));
  w(0, "RIFF");
  v.setUint32(4, 36 + n * 2, true);
  w(8, "WAVEfmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, 44100, true);
  v.setUint32(28, 88200, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  w(36, "data");
  v.setUint32(40, n * 2, true);
  let bin = "";
  b.forEach((x) => (bin += String.fromCharCode(x)));
  return `data:audio/wav;base64,${btoa(bin)}`;
})();

/** Адрес звука из протокола mtsound (в браузере без Tauri звуков-сэмплов нет — только синтезаторы). */
export const soundUrl = (path: string) => (inTauri ? convertFileSrc(path, "mtsound") : `/__no_samples__/${path}`);

export function loadEngine(): Promise<Engine> {
  fixChannelCount();
  engine ??= (async () => {
    const [{ core, transpiler }, webaudio, codemirror, draw] = await Promise.all([
      loadStrudelCore(),
      import("@strudel/webaudio"),
      import("@strudel/codemirror"),
      import("@strudel/draw"),
    ]);
    const mt = installMt(core);
    await core.evalScope(webaudio, codemirror, draw, mt);

    await Promise.all([webaudio.registerSynthSounds(), webaudio.registerZZFXSounds?.()]);
    return { core, webaudio, codemirror, draw, transpiler };
  })();
  return engine;
}

/** Имена загруженных звуков (для подсказок в s("…")). */
export function soundNames(e: Engine | null): string[] {
  try {
    return Object.keys(e?.webaudio.soundMap?.get?.() ?? {});
  } catch {
    return [];
  }
}

/** Встроенные звуки, свои сэмплы и записи; интернет-наборы — по желанию. Можно вызывать повторно. */
export async function loadSounds(opts: { net: boolean; reload?: boolean }): Promise<void> {
  if (soundsReady && !opts.reload) return soundsReady;
  soundsReady = (async () => {
    const { webaudio } = await loadEngine();
    if (!inTauri) {
      // В браузере без ядра сэмплов нет: те же имена, но тишина — чтобы примеры работали без ошибок.
      await webaudio.samples(builtinSampleMap(() => SILENT_WAV));
      return;
    }
    await webaudio.samples(builtinSampleMap(soundUrl));
    const banks = await api.codeSampleBanks().catch((): SampleBanks => ({ user: {}, rec: [] }));
    await webaudio.samples(userSampleMap(banks, soundUrl));
    if (opts.net) {
      for (const url of NET_SAMPLE_MAPS) {
        try {
          const json = JSON.parse(await api.codeNetText(url));
          await webaudio.samples(proxiedMap(json, url, soundUrl));
        } catch (e) {
          console.warn("набор не загружен", url, e);
        }
      }
      try {
        await webaudio.aliasBank?.(JSON.parse(await api.codeNetText(NET_ALIAS_MAP)));
      } catch {
        /* без псевдонимов банков */
      }
    }
  })();
  return soundsReady;
}

export interface TriggerInfo {
  /** Звучащее или отмеченное (партия ученика) событие. */
  value: any;
  /** Момент по часам AudioContext. */
  audioTime: number;
  you: boolean;
}

export interface LiveCallbacks {
  onState?: (s: { started: boolean; error: string | null; pending: boolean; code: string; dirty: boolean }) => void;
  onEvaluated?: (info: EvalInfo) => void;
  onTrigger?: (t: TriggerInfo) => void;
}

/** Живой редактор со звуком. */
export class LiveCode {
  mirror: any = null;
  private clock = new ClockSync();
  private cb: LiveCallbacks;
  private e: Engine | null = null;

  constructor(cb: LiveCallbacks) {
    this.cb = cb;
  }

  async mount(root: HTMLElement, code: string, panel: () => PanelSettings): Promise<void> {
    const e = (this.e = await loadEngine());
    const { webaudio, codemirror, draw, core, transpiler } = e;
    void this.clock.sync();
    const output = async (hap: any, deadline: number, duration: number, cps: number, t: number) => {
      const you = isYou(hap.value);
      this.cb.onTrigger?.({ value: hap.value, audioTime: t, you });
      if (you) return;
      return webaudio.webaudioOutput(hap, deadline, duration, cps, t);
    };
    this.mirror = new codemirror.StrudelMirror({
      defaultOutput: output,
      getTime: () => webaudio.getAudioContext().currentTime,
      transpiler,
      root,
      initialCode: code,
      pattern: core.silence,
      drawTime: [-2, 2],
      drawContext: draw.getDrawContext(),
      prebake: () => loadSounds({ net: false }),
      solo: true,
      beforeEval: async () => {
        setPanel(panel());
        beforeEvalMt(core);
        await webaudio.initAudio?.();
        // Контекст создан до клика и стоит «на паузе»; initAudio его не будит — будим сами (это жест пользователя).
        const ctx = webaudio.getAudioContext();
        if (ctx.state !== "running") await ctx.resume().catch(() => {});
      },
      afterEval: () => {
        this.cb.onEvaluated?.(evalInfo());
        void this.prefetch();
      },
      onUpdateState: (s: any) =>
        this.cb.onState?.({
          started: !!s.started,
          error: s.error ? String(s.error?.message ?? s.error) : null,
          pending: !!s.pending,
          code: s.code ?? "",
          dirty: !!s.isDirty,
        }),
    });
    this.mirror.updateSettings?.({ ...codemirror.codemirrorSettings.get(), fontSize: 15, isLineWrappingEnabled: true });
    // Автодополнение и справка по наведению (свои: звуки, русские описания, наши функции).
    this.mirror.editor?.dispatch({ effects: StateEffect.appendConfig.of(strudelAssist(() => soundNames(this.e))) });
  }

  /** Вставить текст в позицию курсора (и выделить вставленное). */
  insertAtCursor(text: string) {
    const view = this.mirror?.editor;
    if (!view) return;
    const { from, to } = view.state.selection.main;
    view.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from, head: from + text.length } });
    view.focus();
  }

  get code(): string {
    return this.mirror?.code ?? "";
  }

  setCode(code: string) {
    this.mirror?.setCode(code);
  }

  async evaluate() {
    await this.mirror?.evaluate();
  }

  stop() {
    this.mirror?.stop();
  }

  destroy() {
    this.stop();
    this.mirror?.clear?.();
    this.mirror?.editor?.destroy?.();
    this.mirror = null;
  }

  /** Текущий итоговый паттерн (после запуска). */
  get pattern(): Pattern | null {
    return this.mirror?.repl?.state?.pattern ?? null;
  }

  get started(): boolean {
    return !!this.mirror?.repl?.scheduler?.started;
  }

  get cps(): number {
    return this.mirror?.repl?.scheduler?.cps ?? 0.5;
  }

  /** Цикл, который звучит в момент `audioTime` по часам AudioContext (формула планировщика Strudel). */
  cycleAtAudioTime(audioTime: number): number | null {
    const s = this.mirror?.repl?.scheduler;
    if (!s?.started || s.seconds_at_cps_change === undefined) return null;
    return s.num_cycles_at_cps_change + (audioTime - s.seconds_at_cps_change - (s.latency ?? 0.1)) * s.cps;
  }

  /** Момент по часам AudioContext, который слышен в момент performance.now() = `perfMs`. */
  audioTimeAtPerf(perfMs: number): number {
    const ctx = this.e?.webaudio.getAudioContext();
    if (!ctx) return 0;
    const ts = ctx.getOutputTimestamp?.();
    if (ts && ts.performanceTime) return ts.contextTime + (perfMs - ts.performanceTime) / 1000;
    return ctx.currentTime - (ctx.outputLatency ?? 0) - (ctx.baseLatency ?? 0) + (perfMs - performance.now()) / 1000;
  }

  /** Цикл, который сейчас слышен. */
  nowCycle(): number | null {
    return this.cycleAtAudioTime(this.audioTimeAtPerf(performance.now()));
  }

  /** Цикл нажатия по времени события ядра (мкс). */
  cycleOfCoreTime(timeUs: number): number | null {
    const perfMs = (timeUs - (this.clock.nowUs() - performance.now() * 1000)) / 1000;
    return this.cycleAtAudioTime(this.audioTimeAtPerf(perfMs));
  }

  /** Ноты итогового паттерна в окне циклов. */
  notes(from: number, to: number): CodeNote[] {
    const p = this.pattern;
    if (!p) return [];
    try {
      return patternNotes(p, from, to);
    } catch {
      return [];
    }
  }

  /** Загрузить заранее сэмплы первых 4 циклов — иначе первая нота опоздает и пропадёт. */
  private async prefetch() {
    const p = this.pattern;
    const w = this.e?.webaudio;
    if (!p || !w?.getSound) return;
    const seen = new Set<string>();
    try {
      const haps = p.queryArc(0, 4);
      for (const h of haps) {
        const v = h.value;
        if (!v || typeof v !== "object" || typeof v.s !== "string" || isYou(v)) continue;
        const k = `${v.s}|${v.n ?? 0}|${v.note ?? ""}`;
        if (seen.has(k) || seen.size > 64) continue;
        seen.add(k);
        const sound = w.getSound(v.s);
        const bank = sound?.data?.samples;
        if (!bank || !w.getSampleInfo || !w.loadBuffer) continue;
        const { url } = w.getSampleInfo({ ...v, n: v.n ?? 0 }, bank);
        if (url) void w.loadBuffer(url, w.getAudioContext()).catch(() => {});
      }
    } catch {
      /* не страшно */
    }
  }
}

/**
 * Офлайн-рендер циклов [0, cycles) в WAV (16 бит, стерео). `extra` — ваши нажатия: звучат роялем в том же графе.
 * Живой AudioContext сохраняется и возвращается после рендера.
 */
export async function renderWav(pattern: Pattern, cycles: number, cps: number, extra: CodeNote[] = [], rate = 44_100): Promise<ArrayBuffer> {
  const { webaudio, core } = await loadEngine();
  const live = webaudio.getAudioContext();
  const liveController = webaudio.getSuperdoughAudioController();
  const seconds = cycles / cps + 2;
  const ctx = new OfflineAudioContext(2, Math.ceil(seconds * rate), rate);
  webaudio.setAudioContext(ctx);
  webaudio.setSuperdoughAudioController(null);
  try {
    await webaudio.initAudio({ maxPolyphony: 256 });
    const haps = pattern.queryArc(0, cycles, { _cps: cps }).filter((h: any) => h.hasOnset() && !isYou(h.value));
    for (const h of haps) {
      const begin = h.whole.begin.valueOf();
      try {
        h.ensureObjectValue?.();
        await webaudio.superdough(h.value, begin / cps, h.duration / cps, cps, begin);
      } catch (e) {
        console.warn("событие не отрендерено", e);
      }
    }
    for (const n of extra) {
      if (n.midi === null) continue;
      await webaudio.superdough({ s: "piano", note: n.midi, gain: 0.9 }, n.begin / cps, Math.max(0.1, n.dur / cps), cps, n.begin);
    }
    const buf = await ctx.startRendering();
    return encodeWav(buf);
  } finally {
    webaudio.setAudioContext(live);
    webaudio.setSuperdoughAudioController(liveController);
    void core;
  }
}

/** WebKit отдаёт `destination.maxChannelCount = 0` и `channelCount = 0` (у офлайнового контекста и без звуковой
 *  карты), а superdough строит по ним микшер. Подменяем геттеры прототипа: ноль → стерео. */
function fixChannelCount() {
  const g = globalThis as unknown as { AudioDestinationNode?: { prototype: object }; AudioNode?: { prototype: object }; __mtChannelFix?: boolean };
  if (g.__mtChannelFix || !g.AudioDestinationNode || !g.AudioNode) return;
  g.__mtChannelFix = true;
  const find = (proto: object | null, name: string): PropertyDescriptor | undefined => {
    for (let p = proto; p; p = Object.getPrototypeOf(p)) {
      const d = Object.getOwnPropertyDescriptor(p, name);
      if (d) return d;
    }
    return undefined;
  };
  const dest = g.AudioDestinationNode.prototype;
  const max = find(dest, "maxChannelCount");
  if (max?.get) Object.defineProperty(dest, "maxChannelCount", { configurable: true, get() { return max.get!.call(this) || 2; } });
  const cc = find(dest, "channelCount");
  if (cc?.get)
    Object.defineProperty(dest, "channelCount", {
      configurable: true,
      get() {
        return cc.get!.call(this) || 2;
      },
      set(v: number) {
        try {
          cc.set?.call(this, v);
        } catch {
          /* у офлайнового контекста число каналов не меняется */
        }
      },
    });
}

function encodeWav(buf: AudioBuffer): ArrayBuffer {
  const ch = Math.min(2, buf.numberOfChannels);
  const len = buf.length;
  const out = new ArrayBuffer(44 + len * ch * 2);
  const v = new DataView(out);
  const str = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, "RIFF");
  v.setUint32(4, 36 + len * ch * 2, true);
  str(8, "WAVE");
  str(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, ch, true);
  v.setUint32(24, buf.sampleRate, true);
  v.setUint32(28, buf.sampleRate * ch * 2, true);
  v.setUint16(32, ch * 2, true);
  v.setUint16(34, 16, true);
  str(36, "data");
  v.setUint32(40, len * ch * 2, true);
  const data = [...Array(ch)].map((_, i) => buf.getChannelData(i));
  let o = 44;
  for (let i = 0; i < len; i++)
    for (let c = 0; c < ch; c++) {
      const s = Math.max(-1, Math.min(1, data[c][i]));
      v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      o += 2;
    }
  return out;
}

/** ArrayBuffer → base64 (для передачи WAV в ядро). */
export function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
