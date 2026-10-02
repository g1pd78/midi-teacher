//! «Студия»: свой трек из дорожек. У каждой дорожки — дубли (записанные попытки),
//! выбранный дубль, громкость, «выкл»/«соло», инструмент и выравнивание по сетке.
//! Отсюда — события воспроизведения, многодорожечный MIDI и сведение в WAV.
//!
//! Время нот — миллисекунды от начала первого такта при темпе трека. Выравнивание
//! не портит запись: дубль хранит игру как есть, сетка применяется при воспроизведении
//! и экспорте и в любой момент выключается.

use crate::midi::MidiMessage;
use crate::midifile::FileTrack;
use crate::synth::{FallbackSynth, SoundFontSynth, Synth};
use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SongNote {
    pub start_ms: f64,
    pub dur_ms: f64,
    pub pitch: u8,
    pub velocity: u8,
}

/// Контроллер (педаль) в дубле.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SongCc {
    pub at_ms: f64,
    pub controller: u8,
    pub value: u8,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Take {
    pub id: String,
    pub name: String,
    pub notes: Vec<SongNote>,
    #[serde(default)]
    pub cc: Vec<SongCc>,
    /// Точность к оригиналу песни (0–1), если он есть.
    #[serde(default)]
    pub accuracy: Option<f64>,
    /// Партия из файла песни (а не своя запись).
    #[serde(default)]
    pub original: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum TrackKind {
    #[default]
    Keys,
    Drums,
    Guitar,
    Bass,
    Other,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SongTrack {
    pub id: String,
    pub name: String,
    pub kind: TrackKind,
    /// Инструмент General MIDI; `None` у клавишных — рояль приложения.
    pub program: Option<u8>,
    /// Громкость 0–1.
    pub volume: f64,
    pub mute: bool,
    pub solo: bool,
    pub takes: Vec<Take>,
    /// Выбранный дубль.
    pub active: usize,
    /// Сетка выравнивания: 0 — как сыграно, 4 — четверти, 8 — восьмые, 16 — шестнадцатые,
    /// 12 — триольные восьмые.
    pub grid: u8,
    /// Сила выравнивания 0–1 (1 — точно в сетку).
    pub strength: f64,
}

impl Default for SongTrack {
    fn default() -> Self {
        Self {
            id: String::new(),
            name: String::new(),
            kind: TrackKind::Keys,
            program: None,
            volume: 0.8,
            mute: false,
            solo: false,
            takes: Vec::new(),
            active: 0,
            grid: 0,
            strength: 1.0,
        }
    }
}

impl SongTrack {
    pub fn take(&self) -> Option<&Take> {
        self.takes.get(self.active).or_else(|| self.takes.last())
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Song {
    /// Имя файла в папке треков (пусто — ещё не сохранён).
    pub file: String,
    pub name: String,
    pub bpm: f64,
    pub meter: (u8, u8),
    pub bars: u32,
    pub tracks: Vec<SongTrack>,
    /// MIDI-файл, из которого сделан трек.
    pub source: Option<String>,
}

impl Default for Song {
    fn default() -> Self {
        Self {
            file: String::new(),
            name: "Мой трек".into(),
            bpm: 100.0,
            meter: (4, 4),
            bars: 16,
            tracks: Vec::new(),
            source: None,
        }
    }
}

impl Song {
    pub fn beat_ms(&self) -> f64 {
        60_000.0 / self.bpm.max(1.0) * 4.0 / self.meter.1.max(1) as f64
    }

    pub fn bar_ms(&self) -> f64 {
        self.beat_ms() * self.meter.0.max(1) as f64
    }

    /// Начало такта `bar` (с 1) в мс.
    pub fn bar_start(&self, bar: u32) -> f64 {
        bar.saturating_sub(1) as f64 * self.bar_ms()
    }

    /// Конец последней ноты (мс).
    pub fn end_ms(&self) -> f64 {
        self.tracks
            .iter()
            .filter_map(|t| t.take())
            .flat_map(|t| t.notes.iter().map(|n| n.start_ms + n.dur_ms))
            .fold(0.0, f64::max)
    }
}

/// Трек из MIDI-песни: каждая дорожка файла — дорожка трека с дублем «Оригинал».
pub fn song_from_file(
    name: &str,
    source: &str,
    bpm: f64,
    meter: (u8, u8),
    tracks: &[FileTrack],
) -> Song {
    let mut song = Song {
        name: name.to_string(),
        bpm,
        meter,
        source: Some(source.to_string()),
        ..Default::default()
    };
    song.tracks = tracks
        .iter()
        .enumerate()
        .map(|(i, t)| {
            let kind = if t.drums {
                TrackKind::Drums
            } else {
                match t.program {
                    Some(32..=39) => TrackKind::Bass,
                    Some(24..=31) => TrackKind::Guitar,
                    None | Some(0..=7) => TrackKind::Keys,
                    _ => TrackKind::Other,
                }
            };
            SongTrack {
                id: format!("t{}", i + 1),
                name: if t.name.trim().is_empty() {
                    format!("Дорожка {}", i + 1)
                } else {
                    t.name.trim().to_string()
                },
                kind,
                program: if kind == TrackKind::Drums {
                    None
                } else {
                    t.program
                },
                takes: vec![Take {
                    id: "orig".into(),
                    name: "Оригинал".into(),
                    notes: t
                        .notes
                        .iter()
                        .map(|&(start_ms, dur_ms, pitch, velocity)| SongNote {
                            start_ms,
                            dur_ms,
                            pitch,
                            velocity,
                        })
                        .collect(),
                    cc: Vec::new(),
                    accuracy: None,
                    original: true,
                }],
                ..Default::default()
            }
        })
        .collect();
    let bar = song.bar_ms();
    song.bars = ((song.end_ms() / bar).ceil() as u32).max(1);
    song
}

// --- Выравнивание ---

/// Время, сдвинутое к ближайшей линии сетки на долю `strength`.
pub fn quantize_ms(t: f64, bpm: f64, grid: u8, strength: f64) -> f64 {
    if grid == 0 {
        return t;
    }
    let quarter = 60_000.0 / bpm.max(1.0);
    let step = match grid {
        12 => quarter / 3.0,
        g => quarter * 4.0 / g as f64,
    };
    let target = (t / step).round() * step;
    t + (target - t) * strength.clamp(0.0, 1.0)
}

fn placed(note: &SongNote, song: &Song, track: &SongTrack) -> SongNote {
    if track.grid == 0 {
        return *note;
    }
    let start = quantize_ms(note.start_ms, song.bpm, track.grid, track.strength);
    let end = quantize_ms(
        note.start_ms + note.dur_ms,
        song.bpm,
        track.grid,
        track.strength,
    );
    SongNote {
        start_ms: start.max(0.0),
        dur_ms: (end - start).max(20.0),
        ..*note
    }
}

// --- Воспроизведение ---

/// Чем звучит дорожка: рояль приложения (свой канал) или GM-синтезатор (канал и инструмент).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Voice {
    Piano { channel: u8 },
    Gm { channel: u8, program: u8 },
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SongEvent {
    pub at_ms: f64,
    pub voice: Voice,
    pub msg: MidiMessage,
}

/// Голоса дорожек: клавишные без инструмента — рояль приложения (каналы 1–8),
/// барабаны — канал ударных GM, остальные — свободные каналы GM.
pub fn voices(song: &Song) -> Vec<Voice> {
    let mut piano = 1u8;
    let mut gm = (0u8..16).filter(|&c| c != 9);
    song.tracks
        .iter()
        .map(|t| match (t.kind, t.program) {
            (TrackKind::Drums, _) => Voice::Gm {
                channel: 9,
                program: 0,
            },
            (TrackKind::Keys, None) if piano <= 8 => {
                piano += 1;
                Voice::Piano { channel: piano - 1 }
            }
            (_, program) => match gm.next() {
                Some(channel) => Voice::Gm {
                    channel,
                    program: program.unwrap_or(0),
                },
                None => Voice::Piano { channel: 8 },
            },
        })
        .collect()
}

/// Что не звучит при записи: вся записываемая дорожка или только перезаписываемый кусок.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct Exclude {
    pub track: Option<usize>,
    /// Кусок [от, до) в мс; `None` — вся дорожка.
    pub range: Option<(f64, f64)>,
}

/// События воспроизведения с момента `from_ms`: громкость дорожек в начале, ноты с
/// выравниванием, педаль. «Соло» у любой дорожки — звучат только дорожки с «соло».
pub fn song_events(song: &Song, from_ms: f64, exclude: Exclude) -> Vec<SongEvent> {
    let voices = voices(song);
    let any_solo = song.tracks.iter().any(|t| t.solo);
    let mut out = Vec::new();
    for (i, (track, &voice)) in song.tracks.iter().zip(&voices).enumerate() {
        if track.mute || (any_solo && !track.solo) {
            continue;
        }
        let Some(take) = track.take() else { continue };
        let skip = |at: f64| {
            exclude.track == Some(i)
                && match exclude.range {
                    None => true,
                    Some((a, b)) => at >= a && at < b,
                }
        };
        out.push(SongEvent {
            at_ms: from_ms,
            voice,
            msg: MidiMessage::ControlChange {
                controller: 7,
                value: (track.volume.clamp(0.0, 1.0) * 127.0).round() as u8,
            },
        });
        for n in &take.notes {
            let n = placed(n, song, track);
            if n.start_ms < from_ms || skip(n.start_ms) {
                continue;
            }
            out.push(SongEvent {
                at_ms: n.start_ms,
                voice,
                msg: MidiMessage::NoteOn {
                    note: n.pitch,
                    velocity: n.velocity.max(1),
                },
            });
            out.push(SongEvent {
                at_ms: n.start_ms + n.dur_ms,
                voice,
                msg: MidiMessage::NoteOff { note: n.pitch },
            });
        }
        for c in &take.cc {
            if c.at_ms >= from_ms && !skip(c.at_ms) {
                out.push(SongEvent {
                    at_ms: c.at_ms,
                    voice,
                    msg: MidiMessage::ControlChange {
                        controller: c.controller,
                        value: c.value,
                    },
                });
            }
        }
    }
    // Одновременные: сначала отпускания, потом нажатия (повтор той же ноты не обрывается).
    out.sort_by(|a, b| {
        a.at_ms
            .total_cmp(&b.at_ms)
            .then_with(|| order(&a.msg).cmp(&order(&b.msg)))
    });
    out
}

fn order(m: &MidiMessage) -> u8 {
    match m {
        MidiMessage::ControlChange { .. } => 0,
        MidiMessage::NoteOff { .. } => 1,
        MidiMessage::NoteOn { .. } => 2,
    }
}

// --- Многодорожечный MIDI ---

/// Стандартный MIDI-файл формата 1: дорожка темпа и по дорожке на каждую партию
/// (имя, инструмент, громкость, ноты с выравниванием). Выключенные дорожки не попадают.
pub fn write_song_smf(song: &Song) -> Vec<u8> {
    const PPQ: u32 = 480;
    let ms_per_tick = 60_000.0 / song.bpm.max(1.0) / PPQ as f64;
    let tick = |ms: f64| (ms / ms_per_tick).round().max(0.0) as u32;
    let mut chunks: Vec<Vec<u8>> = Vec::new();

    let mut meta = Vec::new();
    vlq(0, &mut meta);
    meta.extend([0xff, 0x03]);
    text(&song.name, &mut meta);
    let tempo = (60_000_000.0 / song.bpm.max(1.0)).round() as u32;
    vlq(0, &mut meta);
    meta.extend([
        0xff,
        0x51,
        3,
        (tempo >> 16) as u8,
        (tempo >> 8) as u8,
        tempo as u8,
    ]);
    vlq(0, &mut meta);
    meta.extend([
        0xff,
        0x58,
        4,
        song.meter.0,
        song.meter.1.max(1).trailing_zeros() as u8,
        24,
        8,
    ]);
    end_track(&mut meta);
    chunks.push(meta);

    let voices = voices(song);
    let any_solo = song.tracks.iter().any(|t| t.solo);
    for (track, voice) in song.tracks.iter().zip(&voices) {
        if track.mute || (any_solo && !track.solo) {
            continue;
        }
        let Some(take) = track.take() else { continue };
        // В файле у каждой партии свой канал: рояль приложения — тоже GM-фортепиано.
        let (ch, program) = match *voice {
            Voice::Gm { channel, program } => {
                (channel, if channel == 9 { None } else { Some(program) })
            }
            Voice::Piano { channel } => (gm_channel_for_piano(channel, &voices), Some(0)),
        };
        let mut evs: Vec<(u32, u8, Vec<u8>)> = Vec::new();
        for n in &take.notes {
            let n = placed(n, song, track);
            evs.push((
                tick(n.start_ms),
                2,
                vec![0x90 | ch, n.pitch, n.velocity.max(1)],
            ));
            evs.push((tick(n.start_ms + n.dur_ms), 1, vec![0x80 | ch, n.pitch, 0]));
        }
        for c in &take.cc {
            evs.push((tick(c.at_ms), 0, vec![0xb0 | ch, c.controller, c.value]));
        }
        evs.sort_by_key(|e| (e.0, e.1));
        let mut body = Vec::new();
        vlq(0, &mut body);
        body.extend([0xff, 0x03]);
        text(&track.name, &mut body);
        if let Some(p) = program {
            vlq(0, &mut body);
            body.extend([0xc0 | ch, p & 0x7f]);
        }
        vlq(0, &mut body);
        body.extend([
            0xb0 | ch,
            7,
            (track.volume.clamp(0.0, 1.0) * 127.0).round() as u8,
        ]);
        let mut last = 0;
        for (t, _, bytes) in evs {
            vlq(t - last, &mut body);
            body.extend(bytes);
            last = t;
        }
        end_track(&mut body);
        chunks.push(body);
    }

    let mut out = Vec::new();
    out.extend(b"MThd");
    out.extend(6u32.to_be_bytes());
    out.extend(1u16.to_be_bytes());
    out.extend((chunks.len() as u16).to_be_bytes());
    out.extend((PPQ as u16).to_be_bytes());
    for c in chunks {
        out.extend(b"MTrk");
        out.extend((c.len() as u32).to_be_bytes());
        out.extend(c);
    }
    out
}

/// Канал файла для дорожки рояля: свободный канал, не занятый дорожками GM.
fn gm_channel_for_piano(piano_channel: u8, voices: &[Voice]) -> u8 {
    let used: Vec<u8> = voices
        .iter()
        .filter_map(|v| match v {
            Voice::Gm { channel, .. } => Some(*channel),
            _ => None,
        })
        .collect();
    (0u8..16)
        .filter(|c| *c != 9 && !used.contains(c))
        .nth(piano_channel.saturating_sub(1) as usize)
        .unwrap_or(0)
}

fn vlq(v: u32, out: &mut Vec<u8>) {
    let mut buf = vec![(v & 0x7f) as u8];
    let mut x = v >> 7;
    while x > 0 {
        buf.push((x & 0x7f) as u8 | 0x80);
        x >>= 7;
    }
    buf.reverse();
    out.extend(buf);
}

fn text(s: &str, out: &mut Vec<u8>) {
    let bytes: Vec<u8> = s.as_bytes().iter().take(127).copied().collect();
    out.push(bytes.len() as u8);
    out.extend(bytes);
}

fn end_track(out: &mut Vec<u8>) {
    vlq(0, out);
    out.extend([0xff, 0x2f, 0]);
}

// --- Сведение в WAV ---

/// Свести трек в WAV (стерео, 16 бит) теми же SoundFont, что звучат в приложении:
/// рояль приложения и GM-банк. Без банка дорожки GM звучат роялем, барабаны молчат.
pub fn render_wav(
    song: &Song,
    piano: Option<&Path>,
    gm: Option<&Path>,
    rate: u32,
) -> Result<Vec<u8>> {
    let events = song_events(song, 0.0, Exclude::default());
    let mut piano_synth: Box<dyn Synth> = match piano {
        Some(p) => Box::new(SoundFontSynth::load(p, rate)?),
        None => Box::new(FallbackSynth::new(rate)),
    };
    let mut gm_synth = match gm {
        Some(p) => Some(SoundFontSynth::load(p, rate)?),
        None => None,
    };
    if let Some(g) = gm_synth.as_mut() {
        for v in voices(song) {
            if let Voice::Gm { channel, program } = v {
                if channel != 9 {
                    g.program_change(channel, program);
                }
            }
        }
    }
    // Хвост после последней ноты — чтобы затихли реверберация и долгие ноты.
    let end_ms = events.last().map(|e| e.at_ms).unwrap_or(0.0) + 2000.0;
    let total = (end_ms / 1000.0 * rate as f64).ceil() as usize;
    const BLOCK: usize = 64;
    let mut left = vec![0.0f32; total];
    let mut right = vec![0.0f32; total];
    let (mut gl, mut gr) = ([0.0f32; BLOCK], [0.0f32; BLOCK]);
    let mut next = 0;
    let mut pos = 0;
    while pos < total {
        let n = BLOCK.min(total - pos);
        let now_ms = pos as f64 * 1000.0 / rate as f64;
        while next < events.len() && events[next].at_ms <= now_ms {
            let e = events[next];
            match e.voice {
                Voice::Piano { channel } => piano_synth.handle(channel, e.msg),
                Voice::Gm { channel, .. } => match gm_synth.as_mut() {
                    Some(g) => g.handle(channel, e.msg),
                    None if channel != 9 => piano_synth.handle(8, e.msg),
                    None => {}
                },
            }
            next += 1;
        }
        piano_synth.render(&mut left[pos..pos + n], &mut right[pos..pos + n]);
        if let Some(g) = gm_synth.as_mut() {
            g.render(&mut gl[..n], &mut gr[..n]);
            for i in 0..n {
                left[pos + i] += gl[i];
                right[pos + i] += gr[i];
            }
        }
        pos += n;
    }
    // Нормализация к −1 дБ, если громче; тихое не усиливаем больше чем в 4 раза.
    let peak = left
        .iter()
        .chain(&right)
        .fold(0.0f32, |m, v| m.max(v.abs()));
    let gain = if peak > 0.0 {
        (0.89 / peak).min(4.0)
    } else {
        1.0
    };
    Ok(wav_stereo(&left, &right, rate, gain))
}

fn wav_stereo(left: &[f32], right: &[f32], rate: u32, gain: f32) -> Vec<u8> {
    let frames = left.len();
    let data_len = (frames * 4) as u32;
    let mut out = Vec::with_capacity(44 + data_len as usize);
    out.extend(b"RIFF");
    out.extend((36 + data_len).to_le_bytes());
    out.extend(b"WAVEfmt ");
    out.extend(16u32.to_le_bytes());
    out.extend(1u16.to_le_bytes());
    out.extend(2u16.to_le_bytes());
    out.extend(rate.to_le_bytes());
    out.extend((rate * 4).to_le_bytes());
    out.extend(4u16.to_le_bytes());
    out.extend(16u16.to_le_bytes());
    out.extend(b"data");
    out.extend(data_len.to_le_bytes());
    for i in 0..frames {
        for v in [left[i], right[i]] {
            let s = (v * gain).clamp(-1.0, 1.0);
            out.extend(((s * 32767.0) as i16).to_le_bytes());
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::midifile;

    fn note(start_ms: f64, pitch: u8) -> SongNote {
        SongNote {
            start_ms,
            dur_ms: 200.0,
            pitch,
            velocity: 90,
        }
    }

    fn take(notes: Vec<SongNote>) -> Take {
        Take {
            id: "1".into(),
            name: "Дубль 1".into(),
            notes,
            cc: Vec::new(),
            accuracy: None,
            original: false,
        }
    }

    fn song() -> Song {
        Song {
            bpm: 120.0,
            tracks: vec![
                SongTrack {
                    id: "a".into(),
                    name: "Фортепиано".into(),
                    takes: vec![take(vec![note(0.0, 60), note(510.0, 62)])],
                    ..Default::default()
                },
                SongTrack {
                    id: "b".into(),
                    name: "Бас".into(),
                    kind: TrackKind::Bass,
                    program: Some(33),
                    takes: vec![take(vec![note(0.0, 36)])],
                    ..Default::default()
                },
                SongTrack {
                    id: "c".into(),
                    name: "Барабаны".into(),
                    kind: TrackKind::Drums,
                    takes: vec![take(vec![note(0.0, 36), note(1000.0, 38)])],
                    ..Default::default()
                },
            ],
            ..Default::default()
        }
    }

    #[test]
    fn quantize_moves_toward_grid_with_strength() {
        // 120 уд/мин: восьмая — 250 мс.
        assert_eq!(quantize_ms(260.0, 120.0, 8, 1.0), 250.0);
        assert_eq!(quantize_ms(260.0, 120.0, 8, 0.5), 255.0);
        assert_eq!(quantize_ms(260.0, 120.0, 0, 1.0), 260.0);
        // Триольные восьмые: 500/3 мс.
        assert!((quantize_ms(160.0, 120.0, 12, 1.0) - 500.0 / 3.0).abs() < 1e-9);
    }

    #[test]
    fn voices_give_each_track_its_own_sound() {
        let v = voices(&song());
        assert_eq!(v[0], Voice::Piano { channel: 1 });
        assert_eq!(
            v[1],
            Voice::Gm {
                channel: 0,
                program: 33
            }
        );
        assert_eq!(
            v[2],
            Voice::Gm {
                channel: 9,
                program: 0
            }
        );
    }

    #[test]
    fn events_respect_mute_solo_exclusion_and_grid() {
        let mut s = song();
        let notes_of = |evs: &[SongEvent]| {
            evs.iter()
                .filter_map(|e| match e.msg {
                    MidiMessage::NoteOn { note, .. } => Some((e.at_ms, note)),
                    _ => None,
                })
                .collect::<Vec<_>>()
        };
        assert_eq!(notes_of(&song_events(&s, 0.0, Exclude::default())).len(), 5);
        // Выравнивание фортепиано по восьмым: 510 → 500.
        s.tracks[0].grid = 8;
        let ev = song_events(&s, 0.0, Exclude::default());
        assert!(notes_of(&ev).contains(&(500.0, 62)));
        // Громкость — в начале, CC 7.
        assert!(ev.iter().any(|e| e.msg
            == MidiMessage::ControlChange {
                controller: 7,
                value: 102
            }));
        // Записываемая дорожка не звучит.
        let ex = song_events(
            &s,
            0.0,
            Exclude {
                track: Some(2),
                range: None,
            },
        );
        assert!(!notes_of(&ex).iter().any(|&(_, p)| p == 38));
        // Перезапись куска: звучит всё, кроме нот внутри куска.
        let punch = song_events(
            &s,
            0.0,
            Exclude {
                track: Some(0),
                range: Some((400.0, 2000.0)),
            },
        );
        let piano: Vec<_> = notes_of(&punch)
            .into_iter()
            .filter(|&(_, p)| p >= 60)
            .collect();
        assert_eq!(piano, vec![(0.0, 60)]);
        // Соло: только басовая дорожка.
        s.tracks[1].solo = true;
        assert_eq!(
            notes_of(&song_events(&s, 0.0, Exclude::default())),
            vec![(0.0, 36)]
        );
        // Выкл.
        s.tracks[1].solo = false;
        s.tracks[1].mute = true;
        let muted = notes_of(&song_events(&s, 0.0, Exclude::default()));
        // Бас выключен: его до (36) нет — остаётся только бочка (тоже 36, канал ударных).
        assert_eq!(
            muted.iter().filter(|&&(t, p)| t == 0.0 && p == 36).count(),
            1
        );
        // Начало с середины: ноты раньше не звучат.
        assert!(notes_of(&song_events(&s, 600.0, Exclude::default()))
            .iter()
            .all(|&(t, _)| t >= 600.0));
    }

    #[test]
    fn song_midi_has_a_track_per_part_and_reads_back() {
        let s = song();
        let bytes = write_song_smf(&s);
        let data = midifile::parse(&bytes).unwrap();
        let (bpm, meter, tracks) = midifile::file_tracks(&data);
        assert_eq!(bpm, 120.0);
        assert_eq!(meter, (4, 4));
        assert_eq!(tracks.len(), 3);
        let drums = tracks.iter().find(|t| t.drums).unwrap();
        assert_eq!(drums.notes.len(), 2);
        assert!((drums.notes[1].0 - 1000.0).abs() < 2.0);
        let bass = tracks.iter().find(|t| t.program == Some(33)).unwrap();
        assert_eq!(bass.notes[0].2, 36);
        // Обратно в трек: дорожки и дубль «Оригинал».
        let back = song_from_file("Трек", "трек.mid", bpm, meter, &tracks);
        assert_eq!(back.tracks.len(), 3);
        assert!(back.tracks.iter().any(|t| t.kind == TrackKind::Drums));
        assert!(back.tracks.iter().any(|t| t.kind == TrackKind::Bass));
        assert!(back.tracks[0].takes[0].original);
        assert_eq!(back.bars, 1);
    }

    #[test]
    fn wav_mix_has_sound_where_notes_are() {
        let s = song();
        let wav = render_wav(&s, None, None, 22_050).unwrap();
        assert_eq!(&wav[0..4], b"RIFF");
        let samples: Vec<i16> = wav[44..]
            .as_chunks::<2>()
            .0
            .iter()
            .map(|b| i16::from_le_bytes(*b))
            .collect();
        // Первые 100 мс — нота звучит (рояль приложения), далеко после конца — тишина.
        let early = samples[..4410]
            .iter()
            .map(|v| v.unsigned_abs() as u32)
            .max()
            .unwrap();
        let tail = samples[samples.len() - 200..]
            .iter()
            .map(|v| v.unsigned_abs() as u32)
            .max()
            .unwrap();
        assert!(early > 1000, "в начале тихо: {early}");
        assert!(tail < early / 4, "в конце громко: {tail}");
    }
}
