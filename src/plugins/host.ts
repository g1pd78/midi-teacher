// API хоста для плагинов, версия 1. Описание для авторов плагинов — docs/plugins.md.
//
// Модуль плагина экспортирует `activate(host)`; всё, что плагин добавляет в интерфейс, появляется только через
// этот объект. Плагин, который ничего не зарегистрировал, в интерфейсе не виден.

import { convertFileSrc } from "@tauri-apps/api/core";
import { api, listen, type PluginManifest } from "../api";
import type { FingerReport } from "./fingers";
import * as reg from "./registry";

export const PLUGIN_API = 1;

export type { FingerReport } from "./fingers";
export type { Mount, PieceStep } from "./registry";

/** Нота с инструмента. `receivedAt` — `performance.now()` в момент прихода (для сверки с кадрами видео). */
export interface MidiNote {
  type: "on" | "off";
  pitch: number;
  velocity: number;
  device: string;
  timeUs: number;
  receivedAt: number;
}

export interface PluginHost {
  readonly api: number;
  readonly id: string;
  /** Ноты с инструментов. Возвращает отписку. */
  onMidi(cb: (n: MidiNote) => void): () => void;
  /** Новый шаг пьесы или упражнения в режиме ожидания; null — пьеса закрыта. */
  onPieceStep(cb: (step: reg.PieceStep | null) => void): () => void;
  /** Текущий шаг (или null). */
  expected(): reg.PieceStep | null;
  /** Каким пальцем нажата клавиша: хост сверяет с аппликатурой, отмечает «не тот палец» и считает статистику. */
  reportFinger(r: FingerReport): void;
  /** Режим подтверждения: верное нажатие засчитывается после `reportFinger` или `confirm` (без ответа — через 300 мс). */
  setConfirmHits(on: boolean): void;
  /** Верная клавиша ждёт подтверждения (только в режиме подтверждения). */
  onPending(cb: (pitch: number) => void): () => void;
  /** Подтвердить или отклонить ждущее нажатие без сверки пальца. */
  confirm(pitch: number, ok: boolean): void;
  /** Свой раздел в «Настройках». Возвращает функцию, убирающую раздел. */
  registerSettings(s: { title: string; mount: reg.Mount }): () => void;
  /** Своё окно в углу экрана пьесы. Возвращает функцию, убирающую окно. */
  registerPieceOverlay(o: { mount: reg.Mount }): () => void;
  /** Свои настройки плагина (JSON в его папке). */
  storage: {
    get<T = unknown>(): Promise<T | null>;
    set(value: unknown): Promise<void>;
  };
  /** Адрес файла плагина (WASM, модель): `host.url("model.task")`. */
  url(path: string): string;
  log(...args: unknown[]): void;
}

/** Адрес файла плагина по протоколу `mtplugin` (в Windows WebView2 — http://mtplugin.localhost/…). Слэши не
 * кодируются: относительные `import` внутри модуля плагина должны работать. */
export function pluginUrl(id: string, path: string): string {
  const rel = path.split("/").map(encodeURIComponent).join("/");
  return `${convertFileSrc("", "mtplugin")}${id}/${rel}`;
}

export function createHost(m: PluginManifest): PluginHost {
  const id = m.id;
  return {
    api: PLUGIN_API,
    id,
    onMidi(cb) {
      let off: (() => void) | null = null;
      let alive = true;
      void listen("midi", (e) => {
        if (e.type === "noteOn" || e.type === "noteOff")
          cb({
            type: e.type === "noteOn" ? "on" : "off",
            pitch: e.note,
            velocity: e.type === "noteOn" ? e.velocity : 0,
            device: e.device,
            timeUs: e.timeUs,
            receivedAt: performance.now(),
          });
      }).then((f) => (alive ? (off = f) : f()));
      return () => {
        alive = false;
        off?.();
      };
    },
    onPieceStep: (cb) => reg.onStep(cb),
    expected: () => reg.currentStep(),
    reportFinger: (r) => reg.reportFinger(r),
    setConfirmHits: (on) => reg.setConfirmHits(id, on),
    onPending: (cb) => reg.onPending(cb),
    confirm: (pitch, ok) => reg.confirm(pitch, ok),
    registerSettings: (s) => reg.addSection({ pluginId: id, title: s.title, mount: s.mount }),
    registerPieceOverlay: (o) => reg.addOverlay({ pluginId: id, mount: o.mount }),
    storage: {
      async get<T>() {
        const text = await api.pluginStorageGet(id);
        return text ? (JSON.parse(text) as T) : null;
      },
      set: (value) => api.pluginStorageSet(id, JSON.stringify(value)),
    },
    url: (path) => pluginUrl(id, path),
    log: (...args) => console.info(`[плагин ${id}]`, ...args),
  };
}
