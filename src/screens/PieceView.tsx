import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api, listen, type HandMode, type PiecePrefs, type PieceSummary } from "../api";
import { Piano } from "../components/Piano";
import { keyLabel } from "../lib/notes";
import { addNoteNames, buildNotes, parseMei, type ScoreNote } from "../lib/score";
import { loadScore, renderScore, warmUpVerovio } from "../lib/verovio";
import { deviceColor, useApp } from "../store";

export interface PieceSource {
  id: string;
  title: string;
  load: () => Promise<{ data: string | ArrayBuffer; zip: boolean }>;
}

const HAND_COLOR = { right: "#5AA9FF", left: "#FFB454" } as const;
/** Темп шагов, которые проходят сами (только другая рука). */
const AUTO_TEMPO = 0.8;

const SOLFEGE: Record<string, string> = { c: "до", d: "ре", e: "ми", f: "фа", g: "соль", a: "ля", b: "си" };
const ACCID: Record<string, string> = { s: "♯", f: "♭", ss: "𝄪", ff: "𝄫" };

function verovioLayout(layout: "line" | "pages", width: number): Record<string, unknown> {
  const common = {
    scale: 42,
    header: "none",
    footer: "none",
    svgViewBox: true,
    svgRemoveXlink: true,
    adjustPageHeight: true,
    pageMarginTop: 60,
    pageMarginBottom: 60,
    pageMarginLeft: 40,
    pageMarginRight: 40,
    lyricSize: 3,
  };
  return layout === "line"
    ? { ...common, breaks: "none", pageWidth: 60000, pageHeight: 60000, adjustPageWidth: true }
    : // Ширина страницы в единицах Verovio подбирается под окно: ~2 единицы на пиксель при scale 42.
      { ...common, breaks: "auto", pageWidth: Math.max(1500, Math.round(width * 2)), pageHeight: 60000 };
}

function formatTime(ms: number): string {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

interface Current {
  index: number;
  noteIds: string[];
  required: number[];
}

export function PieceView({ source, onBack }: { source: PieceSource; onBack: () => void }) {
  const { prefs, setPrefs, held, devices } = useApp();
  const p = prefs.piece;
  const setPiece = (patch: Partial<PiecePrefs>) => setPrefs({ piece: { ...p, ...patch } });
  const naming = prefs.noteNames;

  const [mei, setMei] = useState<string | null>(null);
  const [pages, setPages] = useState<string[]>([]);
  const [notes, setNotes] = useState<ScoreNote[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [current, setCurrent] = useState<Current | null>(null);
  const [hits, setHits] = useState<Set<string>>(new Set());
  const [wrongKey, setWrongKey] = useState<number | null>(null);
  const [summary, setSummary] = useState<PieceSummary | null>(null);
  const [run, setRun] = useState(0);
  const [width, setWidth] = useState(1200);

  const scrollRef = useRef<HTMLDivElement>(null);
  const marked = useRef<Element[]>([]);

  // Загрузка файла → MEI.
  useEffect(() => {
    warmUpVerovio();
    let alive = true;
    source
      .load()
      .then(({ data, zip }) => loadScore(data, zip))
      .then((m) => alive && setMei(m))
      .catch((e) => alive && setError(`Не удалось открыть ноты: ${e.message ?? e}`));
    return () => {
      alive = false;
      void api.pieceStop();
    };
  }, [source]);

  // Ширина области нот (для режима «страницы»).
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(Math.round(el.clientWidth / 100) * 100));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Рендер нот и разбор пьесы.
  const layoutKey = p.layout === "pages" ? `pages-${width}` : "line";
  useEffect(() => {
    if (!mei) return;
    let alive = true;
    const text = p.names
      ? addNoteNames(mei, (pname, accid) => {
          const base = naming === "solfege" ? SOLFEGE[pname] : pname.toUpperCase();
          return base + (accid ? (ACCID[accid] ?? "") : "");
        })
      : mei;
    renderScore(text, verovioLayout(p.layout, width))
      .then((r) => {
        if (!alive) return;
        setPages(r.pages);
        setNotes(buildNotes(r.timemap, r.midi, parseMei(mei)));
      })
      .catch((e) => alive && setError(String(e)));
    return () => {
      alive = false;
    };
    // width входит в layoutKey
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mei, p.names, naming, layoutKey]);

  const hasLeft = notes.some((n) => n.hand === "left");
  const hasRight = notes.some((n) => n.hand === "right");
  const hands: HandMode = !hasLeft ? "right" : !hasRight ? "left" : p.hands;
  const noteById = useMemo(() => new Map(notes.map((n) => [n.id, n])), [notes]);
  const includes = (hand: "right" | "left") => hands === "both" || hands === hand;

  // Сессия режима ожидания в Rust: перезапуск при смене руки/второй руки/«заново».
  // Смена вида или подписей перерисовывает ноты, но id остаются те же — сессию не трогаем.
  const notesKey = useMemo(() => notes.map((n) => n.id).join(","), [notes]);
  const notesRef = useRef(notes);
  notesRef.current = notes;
  useEffect(() => {
    const notes = notesRef.current;
    if (!notes.length) return;
    setSummary(null);
    setHits(new Set());
    setCurrent(null);
    void api.pieceStart(
      notes.map(({ id, pitch, startMs, durMs, hand, measure }) => ({ id, pitch, startMs, durMs, hand, measure })),
      { hands, accompany: p.accompany, tempo: AUTO_TEMPO },
    );
  }, [notesKey, hands, p.accompany, run]);

  useEffect(() => {
    let off: (() => void) | undefined;
    let alive = true;
    void listen("piece", (e) => {
      if (e.kind === "step") {
        setCurrent({ index: e.index, noteIds: e.noteIds, required: e.required });
        setHits(new Set());
      } else if (e.kind === "hit") {
        setHits((h) => new Set([...h, ...e.noteIds]));
      } else if (e.kind === "wrong") {
        setWrongKey(e.pitch);
        setTimeout(() => setWrongKey((k) => (k === e.pitch ? null : k)), 600);
      } else if (e.kind === "finished") {
        setCurrent(null);
        setSummary(e.summary);
      }
    }).then((fn) => (alive ? (off = fn) : fn()));
    return () => {
      alive = false;
      off?.();
    };
  }, []);

  // Подсветка нот текущего шага прямо в SVG.
  useLayoutEffect(() => {
    const root = scrollRef.current;
    if (!root) return;
    for (const el of marked.current) el.classList.remove("mark-right", "mark-left", "mark-app", "mark-hit");
    marked.current = [];
    if (!current) return;
    for (const id of current.noteIds) {
      const el = root.querySelector(`g[id="${id}"]`);
      const n = noteById.get(id);
      if (!el || !n) continue;
      const cls = hits.has(id) ? "mark-hit" : includes(n.hand) ? `mark-${n.hand}` : "mark-app";
      el.classList.add(cls);
      marked.current.push(el);
    }
  });

  // Прокрутка к текущему месту.
  useEffect(() => {
    const root = scrollRef.current;
    if (!root || !current) return;
    const el = root.querySelector(`g[id="${current.noteIds[0]}"]`);
    if (!el) return;
    const box = el.getBoundingClientRect();
    const view = root.getBoundingClientRect();
    if (p.layout === "line") {
      const target = root.scrollLeft + (box.left - view.left) - view.width * 0.25;
      root.scrollTo({ left: Math.max(0, target), behavior: "smooth" });
    } else {
      const system = el.closest("g.system") ?? el;
      const sb = system.getBoundingClientRect();
      if (sb.top < view.top + 10 || sb.bottom > view.bottom - 10) {
        root.scrollTo({ top: root.scrollTop + (sb.top - view.top) - 20, behavior: "smooth" });
      }
    }
  }, [current, p.layout, pages]);

  const restart = useCallback(() => setRun((r) => r + 1), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === "INPUT") return;
      if (e.key === "Escape") onBack();
      else if (e.key === "r" || e.key === "R" || e.key === "к" || e.key === "К") restart();
      else if (e.key === "1") setPiece({ hands: "right" });
      else if (e.key === "2") setPiece({ hands: "left" });
      else if (e.key === "3") setPiece({ hands: "both" });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // Клавиатура: диапазон пьесы, подсветка нужных клавиш и нажатий.
  const [low, high] = useMemo(() => {
    if (!notes.length) return [48, 84];
    const ps = notes.map((n) => n.pitch);
    return [Math.min(...ps) - 2, Math.max(...ps) + 2];
  }, [notes]);
  const highlight: Record<number, { color: string; strength?: number }> = {};
  if (p.keyHints && current) {
    for (const id of current.noteIds) {
      const n = noteById.get(id);
      if (n && includes(n.hand) && !hits.has(id)) highlight[n.pitch] = { color: HAND_COLOR[n.hand], strength: 0.45 };
    }
  }
  for (const [n, h] of Object.entries(held)) highlight[Number(n)] = { color: deviceColor(h.device, devices), strength: 0.85 };
  if (wrongKey !== null) highlight[wrongKey] = { color: "#FF5C5C", strength: 0.9 };

  // Пьеса шире клавиатуры?
  const needed = notes.filter((n) => includes(n.hand)).map((n) => n.pitch);
  const narrow = devices.inputs.filter(
    (d) => d.connected && d.settings.range && needed.some((x) => x < d.settings.range![0] || x > d.settings.range![1]),
  );

  const totalSteps = useMemo(() => new Set(notes.map((n) => n.startMs)).size, [notes]);

  return (
    <main className="piece">
      <div className="piece-bar">
        <button className="ghost" onClick={onBack} title="Esc">
          ← Пьесы
        </button>
        <div className="piece-name">{source.title}</div>
        <span className="segmented" title="1 / 2 / 3">
          <button className={hands === "right" ? "on" : ""} disabled={!hasRight} onClick={() => setPiece({ hands: "right" })}>
            Правая
          </button>
          <button className={hands === "left" ? "on" : ""} disabled={!hasLeft} onClick={() => setPiece({ hands: "left" })}>
            Левая
          </button>
          <button className={hands === "both" ? "on" : ""} disabled={!hasLeft || !hasRight} onClick={() => setPiece({ hands: "both" })}>
            Обе
          </button>
        </span>
        <span className="segmented">
          <button className={p.layout === "line" ? "on" : ""} onClick={() => setPiece({ layout: "line" })}>
            Строка
          </button>
          <button className={p.layout === "pages" ? "on" : ""} onClick={() => setPiece({ layout: "pages" })}>
            Страницы
          </button>
        </span>
        <button onClick={restart} title="R">
          Заново
        </button>
      </div>
      <div className="piece-toggles">
        <Toggle label="Вторая рука звучит" on={p.accompany} disabled={hands === "both"} onChange={(v) => setPiece({ accompany: v })} />
        <Toggle label="Названия нот" on={p.names} onChange={(v) => setPiece({ names: v })} />
        <Toggle label="Аппликатура" on={p.fingering} onChange={(v) => setPiece({ fingering: v })} />
        <Toggle label="Подсветка клавиш" on={p.keyHints} onChange={(v) => setPiece({ keyHints: v })} />
        <span className="piece-progress">
          {current ? `шаг ${current.index + 1} из ${totalSteps}` : summary ? "сыграно" : ""}
        </span>
      </div>

      {error && <div className="notice warn">{error}</div>}
      {narrow.map((d) => (
        <div key={d.name} className="notice info">
          Пьеса выходит за диапазон «{d.name}» ({keyLabel(d.settings.range![0], naming)}–{keyLabel(d.settings.range![1], naming)}).
          Часть нот придётся играть на другом инструменте.
        </div>
      ))}

      <section className="paper piece-paper">
        <div
          ref={scrollRef}
          className={`score-scroll ${p.layout}${p.fingering ? "" : " hide-fing"}`}
          // Для сквозных тестов: текущий шаг и какие клавиши он ждёт.
          data-current-step={current ? current.index : ""}
          data-current-pitches={current ? current.required.join(",") : ""}
          data-finished={summary ? "1" : "0"}
        >
          {!pages.length && !error && <div className="muted score-loading">Загрузка нот…</div>}
          {pages.map((svg, i) => (
            <div key={i} className="score-page" dangerouslySetInnerHTML={{ __html: svg }} />
          ))}
        </div>
        {summary && (
          <div className="summary-overlay">
            <div className="summary card">
              <h2>Пьеса сыграна</h2>
              <div className="summary-stats">
                <div>
                  <div className={`big ${summary.errors === 0 ? "good" : ""}`}>{summary.errors}</div>
                  <div className="muted">ошибок</div>
                </div>
                <div>
                  <div className="big">{formatTime(summary.durationMs)}</div>
                  <div className="muted">время</div>
                </div>
              </div>
              {summary.troubleMeasures.length > 0 && (
                <div className="trouble">
                  <span className="muted">Трудные такты: </span>
                  {summary.troubleMeasures.slice(0, 6).map((m) => (
                    <span key={m.measure} className="chip small">
                      такт {m.measure} — {m.errors}
                    </span>
                  ))}
                </div>
              )}
              <div className="summary-actions">
                <button className="primary" onClick={restart}>
                  Ещё раз
                </button>
                <button className="ghost" onClick={onBack}>
                  К списку пьес
                </button>
              </div>
            </div>
          </div>
        )}
      </section>

      <section className="session-piano">
        <Piano low={low} high={high} naming={naming} highlight={highlight} labels="c" />
      </section>
    </main>
  );
}

function Toggle({ label, on, onChange, disabled }: { label: string; on: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <label className={`toggle${disabled ? " disabled" : ""}`}>
      <span className="switch">
        <input type="checkbox" checked={on} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
        <span />
      </span>
      {label}
    </label>
  );
}
