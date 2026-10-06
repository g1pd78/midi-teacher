// Звуки вкладки «Код». Встроенные — из GM-банка приложения (GeneralUser GS) и встроенного рояля: Rust
// рендерит ноту по запросу через протокол mtsound. Имена как у Strudel (bd, sd, hh…, gm_*, piano), поэтому
// примеры из документации Strudel звучат без интернета. Звучит иначе, чем оригинальные драм-машины на
// strudel.cc, — это осознанно: их сэмплы без лицензии, в установщик их класть нельзя.

/** Инструменты GM в порядке программ, как в @strudel/soundfonts (без программ 1–3: там они закомментированы). */
export const GM_NAMES = [
  "piano", "epiano1", "epiano2", "harpsichord", "clavinet", "celesta", "glockenspiel", "music_box", "vibraphone",
  "marimba", "xylophone", "tubular_bells", "dulcimer", "drawbar_organ", "percussive_organ", "rock_organ",
  "church_organ", "reed_organ", "accordion", "harmonica", "bandoneon", "acoustic_guitar_nylon",
  "acoustic_guitar_steel", "electric_guitar_jazz", "electric_guitar_clean", "electric_guitar_muted",
  "overdriven_guitar", "distortion_guitar", "guitar_harmonics", "acoustic_bass", "electric_bass_finger",
  "electric_bass_pick", "fretless_bass", "slap_bass_1", "slap_bass_2", "synth_bass_1", "synth_bass_2", "violin",
  "viola", "cello", "contrabass", "tremolo_strings", "pizzicato_strings", "orchestral_harp", "timpani",
  "string_ensemble_1", "string_ensemble_2", "synth_strings_1", "synth_strings_2", "choir_aahs", "voice_oohs",
  "synth_choir", "orchestra_hit", "trumpet", "trombone", "tuba", "muted_trumpet", "french_horn", "brass_section",
  "synth_brass_1", "synth_brass_2", "soprano_sax", "alto_sax", "tenor_sax", "baritone_sax", "oboe", "english_horn",
  "bassoon", "clarinet", "piccolo", "flute", "recorder", "pan_flute", "blown_bottle", "shakuhachi", "whistle",
  "ocarina", "lead_1_square", "lead_2_sawtooth", "lead_3_calliope", "lead_4_chiff", "lead_5_charang",
  "lead_6_voice", "lead_7_fifths", "lead_8_bass_lead", "pad_new_age", "pad_warm", "pad_poly", "pad_choir",
  "pad_bowed", "pad_metallic", "pad_halo", "pad_sweep", "fx_rain", "fx_soundtrack", "fx_crystal", "fx_atmosphere",
  "fx_brightness", "fx_goblins", "fx_echoes", "fx_sci_fi", "sitar", "banjo", "shamisen", "koto", "kalimba",
  "bagpipe", "fiddle", "shanai", "tinkle_bell", "agogo", "steel_drums", "woodblock", "taiko_drum", "melodic_tom",
  "synth_drum", "reverse_cymbal", "guitar_fret_noise", "breath_noise", "seashore", "bird_tweet", "telephone",
  "helicopter", "applause", "gunshot",
] as const;

/** Программа GM для имени из списка (gm_piano → 0, gm_epiano1 → 4…). */
export const gmProgram = (index: number) => (index === 0 ? 0 : index + 3);

/** Короткие имена ударных Strudel → ноты GM-барабанов (варианты для `:n`). */
export const DRUM_NOTES: Record<string, number[]> = {
  bd: [36, 35],
  sd: [38, 40],
  rim: [37],
  cp: [39],
  hh: [42, 44],
  oh: [46],
  lt: [41, 43],
  mt: [45, 47],
  ht: [48, 50],
  cr: [49, 57],
  rd: [51, 59],
  cb: [56],
  sh: [82, 70],
  tb: [54],
  perc: [75, 76, 77],
  misc: [81, 80],
};

/** Ноты, с которых снят каждый сэмпл инструмента: через каждые 3 полутона — переносы высоты не слышны. */
export const PITCHED_NOTES = Array.from({ length: 27 }, (_, i) => 21 + i * 3);

const NAMES = ["c", "db", "d", "eb", "e", "f", "gb", "g", "ab", "a", "bb", "b"];
/** 60 → «c4», как в Strudel. */
export const midiName = (m: number) => `${NAMES[m % 12]}${Math.floor(m / 12) - 1}`;

export type SampleMap = Record<string, string[] | Record<string, string[]>>;

/**
 * Карта встроенных звуков. `url(путь)` превращает путь протокола в адрес для текущей платформы
 * (в Windows — http://mtsound.localhost/…).
 */
export function builtinSampleMap(url: (path: string) => string): SampleMap {
  const map: SampleMap = {};
  for (const [name, notes] of Object.entries(DRUM_NOTES)) map[name] = notes.map((n) => url(`drum/${n}.wav`));
  const pitched = (f: (note: number) => string) => Object.fromEntries(PITCHED_NOTES.map((n) => [midiName(n), [f(n)]]));
  GM_NAMES.forEach((name, i) => {
    map[`gm_${name}`] = pitched((n) => url(`gm/${gmProgram(i)}/${n}.wav`));
  });
  map.piano = pitched((n) => url(`piano/${n}.wav`));
  return map;
}

export interface SampleBanks {
  /** Имя звука → файлы относительно «Сэмплы». */
  user: Record<string, string[]>;
  /** «Гитара/рифф.wav», «Треки/бит.wav». */
  rec: string[];
}

/** Свои сэмплы (папка «Сэмплы») и свои записи (банк `rec`, по порядку файлов: `s("rec:2")`). */
export function userSampleMap(banks: SampleBanks, url: (path: string) => string): SampleMap {
  const map: SampleMap = {};
  for (const [name, files] of Object.entries(banks.user)) map[name] = files.map((f) => url(`user/${f}`));
  if (banks.rec.length) map.rec = banks.rec.map((f) => url(`rec/${f}`));
  return map;
}

/** Номера записей для подсказки: rec:0 — «Гитара/рифф.wav»… */
export const recIndex = (banks: SampleBanks) => banks.rec.map((f, i) => ({ code: `rec:${i}`, file: f }));

/** Стандартные наборы Strudel (как на strudel.cc) — грузятся из интернета, только если включено. */
const DS = "https://raw.githubusercontent.com/felixroos/dough-samples/main";
export const NET_SAMPLE_MAPS = [
  `${DS}/tidal-drum-machines.json`,
  `${DS}/piano.json`,
  `${DS}/Dirt-Samples.json`,
  `${DS}/vcsl.json`,
  `${DS}/mridangam.json`,
  "https://raw.githubusercontent.com/tidalcycles/uzu-drumkit/main/strudel.json",
];
export const NET_ALIAS_MAP = "https://raw.githubusercontent.com/todepond/samples/main/tidal-drum-machines-alias.json";

/** base64url без «=» — так URL прячется в путь протокола (net/…). */
export function base64url(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Карта стандартного набора → те же звуки, но через кэш приложения (net/<url>). */
export function proxiedMap(json: Record<string, unknown>, mapUrl: string, url: (path: string) => string): SampleMap {
  const base0 = typeof json._base === "string" ? json._base : mapUrl.slice(0, mapUrl.lastIndexOf("/") + 1);
  const githubBase = (b: string) =>
    b.startsWith("github:") ? `https://raw.githubusercontent.com/${b.slice(7).replace(/\/$/, "")}${b.split("/").length < 3 ? "/main" : ""}/` : b;
  const out: SampleMap = {};
  const full = (base: string, f: string) => url(`net/${base64url(/^https?:/.test(f) ? f : base + f)}`);
  for (const [key, value] of Object.entries(json)) {
    if (key === "_base") continue;
    if (typeof value === "string") out[key] = [full(githubBase(base0), value)];
    else if (Array.isArray(value)) out[key] = value.map((f) => full(githubBase(base0), String(f)));
    else if (value && typeof value === "object") {
      const v = value as Record<string, unknown>;
      const base = githubBase(typeof v._base === "string" ? v._base : base0);
      out[key] = Object.fromEntries(
        Object.entries(v)
          .filter(([k]) => k !== "_base")
          .map(([note, files]) => [note, (Array.isArray(files) ? files : [files]).map((f) => full(base, String(f)))]),
      );
    }
  }
  return out;
}

export const AUDIO_FILE = /\.(wav|ogg|mp3|flac)$/i;
/** Имя звука по умолчанию: папка или первый файл, латиница/цифры/«_». */
export function defaultSoundName(paths: string[]): string {
  const first = paths[0] ?? "";
  const base = first.split(/[\\/]/).filter(Boolean).pop() ?? "";
  const stem = AUDIO_FILE.test(base) ? base.replace(AUDIO_FILE, "") : base;
  const clean = stem
    .replace(/[^A-Za-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
  return /^[a-z_]/.test(clean) ? clean : clean ? `s_${clean}` : "mysample";
}
