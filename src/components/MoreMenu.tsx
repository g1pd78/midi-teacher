import { useEffect, useRef, useState } from "react";

/**
 * Кнопка «⋯» с выпадающей панелью — для редких настроек, чтобы основная панель
 * помещалась в строку. Панель остаётся в документе (скрыта), закрывается кликом мимо и Esc.
 */
export function MoreMenu({ children, title = "Ещё" }: { children: React.ReactNode; title?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    // Перехват до обработчиков экрана: Esc закрывает только меню.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopImmediatePropagation();
      setOpen(false);
    };
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open]);
  return (
    <span className="more-menu" ref={ref}>
      <button className={open ? "on" : ""} onClick={() => setOpen((o) => !o)} title={title} data-more>
        ⋯
      </button>
      <div className="more-pop" hidden={!open}>
        {children}
      </div>
    </span>
  );
}
