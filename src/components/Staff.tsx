import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { buildMei, type Clef, type StaffNote } from "../lib/mei";
import type { NoteNaming } from "../lib/notes";
import { verovioOptions, type StaffLayout } from "../lib/staffOptions";
import { renderSvg } from "../lib/verovio";

export type NoteMark = "current" | "correct" | "wrong" | "done-wrong";

export interface StaffProps {
  notes: StaffNote[];
  grand: boolean;
  clef: Clef;
  layout: StaffLayout;
  naming: NoteNaming;
  marks?: Record<string, NoteMark>;
  /** Подписи: у всех нот, ни у одной или у перечисленных id. */
  names: "all" | "none" | string[];
  onRendered?: () => void;
}

/** Нотный стан (Verovio) с подсветкой нот по id. */
export function Staff({ notes, grand, clef, layout, naming, marks = {}, names, onRendered }: StaffProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [svg, setSvg] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const key = JSON.stringify([notes, grand, clef, layout, naming]);

  useEffect(() => {
    let alive = true;
    renderSvg(buildMei(notes, { grand, clef, naming }), verovioOptions(layout, notes.length))
      .then((s) => alive && (setSvg(s), setError(null)))
      .catch((e) => alive && setError(String(e)));
    return () => {
      alive = false;
    };
    // key описывает все входные данные рендера
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  // Ноты вписываются по центру отведённого места.
  useLayoutEffect(() => {
    ref.current?.querySelector("svg")?.setAttribute("preserveAspectRatio", "xMidYMid meet");
  }, [svg]);

  // Подсветка и подписи меняются без повторного рендера нот.
  useLayoutEffect(() => {
    const root = ref.current;
    if (!root) return;
    for (const n of notes) {
      const el = root.querySelector<SVGGElement>(`g[id="${n.id}"]`);
      if (!el) continue;
      const mark = marks[n.id];
      el.setAttribute("class", `note${mark ? ` mark-${mark}` : ""}${Array.isArray(names) && names.includes(n.id) ? " show-name" : ""}`);
    }
  });

  useEffect(() => {
    if (svg) onRendered?.();
    // Сообщаем только о новом SVG
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [svg]);

  if (error) return <div className="staff-error">Не удалось нарисовать ноты: {error}</div>;
  return (
    <div
      ref={ref}
      className={`staff-svg ${layout}${names === "all" ? " names-all" : ""}`}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
