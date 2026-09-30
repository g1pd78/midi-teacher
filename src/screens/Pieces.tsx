import { useCallback, useEffect, useState } from "react";
import { api, onFileDrop, pickScoreFiles, type LibraryItem, type LibraryListing, type PieceProgress } from "../api";
import { BUILTIN_PIECES } from "../pieces";
import { PieceView, type PieceSource } from "./PieceView";
import { FragmentStrip } from "./Progress";

export function Pieces({ initial, onInitialOpened }: { initial?: string | null; onInitialOpened?: () => void }) {
  const [listing, setListing] = useState<LibraryListing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [open, setOpen] = useState<PieceSource | null>(null);
  const [progress, setProgress] = useState<Map<string, PieceProgress>>(new Map());

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
      }),
    [],
  );

  // Переход с экрана «Прогресс»: открыть нужную пьесу.
  useEffect(() => {
    if (!initial) return;
    const builtin = BUILTIN_PIECES.find((p) => p.id === initial);
    const user = listing?.items.find((i) => `user:${i.id}` === initial && i.format !== "midi");
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
                {strip(`user:${item.id}`)}
              </button>
            ),
          )}
        </div>
      </section>
    </main>
  );
}
