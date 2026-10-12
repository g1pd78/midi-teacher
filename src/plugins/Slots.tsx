// Места в интерфейсе для плагинов: разделы настроек и окна в пьесе. Нет плагинов — ничего не рисуется.

import { useEffect, useRef } from "react";
import { usePlugins, type Mount } from "./registry";

/** Элемент, в который плагин рисует сам; ошибка плагина не роняет экран. */
function PluginMount({ mount, className }: { mount: Mount; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let off: void | (() => void);
    try {
      off = mount(el);
    } catch (e) {
      console.error("плагин:", e);
    }
    return () => {
      try {
        off?.();
      } catch (e) {
        console.error("плагин:", e);
      }
      el.replaceChildren();
    };
  }, [mount]);
  return <div ref={ref} className={className} />;
}

/** Разделы плагинов в «Настройках» и строка об ошибках загрузки. */
export function PluginSettings() {
  const { plugins, sections } = usePlugins();
  if (!plugins.length) return null;
  const failed = plugins.filter((p) => p.error);
  return (
    <>
      {sections.map((s) => (
        <section className="card" key={s.key} data-plugin-section={s.pluginId}>
          <h2>{s.title}</h2>
          <PluginMount mount={s.mount} />
        </section>
      ))}
      <section className="card" data-plugins>
        <h2>Плагины</h2>
        {plugins.map((p) => (
          <p key={p.manifest.id} className={p.error ? "bad" : "muted"}>
            {p.manifest.name} {p.manifest.version}
            {p.error ? ` — не загрузился: ${p.error}` : ""}
          </p>
        ))}
        {failed.length > 0 && <p className="hint">Подробности — в журнале приложения.</p>}
      </section>
    </>
  );
}

/** Окна плагинов в углу экрана пьесы. */
export function PluginOverlays() {
  const { overlays } = usePlugins();
  if (!overlays.length) return null;
  return (
    <div className="plugin-overlays">
      {overlays.map((o) => (
        <PluginMount key={o.key} mount={o.mount} className="plugin-overlay" />
      ))}
    </div>
  );
}
