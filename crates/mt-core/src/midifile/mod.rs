//! Импорт MIDI-файлов: дорожки, руки, выравнивание по сетке, нотный стан (MusicXML).
//!
//! Путь файла: разбор (`inspect`) → роли дорожек (правая, левая, обе, аккомпанемент,
//! выключить) → деление «обеих» на руки по высоте → выравнивание по сетке (для каждой
//! четверти — шестнадцатые или триоли) → такты с лигами и паузами → MusicXML для
//! Verovio. Аккомпанемент в ноты не попадает: он возвращается списком нот, которые
//! играет приложение. Здесь же — запись своей игры в стандартный MIDI-файл.

use crate::midi::MidiMessage;
use anyhow::{anyhow, Result};
use midly::{MetaMessage, MidiMessage as MM, Smf, Timing, TrackEventKind};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};

mod key;
mod quantize;
mod smf;
mod xml;

pub use key::transpose_fifths;
use key::*;
use quantize::*;
pub use smf::{write_smf, write_smf_channels, write_smf_programs};
use xml::*;

/// Делений на четверть в MusicXML: хватает и для шестнадцатых (3), и для триольных восьмых (4).
pub const DIV: i64 = 12;
const STRAIGHT: i64 = 3;
const TRIPLET: i64 = 4;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TrackRole {
    Right,
    Left,
    /// Обе руки: разделить по высоте.
    Both,
    /// Звучит (играет приложение), в нотах не показывается.
    Accompany,
    /// Барабаны — партия ученика на пэдах (только для дорожки ударных).
    Drums,
    Off,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum HandSide {
    Right,
    Left,
}

#[derive(Debug, Clone, PartialEq)]
struct RawNote {
    tick: u64,
    end: u64,
    pitch: u8,
    velocity: u8,
}

#[derive(Debug, Clone)]
struct Track {
    name: String,
    channel: u8,
    program: Option<u8>,
    notes: Vec<RawNote>,
}

#[derive(Debug, Clone)]
pub struct MidiData {
    ppq: u64,
    tracks: Vec<Track>,
    tempo_us: u32,
    meter: (u8, u8),
    key: Option<(i8, bool)>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackInfo {
    pub index: usize,
    pub name: String,
    /// Канал 1–16.
    pub channel: u8,
    pub program: Option<u8>,
    pub drums: bool,
    pub notes: usize,
    pub low: u8,
    pub high: u8,
    /// Предложенная роль.
    pub role: TrackRole,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MidiInfo {
    pub tracks: Vec<TrackInfo>,
    pub bpm: f64,
    pub meter: (u8, u8),
    pub key_fifths: i8,
    pub key_minor: bool,
    /// Тональность указана в файле (иначе определена по нотам).
    pub key_from_file: bool,
    pub duration_sec: f64,
}

/// Разобрать стандартный MIDI-файл. Дорожки делятся по каналам (в файлах формата 0
/// все инструменты лежат в одной дорожке на разных каналах).
pub fn parse(bytes: &[u8]) -> Result<MidiData> {
    let smf = Smf::parse(bytes).map_err(|e| anyhow!("не MIDI-файл: {e}"))?;
    let ppq = match smf.header.timing {
        Timing::Metrical(t) => t.as_int() as u64,
        Timing::Timecode(..) => return Err(anyhow!("MIDI с временем SMPTE не поддерживается")),
    };
    let mut tempo_us = None;
    let mut meter = None;
    let mut key = None;
    let mut tracks = Vec::new();
    for events in &smf.tracks {
        let mut tick = 0u64;
        let mut name = String::new();
        let mut programs: HashMap<u8, u8> = HashMap::new();
        let mut open: HashMap<(u8, u8), Vec<(u64, u8)>> = HashMap::new();
        let mut by_channel: BTreeMap<u8, Vec<RawNote>> = BTreeMap::new();
        for ev in events {
            tick += ev.delta.as_int() as u64;
            match ev.kind {
                TrackEventKind::Meta(MetaMessage::TrackName(n)) if name.is_empty() => {
                    name = String::from_utf8_lossy(n).trim().to_string();
                }
                TrackEventKind::Meta(MetaMessage::Tempo(t)) if tempo_us.is_none() => {
                    tempo_us = Some(t.as_int())
                }
                TrackEventKind::Meta(MetaMessage::TimeSignature(n, d, ..)) if meter.is_none() => {
                    meter = Some((n.max(1), 1u8 << d.min(5)));
                }
                TrackEventKind::Meta(MetaMessage::KeySignature(sf, minor)) if key.is_none() => {
                    key = Some((sf, minor))
                }
                TrackEventKind::Midi { channel, message } => {
                    let ch = channel.as_int();
                    match message {
                        MM::ProgramChange { program } => {
                            programs.entry(ch).or_insert(program.as_int());
                        }
                        MM::NoteOn { key: k, vel } if vel.as_int() > 0 => {
                            open.entry((ch, k.as_int()))
                                .or_default()
                                .push((tick, vel.as_int()));
                        }
                        MM::NoteOn { key: k, .. } | MM::NoteOff { key: k, .. } => {
                            if let Some(stack) = open.get_mut(&(ch, k.as_int())) {
                                if !stack.is_empty() {
                                    let (start, vel) = stack.remove(0);
                                    by_channel.entry(ch).or_default().push(RawNote {
                                        tick: start,
                                        end: tick.max(start + 1),
                                        pitch: k.as_int(),
                                        velocity: vel,
                                    });
                                }
                            }
                        }
                        _ => {}
                    }
                }
                _ => {}
            }
        }
        // Незакрытые ноты — до конца дорожки.
        for ((ch, pitch), stack) in open {
            for (start, vel) in stack {
                by_channel.entry(ch).or_default().push(RawNote {
                    tick: start,
                    end: tick.max(start + 1),
                    pitch,
                    velocity: vel,
                });
            }
        }
        let several = by_channel.len() > 1;
        for (ch, mut notes) in by_channel {
            notes.sort_by_key(|n| (n.tick, n.pitch));
            let base = if name.is_empty() {
                format!("Дорожка {}", tracks.len() + 1)
            } else {
                name.clone()
            };
            tracks.push(Track {
                name: if several {
                    format!("{base} · канал {}", ch + 1)
                } else {
                    base
                },
                channel: ch,
                program: programs.get(&ch).copied(),
                notes,
            });
        }
    }
    Ok(MidiData {
        ppq,
        tracks,
        tempo_us: tempo_us.unwrap_or(500_000),
        meter: meter.unwrap_or((4, 4)),
        key,
    })
}

fn is_drums(t: &Track) -> bool {
    t.channel == 9
}

fn is_piano(t: &Track) -> bool {
    !is_drums(t) && t.program.is_none_or(|p| p < 8)
}

fn mean_pitch(t: &Track) -> f64 {
    t.notes.iter().map(|n| n.pitch as f64).sum::<f64>() / t.notes.len().max(1) as f64
}

/// Роли по умолчанию: одна фортепианная дорожка — «обе», две — правая и левая
/// (по средней высоте), остальные мелодические — аккомпанемент, барабаны — выключить.
pub fn suggest_roles(data: &MidiData) -> Vec<TrackRole> {
    let mut roles = vec![TrackRole::Off; data.tracks.len()];
    let melodic: Vec<usize> = (0..data.tracks.len())
        .filter(|&i| !is_drums(&data.tracks[i]))
        .collect();
    let mut pianos: Vec<usize> = melodic
        .iter()
        .copied()
        .filter(|&i| is_piano(&data.tracks[i]))
        .collect();
    pianos.sort_by_key(|&i| std::cmp::Reverse(data.tracks[i].notes.len()));
    for &i in &melodic {
        roles[i] = TrackRole::Accompany;
    }
    // Только барабаны (например, запись игры на пэдах) — это и есть партия.
    if melodic.is_empty() {
        for (i, t) in data.tracks.iter().enumerate() {
            if is_drums(t) {
                roles[i] = TrackRole::Drums;
            }
        }
        return roles;
    }
    match pianos.len() {
        0 => {
            if let Some(&i) = melodic.iter().max_by_key(|&&i| data.tracks[i].notes.len()) {
                roles[i] = TrackRole::Both;
            }
        }
        1 => roles[pianos[0]] = TrackRole::Both,
        _ => {
            let (a, b) = (pianos[0], pianos[1]);
            let (hi, lo) = if mean_pitch(&data.tracks[a]) >= mean_pitch(&data.tracks[b]) {
                (a, b)
            } else {
                (b, a)
            };
            roles[hi] = TrackRole::Right;
            roles[lo] = TrackRole::Left;
        }
    }
    roles
}

pub fn inspect(data: &MidiData) -> MidiInfo {
    let roles = suggest_roles(data);
    let (key_fifths, key_minor, key_from_file) = match data.key {
        Some((sf, minor)) => (sf.clamp(-7, 7), minor, true),
        None => {
            let (f, m) = detect_key(
                data.tracks
                    .iter()
                    .filter(|t| !is_drums(t))
                    .flat_map(|t| t.notes.iter()),
            );
            (f, m, false)
        }
    };
    let end = data
        .tracks
        .iter()
        .flat_map(|t| t.notes.iter().map(|n| n.end))
        .max()
        .unwrap_or(0);
    MidiInfo {
        tracks: data
            .tracks
            .iter()
            .enumerate()
            .map(|(i, t)| TrackInfo {
                index: i,
                name: t.name.clone(),
                channel: t.channel + 1,
                program: t.program,
                drums: is_drums(t),
                notes: t.notes.len(),
                low: t.notes.iter().map(|n| n.pitch).min().unwrap_or(0),
                high: t.notes.iter().map(|n| n.pitch).max().unwrap_or(0),
                role: roles[i],
            })
            .collect(),
        bpm: bpm(data),
        meter: data.meter,
        key_fifths,
        key_minor,
        key_from_file,
        duration_sec: end as f64 / data.ppq as f64 * data.tempo_us as f64 / 1e6,
    }
}

fn bpm(data: &MidiData) -> f64 {
    (60_000_000.0 / data.tempo_us.max(1) as f64 * 10.0).round() / 10.0
}

/// Канал (0–15) и инструмент General MIDI дорожки.
pub fn track_voice(data: &MidiData, track: usize) -> Option<(u8, Option<u8>)> {
    data.tracks.get(track).map(|t| (t.channel, t.program))
}

/// Ноты дорожки для прослушивания: первые `secs` секунд от её первой ноты,
/// как (начало мс, длительность мс, высота, сила).
/// Дорожка файла целиком, со временем в миллисекундах от начала файла (для студии).
#[derive(Debug, Clone, PartialEq)]
pub struct FileTrack {
    pub name: String,
    pub channel: u8,
    pub program: Option<u8>,
    pub drums: bool,
    /// (начало мс, длительность мс, высота, сила).
    pub notes: Vec<(f64, f64, u8, u8)>,
}

/// Все дорожки файла с нотами в миллисекундах: темп, размер и дорожки.
pub fn file_tracks(data: &MidiData) -> (f64, (u8, u8), Vec<FileTrack>) {
    let ms_per_tick = data.tempo_us as f64 / 1000.0 / data.ppq as f64;
    let tracks = data
        .tracks
        .iter()
        .filter(|t| !t.notes.is_empty())
        .map(|t| FileTrack {
            name: t.name.clone(),
            channel: t.channel,
            program: t.program,
            drums: is_drums(t),
            notes: t
                .notes
                .iter()
                .map(|n| {
                    (
                        n.tick as f64 * ms_per_tick,
                        ((n.end - n.tick) as f64 * ms_per_tick).max(20.0),
                        n.pitch,
                        n.velocity.max(1),
                    )
                })
                .collect(),
        })
        .collect();
    (bpm(data), data.meter, tracks)
}

pub fn track_preview(data: &MidiData, track: usize, secs: f64) -> Vec<(u32, u32, u8, u8)> {
    let Some(t) = data.tracks.get(track) else {
        return Vec::new();
    };
    let ms_per_tick = data.tempo_us as f64 / 1000.0 / data.ppq as f64;
    let first = t.notes.iter().map(|n| n.tick).min().unwrap_or(0);
    let limit = secs * 1000.0;
    t.notes
        .iter()
        .map(|n| {
            let start = (n.tick - first) as f64 * ms_per_tick;
            let dur = ((n.end - n.tick) as f64 * ms_per_tick).min(limit - start);
            (start, dur, n.pitch, n.velocity)
        })
        .filter(|&(start, ..)| start < limit)
        .map(|(start, dur, p, v)| (start as u32, dur.max(30.0) as u32, p, v.max(1)))
        .collect()
}

// --- Преобразование в MusicXML ---

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HandOverride {
    /// Начало ноты в делениях (DIV на четверть) от начала файла, после выравнивания.
    pub start: i64,
    /// Высота без транспонирования.
    pub pitch: u8,
    pub hand: HandSide,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ConvertOptions {
    pub roles: Vec<TrackRole>,
    pub hand_overrides: Vec<HandOverride>,
    pub transpose: i8,
    pub title: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccompNote {
    pub pitch: u8,
    pub start_ms: u32,
    pub dur_ms: u32,
    pub measure: u32,
    /// Канал дорожки (0–15; 9 — барабаны) и её инструмент General MIDI.
    pub channel: u8,
    pub program: Option<u8>,
}

/// Удар барабанной партии: клетка такта, нота ударных GM, сила.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DrumHitOut {
    pub cell: u32,
    pub gm: u8,
    pub velocity: u8,
}

/// Такт барабанной партии: клеток на четверть — 4 (шестнадцатые) или 3 (триоли).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DrumMeasure {
    pub per_beat: u8,
    pub cells: u32,
    pub hits: Vec<DrumHitOut>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Converted {
    pub musicxml: String,
    pub accompaniment: Vec<AccompNote>,
    /// Ноты рук как аккомпанемент — когда ученик играет барабаны, их играет приложение.
    pub hands_accompaniment: Vec<AccompNote>,
    /// Барабанная партия (дорожки с ролью «мои барабаны»), такты — те же, что у нот.
    pub drums: Option<Vec<DrumMeasure>>,
    pub meter: (u8, u8),
    pub bpm: f64,
    pub measures: u32,
    /// Сколько делений пустого начала отрезано (для сопоставления нот с файлом).
    pub trim: i64,
    pub key_fifths: i8,
    /// Сколько четвертей записано триолями.
    pub triplet_quarters: usize,
}

/// Преобразовать MIDI в MusicXML (ноты рук) и список нот аккомпанемента.
pub fn convert(data: &MidiData, opts: &ConvertOptions) -> Result<Converted> {
    let roles: Vec<TrackRole> = if opts.roles.len() == data.tracks.len() {
        opts.roles.clone()
    } else {
        suggest_roles(data)
    };
    let tr = |p: u8| (p as i32 + opts.transpose as i32).clamp(0, 127) as u8;
    let player_raw: Vec<&RawNote> = data
        .tracks
        .iter()
        .zip(&roles)
        .filter(|(_, r)| matches!(r, TrackRole::Right | TrackRole::Left | TrackRole::Both))
        .flat_map(|(t, _)| t.notes.iter())
        .collect();
    let drum_raw: Vec<&RawNote> = data
        .tracks
        .iter()
        .zip(&roles)
        .filter(|(_, r)| **r == TrackRole::Drums)
        .flat_map(|(t, _)| t.notes.iter())
        .collect();
    if player_raw.is_empty() && drum_raw.is_empty() {
        return Err(anyhow!(
            "нет партии для игры: назначь хотя бы одной дорожке роль «правая», «левая», «обе» или «барабаны»"
        ));
    }
    let ppq = data.ppq;
    // Сетка (шестнадцатые или триоли) — по тому, что играет ученик.
    let onsets: Vec<f64> = player_raw
        .iter()
        .chain(&drum_raw)
        .map(|n| n.tick as f64 / ppq as f64)
        .collect();
    let last_tick = data
        .tracks
        .iter()
        .flat_map(|t| t.notes.iter().map(|n| n.end))
        .max()
        .unwrap_or(0);
    let quarters = (last_tick / ppq + 2) as usize;
    let grids = choose_grids(&onsets, quarters);

    let mut right: Vec<QNote> = Vec::new();
    let mut left: Vec<QNote> = Vec::new();
    let mut accomp: Vec<QNote> = Vec::new();
    // Канал и инструмент дорожки для каждой ноты аккомпанемента (в том же порядке).
    let mut accomp_src: Vec<(u8, Option<u8>)> = Vec::new();
    let mut drum_q: Vec<QNote> = Vec::new();
    // Ноты рук с каналом и инструментом своей дорожки — аккомпанемент для барабанщика.
    let mut hands_q: Vec<QNote> = Vec::new();
    let mut hands_src: Vec<(u8, Option<u8>)> = Vec::new();
    for (t, role) in data.tracks.iter().zip(&roles) {
        let q = quantize(&t.notes, ppq, &grids);
        if matches!(role, TrackRole::Right | TrackRole::Left | TrackRole::Both) {
            hands_src.extend(std::iter::repeat_n((t.channel, t.program), q.len()));
            hands_q.extend(q.iter().cloned());
        }
        match role {
            TrackRole::Drums => drum_q.extend(q),
            TrackRole::Right => right.extend(q),
            TrackRole::Left => left.extend(q),
            TrackRole::Both => {
                let hands = split_hands(&q);
                for (n, h) in q.into_iter().zip(hands) {
                    let forced = opts
                        .hand_overrides
                        .iter()
                        .find(|o| o.start == n.start && o.pitch == n.pitch)
                        .map(|o| o.hand);
                    match forced.unwrap_or(h) {
                        HandSide::Right => right.push(n),
                        HandSide::Left => left.push(n),
                    }
                }
            }
            TrackRole::Accompany => {
                accomp_src.extend(std::iter::repeat_n((t.channel, t.program), q.len()));
                accomp.extend(q);
            }
            TrackRole::Off => {}
        }
    }
    // Правка руки работает и для дорожек «правая»/«левая».
    for o in &opts.hand_overrides {
        let (from, to) = match o.hand {
            HandSide::Right => (&mut left, &mut right),
            HandSide::Left => (&mut right, &mut left),
        };
        if let Some(i) = from
            .iter()
            .position(|n| n.start == o.start && n.pitch == o.pitch)
        {
            to.push(from.remove(i));
        }
    }

    fill_gaps(&mut right);
    fill_gaps(&mut left);

    let (num, den) = data.meter;
    let ml = num as i64 * 4 * DIV / den as i64;
    let all_start = right
        .iter()
        .chain(&left)
        .chain(&accomp)
        .chain(&drum_q)
        .map(|n| n.start)
        .min()
        .unwrap_or(0);
    let trim = all_start.div_euclid(ml) * ml;
    let all_end = right
        .iter()
        .chain(&left)
        .chain(&accomp)
        .chain(&drum_q)
        .map(|n| n.end)
        .max()
        .unwrap_or(ml);
    let measures = ((all_end - trim + ml - 1) / ml).max(1);
    let total = measures * ml;
    let shift = |v: &mut Vec<QNote>| {
        for n in v.iter_mut() {
            n.start -= trim;
            n.end -= trim;
            n.pitch = tr(n.pitch);
        }
    };
    shift(&mut right);
    shift(&mut left);
    shift(&mut accomp);
    shift(&mut hands_q);
    // Барабаны не транспонируются: высота — это номер барабана.
    for n in drum_q.iter_mut() {
        n.start -= trim;
        n.end -= trim;
    }
    // Сетки тоже сдвигаются на отрезанное начало.
    let grid_shift = (trim / DIV) as usize;
    let grids: Vec<i64> = grids.into_iter().skip(grid_shift).collect();

    let (key_fifths, minor) = match data.key {
        Some((sf, m)) => (sf.clamp(-7, 7), m),
        None if player_raw.is_empty() => (0, false),
        None => detect_key(player_raw.iter().copied()),
    };
    let fifths = transpose_fifths(key_fifths, opts.transpose);
    let bpm = bpm(data);

    let r_events = staff_events(&right, total);
    let l_events = staff_events(&left, total);
    let w1 = StaffWriter {
        staff: 1,
        fifths,
        minor,
        grids: &grids,
    };
    let w2 = StaffWriter {
        staff: 2,
        fifths,
        minor,
        grids: &grids,
    };
    let mut body = String::new();
    let (mut t1, mut t2) = (Vec::new(), Vec::new());
    for m in 0..measures {
        let (ms, me) = (m * ml, (m + 1) * ml);
        body.push_str(&format!(r#"<measure number="{}">"#, m + 1));
        if m == 0 {
            body.push_str(&format!(
                "<attributes><divisions>{DIV}</divisions><key><fifths>{fifths}</fifths><mode>{}</mode></key>\
                 <time><beats>{num}</beats><beat-type>{den}</beat-type></time><staves>2</staves>\
                 <clef number=\"1\"><sign>G</sign><line>2</line></clef><clef number=\"2\"><sign>F</sign><line>4</line></clef></attributes>\
                 <direction placement=\"above\"><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>{}</per-minute></metronome></direction-type><sound tempo=\"{bpm}\"/></direction>",
                if minor { "minor" } else { "major" },
                bpm.round()
            ));
        }
        body.push_str(&w1.measure_xml(&r_events, ms, me, &mut t1));
        body.push_str(&format!("<backup><duration>{ml}</duration></backup>"));
        body.push_str(&w2.measure_xml(&l_events, ms, me, &mut t2));
        if m == measures - 1 {
            body.push_str(
                r#"<barline location="right"><bar-style>light-heavy</bar-style></barline>"#,
            );
        }
        body.push_str("</measure>");
    }
    let title = if opts.title.is_empty() {
        "MIDI".to_string()
    } else {
        opts.title.clone()
    };
    let musicxml = format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<!DOCTYPE score-partwise PUBLIC \"-//Recordare//DTD MusicXML 4.0 Partwise//EN\" \"http://www.musicxml.org/dtds/partwise.dtd\">\n\
         <score-partwise version=\"4.0\"><work><work-title>{}</work-title></work>\
         <identification><encoding><software>MIDI Teacher (импорт MIDI)</software></encoding></identification>\
         <part-list><score-part id=\"P1\"><part-name print-object=\"no\">Фортепиано</part-name></score-part></part-list>\
         <part id=\"P1\">{body}</part></score-partwise>\n",
        escape(&title)
    );
    let ms_per_div = 60_000.0 / bpm / DIV as f64;
    let to_accomp = |notes: &[QNote], src: &[(u8, Option<u8>)]| -> Vec<AccompNote> {
        notes
            .iter()
            .zip(src)
            .map(|(n, &(channel, program))| AccompNote {
                pitch: n.pitch,
                start_ms: (n.start as f64 * ms_per_div).round() as u32,
                dur_ms: ((n.end - n.start) as f64 * ms_per_div).round() as u32,
                measure: (n.start / ml + 1) as u32,
                channel,
                program,
            })
            .collect()
    };
    let accompaniment = to_accomp(&accomp, &accomp_src);
    let hands_accompaniment = to_accomp(&hands_q, &hands_src);
    let drums = (!drum_q.is_empty()).then(|| drum_measures(&drum_q, &grids, ml, measures));
    Ok(Converted {
        musicxml,
        accompaniment,
        hands_accompaniment,
        drums,
        meter: data.meter,
        bpm,
        measures: measures as u32,
        trim,
        key_fifths: fifths,
        triplet_quarters: grids.iter().filter(|&&g| g == TRIPLET).count(),
    })
}

/// Барабанная партия по тактам: сетка такта — триоли, если их большинство среди его
/// четвертей (и такт делится на триольные клетки), иначе шестнадцатые.
fn drum_measures(notes: &[QNote], grids: &[i64], ml: i64, measures: i64) -> Vec<DrumMeasure> {
    (0..measures)
        .map(|m| {
            let (ms, me) = (m * ml, (m + 1) * ml);
            let quarters = (ms / DIV) as usize..(me / DIV) as usize;
            let triplets = quarters
                .clone()
                .filter(|&q| grids.get(q) == Some(&TRIPLET))
                .count();
            let per_beat: i64 = if triplets * 2 > quarters.len() && ml % TRIPLET == 0 {
                3
            } else {
                4
            };
            let step = DIV / per_beat;
            let cells = ml / step;
            let mut hits: Vec<DrumHitOut> = notes
                .iter()
                .filter(|n| n.start >= ms && n.start < me)
                .map(|n| DrumHitOut {
                    cell: (((n.start - ms) as f64 / step as f64).round() as i64).min(cells - 1)
                        as u32,
                    gm: n.pitch,
                    velocity: n.velocity,
                })
                .collect();
            hits.sort_by_key(|h| (h.cell, h.gm));
            hits.dedup_by_key(|h| (h.cell, h.gm));
            DrumMeasure {
                per_beat: per_beat as u8,
                cells: cells as u32,
                hits,
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Дорожка теста: (имя, канал, программа, ноты (тик, длина, высота)).
    type TestTrack<'a> = (&'a str, u8, Option<u8>, Vec<(u64, u64, u8)>);

    /// Собрать MIDI-файл формата 1.
    fn smf(ppq: u16, tracks: &[TestTrack], key: Option<(i8, bool)>, meter: (u8, u8)) -> Vec<u8> {
        use midly::num::{u15, u24, u28, u4, u7};
        use midly::{Format, Header, MetaMessage, TrackEvent};
        let mut out_tracks = Vec::new();
        let mut meta = vec![
            TrackEvent {
                delta: u28::new(0),
                kind: TrackEventKind::Meta(MetaMessage::Tempo(u24::new(500_000))),
            },
            TrackEvent {
                delta: u28::new(0),
                kind: TrackEventKind::Meta(MetaMessage::TimeSignature(
                    meter.0,
                    meter.1.trailing_zeros() as u8,
                    24,
                    8,
                )),
            },
        ];
        if let Some((sf, m)) = key {
            meta.push(TrackEvent {
                delta: u28::new(0),
                kind: TrackEventKind::Meta(MetaMessage::KeySignature(sf, m)),
            });
        }
        meta.push(TrackEvent {
            delta: u28::new(0),
            kind: TrackEventKind::Meta(MetaMessage::EndOfTrack),
        });
        out_tracks.push(meta);
        for (name, ch, program, notes) in tracks {
            let mut evs: Vec<(u64, TrackEventKind)> = Vec::new();
            evs.push((
                0,
                TrackEventKind::Meta(MetaMessage::TrackName(name.as_bytes())),
            ));
            if let Some(p) = program {
                evs.push((
                    0,
                    TrackEventKind::Midi {
                        channel: u4::new(*ch),
                        message: MM::ProgramChange {
                            program: u7::new(*p),
                        },
                    },
                ));
            }
            for &(t, len, pitch) in notes {
                evs.push((
                    t,
                    TrackEventKind::Midi {
                        channel: u4::new(*ch),
                        message: MM::NoteOn {
                            key: u7::new(pitch),
                            vel: u7::new(80),
                        },
                    },
                ));
                evs.push((
                    t + len,
                    TrackEventKind::Midi {
                        channel: u4::new(*ch),
                        message: MM::NoteOff {
                            key: u7::new(pitch),
                            vel: u7::new(0),
                        },
                    },
                ));
            }
            evs.sort_by_key(|e| {
                (
                    e.0,
                    matches!(
                        e.1,
                        TrackEventKind::Midi {
                            message: MM::NoteOn { .. },
                            ..
                        }
                    ),
                )
            });
            let mut last = 0;
            let mut track: Vec<TrackEvent> = evs
                .into_iter()
                .map(|(t, kind)| {
                    let d = t - last;
                    last = t;
                    TrackEvent {
                        delta: u28::new(d as u32),
                        kind,
                    }
                })
                .collect();
            track.push(TrackEvent {
                delta: u28::new(0),
                kind: TrackEventKind::Meta(MetaMessage::EndOfTrack),
            });
            out_tracks.push(track);
        }
        let smf = Smf {
            header: Header::new(Format::Parallel, Timing::Metrical(u15::new(ppq))),
            tracks: out_tracks,
        };
        let mut buf = Vec::new();
        smf.write_std(&mut buf).unwrap();
        buf
    }

    /// Проверка записи: в каждом такте каждого стана сумма длительностей равна длине такта.
    fn check_measures(xml: &str, ml: i64) {
        for (mi, m) in xml.split("<measure ").skip(1).enumerate() {
            let parts: Vec<&str> = m.split("<backup>").collect();
            assert_eq!(parts.len(), 2, "такт {}", mi + 1);
            for (si, p) in parts.iter().enumerate() {
                let mut sum = 0;
                for note in p.split("<note>").skip(1) {
                    if note.starts_with("<chord/>") {
                        continue;
                    }
                    let d: i64 = note
                        .split("<duration>")
                        .nth(1)
                        .unwrap()
                        .split('<')
                        .next()
                        .unwrap()
                        .parse()
                        .unwrap();
                    sum += d;
                }
                let expect = if si == 0 { ml } else { ml + ml }; // во втором куске — ещё сам backup
                let backup = if si == 1 { ml } else { 0 };
                assert_eq!(
                    sum + backup,
                    expect,
                    "такт {}, стан {}: {sum}",
                    mi + 1,
                    si + 1
                );
            }
        }
    }

    fn scale(start: u64, step: u64, pitches: &[u8]) -> Vec<(u64, u64, u8)> {
        pitches
            .iter()
            .enumerate()
            .map(|(i, &p)| (start + i as u64 * step, step, p))
            .collect()
    }

    #[test]
    fn drum_track_becomes_my_part_and_hands_play_along() {
        // Рок-бит на два такта: хэт восьмыми, бочка на 1 и 3, малый на 2 и 4 (ppq 480).
        let mut drums = Vec::new();
        for bar in 0..2u64 {
            let o = bar * 1920;
            for i in 0..8 {
                drums.push((o + i * 240, 60, 42));
            }
            drums.extend([
                (o, 60, 36),
                (o + 960, 60, 36),
                (o + 480, 60, 38),
                (o + 1440, 60, 38),
            ]);
        }
        let bytes = smf(
            480,
            &[
                ("Piano", 0, Some(0), scale(0, 960, &[60, 64, 67, 72])),
                ("Drums", 9, None, drums),
            ],
            Some((0, false)),
            (4, 4),
        );
        let data = parse(&bytes).unwrap();
        let c = convert(
            &data,
            &ConvertOptions {
                roles: vec![TrackRole::Both, TrackRole::Drums],
                ..Default::default()
            },
        )
        .unwrap();
        let d = c.drums.as_ref().expect("барабанная партия");
        assert_eq!(d.len(), 2);
        assert_eq!((d[0].per_beat, d[0].cells), (4, 16));
        let cells = |gm: u8| {
            d[0].hits
                .iter()
                .filter(|h| h.gm == gm)
                .map(|h| h.cell)
                .collect::<Vec<_>>()
        };
        assert_eq!(cells(42), vec![0, 2, 4, 6, 8, 10, 12, 14]);
        assert_eq!(cells(36), vec![0, 8]);
        assert_eq!(cells(38), vec![4, 12]);
        // Барабаны не попадают в аккомпанемент, а руки — попадают в «аккомпанемент для барабанщика».
        assert!(c.accompaniment.is_empty());
        assert_eq!(c.hands_accompaniment.len(), 4);
        assert_eq!(c.hands_accompaniment[1].start_ms, 1000);
        assert_eq!(c.meter, (4, 4));

        // Одни барабаны, без рук — тоже можно.
        let only = convert(
            &data,
            &ConvertOptions {
                roles: vec![TrackRole::Off, TrackRole::Drums],
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(only.drums.unwrap().len(), 2);
        assert!(only.hands_accompaniment.is_empty());
    }

    #[test]
    fn two_piano_tracks_become_hands() {
        let bytes = smf(
            480,
            &[
                (
                    "Right",
                    0,
                    Some(0),
                    scale(0, 480, &[60, 62, 64, 65, 67, 69, 71, 72]),
                ),
                ("Left", 1, Some(0), vec![(0, 1920, 48), (1920, 1920, 43)]),
                ("Strings", 2, Some(48), vec![(0, 3840, 55)]),
                ("Drums", 9, None, vec![(0, 100, 36), (480, 100, 38)]),
            ],
            Some((0, false)),
            (4, 4),
        );
        let data = parse(&bytes).unwrap();
        let info = inspect(&data);
        let roles: Vec<TrackRole> = info.tracks.iter().map(|t| t.role).collect();
        assert_eq!(
            roles,
            vec![
                TrackRole::Right,
                TrackRole::Left,
                TrackRole::Accompany,
                TrackRole::Off
            ]
        );
        assert_eq!(info.bpm, 120.0);
        assert_eq!(info.key_fifths, 0);
        assert!(!info.key_minor);
        let c = convert(
            &data,
            &ConvertOptions {
                roles,
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(c.measures, 2);
        assert_eq!(c.accompaniment.len(), 1);
        assert_eq!(c.accompaniment[0].dur_ms, 4000);
        assert_eq!(
            (c.accompaniment[0].channel, c.accompaniment[0].program),
            (2, Some(48))
        );
        check_measures(&c.musicxml, 48);
        assert!(c.musicxml.contains("<step>C</step><octave>4</octave>"));
        assert!(c.musicxml.contains("<staff>2</staff>"));
    }

    #[test]
    fn format0_channels_are_separate_tracks() {
        // Формат 0: одна дорожка, фортепиано на канале 1, бас на канале 2.
        use midly::num::{u15, u28, u4, u7};
        use midly::{Format, Header, TrackEvent};
        let mut track = Vec::new();
        for (ch, pitch) in [(0u8, 72u8), (1, 40)] {
            track.push(TrackEvent {
                delta: u28::new(0),
                kind: TrackEventKind::Midi {
                    channel: u4::new(ch),
                    message: MM::ProgramChange {
                        program: u7::new(if ch == 0 { 0 } else { 33 }),
                    },
                },
            });
            track.push(TrackEvent {
                delta: u28::new(0),
                kind: TrackEventKind::Midi {
                    channel: u4::new(ch),
                    message: MM::NoteOn {
                        key: u7::new(pitch),
                        vel: u7::new(90),
                    },
                },
            });
        }
        track.push(TrackEvent {
            delta: u28::new(960),
            kind: TrackEventKind::Midi {
                channel: u4::new(0),
                message: MM::NoteOff {
                    key: u7::new(72),
                    vel: u7::new(0),
                },
            },
        });
        track.push(TrackEvent {
            delta: u28::new(0),
            kind: TrackEventKind::Midi {
                channel: u4::new(1),
                message: MM::NoteOn {
                    key: u7::new(40),
                    vel: u7::new(0),
                },
            },
        });
        track.push(TrackEvent {
            delta: u28::new(0),
            kind: TrackEventKind::Meta(MetaMessage::EndOfTrack),
        });
        let smf = Smf {
            header: Header::new(Format::SingleTrack, Timing::Metrical(u15::new(480))),
            tracks: vec![track],
        };
        let mut bytes = Vec::new();
        smf.write_std(&mut bytes).unwrap();
        let info = inspect(&parse(&bytes).unwrap());
        assert_eq!(info.tracks.len(), 2);
        assert_eq!(info.tracks[0].role, TrackRole::Both);
        assert_eq!(info.tracks[1].role, TrackRole::Accompany);
        assert!(info.tracks[1].name.contains("канал 2"));
    }

    #[test]
    fn sloppy_timing_is_snapped_and_triplets_detected() {
        // Четверти с разбросом ±30 тиков, затем такт триолей восьмыми.
        let mut notes: Vec<(u64, u64, u8)> = vec![
            (10, 470, 60),
            (470, 480, 62),
            (975, 460, 64),
            (1435, 480, 65),
        ];
        for k in 0..12u64 {
            notes.push((
                1920 + k * 160 + if k % 2 == 0 { 5 } else { 0 },
                150,
                67 + (k % 3) as u8,
            ));
        }
        let bytes = smf(480, &[("Piano", 0, Some(0), notes)], None, (4, 4));
        let data = parse(&bytes).unwrap();
        let c = convert(&data, &ConvertOptions::default()).unwrap();
        assert_eq!(c.measures, 2);
        assert_eq!(c.triplet_quarters, 4);
        check_measures(&c.musicxml, 48);
        assert!(c.musicxml.contains("<time-modification>"));
        assert!(c.musicxml.contains(r#"<tuplet type="start""#));
        // Первые четыре — ровные четверти.
        let first = c.musicxml.split("<measure number=\"2\"").next().unwrap();
        assert_eq!(first.matches("<type>quarter</type>").count(), 4);
    }

    #[test]
    fn short_releases_become_legato_but_rests_stay() {
        // Четверти, отпущенные на 80% длины (живая игра), затем четверть и четвертная пауза.
        let mut notes: Vec<(u64, u64, u8)> = (0..4).map(|k| (k * 480, 384, 60 + k as u8)).collect();
        notes.push((1920, 480, 67));
        notes.push((2880, 480, 69));
        let c = convert(
            &parse(&smf(480, &[("P", 0, None, notes)], None, (4, 4))).unwrap(),
            &ConvertOptions::default(),
        )
        .unwrap();
        check_measures(&c.musicxml, 48);
        let first = c.musicxml.split("<measure number=\"2\"").next().unwrap();
        assert_eq!(first.matches("<type>quarter</type>").count(), 4, "{first}");
        let second = c.musicxml.split("<measure number=\"2\"").nth(1).unwrap();
        let upper = second.split("<backup>").next().unwrap();
        assert!(
            upper.contains("<rest"),
            "пауза между соль и ля остаётся: {upper}"
        );
    }

    #[test]
    fn smart_split_follows_hands() {
        // Одна дорожка: бас-аккорды в малой октаве и мелодия во второй; широкий аккорд делится.
        let mut notes = vec![];
        for bar in 0..2u64 {
            let t = bar * 1920;
            for p in [48u8, 52, 55] {
                notes.push((t, 1920, p));
            }
            for (k, p) in [76u8, 74, 72, 71].into_iter().enumerate() {
                notes.push((t + k as u64 * 480, 480, p));
            }
        }
        notes.push((3840, 1920, 43));
        notes.push((3840, 1920, 67));
        notes.push((3840, 1920, 71));
        notes.push((3840, 1920, 74));
        let bytes = smf(480, &[("Piano", 0, None, notes)], None, (4, 4));
        let data = parse(&bytes).unwrap();
        let c = convert(&data, &ConvertOptions::default()).unwrap();
        check_measures(&c.musicxml, 48);
        let staff_of = |step: &str, oct: u8| -> Vec<u8> {
            let needle = format!("<step>{step}</step><octave>{oct}</octave>");
            c.musicxml
                .split("<note>")
                .filter(|n| n.contains(&needle))
                .map(|n| n.split("<staff>").nth(1).unwrap().as_bytes()[0] - b'0')
                .collect()
        };
        assert!(staff_of("C", 3).iter().all(|&s| s == 2));
        assert!(staff_of("E", 5).iter().all(|&s| s == 1));
        assert!(staff_of("G", 2).iter().all(|&s| s == 2));
        assert!(staff_of("D", 5).iter().all(|&s| s == 1));

        // Правка руки: соль второй октавы (43 → G2) — в правую руку.
        let q = quantize(&data.tracks[0].notes, 480, &[STRAIGHT; 16]);
        let g2 = q.iter().find(|n| n.pitch == 43).unwrap();
        let c2 = convert(
            &data,
            &ConvertOptions {
                hand_overrides: vec![HandOverride {
                    start: g2.start,
                    pitch: 43,
                    hand: HandSide::Right,
                }],
                ..Default::default()
            },
        )
        .unwrap();
        let g2_staff = c2
            .musicxml
            .split("<note>")
            .find(|n| n.contains("<step>G</step><octave>2</octave>"))
            .unwrap()
            .split("<staff>")
            .nth(1)
            .unwrap()
            .as_bytes()[0];
        assert_eq!(g2_staff, b'1');
    }

    #[test]
    fn key_signature_from_file_and_detection() {
        let g_major = scale(0, 480, &[67, 69, 71, 72, 74, 76, 78, 79]);
        let data = parse(&smf(480, &[("P", 0, None, g_major.clone())], None, (4, 4))).unwrap();
        let info = inspect(&data);
        assert_eq!((info.key_fifths, info.key_from_file), (1, false));
        let c = convert(&data, &ConvertOptions::default()).unwrap();
        assert!(c.musicxml.contains("<fifths>1</fifths>"));
        // Фа-диез из ключа — без знака перед нотой.
        assert!(!c.musicxml.contains("<accidental>sharp</accidental>"));

        let data = parse(&smf(
            480,
            &[("P", 0, None, g_major)],
            Some((-3, true)),
            (4, 4),
        ))
        .unwrap();
        assert_eq!(inspect(&data).key_fifths, -3);

        // Транспонирование: соль мажор на −7 полутонов → до мажор.
        let data = parse(&smf(
            480,
            &[("P", 0, None, scale(0, 480, &[67, 71, 74]))],
            Some((1, false)),
            (4, 4),
        ))
        .unwrap();
        let c = convert(
            &data,
            &ConvertOptions {
                transpose: -7,
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(c.key_fifths, 0);
        assert!(c.musicxml.contains("<step>C</step><octave>4</octave>"));
        assert_eq!(transpose_fifths(0, 2), 2);
        assert_eq!(transpose_fifths(0, 1), -5);
        assert_eq!(transpose_fifths(-3, 3), 6); // ми-бемоль → фа-диез мажор
    }

    #[test]
    fn spelling_in_keys() {
        assert_eq!(spell(66, 1, false), ('F', 1, 4));
        assert_eq!(spell(70, -1, false), ('B', -1, 4));
        assert_eq!(spell(68, 0, true), ('G', 1, 4)); // ля минор: соль-диез
        assert_eq!(spell(61, 0, false), ('C', 1, 4));
        assert_eq!(spell(61, -2, false), ('D', -1, 4));
        assert_eq!(spell(59, -6, false), ('C', -1, 4)); // до-бемоль в соль-бемоль мажоре
        assert_eq!(spell(65, 6, false), ('E', 1, 4)); // ми-диез в фа-диез мажоре
    }

    #[test]
    fn leading_silence_trimmed_and_meter_respected() {
        // Два пустых такта 3/4, потом ноты.
        let notes = scale(2880, 480, &[60, 62, 64, 65, 67, 69]);
        let data = parse(&smf(480, &[("P", 0, None, notes)], None, (3, 4))).unwrap();
        let c = convert(&data, &ConvertOptions::default()).unwrap();
        assert_eq!(c.trim, 72);
        assert_eq!(c.measures, 2);
        check_measures(&c.musicxml, 36);
        assert!(c.musicxml.contains("<beats>3</beats>"));
    }

    #[test]
    fn long_notes_across_barlines_are_tied() {
        let data = parse(&smf(
            480,
            &[("P", 0, None, vec![(960, 1920, 60)])],
            None,
            (4, 4),
        ))
        .unwrap();
        let c = convert(&data, &ConvertOptions::default()).unwrap();
        check_measures(&c.musicxml, 48);
        assert!(c.musicxml.contains(r#"<tie type="start"/>"#));
        assert!(c.musicxml.contains(r#"<tie type="stop"/>"#));
    }

    #[test]
    fn recording_round_trip() {
        let events = vec![
            (
                0,
                MidiMessage::NoteOn {
                    note: 60,
                    velocity: 90,
                },
            ),
            (500_000, MidiMessage::NoteOff { note: 60 }),
            (
                500_000,
                MidiMessage::NoteOn {
                    note: 64,
                    velocity: 70,
                },
            ),
            (1_000_000, MidiMessage::NoteOff { note: 64 }),
            (
                1_000_000,
                MidiMessage::ControlChange {
                    controller: 64,
                    value: 127,
                },
            ),
        ];
        let bytes = write_smf(&events, 120.0, "Моя запись");
        let data = parse(&bytes).unwrap();
        let info = inspect(&data);
        assert_eq!(info.tracks.len(), 1);
        assert_eq!(info.tracks[0].notes, 2);
        assert_eq!(info.bpm, 120.0);
        let c = convert(&data, &ConvertOptions::default()).unwrap();
        check_measures(&c.musicxml, 48);
        assert!(c.musicxml.contains("<step>E</step><octave>4</octave>"));
    }

    #[test]
    fn broken_files_give_errors() {
        assert!(parse(b"not a midi").is_err());
        let data = parse(&smf(
            480,
            &[("Drums", 9, None, vec![(0, 100, 36)])],
            None,
            (4, 4),
        ))
        .unwrap();
        // Одни ударные — это барабанная партия (например, запись игры на пэдах).
        let roles = suggest_roles(&data);
        assert_eq!(roles, vec![TrackRole::Drums]);
        assert!(convert(
            &data,
            &ConvertOptions {
                roles,
                ..Default::default()
            }
        )
        .unwrap()
        .drums
        .is_some());
        // Ничего не выбрано для игры — понятная ошибка.
        assert!(convert(
            &data,
            &ConvertOptions {
                roles: vec![TrackRole::Off],
                ..Default::default()
            }
        )
        .is_err());
    }
}
