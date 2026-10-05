// Подсказки распознаванию звука гитары/баса: какие ноты и аккорды сейчас ждёт пьеса.

import { useEffect, useMemo } from "react";
import { api } from "../../api";
import type { StringInstrument } from "../../lib/tab";
import type { ScoreNote } from "../../lib/score";
import type { Current } from "./helpers";

export function useGuitarHints(
  strInst: StringInstrument | null,
  rhythmMode: boolean,
  steps: { onsets: number[]; ids: string[][] },
  rhythmStep: number,
  noteById: Map<string, ScoreNote>,
  current: Current | null,
) {
  // Подсказка распознаванию гитары: какие ноты сейчас ждём (ошибки на октаву).
  const expectKey = strInst
    ? rhythmMode
      ? steps.ids.slice(Math.max(0, rhythmStep), Math.max(0, rhythmStep) + 3).flat().map((id) => noteById.get(id)?.pitch ?? 0).join(",")
      : (current?.required ?? []).join(",")
    : "";
  useEffect(() => {
    if (!strInst) return;
    void api.guitarExpect(expectKey ? expectKey.split(",").map(Number).filter(Boolean) : []).catch(() => {});
  }, [strInst, expectKey]);
  useEffect(() => () => void api.guitarExpect([]).catch(() => {}), []);
  // Аккорды впереди (бой, аккорды в табах): удар по струнам проверяется по спектру, а не по одной ноте.
  // Кандидаты — текущий и соседние шаги; режим аккорда — если среди них есть аккорд от 3 звуков.
  const chordKey = useMemo(() => {
    if (!strInst) return "[]";
    const sets: number[][] = rhythmMode
      ? steps.ids.slice(Math.max(0, rhythmStep - 1), Math.max(0, rhythmStep) + 3).map((ids) => ids.map((id) => noteById.get(id)?.pitch ?? 0).filter(Boolean))
      : current
        ? [current.required]
        : [];
    const uniq = [...new Map(sets.map((s) => [[...s].sort((a, b) => a - b).join(","), [...s].sort((a, b) => a - b)])).values()].filter((s) => s.length);
    return JSON.stringify(uniq.some((s) => s.length >= 3) ? uniq : []);
  }, [strInst, rhythmMode, steps, rhythmStep, noteById, current]);
  useEffect(() => {
    if (!strInst) return;
    void api.guitarExpectChords(JSON.parse(chordKey)).catch(() => {});
  }, [strInst, chordKey]);
  useEffect(() => () => void api.guitarExpectChords([]).catch(() => {}), []);
}
