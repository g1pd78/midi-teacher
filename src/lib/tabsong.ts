// Песня из табов (Guitar Pro, текстовые табы): общая модель и её запись в MEI.
//
// Модель не зависит от формата: такты (размер, тональность, части песни), порядок их звучания
// (повторы уже развёрнуты), темп по тактам и партии — гитара, бас (табы с ладами), фортепиано и
// другие (обычные ноты), барабаны. Из модели строится MEI выбранной партии и аккомпанемент
// остальных — с одной картой темпа, чтобы всё звучало вместе.
//
// Verovio меняет темп только с начала такта, поэтому темп такта — средний по такту (длительность
// такта как в оригинале), а аккомпанемент считается по той же карте.

import type { AccompNote } from "../api";
import { drumMei, drumOfGm, type DrumBar, type DrumHit, type DrumScore } from "./drums";

/** Тиков на четверть (как в alphaTab). */
export const TPQ = 960;

export type PartKind = "guitar" | "bass" | "piano" | "drums" | "other";

export interface TsNote {
  /** Звучащая высота (MIDI); у барабанов — нота GM. */
  pitch: number;
  /** Струна от низкой (0) и лад от каподастра — у табов. */
  string?: number;
  fret?: number;
  /** Продолжение ноты под лигой. */
  tie?: boolean;
  /** Глушёная нота: только ритм, без высоты. */
  dead?: boolean;
  /** Подписи приёмов (H, P, ↗, B½, ~, PM…). */
  techniques?: string[];
  accent?: boolean;
  ghost?: boolean;
}

export interface TsBeat {
  /** Начало в такте и длительность, тики. */
  tick: number;
  dur: number;
  /** Записанная длительность: 1, 2, 4, 8, 16, 32, 64; точки; триоль и т. п. (num:den). */
  type: number;
  dots: number;
  tuplet?: [number, number];
  /** Пусто — пауза. */
  notes: TsNote[];
  /** Слова: строка на каждый куплет. */
  lyrics?: string[];
  text?: string;
  chord?: string;
}

export interface TsStaff {
  tab: boolean;
  clef: "G" | "F" | "G8" | "F8";
  /** [такт файла][голос][доля] */
  bars: TsBeat[][][];
}

export interface TsPart {
  id: string;
  name: string;
  kind: PartKind;
  /** Инструмент General MIDI. */
  program: number;
  /** Открытые струны от низкой (без каподастра) — у гитары и баса. */
  tuning?: number[];
  capo: number;
  staves: TsStaff[];
}

export interface TsMasterBar {
  num: number;
  den: number;
  ticks: number;
  /** Ключевые знаки: −7…7 (бемоли — минус). */
  key: number;
  section?: string;
}

/** Такт в порядке звучания. */
export interface TsBarRef {
  master: number;
  /** Смены темпа внутри такта (тик от начала такта). */
  tempos: { tick: number; bpm: number }[];
  /** Который раз звучит этот такт (0 — первый): для куплетов слов. */
  pass: number;
}

export interface TabSong {
  title: string;
  artist: string;
  album: string;
  /** Темп в начале песни. */
  tempo: number;
  masters: TsMasterBar[];
  order: TsBarRef[];
  parts: TsPart[];
}

/** Записанная длительность одной нотой (четверть, восьмая с точкой…) или `null`, если одной не записать. */
export function writtenDuration(ticks: number): { type: number; dots: number } | null {
  for (const t of [1, 2, 4, 8, 16, 32])
    for (const dots of [0, 1]) if (Math.abs(((TPQ * 4) / t) * (dots ? 1.5 : 1) - ticks) < 1) return { type: t, dots };
  return null;
}

export const PART_KIND_NAME: Record<PartKind, string> = {
  guitar: "Гитара",
  bass: "Бас",
  piano: "Фортепиано",
  drums: "Барабаны",
  other: "Мелодия",
};

export const partTitle = (p: Pick<TsPart, "name" | "kind">) => p.name.trim() || PART_KIND_NAME[p.kind];

// --- Темп ---

/** Темп каждого такта (в порядке звучания): средний по такту, целый. */
export function barTempos(song: Pick<TabSong, "tempo" | "masters" | "order">): number[] {
  let cur = song.tempo;
  return song.order.map((ref) => {
    const ticks = song.masters[ref.master].ticks;
    const changes = [...ref.tempos].filter((t) => t.tick < ticks).sort((a, b) => a.tick - b.tick);
    let minutes = 0;
    let at = 0;
    for (const c of changes) {
      minutes += (c.tick - at) / TPQ / cur;
      at = c.tick;
      cur = c.bpm;
    }
    minutes += (ticks - at) / TPQ / cur;
    const bpm = minutes > 0 ? ticks / TPQ / minutes : cur;
    return Math.max(20, Math.min(400, Math.round(bpm)));
  });
}

/** Начало каждого такта, мс (при потактовом темпе). */
export function barStartsMs(song: Pick<TabSong, "masters" | "order">, tempos: number[]): number[] {
  let ms = 0;
  return song.order.map((ref, k) => {
    const start = ms;
    ms += (song.masters[ref.master].ticks / TPQ) * (60000 / tempos[k]);
    return start;
  });
}

// --- Написание нот ---

const SHARP_NAMES = ["c", "c", "d", "d", "e", "f", "f", "g", "g", "a", "a", "b"];
const SHARP_ALT = [0, 1, 0, 1, 0, 0, 1, 0, 1, 0, 1, 0];
const FLAT_NAMES = ["c", "d", "d", "e", "e", "f", "g", "g", "a", "a", "b", "b"];
const FLAT_ALT = [0, -1, 0, -1, 0, 0, -1, 0, -1, 0, -1, 0];
const SHARP_ORDER = ["f", "c", "g", "d", "a", "e", "b"];
const FLAT_ORDER = ["b", "e", "a", "d", "g", "c", "f"];

/** Высота → нота (диезы в диезных тональностях и до мажоре, бемоли — в бемольных). */
export function spell(midi: number, key: number): { pname: string; oct: number; alter: number } {
  const pc = ((midi % 12) + 12) % 12;
  const flat = key < 0;
  return { pname: (flat ? FLAT_NAMES : SHARP_NAMES)[pc], alter: (flat ? FLAT_ALT : SHARP_ALT)[pc], oct: Math.floor(midi / 12) - 1 };
}

function keyAlter(pname: string, key: number): number {
  if (key > 0) return SHARP_ORDER.slice(0, key).includes(pname) ? 1 : 0;
  if (key < 0) return FLAT_ORDER.slice(0, -key).includes(pname) ? -1 : 0;
  return 0;
}

const ACC = (alter: number) => (alter > 0 ? "s" : alter < 0 ? "f" : "n");

function esc(s: string): string {
  return s.replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" })[c]!);
}

// --- MEI партии ---

export interface PartChart {
  mei: string;
  /** Звучащие открытые струны (с каподастром) — у табов. */
  tuning?: number[];
  capo: number;
  measures: number;
  notes: number;
}

const isTab = (p: TsPart) => (p.kind === "guitar" || p.kind === "bass") && !!p.tuning?.length && p.staves[0]?.tab !== false;

/** Партия → MEI: табулатура (гитара, бас), обычные ноты (фортепиано и др.) или ударный стан. */
export function partChart(song: TabSong, index: number): PartChart {
  const part = song.parts[index];
  if (part.kind === "drums") return drumChart(song, part);
  const tab = isTab(part);
  const tempos = barTempos(song);
  const staves = tab ? part.staves.slice(0, 1) : part.staves;
  const sounding = tab ? part.tuning!.map((m) => m + part.capo) : undefined;
  const strings = sounding?.length ?? 0;
  let id = 0;
  let noteCount = 0;
  const nid = () => `t${index}x${++id}`;
  const measures: string[] = [];
  const ties: string[][] = song.order.map(() => []);
  const lastNote = new Map<string, { id: string; bar: number }>();
  let meter = "";
  let key = song.masters[song.order[0]?.master ?? 0]?.key ?? 0;

  song.order.forEach((ref, k) => {
    const mb = song.masters[ref.master];
    const head: string[] = [];
    const m = `${mb.num}/${mb.den}`;
    if (k > 0 && (m !== meter || (!tab && mb.key !== key))) {
      head.push(`<scoreDef meter.count="${mb.num}" meter.unit="${mb.den}"${!tab && mb.key !== key ? ` keysig="${keySig(mb.key)}"` : ""}/>`);
    }
    meter = m;
    if (!tab) key = mb.key;
    const controls: string[] = [];
    const staffXml = staves.map((st, si) => {
      const voices = st.bars[ref.master] ?? [];
      const used = voices.filter((v, vi) => vi === 0 || v.some((b) => b.notes.length));
      const acc = new Map<string, number>();
      const layers = (used.length ? used : [[]]).map((beats, vi) => {
        const items: Item[] = [];
        let pos = 0;
        // Открытая группа триоли (квинтоли…): неполную дополняем паузами той же группы.
        let run: { tuplet: [number, number]; type: number; acc: number; len: number } | null = null;
        const closeRun = (until: number) => {
          if (!run) return;
          const d = nominal(run.type, 0) * (run.tuplet[1] / run.tuplet[0]);
          while (run.acc + d <= run.len + 1 && pos + d <= until + 1) {
            items.push({ xml: `<${vi > 0 ? "space" : "rest"} dur="${run.type}"/>`, tick: pos, dur: d, type: run.type, dots: 0, tuplet: run.tuplet, short: false });
            pos += d;
            run.acc += d;
          }
          run = null;
        };
        for (const b of beats) {
          // Переполненный такт (бывает в файлах) — лишнее не пишем.
          if (b.tick >= mb.ticks) break;
          const same = run && b.tuplet && b.tuplet[0] === run.tuplet[0] && b.tuplet[1] === run.tuplet[1] && b.tick === pos;
          if (!same) closeRun(Math.min(b.tick, mb.ticks));
          if (b.tick > pos) items.push(...restItems(b.tick - pos, pos, vi > 0));
          pos = Math.max(pos, b.tick + b.dur);
          if (b.tuplet) {
            if (!run) run = { tuplet: b.tuplet, type: b.type, acc: 0, len: b.tuplet[1] * nominal(b.type, b.dots) };
            run.acc += b.dur;
            if (run.acc >= run.len - 1) run = null;
          }
          const playable = b.notes.filter((n) => !n.dead && (!tab || n.string !== undefined));
          const durAttr = ` dur="${b.type}"${b.dots ? ` dots="${b.dots}"` : ""}`;
          const labels = [...new Set(b.notes.flatMap((n) => n.techniques ?? []))];
          if (b.notes.some((n) => n.dead)) labels.push("X");
          if (!playable.length) {
            // Только глушёные ноты — пауза с подписью «X».
            const rid = labels.length && si === 0 && vi === 0 ? nid() : "";
            if (rid) controls.push(`<dir staff="1" startid="#${rid}" place="above"><rend fontsize="x-small">${esc(labels.join(" "))}</rend></dir>`);
            const el = vi > 0 && !rid ? "space" : "rest";
            items.push({ xml: `<${el}${rid ? ` xml:id="${rid}"` : ""}${durAttr}/>`, tick: b.tick, dur: b.dur, type: b.type, dots: b.dots, tuplet: b.tuplet, short: false });
            continue;
          }
          const gid = nid();
          const lyric = si === 0 && vi === 0 ? b.lyrics?.[Math.min(ref.pass, (b.lyrics?.length ?? 1) - 1)] : undefined;
          const notesXml = playable
            .sort((a, b2) => a.pitch - b2.pitch)
            .map((n, ni) => {
              const id2 = nid();
              const tieKey = `${si}:${n.pitch}`;
              const prev = lastNote.get(tieKey);
              if (n.tie && prev) ties[prev.bar].push(`<tie staff="${si + 1}" startid="#${prev.id}" endid="#${id2}"/>`);
              else noteCount++;
              lastNote.set(tieKey, { id: id2, bar: k });
              const verse = ni === 0 && lyric ? `<verse n="1"><syl>${esc(lyric)}</syl></verse>` : "";
              let attrs: string;
              if (tab) {
                const sp = spell(n.pitch, 0);
                attrs = ` pname="${sp.pname}" oct="${sp.oct}" accid.ges="${ACC(sp.alter)}" tab.course="${strings - n.string!}" tab.fret="${n.fret}"`;
              } else {
                const sp = spell(n.pitch, mb.key);
                const k2 = sp.pname + sp.oct;
                const expected = acc.get(k2) ?? keyAlter(sp.pname, mb.key);
                if (sp.alter !== expected && !n.tie) {
                  attrs = ` pname="${sp.pname}" oct="${sp.oct}" accid="${ACC(sp.alter)}"`;
                  acc.set(k2, sp.alter);
                } else attrs = ` pname="${sp.pname}" oct="${sp.oct}" accid.ges="${ACC(sp.alter)}"`;
                if (playable.length === 1) attrs += durAttr;
              }
              return verse ? `<note xml:id="${id2}"${attrs}>${verse}</note>` : `<note xml:id="${id2}"${attrs}/>`;
            });
          const xml = tab
            ? `<tabGrp xml:id="${gid}"${durAttr}><tabDurSym/>${notesXml.join("")}</tabGrp>`
            : playable.length === 1
              ? notesXml[0]
              : `<chord xml:id="${gid}"${durAttr}>${notesXml.join("")}</chord>`;
          // Подписи — к аккорду/группе (у одиночной ноты — к ней самой).
          const anchor = tab || playable.length > 1 ? gid : /xml:id="([^"]+)"/.exec(xml)![1];
          if (si === 0 && labels.length)
            controls.push(`<dir staff="1" startid="#${anchor}" place="above"><rend fontsize="x-small">${esc(labels.join(" "))}</rend></dir>`);
          if (si === 0 && b.chord) controls.push(`<harm staff="1" startid="#${anchor}">${esc(b.chord)}</harm>`);
          if (si === 0 && b.text) controls.push(`<dir staff="1" startid="#${anchor}" place="above"><rend fontstyle="italic" fontsize="small">${esc(b.text)}</rend></dir>`);
          items.push({ xml, tick: b.tick, dur: b.dur, type: b.type, dots: b.dots, tuplet: b.tuplet, short: b.type >= 8 });
        }
        closeRun(mb.ticks);
        if (pos < mb.ticks) items.push(...restItems(mb.ticks - pos, pos, vi > 0));
        return `<layer n="${vi + 1}">${group(items, mb)}</layer>`;
      });
      return `<staff n="${si + 1}">${layers.join("")}</staff>`;
    });
    // Темп: метка при заметной смене, значение — при любой.
    const bpm = tempos[k];
    if (k === 0 || bpm !== tempos[k - 1]) {
      const show = k === 0 || Math.abs(bpm - tempos[k - 1]) >= 3;
      controls.push(`<tempo staff="1" tstamp="1" midi.bpm="${bpm}">${show ? `♩ = ${bpm}` : ""}</tempo>`);
    }
    const section = mb.section && (k === 0 || song.order[k - 1].master !== ref.master || ref.pass === 0) ? mb.section : undefined;
    if (section) controls.push(`<dir staff="1" tstamp="1" place="above"><rend fontweight="bold">${esc(section)}</rend></dir>`);
    const next = song.order[k + 1];
    const right = !next ? ` right="end"` : song.masters[next.master].section ? ` right="dbl"` : "";
    measures.push(`${head.join("")}<measure xml:id="m${k + 1}" n="${k + 1}"${right}>${staffXml.join("")}${controls.join("")}`);
  });
  const body = measures.map((m, k) => m + ties[k].join("") + "</measure>").join("");
  const first = song.masters[song.order[0]?.master ?? 0] ?? { num: 4, den: 4, key: 0 };
  let staffGrp: string;
  if (tab) {
    const tuningXml =
      "<tuning>" +
      sounding!
        .map((mm, i) => {
          const sp = spell(mm, 0);
          return `<course n="${strings - i}" pname="${sp.pname}" oct="${sp.oct}"${sp.alter ? ` accid="${ACC(sp.alter)}"` : ""}/>`;
        })
        .reverse()
        .join("") +
      "</tuning>";
    staffGrp = `<staffGrp><staffDef n="1" notationtype="tab.guitar" lines="${strings}"><clef shape="TAB" line="${strings - 1}"/>${tuningXml}</staffDef></staffGrp>`;
  } else {
    const defs = staves.map((st, si) => `<staffDef n="${si + 1}" lines="5">${clefXml(st.clef)}</staffDef>`).join("");
    staffGrp = staves.length > 1 ? `<staffGrp symbol="brace" bar.thru="true">${defs}</staffGrp>` : `<staffGrp>${defs}</staffGrp>`;
  }
  const mei =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<mei xmlns="http://www.music-encoding.org/ns/mei" meiversion="5.0"><meiHead><fileDesc><titleStmt><title>${esc(song.title)}</title></titleStmt><pubStmt/></fileDesc></meiHead>` +
    `<music><body><mdiv><score><scoreDef meter.count="${first.num}" meter.unit="${first.den}"${tab ? "" : ` keysig="${keySig(first.key)}"`} midi.bpm="${tempos[0] ?? song.tempo}">` +
    staffGrp +
    `</scoreDef><section>${body}</section></score></mdiv></body></music></mei>`;
  return { mei, tuning: sounding, capo: tab ? part.capo : 0, measures: song.order.length, notes: noteCount };
}

function keySig(key: number): string {
  return key === 0 ? "0" : key > 0 ? `${key}s` : `${-key}f`;
}

function clefXml(c: TsStaff["clef"]): string {
  switch (c) {
    case "F":
      return `<clef shape="F" line="4"/>`;
    case "F8":
      return `<clef shape="F" line="4" dis="8" dis.place="below"/>`;
    case "G8":
      return `<clef shape="G" line="2" dis="8" dis.place="below"/>`;
    default:
      return `<clef shape="G" line="2"/>`;
  }
}

interface Item {
  xml: string;
  tick: number;
  dur: number;
  type: number;
  dots: number;
  tuplet?: [number, number];
  short: boolean;
}

/** Паузы на промежуток (в голосах кроме первого — невидимые). */
function restItems(len: number, from: number, invisible: boolean): Item[] {
  const out: Item[] = [];
  const el = invisible ? "space" : "rest";
  let t = from;
  // Крупные — сначала: целая, половинная, четверть… до 64-й.
  for (const type of [1, 2, 4, 8, 16, 32, 64]) {
    const d = (TPQ * 4) / type;
    while (len >= d) {
      out.push({ xml: `<${el} dur="${type}"/>`, tick: t, dur: d, type, dots: 0, short: false });
      t += d;
      len -= d;
    }
  }
  return out;
}

const nominal = (type: number, dots: number) => ((TPQ * 4) / type) * (dots === 1 ? 1.5 : dots === 2 ? 1.75 : 1);

/** Триоли (и др.) — в группы `<tuplet>`; восьмые и мельче одной доли — под ребро. */
function group(items: Item[], mb: TsMasterBar): string {
  const beamUnit = mb.den === 8 && mb.num % 3 === 0 ? (TPQ * 3) / 2 : TPQ;
  const out: string[] = [];
  const beam = (xs: Item[]): string => {
    const parts: string[] = [];
    let run: Item[] = [];
    const flush = () => {
      if (run.length >= 2) parts.push(`<beam>${run.map((r) => r.xml).join("")}</beam>`);
      else parts.push(...run.map((r) => r.xml));
      run = [];
    };
    for (const it of xs) {
      if (it.short && (!run.length || Math.floor(it.tick / beamUnit) === Math.floor(run[0].tick / beamUnit))) run.push(it);
      else {
        flush();
        if (it.short) run.push(it);
        else parts.push(it.xml);
      }
    }
    flush();
    return parts.join("");
  };
  let i = 0;
  let plain: Item[] = [];
  while (i < items.length) {
    const it = items[i];
    if (!it.tuplet) {
      plain.push(it);
      i++;
      continue;
    }
    out.push(beam(plain));
    plain = [];
    const [num, den] = it.tuplet;
    // Группа n:d — d записанных длительностей первой ноты (три восьмые в триоли — две восьмые).
    const groupLen = den * nominal(it.type, it.dots);
    const inner: Item[] = [];
    let acc = 0;
    while (i < items.length && items[i].tuplet && items[i].tuplet![0] === num && items[i].tuplet![1] === den) {
      inner.push(items[i]);
      acc += items[i].dur;
      i++;
      if (acc >= groupLen - 1) break;
    }
    out.push(`<tuplet num="${num}" numbase="${den}" bracket.visible="false">${beam(inner)}</tuplet>`);
  }
  out.push(beam(plain));
  return out.join("");
}

// --- Барабаны ---

function drumChart(song: TabSong, part: TsPart): PartChart {
  const tempos = barTempos(song);
  let notes = 0;
  const bars: DrumBar[] = song.order.map((ref) => {
    const mb = song.masters[ref.master];
    const beats = (part.staves[0]?.bars[ref.master] ?? []).flat();
    // Триоли — если есть удары не по сетке шестнадцатых, но по сетке триольных восьмых.
    const triplet = beats.some((b) => b.notes.length && b.tick % (TPQ / 4) !== 0 && b.tick % (TPQ / 3) === 0);
    const perBeat = triplet ? 3 : 4;
    const cell = TPQ / perBeat;
    const cells: DrumHit[][] = Array.from({ length: Math.max(1, Math.round(mb.ticks / cell)) }, () => []);
    for (const b of beats)
      for (const n of b.notes) {
        if (n.tie || n.dead || b.tick >= mb.ticks) continue;
        const d = drumOfGm(n.pitch);
        const c = Math.min(cells.length - 1, Math.round(b.tick / cell));
        if (!d || cells[c].some((h) => h.drum === d.id)) continue;
        cells[c].push({ drum: d.id, accent: n.accent || undefined, ghost: n.ghost || undefined });
        notes++;
      }
    return { perBeat, cells };
  });
  const first = song.masters[song.order[0]?.master ?? 0];
  const score: DrumScore = {
    bpm: tempos[0] ?? song.tempo,
    bars,
    meter: first ? [first.num, first.den] : [4, 4],
    tempos,
    sections: song.order.map((ref, k) => {
      const s = song.masters[ref.master].section;
      return s && (k === 0 || ref.pass === 0 || song.order[k - 1].master !== ref.master) ? s : undefined;
    }),
  };
  return { mei: drumMei(score, { title: song.title }), capo: 0, measures: bars.length, notes };
}

// --- Аккомпанемент ---

/** Каналы GM: барабаны — 9, остальные партии — по порядку (кроме 9). */
export function partChannel(song: TabSong, index: number): number {
  if (song.parts[index].kind === "drums") return 9;
  let ch = 0;
  for (let i = 0; i < index; i++) if (song.parts[i].kind !== "drums") ch++;
  ch = ch % 15;
  return ch >= 9 ? ch + 1 : ch;
}

/** Все партии, кроме `except`, — ноты для приложения (время — по потактовой карте темпа). */
export function songAccompaniment(song: TabSong, except: number): AccompNote[] {
  const tempos = barTempos(song);
  const starts = barStartsMs(song, tempos);
  const out: AccompNote[] = [];
  song.parts.forEach((part, pi) => {
    if (pi === except) return;
    const channel = partChannel(song, pi);
    const program = part.kind === "drums" ? null : part.program;
    part.staves.forEach((st) => {
      const open = new Map<number, AccompNote>();
      song.order.forEach((ref, k) => {
        const msPerTick = 60000 / tempos[k] / TPQ;
        const ticks = song.masters[ref.master].ticks;
        for (const voice of st.bars[ref.master] ?? [])
          for (const b of voice) {
            if (b.tick >= ticks) break;
            const startMs = starts[k] + b.tick * msPerTick;
            const durMs = b.dur * msPerTick;
            for (const n of b.notes) {
              if (n.dead) continue;
              const prev = open.get(n.pitch);
              if (n.tie && prev && part.kind !== "drums") {
                prev.durMs = Math.round(startMs + durMs - prev.startMs);
                continue;
              }
              const note: AccompNote = {
                pitch: n.pitch,
                startMs: Math.round(startMs),
                durMs: Math.max(30, Math.round(part.kind === "drums" ? Math.min(durMs, 200) : durMs)),
                measure: k + 1,
                channel,
                program,
              };
              open.set(n.pitch, note);
              out.push(note);
            }
          }
      });
    });
  });
  return out.sort((a, b) => a.startMs - b.startMs);
}
