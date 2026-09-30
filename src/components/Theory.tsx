import { useEffect, useState } from "react";
import { CARD_BY_ID, type TheoryCard } from "../lib/theory";
import { renderSvg } from "../lib/verovio";
import { useApp } from "../store";

/** Нотный пример карточки (Verovio). */
export function TheoryExample({ card }: { card: TheoryCard }) {
  const [svg, setSvg] = useState<string | null>(null);
  useEffect(() => {
    if (!card.example) return;
    let alive = true;
    setSvg(null);
    renderSvg(card.example(), {
      scale: 45,
      header: "none",
      footer: "none",
      svgViewBox: true,
      adjustPageHeight: true,
      adjustPageWidth: true,
      breaks: "none",
      pageWidth: 20000,
      pageMarginTop: 40,
      pageMarginBottom: 40,
      pageMarginLeft: 20,
      pageMarginRight: 20,
    })
      .then((s) => alive && setSvg(s))
      .catch(() => alive && setSvg(""));
    return () => {
      alive = false;
    };
  }, [card]);
  if (!card.example) return null;
  return (
    <div className="paper theory-example">
      {svg === null ? <span className="muted">…</span> : <div dangerouslySetInnerHTML={{ __html: svg }} />}
    </div>
  );
}

/** Карточка целиком: заголовок, текст, пример. */
export function TheoryCardView({ card }: { card: TheoryCard }) {
  return (
    <div className="theory-card">
      <div className="muted theory-group">{card.group}</div>
      <h2>{card.title}</h2>
      {card.body.map((p, i) => (
        <p key={i}>{p}</p>
      ))}
      <TheoryExample card={card} />
    </div>
  );
}

/** Окно с карточкой поверх экрана. */
export function TheoryModal({ card, onClose }: { card: TheoryCard; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="theory-modal" onClick={onClose}>
      <div className="card theory-modal-card" onClick={(e) => e.stopPropagation()}>
        <TheoryCardView card={card} />
        <div className="summary-actions">
          <button className="primary" onClick={onClose}>
            Понятно
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Плашка «Новое» сбоку: первый ещё не показанный элемент из `features`.
 * Игру не останавливает; «Понятно» отмечает карточку показанной.
 */
export function TheoryPlaque({ features }: { features: string[] }) {
  const { prefs, setPrefs } = useApp();
  const [open, setOpen] = useState<TheoryCard | null>(null);
  const seen = new Set(prefs.theorySeen ?? []);
  const unseen = features.filter((id) => !seen.has(id) && CARD_BY_ID.has(id));
  const card = unseen.length ? CARD_BY_ID.get(unseen[0])! : null;
  const markSeen = (id: string) => setPrefs({ theorySeen: [...(prefs.theorySeen ?? []), id] });
  return (
    <>
      {card && (
        <aside className="theory-plaque" data-theory={card.id}>
          <div className="theory-plaque-head">
            <b>Новое: {card.title}</b>
            {unseen.length > 1 && <span className="muted">ещё {unseen.length - 1}</span>}
          </div>
          <p>{card.short}</p>
          <div className="buttons">
            <button className="small" onClick={() => setOpen(card)}>
              Подробнее
            </button>
            <button className="small primary" onClick={() => markSeen(card.id)}>
              Понятно
            </button>
          </div>
        </aside>
      )}
      {open && (
        <TheoryModal
          card={open}
          onClose={() => {
            markSeen(open.id);
            setOpen(null);
          }}
        />
      )}
    </>
  );
}
