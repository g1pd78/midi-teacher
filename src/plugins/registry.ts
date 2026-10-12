// Состояние плагинов для экранов: разделы настроек, окна в пьесе, режим подтверждения нажатий и связь с
// пьесой. Без установленных плагинов всё пусто, и экраны ничего не показывают.

import { useSyncExternalStore } from "react";
import { api, listen, type PieceEvent, type PluginManifest } from "../api";
import type { FingerReport, FingerVerdict } from "./fingers";
import type { HandSide } from "../lib/hands";

/** Ответ на ждущее нажатие, пришедший раньше события `pending`, годен столько. */
const EARLY_MS = 300;

export type Mount = (el: HTMLElement) => void | (() => void);

export interface SettingsSection {
  key: string;
  pluginId: string;
  title: string;
  mount: Mount;
}

export interface PieceOverlay {
  key: string;
  pluginId: string;
  mount: Mount;
}

export interface LoadedPlugin {
  manifest: PluginManifest;
  /** Текст ошибки загрузки или `activate`. */
  error?: string;
}

/** Шаг пьесы для плагина: какие ноты ждём, какой рукой и каким пальцем (по аппликатуре). */
export interface PieceStep {
  index: number;
  notes: { pitch: number; hand: HandSide; finger: number | null }[];
}

/** Связь с открытой пьесой: экран пьесы сверяет пальцы со своей аппликатурой. */
export interface PieceBridge {
  report(r: FingerReport): FingerVerdict | null;
}

export interface PluginsSnapshot {
  plugins: LoadedPlugin[];
  sections: SettingsSection[];
  overlays: PieceOverlay[];
  /** Хоть один плагин просит подтверждать нажатия. */
  confirmHits: boolean;
}

let snap: PluginsSnapshot = { plugins: [], sections: [], overlays: [], confirmHits: false };
const subs = new Set<() => void>();
let seq = 0;

function update(patch: Partial<PluginsSnapshot>) {
  snap = { ...snap, ...patch };
  subs.forEach((f) => f());
}

export function subscribe(f: () => void): () => void {
  subs.add(f);
  return () => subs.delete(f);
}

export const snapshot = () => snap;

/** Плагины для React: перерисовка при любых изменениях. */
export function usePlugins(): PluginsSnapshot {
  return useSyncExternalStore(subscribe, snapshot);
}

export function setPlugins(plugins: LoadedPlugin[]) {
  update({ plugins });
}

export function addSection(s: Omit<SettingsSection, "key">): () => void {
  const key = `s${++seq}`;
  update({ sections: [...snap.sections, { ...s, key }] });
  return () => update({ sections: snap.sections.filter((x) => x.key !== key) });
}

export function addOverlay(o: Omit<PieceOverlay, "key">): () => void {
  const key = `o${++seq}`;
  update({ overlays: [...snap.overlays, { ...o, key }] });
  return () => update({ overlays: snap.overlays.filter((x) => x.key !== key) });
}

// --- Подтверждение нажатий ---

const confirmers = new Set<string>();

export function setConfirmHits(pluginId: string, on: boolean) {
  if (on) confirmers.add(pluginId);
  else confirmers.delete(pluginId);
  const want = confirmers.size > 0;
  if (want === snap.confirmHits) return;
  update({ confirmHits: want });
  void api.pieceConfirmHits(want).catch(() => {});
}

const pending = new Set<number>();
const early = new Map<number, { ok: boolean; at: number }>();
const pendingSubs = new Set<(pitch: number) => void>();

export function onPending(cb: (pitch: number) => void): () => void {
  pendingSubs.add(cb);
  return () => pendingSubs.delete(cb);
}

export function confirm(pitch: number, ok: boolean) {
  if (!pending.delete(pitch)) return;
  void api.pieceConfirm(pitch, ok).catch(() => {});
}

/** Событие ядра о пьесе (слушается, пока есть плагины). */
export function onPieceEvent(e: PieceEvent, now = performance.now()) {
  if (e.kind === "pending") {
    pending.add(e.pitch);
    const got = early.get(e.pitch);
    early.delete(e.pitch);
    if (got && now - got.at <= EARLY_MS) confirm(e.pitch, got.ok);
    else pendingSubs.forEach((f) => f(e.pitch));
  } else if (e.kind === "step" || e.kind === "finished") {
    pending.clear();
    early.clear();
  } else if (e.kind === "wrong") {
    pending.delete(e.pitch);
  }
}

let pieceListening = false;
export function listenPiece() {
  if (pieceListening) return;
  pieceListening = true;
  void listen("piece", (e) => onPieceEvent(e));
}

// --- Пьеса и пальцы ---

let bridge: PieceBridge | null = null;
let step: PieceStep | null = null;
const stepSubs = new Set<(s: PieceStep | null) => void>();

export function setBridge(b: PieceBridge | null) {
  bridge = b;
}

export function publishStep(s: PieceStep | null) {
  step = s;
  stepSubs.forEach((f) => f(s));
}

export const currentStep = () => step;

export function onStep(cb: (s: PieceStep | null) => void): () => void {
  stepSubs.add(cb);
  return () => stepSubs.delete(cb);
}

/** Плагин сообщил палец: экран пьесы сверяет и отмечает, ждущее нажатие подтверждается или отклоняется. */
export function reportFinger(r: FingerReport, now = performance.now()) {
  const v = bridge?.report(r) ?? null;
  // Нечего сверять (нет аппликатуры) — нажатие не держим.
  const ok = v ? v.ok : true;
  if (pending.has(r.pitch)) confirm(r.pitch, ok);
  else early.set(r.pitch, { ok, at: now });
}

/** Для тестов: всё с нуля. */
export function resetRegistry() {
  snap = { plugins: [], sections: [], overlays: [], confirmHits: false };
  confirmers.clear();
  pending.clear();
  early.clear();
  pendingSubs.clear();
  stepSubs.clear();
  bridge = null;
  step = null;
}
