import { useEffect, useRef, useState } from "react";
import { api, listen } from "../api";
import { lightsFromHighlight, lightsKey, withPresses, type KeyHighlight } from "../lib/lights";
import { useApp } from "../store";

// Что подсвечивают экранные клавиатуры → лента над клавишами. Публикует последняя показанная клавиатура
// (обычно на экране одна); при её закрытии лента гаснет.

type Keys = [number, number][];
let current: Keys = [];
let owner = 0;
let nextOwner = 1;
/** Сколько клавиатур с подсказками сейчас показано (занятие идёт). */
let publishers = 0;
const subscribers = new Set<(k: Keys) => void>();

function publish(keys: Keys) {
  if (lightsKey(keys) === lightsKey(current)) return;
  current = keys;
  for (const s of subscribers) s(keys);
}

/** Для экранной клавиатуры: её подсказки уходят на ленту, пока она показана. */
export function usePublishLights(highlight: Record<number, KeyHighlight>, enabled: boolean) {
  const id = useRef(0);
  const keys = lightsFromHighlight(enabled ? highlight : {});
  const key = lightsKey(keys);
  useEffect(() => {
    if (!enabled) return;
    id.current = nextOwner++;
    owner = id.current;
    publishers++;
    return () => {
      publishers--;
      if (owner === id.current) publish([]);
    };
  }, [enabled]);
  useEffect(() => {
    if (enabled && owner === id.current) publish(keys);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, enabled]);
}

/** Текущие огоньки (для предпросмотра на экране): подсказки и, если включено, мои нажатия. */
export function useLights(): Keys {
  const [k, setK] = useState<Keys>(current);
  const held = useApp((s) => s.held);
  const show = useApp((s) => s.devices.lights?.showPresses ?? true);
  useEffect(() => {
    subscribers.add(setK);
    setK(current);
    return () => {
      subscribers.delete(setK);
    };
  }, []);
  return withPresses(k, Object.keys(held).map(Number), show, publishers > 0);
}

const IDLE_MS = 10 * 60 * 1000;
const MIN_INTERVAL_MS = 33;

/** Шлёт огоньки на плату: не чаще 30 раз в секунду; через 10 минут без игры лента гаснет. */
export function LightsBridge() {
  const enabled = useApp((s) => s.devices.lights?.enabled ?? false);
  const keys = useLights();
  const latest = useRef(keys);
  latest.current = keys;
  const keysKey = lightsKey(keys);
  const lastSent = useRef(0);
  const timer = useRef<number | null>(null);
  const idle = useRef(false);
  const lastActivity = useRef(Date.now());

  useEffect(() => {
    const send = () => {
      timer.current = null;
      lastSent.current = Date.now();
      void api.lightsSet(enabled && !idle.current ? latest.current : []).catch(() => {});
    };
    const wait = MIN_INTERVAL_MS - (Date.now() - lastSent.current);
    if (timer.current !== null) return;
    if (wait <= 0) send();
    else timer.current = window.setTimeout(send, wait);
  }, [keysKey, enabled]);

  useEffect(() => {
    let off: (() => void) | null = null;
    let alive = true;
    void listen("midi", () => {
      lastActivity.current = Date.now();
      if (idle.current) {
        idle.current = false;
        void api.lightsSet(latest.current).catch(() => {});
      }
    }).then((f) => (alive ? (off = f) : f()));
    const t = window.setInterval(() => {
      if (!idle.current && Date.now() - lastActivity.current > IDLE_MS) {
        idle.current = true;
        void api.lightsSet([]).catch(() => {});
      }
    }, 30_000);
    return () => {
      alive = false;
      off?.();
      window.clearInterval(t);
    };
  }, []);
  return null;
}
