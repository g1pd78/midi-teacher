// Песня из файла с партиями: Rocksmith (.psarc), Guitar Pro, текстовый таб.
// Экран пьесы работает с ней одинаково: выбираешь партию, её ноты — на экране,
// остальные партии звучат.

import { api, type AccompNote } from "../api";
import { arrangementTitle, rsAccompaniment, rsChart, rsTuning, type RsSong } from "./rocksmith";
import { partChart, partTitle, songAccompaniment, type PartKind, type TabSong } from "./tabsong";
import { parseTextTab } from "./asciitab";

export type SongFormat = "psarc" | "gp" | "tab";

export interface FilePart {
  id: string;
  /** Короткий ключ партии (для разметки и тестов): lead, rhythm, bass, track0… */
  slug: string;
  title: string;
  kind: PartKind;
  /** Открытые струны от низкой, без каподастра (гитара, бас). */
  tuning?: number[];
  capo: number;
}

export interface FileSong {
  title: string;
  artist: string;
  format: SongFormat;
  parts: FilePart[];
  /** MEI партии (табы — с ладами и строем файла). */
  chart(index: number): string;
  /** Остальные партии — для приложения. */
  accompaniment(index: number): AccompNote[];
}

export function fromRocksmith(song: RsSong): FileSong {
  const charts = new Map<number, ReturnType<typeof rsChart>>();
  const chart = (i: number) => {
    if (!charts.has(i)) charts.set(i, rsChart(song, song.arrangements[i]));
    return charts.get(i)!;
  };
  return {
    title: song.title,
    artist: song.artist,
    format: "psarc",
    parts: song.arrangements.map((a) => ({
      id: a.id,
      slug: a.name.toLowerCase(),
      title: arrangementTitle(a),
      kind: a.bass ? "bass" : "guitar",
      tuning: rsTuning(a),
      capo: a.capo,
    })),
    chart: (i) => chart(i).mei,
    accompaniment: (i) => rsAccompaniment(song, song.arrangements[i], chart(i).barBeats),
  };
}

export function fromTabSong(song: TabSong, format: SongFormat): FileSong {
  const charts = new Map<number, string>();
  // Одинаковые названия партий («Гитара», «Гитара») — с номером.
  const titles = song.parts.map((p) => partTitle(p));
  return {
    title: song.title,
    artist: song.artist,
    format,
    parts: song.parts.map((p, i) => ({
      id: p.id,
      slug: p.id.toLowerCase(),
      title: titles.filter((t) => t === titles[i]).length > 1 ? `${titles[i]} ${titles.slice(0, i + 1).filter((t) => t === titles[i]).length}` : titles[i],
      kind: p.kind,
      tuning: p.tuning,
      capo: p.capo,
    })),
    chart: (i) => {
      if (!charts.has(i)) charts.set(i, partChart(song, i).mei);
      return charts.get(i)!;
    },
    accompaniment: (i) => songAccompaniment(song, i),
  };
}

/** Открыть песню из библиотеки. */
export async function openSongFile(id: string, format: SongFormat, title: string): Promise<FileSong> {
  if (format === "psarc") return fromRocksmith(await api.rocksmithOpen(id));
  const bytes = new Uint8Array(await api.libraryRead(id));
  if (format === "gp") {
    const { loadGuitarPro } = await import("./gp");
    const song = await loadGuitarPro(bytes);
    if (!song.parts.length) throw new Error("в файле нет партий с нотами");
    if (!song.title) song.title = title;
    return fromTabSong(song, "gp");
  }
  const tab = parseTextTab(new TextDecoder().decode(bytes), { title });
  return fromTabSong(tab.song, "tab");
}
