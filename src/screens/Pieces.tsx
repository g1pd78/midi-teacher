import { useCallback, useEffect, useState } from "react";
import { api, onFileDrop, pickScoreFiles, type LibraryItem, type LibraryListing, type PieceProgress } from "../api";
import { BUILTIN_PIECES } from "../pieces";
import { PieceView, type PieceSource } from "./PieceView";
import { RecordPanel } from "../components/RecordPanel";
import { FragmentStrip } from "./Progress";

export function Pieces({ initial, onInitialOpened }: { initial?: string | null; onInitialOpened?: () => void }) {
  const [listing, setListing] = useState<LibraryListing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [open, setOpen] = useState<PieceSource | null>(null);
  const [progress, setProgress] = useState<Map<string, PieceProgress>>(new Map());
  const [recording, setRecording] = useState(false);

  const reload = useCallback(() => {
    api.libraryList().then(setListing).catch((e) => setError(String(e)));
  }, []);

  const importPaths = useCallback(
    async (paths: string[]) => {
      if (!paths.length) return;
      try {
        const added = await api.libraryImport(paths);
        setMessage(added.length ? `Добавлено: ${added.join(", ")}` : "Подходящих файлов нет (нужны .musicxml, .mxl, .mid или .psarc)");
        reload();
      } catch (e) {
        setError(String(e));
      }
    },
    [reload],
  );

  useEffect(() => {
    reload();
    let off: (() => void) | undefined;
    let alive = true;
    void onFileDrop((e) => {
      if (e.type === "over") setDragOver(true);
      else setDragOver(false);
      if (e.type === "drop") void importPaths(e.paths);
    }).then((fn) => (alive ? (off = fn) : fn()));
    return () => {
      alive = false;
      off?.();
    };
  }, [reload, importPaths]);

  // Прогресс разучивания на карточках (обновляется при возврате из пьесы).
  useEffect(() => {
    if (open) return;
    api
      .progressOverview()
      .then((p) => setProgress(new Map(p.pieces.map((x) => [x.id, x]))))
      .catch(() => {});
  }, [open]);

  const openBuiltin = useCallback(
    (p: (typeof BUILTIN_PIECES)[number]) => setOpen({ id: p.id, title: p.title, load: async () => ({ data: p.data, zip: false }) }),
    [],
  );
  const openUser = useCallback(
    (item: LibraryItem) =>
      setOpen({
        id: `user:${item.id}`,
        title: item.title,
        load: async () => {
          const buf = await api.libraryRead(item.id);
          return item.format === "mxl" ? { data: buf, zip: true } : { data: new TextDecoder().decode(buf), zip: false };
        },
        midi: item.format === "midi" ? item.id : undefined,
        rocksmith: item.format === "psarc" ? item.id : undefined,
      }),
    [],
  );

  // Переход с экрана «Прогресс»: открыть нужную пьесу.
  useEffect(() => {
    if (!initial) return;
    const builtin = BUILTIN_PIECES.find((p) => p.id === initial);
    const user = listing?.items.find((i) => `user:${i.id}` === initial);
    if (builtin) openBuiltin(builtin);
    else if (user) openUser(user);
    else if (!listing) return; // ждём список файлов
    onInitialOpened?.();
  }, [initial, listing, openBuiltin, openUser, onInitialOpened]);

  if (open) return <PieceView source={open} onBack={() => setOpen(null)} />;

  const strip = (id: string) => {
    const pr = progress.get(id);
    if (!pr || !pr.fragments.some((f) => f.started)) return null;
    const learned = pr.fragments.filter((f) => f.learned).length;
    return (
      <div className="card-progress">
        <FragmentStrip piece={pr} compact />
        <span className="muted">{pr.learned ? "выучена наизусть" : `выучено ${learned} из ${pr.fragments.length}`}</span>
      </div>
    );
  };

  return (
    <main className="pieces">
      {dragOver && <div className="drop-overlay">Отпусти, чтобы добавить в библиотеку</div>}
      <section className="card pieces-intro">
        <div>
          <h1>Пьесы</h1>
          <p className="hint">
            Выбери пьесу. В режиме «Разучить» приложение делит её на фрагменты по 2–4 такта и ведёт от прослушивания
            и полных подсказок до игры по памяти. В режиме «Свободно» играешь как хочешь: руки, темп, циклы.
          </p>
        </div>
      </section>

      <section>
        <h2 className="section-h">Встроенные</h2>
        <div className="piece-grid">
          {BUILTIN_PIECES.map((p) => (
            <button
              key={p.id}
              className="piece-card card"
              onClick={() => openBuiltin(p)}
            >
              <div className="piece-title">{p.title}</div>
              <div className="piece-composer">{p.composer}</div>
              <div className="piece-desc">{p.description}</div>
              <span className="chip small">{p.level}</span>
              {strip(p.id)}
            </button>
          ))}
        </div>
      </section>

      <section>
        <div className="section-row">
          <h2 className="section-h">Мои файлы</h2>
          <span className="buttons">
            <button onClick={() => setRecording((v) => !v)} className={recording ? "primary" : ""} data-record-open>
              ● Записать игру
            </button>
            <button onClick={async () => importPaths(await pickScoreFiles())}>Добавить файл…</button>
            <button onClick={() => void api.libraryOpenFolder()}>Открыть папку</button>
          </span>
        </div>
        {recording && (
          <RecordPanel
            onClose={() => setRecording(false)}
            onSaved={(file) => {
              setRecording(false);
              setMessage(`Запись сохранена: ${file}`);
              reload();
            }}
          />
        )}
        {error && <div className="notice warn">{error}</div>}
        {message && <div className="notice info">{message}</div>}
        <p className="hint">
          Файлы MusicXML (.musicxml, .xml, .mxl), MIDI (.mid) и песни Rocksmith (.psarc) из папки{" "}
          {listing ? <code>{listing.dir}</code> : "библиотеки"}. Можно просто перетащить файл в окно. Из MIDI приложение
          само строит ноты: при первом открытии выбери, какие дорожки играешь. Песни Rocksmith — пользовательские (CDLC,
          например с CustomsForge): скачай файл сам и добавь сюда — откроются табы гитары и баса с настоящим строем;
          официальные DLC игры не открываются.
        </p>
        {listing && listing.items.length === 0 && <p className="muted">Пока пусто.</p>}
        <div className="piece-grid">
          {listing?.items.map((item) => (
            <button key={item.id} className="piece-card card" onClick={() => openUser(item)} data-file={item.id}>
              <div className="piece-title">{item.title}</div>
              <div className="piece-composer">{item.id}</div>
              {item.format === "midi" && <span className="chip small">MIDI</span>}
              {item.format === "psarc" && <span className="chip small" title="Песня Rocksmith (CDLC): табы гитары и баса">Rocksmith</span>}
              {strip(`user:${item.id}`)}
            </button>
          ))}
        </div>
      </section>
    </main>
  );
}
