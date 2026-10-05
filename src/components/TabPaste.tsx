import { useEffect, useMemo, useState } from "react";
import { api } from "../api";
import { parseTextTab, textTabHeader, textTabHeaderLine, type TabRhythm } from "../lib/asciitab";
import { partChart } from "../lib/tabsong";
import { tuningLabel } from "../lib/guitar";
import { renderScore } from "../lib/verovio";

const RHYTHMS: { id: TabRhythm; label: string }[] = [
  { id: "spacing", label: "по расстоянию" },
  { id: 8, label: "ровно восьмыми" },
  { id: 16, label: "ровно шестнадцатыми" },
  { id: 4, label: "ровно четвертями" },
];

/** «Вставить таб»: текст с сайта → предпросмотр нот → сохранить в библиотеку (.txt). */
export function TabPaste({ onClose, onSaved }: { onClose: () => void; onSaved: (file: string) => void }) {
  const [text, setText] = useState("");
  const [name, setName] = useState("");
  const [tempo, setTempo] = useState<number | null>(null);
  const [meter, setMeter] = useState<[number, number] | null>(null);
  const [rhythm, setRhythm] = useState<TabRhythm | null>(null);
  const [svg, setSvg] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Что написано в самом тексте — по умолчанию; выбранное в окне — поверх.
  const head = useMemo(() => textTabHeader(text), [text]);
  const parsed = useMemo(() => {
    if (!text.trim()) return null;
    try {
      return parseTextTab(text, { title: name, tempo: tempo ?? undefined, meter: meter ?? undefined, rhythm: rhythm ?? undefined });
    } catch (e) {
      return { error: String((e as Error).message ?? e) };
    }
  }, [text, name, tempo, meter, rhythm]);
  const ok = parsed && !("error" in parsed) ? parsed : null;

  // Предпросмотр: первые такты табулатуры.
  useEffect(() => {
    setSvg("");
    if (!ok) return;
    let alive = true;
    const timer = window.setTimeout(() => {
      renderScore(partChart(ok.song, 0).mei, { scale: 40, breaks: "auto", pageWidth: 2000, adjustPageHeight: true, svgViewBox: true, header: "none", footer: "none" })
        .then((r) => alive && setSvg(r.pages[0] ?? ""))
        .catch(() => {});
    }, 250);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [ok]);

  const save = async () => {
    if (!ok) return;
    setSaving(true);
    setError(null);
    try {
      // Выбранные темп, размер и ритм — первой строкой файла: при открытии получится то же.
      const header = textTabHeaderLine({ tempo: ok.tempo, meter: ok.meter, rhythm: ok.rhythm });
      const body = text.split(/\r?\n/).filter((l) => !/^\s*Темп:\s*\d+\s*·\s*Размер:/.test(l)).join("\n");
      const file = await api.libraryAddText(name.trim() || "Таб", `${header}\n${body}`);
      onSaved(file);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="theory-modal" data-tab-paste>
      <div className="card track-dialog tab-paste">
        <div className="section-row">
          <h2>Вставить таб</h2>
          <button className="small" onClick={onClose}>
            Закрыть
          </button>
        </div>
        <p className="hint">
          Скопируй таб с сайта (строки вида <code>e|---0---3---|</code>) и вставь сюда. В текстовых табах нет длительностей:
          ритм берётся по расстоянию между цифрами внутри такта (или ровно восьмыми — выбери, как точнее). Строй — по буквам
          слева, каподастр — из строки «Capo 2».
        </p>
        <textarea
          className="tab-text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={"e|-------0---|\nB|-----1-----|\nG|---2-------|\nD|-2---------|\nA|-----------|\nE|-----------|"}
          spellCheck={false}
          data-tab-text
        />
        <div className="guitar-row">
          <label className="grow">
            Название
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Таб" data-tab-name />
          </label>
          <label>
            Темп
            <input
              type="number"
              min={30}
              max={300}
              value={tempo ?? head.tempo ?? 90}
              onChange={(e) => setTempo(Number(e.target.value) || null)}
              style={{ width: 70 }}
              data-tab-tempo
            />
          </label>
          <label>
            Размер
            <select value={(meter ?? head.meter ?? [4, 4]).join("/")} onChange={(e) => setMeter(e.target.value.split("/").map(Number) as [number, number])}>
              {["4/4", "3/4", "2/4", "6/8", "12/8"].map((m) => (
                <option key={m}>{m}</option>
              ))}
            </select>
          </label>
          <label>
            Ритм
            <select value={String(rhythm ?? head.rhythm ?? "spacing")} onChange={(e) => setRhythm(e.target.value === "spacing" ? "spacing" : (Number(e.target.value) as TabRhythm))} data-tab-rhythm>
              {RHYTHMS.map((r) => (
                <option key={r.id} value={String(r.id)}>
                  {r.label}
                </option>
              ))}
            </select>
          </label>
        </div>
        {parsed && "error" in parsed && <div className="notice warn">{parsed.error}</div>}
        {ok && (
          <p className="muted" data-tab-summary={`${ok.strings}:${ok.bars}:${ok.notes}`}>
            {ok.strings === 4 || ok.strings === 5 ? "Бас" : "Гитара"}, {ok.strings} струн · {tuningLabel(ok.song.parts[0].tuning!, ok.capo, ok.strings <= 5 ? "bass" : "guitar")} · тактов: {ok.bars} · нот: {ok.notes}
          </p>
        )}
        {svg && <div className="tab-preview" dangerouslySetInnerHTML={{ __html: svg }} />}
        {error && <div className="notice warn">{error}</div>}
        <div className="buttons">
          <button className="primary" disabled={!ok || saving} onClick={() => void save()} data-tab-save>
            Сохранить в библиотеку
          </button>
        </div>
      </div>
    </div>
  );
}
