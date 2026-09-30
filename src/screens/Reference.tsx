import { useState } from "react";
import { TheoryCardView } from "../components/Theory";
import { CARDS, THEORY_GROUPS } from "../lib/theory";
import { useApp } from "../store";

/** «Справочник»: все карточки теории с примерами. */
export function Reference() {
  const seen = new Set(useApp((s) => s.prefs.theorySeen) ?? []);
  const [sel, setSel] = useState(CARDS[0]);
  return (
    <main className="reference">
      <nav className="card reference-list">
        <h1>Справочник</h1>
        {THEORY_GROUPS.map((g) => (
          <div key={g} className="reference-group">
            <div className="muted reference-group-title">{g}</div>
            {CARDS.filter((c) => c.group === g).map((c) => (
              <button key={c.id} className={`reference-item${c === sel ? " on" : ""}`} onClick={() => setSel(c)} data-card={c.id}>
                {c.title}
                {!seen.has(c.id) && <span className="reference-new" title="Ещё не встречалось">•</span>}
              </button>
            ))}
          </div>
        ))}
      </nav>
      <section className="card reference-detail">
        <TheoryCardView card={sel} />
      </section>
    </main>
  );
}
