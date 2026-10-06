import { useCallback, useEffect, useRef, useState } from "react";
import { api, type CodeFile } from "../api";
import { takeCodeRequest } from "../lib/codeBridge";
import { EXAMPLES } from "../lib/strudel/examples";
import { loadSounds } from "../lib/strudel/engine";
import { CodeEditor, type CodeEditorHandle, type CodePanel } from "./code/CodeEditor";
import { CodeTools } from "./code/CodeTools";

const NET_KEY = "mt-code-net";
const LAST_KEY = "mt-code-last";

function stored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function store(key: string, v: string) {
  try {
    localStorage.setItem(key, v);
  } catch {
    /* без памяти */
  }
}

const settingsName = (file: string) => file.replace(/\.js$/, ".mt.json");

/** Вкладка «Код»: треки-код (Strudel) в папке «Код», примеры, игра поверх кода. */
export function Code() {
  const [files, setFiles] = useState<CodeFile[] | null>(null);
  const [current, setCurrent] = useState<{ name: string; text: string; modified: number } | null>(null);
  const [panel, setPanel] = useState<CodePanel>({});
  const [net, setNet] = useState(stored(NET_KEY) === "1");
  const [note, setNote] = useState<string | null>(null);
  const [editorKey, setEditorKey] = useState(0);
  const handle = useRef<CodeEditorHandle | null>(null);
  const saveTimer = useRef<number | null>(null);
  const lastSaved = useRef("");

  const refresh = useCallback(async () => {
    const list = await api.codeList();
    setFiles(list);
    return list;
  }, []);

  const open = useCallback(async (name: string) => {
    const r = await api.codeRead(name);
    if (!r) return;
    const [text, modified] = r;
    const cfg = await api.codeRead(settingsName(name)).catch(() => null);
    let p: CodePanel = {};
    try {
      p = cfg ? (JSON.parse(cfg[0]) as CodePanel) : {};
    } catch {
      p = {};
    }
    handle.current?.stop();
    lastSaved.current = text;
    setPanel(p);
    setCurrent({ name, text, modified });
    setEditorKey((k) => k + 1);
    store(LAST_KEY, name);
  }, []);

  const create = useCallback(
    async (name: string, text: string) => {
      const file = await api.codeCreate(name, text);
      await refresh();
      await open(file);
      return file;
    },
    [open, refresh],
  );

  // Первое открытие: запрос «В код» с другого экрана, иначе последний трек, иначе первый.
  useEffect(() => {
    void (async () => {
      const list = await refresh();
      const req = takeCodeRequest();
      if (req) return void create(req.name, req.text);
      const last = stored(LAST_KEY);
      const name = list.find((f) => f.name === last)?.name ?? list[0]?.name;
      if (name) await open(name);
      else await create("Первый трек", EXAMPLES[0].code);
    })();
    const onReq = () => {
      const req = takeCodeRequest();
      if (req) void create(req.name, req.text);
    };
    window.addEventListener("mt-open-code", onReq);
    return () => window.removeEventListener("mt-open-code", onReq);
  }, [create, open, refresh]);

  // Звуки: встроенные и свои; интернет-наборы — по переключателю.
  useEffect(() => {
    void loadSounds({ net, reload: true });
  }, [net]);

  // Правка снаружи (свой редактор, Claude): при возвращении в окно — перечитать, если файл новее.
  useEffect(() => {
    const onFocus = () => {
      if (!current) return;
      void api.codeRead(current.name).then((r) => {
        if (r && r[1] > current.modified + 1000 && r[0] !== lastSaved.current) {
          lastSaved.current = r[0];
          handle.current?.setCode(r[0]);
          setCurrent({ ...current, text: r[0], modified: r[1] });
          setNote("Файл изменён снаружи — загружена новая версия.");
        }
      });
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [current]);

  const onCodeChange = (code: string) => {
    if (!current || code === lastSaved.current || code === "// LOADING") return;
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    const name = current.name;
    saveTimer.current = window.setTimeout(() => {
      lastSaved.current = code;
      void api.codeWrite(name, code).then((modified) => setCurrent((c) => (c && c.name === name ? { ...c, modified } : c)));
    }, 1000);
  };

  const onPanelChange = (p: CodePanel) => {
    setPanel(p);
    if (current) void api.codeWrite(settingsName(current.name), JSON.stringify(p, null, 2));
  };

  const rename = async () => {
    if (!current) return;
    const to = window.prompt("Новое имя трека", current.name.replace(/\.js$/, ""));
    if (!to) return;
    const file = await api.codeRename(current.name, to);
    await refresh();
    await open(file);
  };

  const remove = async () => {
    if (!current || !window.confirm(`Удалить «${current.name}»?`)) return;
    await api.codeDelete(current.name);
    const list = await refresh();
    if (list[0]) await open(list[0].name);
    else await create("Первый трек", EXAMPLES[0].code);
  };

  return (
    <div className="code-screen" data-code-screen>
      <aside className="code-files">
        <div className="code-files-head">
          <b>Мои треки</b>
          <button className="ghost small" onClick={() => void create("Новый трек", "setcps(0.5)\n\n$: s(\"bd sd\")\n")} data-code-new>
            + Новый
          </button>
        </div>
        <ul data-code-files>
          {(files ?? []).map((f) => (
            <li key={f.name}>
              <button className={current?.name === f.name ? "file active" : "file"} onClick={() => void open(f.name)} data-code-file={f.name}>
                {f.name.replace(/\.js$/, "")}
              </button>
            </li>
          ))}
        </ul>
        <div className="code-files-head">
          <b>Примеры</b>
        </div>
        <ul>
          {EXAMPLES.map((e) => (
            <li key={e.id}>
              <button className="file" title={e.about} onClick={() => void create(e.title, e.code)} data-code-example={e.id}>
                {e.title}
                {e.mtOnly && <span className="chip small">MT</span>}
              </button>
            </li>
          ))}
        </ul>
        <div className="code-files-foot">
          <button className="link" onClick={() => void api.codeOpenFolder("code")}>
            Папка «Код»
          </button>
          <button className="link" onClick={() => void api.codeOpenFolder("samples")}>
            Папка «Сэмплы»
          </button>
          <button
            className="link"
            onClick={() => {
              void loadSounds({ net, reload: true }).then(() => setNote("Звуки обновлены."));
            }}
            data-code-reload-sounds
          >
            Обновить звуки
          </button>
          <label className="check" title="Оригинальные драм-машины и Dirt-Samples, как на strudel.cc. Скачиваются из интернета при первом использовании и сохраняются на компьютере.">
            <input
              type="checkbox"
              checked={net}
              onChange={(e) => {
                setNet(e.target.checked);
                store(NET_KEY, e.target.checked ? "1" : "0");
              }}
              data-code-net
            />{" "}
            Стандартные наборы Strudel (интернет)
          </label>
        </div>
      </aside>
      <section className="code-center">
        {current ? (
          <CodeEditor
            key={editorKey}
            initialCode={current.text}
            onCodeChange={onCodeChange}
            panel={panel}
            onPanelChange={onPanelChange}
            onReady={(h) => (handle.current = h)}
            toolbar={
              <>
                <span className="code-title" data-code-current={current.name}>
                  {current.name.replace(/\.js$/, "")}
                </span>
                <button className="ghost small" onClick={() => void rename()}>
                  Переименовать
                </button>
                <button className="ghost small" onClick={() => void remove()}>
                  Удалить
                </button>
                <CodeTools handle={() => handle.current} name={current.name.replace(/\.js$/, "")} panel={panel} onNote={setNote} onCreate={create} />
              </>
            }
          />
        ) : (
          <div className="loading">Загрузка…</div>
        )}
        {note && (
          <div className="code-note" data-code-note>
            {note}{" "}
            <button className="link" onClick={() => setNote(null)}>
              ок
            </button>
          </div>
        )}
      </section>
    </div>
  );
}
