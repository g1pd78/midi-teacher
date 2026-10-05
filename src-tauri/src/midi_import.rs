//! MIDI-файлы: разбор, перевод в ноты, прослушивание дорожек и запись своей игры.

use crate::library::{library_dir, safe_path, unique_name};
use mt_core::audio::AudioEngine;
use mt_core::clock;
use mt_core::devices::{DeviceManager, DRUM_CHANNEL};
use mt_core::midi::MidiMessage;
use mt_core::midifile::{self, ConvertOptions, Converted, MidiData, MidiInfo};
use parking_lot::Mutex;
use serde::Serialize;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, State};

/// Сколько секунд звучит дорожка в окне выбора.
const PREVIEW_SECS: f64 = 8.0;
/// Нажатия чуть раньше первой доли (после отсчёта) ещё попадают в запись.
const EARLY_US: u64 = 300_000;

struct Recording {
    /// Первая доля записи (после отсчёта), мкс.
    start_us: u64,
    bpm: f64,
    /// (время от первой доли, канал, сообщение).
    events: Vec<(u64, u8, MidiMessage)>,
    notes: usize,
    /// Без метронома и отсчёта: сетка тактов начинается с первой ноты.
    free: bool,
}

pub struct MidiHub {
    devices: Arc<DeviceManager>,
    audio: AudioEngine,
    preview_gen: AtomicU64,
    rec: Mutex<Option<Recording>>,
    rec_gen: AtomicU64,
    /// Остановленная запись, которую можно прослушать, сохранить или выбросить.
    take: Mutex<Option<Recording>>,
}

/// Дубль: сколько нот и длительность.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TakeInfo {
    notes: usize,
    duration_ms: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordStatus {
    recording: bool,
    /// Время от первой доли; во время отсчёта отрицательное.
    elapsed_ms: i64,
    notes: usize,
}

impl MidiHub {
    pub fn new(devices: Arc<DeviceManager>, audio: AudioEngine) -> Self {
        Self {
            devices,
            audio,
            preview_gen: AtomicU64::new(0),
            rec: Mutex::new(None),
            rec_gen: AtomicU64::new(0),
            take: Mutex::new(None),
        }
    }

    /// Любое сообщение с входов: во время записи сохраняется.
    pub fn on_midi(&self, channel: u8, msg: MidiMessage, time_us: u64) {
        let mut guard = self.rec.lock();
        let Some(rec) = guard.as_mut() else { return };
        if time_us + EARLY_US < rec.start_us {
            return; // отсчёт
        }
        if matches!(msg, MidiMessage::NoteOn { .. }) {
            rec.notes += 1;
        }
        rec.events
            .push((time_us.saturating_sub(rec.start_us), channel, msg));
    }

    fn stop_preview(&self) {
        self.preview_gen.fetch_add(1, Ordering::SeqCst);
    }

    fn stop_metronome(&self) {
        self.rec_gen.fetch_add(1, Ordering::SeqCst);
        self.devices.set_extra_sound_demand(false);
    }
}

fn load(app: &AppHandle, id: &str) -> Result<MidiData, String> {
    let path = safe_path(&library_dir(app)?, id)?;
    let bytes = std::fs::read(&path).map_err(|e| format!("не удалось прочитать {id}: {e}"))?;
    midifile::parse(&bytes).map_err(|e| e.to_string())
}

/// Дорожки файла, темп, размер, тональность и предложенные роли.
#[tauri::command]
pub fn midi_inspect(app: AppHandle, id: String) -> Result<MidiInfo, String> {
    Ok(midifile::inspect(&load(&app, &id)?))
}

/// Ноты для стана (MusicXML) и аккомпанемент.
#[tauri::command]
pub async fn midi_convert(
    app: AppHandle,
    id: String,
    options: ConvertOptions,
) -> Result<Converted, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let data = load(&app, &id)?;
        midifile::convert(&data, &options).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Прослушать начало дорожки (звучит как «звук приложения»).
#[tauri::command]
pub fn midi_preview(
    app: AppHandle,
    hub: State<Arc<MidiHub>>,
    id: String,
    track: usize,
) -> Result<(), String> {
    let data = load(&app, &id)?;
    let notes = midifile::track_preview(&data, track, PREVIEW_SECS);
    // Если GM-банк загружен — дорожка звучит своим инструментом (барабаны — барабанами).
    let voice = midifile::track_voice(&data, track).filter(|_| hub.audio.status().gm.is_some());
    let notes = notes
        .into_iter()
        .map(|(start, dur, pitch, velocity)| Playback {
            start,
            dur,
            pitch,
            velocity,
            voice,
        })
        .collect();
    spawn_playback(Arc::clone(&hub), notes)
}

/// Нота для проигрывания из интерфейса (тренажёр слуха, аккомпанемент тренажёра баса).
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayNote {
    start_ms: u32,
    dur_ms: u32,
    pitch: u8,
    velocity: u8,
    /// Свой канал GM (9 — барабаны) и инструмент; без него — общий `program` вызова.
    #[serde(default)]
    channel: Option<u8>,
    #[serde(default)]
    program: Option<u8>,
}

/// Канал GM для заданий с тембром (не 1-й — там звук приложения, не 10-й — барабаны).
const PLAY_CHANNEL: u8 = 2;

/// Проиграть ноты: инструментом GM (`program` или свой канал ноты, если банк загружен) или
/// звуком приложения; барабаны без GM-банка не звучат. Новый вызов и `midi_preview_stop`
/// обрывают предыдущий.
#[tauri::command]
pub fn play_notes(
    hub: State<Arc<MidiHub>>,
    notes: Vec<PlayNote>,
    program: Option<u8>,
) -> Result<(), String> {
    let gm = hub.audio.status().gm.is_some();
    let notes = notes
        .into_iter()
        .filter(|n| gm || n.channel != Some(DRUM_CHANNEL))
        .map(|n| {
            let voice = if !gm {
                None
            } else if let Some(ch) = n.channel {
                Some((ch.min(15), n.program.map(|p| p.min(127))))
            } else {
                program.map(|p| (PLAY_CHANNEL, Some(p.min(127))))
            };
            Playback {
                start: n.start_ms,
                dur: n.dur_ms.max(1),
                pitch: n.pitch.min(127),
                velocity: n.velocity.clamp(1, 127),
                voice,
            }
        })
        .collect();
    spawn_playback(Arc::clone(&hub), notes)
}

/// Голос GM: канал и инструмент; `None` — звук приложения.
type Voice = Option<(u8, Option<u8>)>;

/// Нота проигрывания: начало и длительность (мс), высота, сила, голос.
struct Playback {
    start: u32,
    dur: u32,
    pitch: u8,
    velocity: u8,
    voice: Voice,
}

/// Нить проигрывания нот: прежнее проигрывание обрывается.
fn spawn_playback(hub: Arc<MidiHub>, notes: Vec<Playback>) -> Result<(), String> {
    hub.stop_preview();
    let gen = hub.preview_gen.load(Ordering::SeqCst);
    thread::Builder::new()
        .name("mt-preview".into())
        .spawn(move || {
            // События: (время мс, нажатие?, высота, сила, голос); отпускания раньше нажатий.
            let mut events: Vec<(u32, bool, u8, u8, Voice)> = notes
                .iter()
                .flat_map(|n| {
                    [
                        (n.start, true, n.pitch, n.velocity, n.voice),
                        (n.start + n.dur, false, n.pitch, 0, n.voice),
                    ]
                })
                .collect();
            events.sort_by_key(|e| (e.0, e.1));
            let gm_voice = notes.iter().any(|n| n.voice.is_some());
            let t0 = clock::now_us();
            let mut sounding: Vec<(u8, Voice)> = Vec::new();
            let play = |voice: Voice, msg: MidiMessage| match voice {
                Some((channel, program)) => hub.audio.gm_send(channel, program, msg),
                None => hub.devices.play_app(msg),
            };
            if gm_voice {
                hub.devices.set_extra_sound_demand(true);
            }
            for (ms, on, pitch, velocity, voice) in events {
                loop {
                    if hub.preview_gen.load(Ordering::SeqCst) != gen {
                        break;
                    }
                    let due = t0 + ms as u64 * 1000;
                    let now = clock::now_us();
                    if now >= due {
                        break;
                    }
                    thread::sleep(Duration::from_micros((due - now).min(20_000)));
                }
                if hub.preview_gen.load(Ordering::SeqCst) != gen {
                    break;
                }
                if on {
                    play(
                        voice,
                        MidiMessage::NoteOn {
                            note: pitch,
                            velocity,
                        },
                    );
                    sounding.push((pitch, voice));
                } else if let Some(i) = sounding.iter().position(|&(p, v)| p == pitch && v == voice)
                {
                    sounding.swap_remove(i);
                    play(voice, MidiMessage::NoteOff { note: pitch });
                }
            }
            for (pitch, voice) in sounding {
                play(voice, MidiMessage::NoteOff { note: pitch });
            }
            if gm_voice {
                hub.devices.set_extra_sound_demand(false);
            }
        })
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn midi_preview_stop(hub: State<Arc<MidiHub>>) {
    hub.stop_preview();
}

/// Начать запись: отсчёт такта (если нужен), затем метроном (если нужен).
#[tauri::command]
pub fn record_start(
    hub: State<Arc<MidiHub>>,
    bpm: f64,
    beats_per_bar: u32,
    metronome: bool,
    count_in: bool,
) {
    hub.stop_metronome();
    let bpm = bpm.clamp(30.0, 240.0);
    let beat_us = (60_000_000.0 / bpm) as u64;
    let beats_per_bar = beats_per_bar.clamp(1, 12) as u64;
    let lead = if count_in { beats_per_bar } else { 0 };
    let first_click = clock::now_us() + 100_000;
    let start_us = first_click + lead * beat_us;
    *hub.rec.lock() = Some(Recording {
        start_us,
        bpm,
        events: Vec::new(),
        notes: 0,
        free: !(metronome || count_in),
    });
    if !(metronome || count_in) {
        return;
    }
    hub.devices.set_extra_sound_demand(true);
    let gen = hub.rec_gen.load(Ordering::SeqCst);
    let hub = Arc::clone(&hub);
    let spawned = thread::Builder::new()
        .name("mt-record-click".into())
        .spawn(move || {
            let mut beat: u64 = 0;
            loop {
                let due = first_click + beat * beat_us;
                loop {
                    if hub.rec_gen.load(Ordering::SeqCst) != gen {
                        return;
                    }
                    let now = clock::now_us();
                    if now >= due {
                        break;
                    }
                    thread::sleep(Duration::from_micros((due - now).min(20_000)));
                }
                if beat >= lead && !metronome {
                    hub.devices.set_extra_sound_demand(false);
                    return;
                }
                hub.audio.click(beat.is_multiple_of(beats_per_bar));
                beat += 1;
            }
        });
    if let Err(e) = spawned {
        log::warn!("метроном записи не запущен: {e}");
    }
}

#[tauri::command]
pub fn record_status(hub: State<Arc<MidiHub>>) -> RecordStatus {
    match hub.rec.lock().as_ref() {
        Some(r) => RecordStatus {
            recording: true,
            elapsed_ms: (clock::now_us() as i64 - r.start_us as i64) / 1000,
            notes: r.notes,
        },
        None => RecordStatus {
            recording: false,
            elapsed_ms: 0,
            notes: 0,
        },
    }
}

/// Остановить запись и сохранить её в библиотеку. `None` — не было ни одной ноты
/// (или `save = false`).
#[tauri::command]
pub fn record_stop(
    app: AppHandle,
    hub: State<Arc<MidiHub>>,
    name: String,
    save: bool,
) -> Result<Option<String>, String> {
    hub.stop_metronome();
    let Some(mut rec) = hub.rec.lock().take() else {
        return Ok(None);
    };
    if !save || rec.notes == 0 {
        return Ok(None);
    }
    if rec.free {
        align_to_first_note(&mut rec.events);
    }
    save_recording(&app, &rec, &name).map(Some)
}

fn save_recording(app: &AppHandle, rec: &Recording, name: &str) -> Result<String, String> {
    let clean: String = name
        .chars()
        .map(|c| if "/\\:*?\"<>|".contains(c) { '-' } else { c })
        .collect();
    let clean = clean.trim();
    let title = if clean.is_empty() {
        "Запись"
    } else {
        clean
    };
    let bytes = midifile::write_smf_channels(&rec.events, rec.bpm, title);
    let dir = library_dir(app)?;
    let file = unique_name(&dir, &format!("{title}.mid"));
    std::fs::write(dir.join(&file), bytes).map_err(|e| format!("запись не сохранена: {e}"))?;
    Ok(file)
}

/// Остановить запись и оставить её дублем: прослушать, сохранить или выбросить.
/// `None` — не было ни одной ноты.
#[tauri::command]
pub fn record_take_stop(hub: State<Arc<MidiHub>>) -> Option<TakeInfo> {
    hub.stop_metronome();
    let mut rec = hub.rec.lock().take()?;
    if rec.notes == 0 {
        return None;
    }
    if rec.free {
        align_to_first_note(&mut rec.events);
    }
    let info = TakeInfo {
        notes: rec.notes,
        duration_ms: rec.events.iter().map(|e| e.0).max().unwrap_or(0) / 1000,
    };
    *hub.take.lock() = Some(rec);
    Some(info)
}

/// Прослушать дубль: клавиши — «звуком приложения», пэды — барабанами GM.
/// Остановить — `midi_preview_stop`.
#[tauri::command]
pub fn record_take_play(hub: State<Arc<MidiHub>>) -> Result<(), String> {
    let Some(events) = hub.take.lock().as_ref().map(|r| r.events.clone()) else {
        return Err("нет записи".into());
    };
    hub.stop_preview();
    let gen = hub.preview_gen.load(Ordering::SeqCst);
    let hub = Arc::clone(&hub);
    thread::Builder::new()
        .name("mt-take".into())
        .spawn(move || {
            let gm = hub.audio.has_gm();
            hub.devices.set_extra_sound_demand(true);
            let t0 = clock::now_us() + 50_000;
            let mut sorted = events;
            sorted.sort_by_key(|e| e.0);
            for (t, ch, msg) in sorted {
                loop {
                    if hub.preview_gen.load(Ordering::SeqCst) != gen {
                        break;
                    }
                    let due = t0 + t;
                    let now = clock::now_us();
                    if now >= due {
                        break;
                    }
                    thread::sleep(Duration::from_micros((due - now).min(20_000)));
                }
                if hub.preview_gen.load(Ordering::SeqCst) != gen {
                    break;
                }
                if ch == DRUM_CHANNEL {
                    if gm {
                        hub.audio.gm_send(DRUM_CHANNEL, None, msg);
                    } else if let MidiMessage::NoteOn { velocity, .. } = msg {
                        hub.audio.click(velocity >= 90);
                    }
                } else {
                    hub.devices.play_app(msg);
                }
            }
            hub.devices.all_app_notes_off();
            hub.devices.set_extra_sound_demand(false);
        })
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Сохранить дубль в библиотеку («Мои файлы»).
#[tauri::command]
pub fn record_take_save(
    app: AppHandle,
    hub: State<Arc<MidiHub>>,
    name: String,
) -> Result<String, String> {
    let guard = hub.take.lock();
    let rec = guard.as_ref().ok_or("нет записи")?;
    save_recording(&app, rec, &name)
}

#[tauri::command]
pub fn record_take_discard(hub: State<Arc<MidiHub>>) {
    hub.stop_preview();
    *hub.take.lock() = None;
}

/// Свободная запись (без щелчков): первая нота — начало первой доли.
fn align_to_first_note(events: &mut [(u64, u8, MidiMessage)]) {
    let Some(first) = events
        .iter()
        .find(|e| matches!(e.2, MidiMessage::NoteOn { .. }))
        .map(|e| e.0)
    else {
        return;
    };
    // Педаль, нажатая до первой ноты, остаётся в начале.
    for e in events.iter_mut() {
        e.0 = e.0.saturating_sub(first);
    }
}

/// Сохранить текст в файл, выбранный в диалоге «Сохранить как».
#[tauri::command]
pub fn save_text_file(path: String, content: String) -> Result<(), String> {
    std::fs::write(&path, content).map_err(|e| format!("не удалось сохранить {path}: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn free_recording_starts_at_first_note() {
        let mut ev = vec![
            (
                100,
                0,
                MidiMessage::ControlChange {
                    controller: 64,
                    value: 127,
                },
            ),
            (
                250_000,
                0,
                MidiMessage::NoteOn {
                    note: 60,
                    velocity: 90,
                },
            ),
            (900_000, 0, MidiMessage::NoteOff { note: 60 }),
        ];
        align_to_first_note(&mut ev);
        assert_eq!(
            ev.iter().map(|e| e.0).collect::<Vec<_>>(),
            vec![0, 0, 650_000]
        );
    }
}
