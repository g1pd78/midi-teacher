// Загрузка плагинов при старте: список из ядра → import() модуля → activate(host).
// Ошибка одного плагина записывается и не мешает остальным и приложению.

import { api, inTauri, type PluginManifest } from "../api";
import { createHost, pluginUrl, PLUGIN_API, type PluginHost } from "./host";
import { listenPiece, setPlugins, type LoadedPlugin } from "./registry";

interface PluginModule {
  activate?: (host: PluginHost) => void | Promise<void>;
}

let started = false;

export async function loadPlugins(): Promise<void> {
  if (started || !inTauri) return;
  started = true;
  let list: PluginManifest[];
  try {
    list = await api.pluginList();
  } catch (e) {
    console.warn("плагины: список не получен", e);
    return;
  }
  if (!list.length) return;
  listenPiece();
  const loaded: LoadedPlugin[] = [];
  for (const m of list) {
    try {
      if (m.api !== PLUGIN_API) throw new Error(`API ${m.api} не поддерживается`);
      const mod = (await import(/* @vite-ignore */ pluginUrl(m.id, m.entry))) as PluginModule;
      if (typeof mod.activate !== "function") throw new Error("в модуле нет activate(host)");
      await mod.activate(createHost(m));
      loaded.push({ manifest: m });
    } catch (e) {
      console.error(`плагин ${m.id}:`, e);
      loaded.push({ manifest: m, error: e instanceof Error ? e.message : String(e) });
    }
  }
  setPlugins(loaded);
}
