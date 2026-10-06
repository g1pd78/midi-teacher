// Живые данные с MIDI-входов для кода: kb() (последняя нота, сила, нажатие) и midin() (ручки CC).
// Порты держит ядро (WebMIDI их не откроет), поэтому значения приходят из событий «midi».

import type { MidiEvent } from "../../api";

interface KbState {
  note: number;
  vel: number;
  gate: boolean;
  held: Set<number>;
}

const kbs = new Map<string, KbState>();
const ccs = new Map<string, number>();
/** Последние сообщения для монитора «что присылает устройство». */
const monitor: { device: string; text: string; at: number }[] = [];
const listeners = new Set<() => void>();
let lastDevice = "";

const kbOf = (device: string) => {
  let s = kbs.get(device);
  if (!s) kbs.set(device, (s = { note: 60, vel: 0, gate: false, held: new Set() }));
  return s;
};

/** Подать событие с MIDI-входа (вызывается из вкладки «Код»). */
export function feedLive(e: MidiEvent) {
  lastDevice = e.device;
  for (const dev of [e.device, ""]) {
    const s = kbOf(dev);
    if (e.type === "noteOn") {
      s.note = e.note;
      s.vel = e.velocity / 127;
      s.held.add(e.note);
      s.gate = true;
    } else if (e.type === "noteOff") {
      s.held.delete(e.note);
      s.gate = s.held.size > 0;
    }
  }
  if (e.type === "controlChange") {
    for (const dev of [e.device, ""])
      for (const ch of [e.channel, -1]) ccs.set(`${dev}|${ch}|${e.controller}`, e.value / 127);
  }
  const text =
    e.type === "noteOn" ? `нота ${e.note}, сила ${e.velocity}` : e.type === "noteOff" ? `нота ${e.note} отпущена` : `CC ${e.controller} = ${e.value}`;
  monitor.unshift({ device: e.device, text: `${text} (канал ${e.channel + 1})`, at: Date.now() });
  monitor.length = Math.min(monitor.length, 12);
  for (const l of listeners) l();
}

/** Без устройства — любое (последнее нажатое). Имя устройства — по началу названия, без регистра. */
function pick<T>(map: Map<string, T>, device: string | undefined, make: (d: string) => T): T {
  if (!device) return make("");
  const want = device.toLowerCase();
  for (const key of map.keys()) if (key && key.toLowerCase().startsWith(want)) return map.get(key)!;
  return make(device);
}

export function liveKb(device?: string): { note: number; vel: number; gate: boolean } {
  return pick(kbs, device, kbOf);
}

export function liveCc(device: string | undefined, n: number, chan?: number): number {
  const ch = chan === undefined ? -1 : chan - 1;
  if (!device) return ccs.get(`|${ch}|${n}`) ?? 0;
  const want = device.toLowerCase();
  for (const [key, v] of ccs) {
    const [dev, c, num] = key.split("|");
    if (dev && dev.toLowerCase().startsWith(want) && Number(c) === ch && Number(num) === n) return v;
  }
  return 0;
}

export const liveMonitor = () => monitor.slice();
export const liveLastDevice = () => lastDevice;
export function onLive(f: () => void) {
  listeners.add(f);
  return () => {
    listeners.delete(f);
  };
}

/** Для тестов. */
export function resetLive() {
  kbs.clear();
  ccs.clear();
  monitor.length = 0;
}
