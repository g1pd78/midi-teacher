// Guitar Pro (.gp3/.gp4/.gp5, .gp — GP7/8) → песня из табов.
//
// Файл разбирает alphaTab (MPL-2.0, загружается только при открытии такого файла).
// Порядок тактов с повторами, вольтами и переходами (D.S., Coda, Fine) и смены темпа берутся из
// его генератора MIDI — он разворачивает форму так же, как при воспроизведении в Guitar Pro.

import type * as AlphaTab from "@coderline/alphatab";
import { type PartKind, type TabSong, type TsBarRef, type TsBeat, type TsMasterBar, type TsNote, type TsPart, type TsStaff } from "./tabsong";

type AT = typeof AlphaTab;
let alphaTab: Promise<AT> | null = null;
const loadAlphaTab = () => (alphaTab ??= import("@coderline/alphatab"));

/** Разобрать файл Guitar Pro. */
export async function loadGuitarPro(data: Uint8Array): Promise<TabSong> {
  const at = await loadAlphaTab();
  const settings = new at.Settings();
  let score: AlphaTab.model.Score;
  try {
    score = at.importer.ScoreLoader.loadScoreFromBytes(data, settings);
  } catch (e) {
    throw new Error(`не похоже на файл Guitar Pro: ${(e as Error)?.message ?? e}`);
  }
  return scoreToSong(at, score, settings);
}

function scoreToSong(at: AT, score: AlphaTab.model.Score, settings: AlphaTab.Settings): TabSong {
  const firstStaff = score.tracks[0]?.staves[0];
  const masters: TsMasterBar[] = score.masterBars.map((mb, i) => ({
    num: mb.timeSignatureNumerator,
    den: mb.timeSignatureDenominator,
    ticks: mb.calculateDuration(),
    key: Number(firstStaff?.bars[i]?.keySignature ?? 0),
    section: mb.section ? (mb.section.text || mb.section.marker || "").trim() || undefined : undefined,
  }));

  // Порядок звучания — как в генераторе MIDI alphaTab (повторы, вольты, переходы).
  const order: TsBarRef[] = [];
  try {
    const midi = new at.midi.MidiFile();
    const gen = new at.midi.MidiFileGenerator(score, settings, new at.midi.AlphaSynthMidiFileHandler(midi));
    gen.generate();
    const passes = new Map<number, number>();
    for (const m of gen.tickLookup.masterBars) {
      const index = m.masterBar.index;
      const pass = passes.get(index) ?? 0;
      passes.set(index, pass + 1);
      const tempos = (m.tempoChanges ?? []).map((t) => ({ tick: t.tick - m.start, bpm: t.tempo })).filter((t) => t.tick > 0 || t.bpm > 0);
      order.push({ master: index, tempos, pass });
    }
  } catch {
    // Генератор не справился (битый файл) — такты подряд, без повторов.
  }
  if (!order.length) score.masterBars.forEach((mb, i) => order.push({ master: i, tempos: mb.tempoAutomations.map((a) => ({ tick: Math.round(a.ratioPosition * masters[i].ticks), bpm: a.value })), pass: 0 }));

  const parts: TsPart[] = score.tracks.map((track, ti) => trackToPart(track, ti));
  return {
    title: score.title?.trim() || "",
    artist: score.artist?.trim() || "",
    album: score.album?.trim() || "",
    tempo: score.tempo || 120,
    masters,
    order,
    parts: parts.filter((p) => p.staves.some((s) => s.bars.some((b) => b.some((v) => v.some((x) => x.notes.length))))),
  };
}

function kindOf(track: AlphaTab.model.Track): PartKind {
  const staff = track.staves[0];
  const program = track.playbackInfo.program;
  if (staff?.isPercussion) return "drums";
  // У любой дорожки Guitar Pro есть «струны» — смотрим на инструмент General MIDI.
  if (program >= 32 && program <= 39) return "bass";
  if ((program >= 24 && program <= 31) || (program >= 104 && program <= 107)) return "guitar";
  if (program <= 7) return "piano";
  // Только табулатура (без нот) — струнный инструмент.
  if (staff && staff.tuning.length > 0 && staff.showTablature && !staff.showStandardNotation) return Math.min(...staff.tuning) < 36 ? "bass" : "guitar";
  return track.staves.length > 1 ? "piano" : "other";
}

function trackToPart(track: AlphaTab.model.Track, index: number): TsPart {
  const kind = kindOf(track);
  const stringed = kind === "guitar" || kind === "bass";
  const first = track.staves[0];
  const staves = (stringed || kind === "drums" ? track.staves.slice(0, 1) : track.staves).map((st, si): TsStaff => ({
    tab: stringed,
    clef: Number(st.bars[0]?.clef) === 3 || (track.staves.length > 1 && si === 1) ? "F" : "G",
    bars: st.bars.map((bar) => bar.voices.map((v) => v.beats.filter((b) => !b.isEmpty && Number(b.graceType) === 0).map((b) => beatOf(track, b)))),
  }));
  return {
    id: `track${index}`,
    name: track.name?.trim() || "",
    kind,
    program: track.playbackInfo.program,
    tuning: stringed ? [...first.tuning].reverse().map((m) => m + first.transpositionPitch) : undefined,
    capo: stringed ? first.capo : 0,
    staves,
  };
}

const BEND = (v: number) => (v >= 8 ? "B2" : v >= 6 ? "B1½" : v >= 4 ? "B1" : v >= 2 ? "B½" : "B¼");

function beatOf(track: AlphaTab.model.Track, b: AlphaTab.model.Beat): TsBeat {
  const percussion = b.voice.bar.staff.isPercussion;
  const stringed = !percussion && b.voice.bar.staff.tuning.length > 0;
  const beatTech: string[] = [];
  if (b.tap) beatTech.push("T");
  if (b.slap) beatTech.push("S");
  if (b.pop) beatTech.push("Pop");
  if (Number(b.vibrato) !== 0) beatTech.push("~");
  if (b.isTremolo) beatTech.push("Trem");
  const notes: TsNote[] = b.isRest
    ? []
    : b.notes.map((n): TsNote => {
        const tech = [...beatTech];
        if (n.isHammerPullOrigin && n.hammerPullDestination) tech.push(n.hammerPullDestination.fret >= n.fret ? "H" : "P");
        if (Number(n.slideOutType) !== 0) tech.push(n.slideTarget && n.slideTarget.fret < n.fret ? "↘" : n.slideTarget ? "↗" : "↘");
        if (n.hasBend) tech.push(BEND(Math.max(...n.bendPoints!.map((p) => p.value))));
        if (Number(n.vibrato) !== 0 && !tech.includes("~")) tech.push("~");
        if (n.isPalmMute) tech.push("PM");
        const harm = Number(n.harmonicType);
        if (harm === 3) tech.push("P.H.");
        else if (harm !== 0) tech.push("Harm");
        if (n.isTrill) tech.push("tr");
        if (Number(n.accentuated) !== 0 && !percussion) tech.push(">");
        const pitch = percussion
          ? (track.percussionArticulations[n.percussionArticulation]?.outputMidiNumber ?? n.percussionArticulation)
          : n.calculateRealValue(true, false);
        return {
          pitch,
          string: stringed ? n.string - 1 : undefined,
          fret: stringed ? n.fret : undefined,
          tie: n.isTieDestination || undefined,
          dead: n.isDead || undefined,
          techniques: tech.length ? tech : undefined,
          accent: Number(n.accentuated) !== 0 || undefined,
          ghost: n.isGhost || undefined,
        };
      });
  const type = Math.max(1, Math.min(64, Number(b.duration)));
  return {
    // Записанные позиции: форшлаги не сдвигают основную ноту.
    tick: b.displayStart,
    dur: b.displayDuration,
    type: [1, 2, 4, 8, 16, 32, 64].includes(type) ? type : 4,
    dots: Math.min(2, b.dots),
    tuplet: b.hasTuplet ? [b.tupletNumerator, b.tupletDenominator] : undefined,
    notes,
    lyrics: b.lyrics?.length ? b.lyrics.map((l) => l ?? "") : undefined,
    text: b.text?.trim() || undefined,
    chord: b.hasChord ? b.chord?.name?.trim() || undefined : undefined,
  };
}

