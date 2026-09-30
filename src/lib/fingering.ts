// Аппликатура на нотном стане: цифры пальцев вставляются в MEI элементами <fing>.
// Подбор и ручные правки считает ядро (`mt_core::fingering`); здесь только показ.

import type { MeiStructure, ScoreNote } from "./score";

export type FingerSource = "manual" | "file" | "auto";

export interface Finger {
  id: string;
  finger: number;
  source: FingerSource;
}

export interface FingerNoteIn {
  id: string;
  pitch: number;
  startMs: number;
  durMs: number;
  hand: "right" | "left";
  file: number | null;
}

/** Палец из текста аппликатуры в файле: «3», «3-4» (подмена) → первая цифра. */
export function parseFinger(text: string | undefined): number | null {
  const m = /[1-5]/.exec(text ?? "");
  return m ? Number(m[0]) : null;
}

/** Ноты пьесы для подбора аппликатуры (с пальцами из файла). */
export function fingerNotes(notes: ScoreNote[], structure: MeiStructure): FingerNoteIn[] {
  return notes.map((n) => ({
    id: n.id,
    pitch: n.pitch,
    startMs: n.startMs,
    durMs: n.durMs,
    hand: n.hand,
    file: parseFinger(structure.fingerOf.get(n.id)),
  }));
}

const FING = /<fing\b[^>]*?(?:\/>|>[\s\S]*?<\/fing>)/g;

/**
 * Заменяет аппликатуру в MEI: убирает <fing> из файла и ставит свою цифру
 * у каждой ноты — над нотой для правой руки, под нотой для левой.
 * Подобранные автоматически помечаются type="auto" (в SVG — класс `auto`,
 * рисуются серым), ручные — type="manual".
 */
export function injectFingering(mei: string, fingers: Finger[], notes: ScoreNote[]): string {
  const noteOf = new Map(notes.map((n) => [n.id, n]));
  const byMeasure = new Map<number, string[]>();
  for (const f of fingers) {
    const n = noteOf.get(f.id);
    if (!n) continue;
    const type = f.source === "file" ? "" : ` type="${f.source}"`;
    const place = n.hand === "right" ? "above" : "below";
    const el = `<fing${type} startid="#${f.id}" staff="${n.staff}" place="${place}">${f.finger}</fing>`;
    byMeasure.set(n.measure, [...(byMeasure.get(n.measure) ?? []), el]);
  }
  let measure = 0;
  return mei
    .replace(FING, "")
    .replace(/<measure\b[^>]*>|<\/measure>/g, (tag) => {
      if (tag.startsWith("<measure")) {
        measure += 1;
        return tag;
      }
      return (byMeasure.get(measure) ?? []).join("") + tag;
    });
}
