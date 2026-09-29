import { useCallback, useEffect, useState } from "react";
import { api, onFileDrop, pickScoreFiles, type LibraryItem, type LibraryListing } from "../api";
import { BUILTIN_PIECES } from "../pieces";
import { PieceView, type PieceSource } from "./PieceView";

export function Pieces() {
  const [listing, setListing] = useState<LibraryListing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [open, setOpen] = useState<PieceSource | null>(null);

  const reload = useCallback(() => {
    api.libraryList().then(setListing).catch((e) => setError(String(e)));
  }, []);

  const importPaths = useCallback(
    async (paths: string[]) => {
      if (!paths.length) return;
      try {
        const added = await api.libraryImport(paths);
        setMessage(added.length ? `Добавлено: ${added.join(", ")}` : "Подходящих файлов нет (нужны .musicxml, .mxl или .mid)");
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

  if (open) return <PieceView source={open} onBack={() => setOpen(null)} />;

  const openUser = (item: LibraryItem) =>
    setOpen({
      id: `user:${item.id}`,
      title: item.title,
      load: async () => {
        const buf = await api.libraryRead(item.id);
        return item.format === "mxl" ? { data: buf, zip: true } : { data: new TextDecoder().decode(buf), zip: false };
      },
    });

  return (
    <main className="pieces">
      {dragOver && <div className="drop-overlay">Отпусти, чтобы добавить в библиотеку</div>}
      <section className="card pieces-intro">
        <div>
          <h1>Пьесы</h1>
          <p className="hint">
            Выбери пьесу и играй по нотам: курсор ждёт, пока ты нажмёшь нужные клавиши. Руку, которую сейчас не учишь,
            может играть приложение.
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
              onClick={() => setOpen({ id: p.id, title: p.title, load: async () => ({ data: p.data, zip: false }) })}
            >
              <div className="piece-title">{p.title}</div>
              <div className="piece-composer">{p.composer}</div>
              <div className="piece-desc">{p.description}</div>
              <span className="chip small">{p.level}</span>
            </button>
          ))}
        </div>
      </section>

      <section>
        <div className="section-row">
          <h2 className="section-h">Мои файлы</h2>
          <span className="buttons">
            <button onClick={async () => importPaths(await pickScoreFiles())}>Добавить файл…</button>
            <button onClick={() => void api.libraryOpenFolder()}>Открыть папку</button>
          </span>
        </div>
        {error && <div className="notice warn">{error}</div>}
        {message && <div className="notice info">{message}</div>}
        <p className="hint">
          Файлы MusicXML (.musicxml, .xml, .mxl) из папки {listing ? <code>{listing.dir}</code> : "библиотеки"}. Можно
          просто перетащить файл в окно.
        </p>
        {listing && listing.items.length === 0 && <p className="muted">Пока пусто.</p>}
        <div className="piece-grid">
          {listing?.items.map((item) =>
            item.format === "midi" ? (
              <div key={item.id} className="piece-card card disabled" title="Поддержка MIDI-файлов появится на этапе 6">
                <div className="piece-title">{item.title}</div>
                <div className="piece-composer">{item.id}</div>
                <div className="piece-desc">MIDI-файлы можно будет играть позже (этап 6).</div>
              </div>
            ) : (
              <button key={item.id} className="piece-card card" onClick={() => openUser(item)}>
                <div className="piece-title">{item.title}</div>
                <div className="piece-composer">{item.id}</div>
              </button>
            ),
          )}
        </div>
      </section>
    </main>
  );
}
