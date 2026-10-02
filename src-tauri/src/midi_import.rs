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
    hub.stop_preview();
    let gen = hub.preview_gen.load(Ordering::SeqCst);
    let hub = Arc::clone(&hub);
    thread::Builder::new()
        .name("mt-preview".into())
        .spawn(move || {
            // События: (время мс, нажатие?, высота, сила); отпускания раньше нажатий.
            let mut events: Vec<(u32, bool, u8, u8)> = notes
                .iter()
                .flat_map(|&(s, d, p, v)| [(s, true, p, v), (s + d, false, p, 0)])
                .collect();
            events.sort_by_key(|e| (e.0, e.1));
            let t0 = clock::now_us();
            let mut sounding: Vec<u8> = Vec::new();
            let play = |msg: MidiMessage| match voice {
                Some((channel, program)) => hub.audio.gm_send(channel, program, msg),
                None => hub.devices.play_app(msg),
            };
            if voice.is_some() {
                hub.devices.set_extra_sound_demand(true);
            }
            for (ms, on, pitch, velocity) in events {
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
                    play(MidiMessage::NoteOn {
                        note: pitch,
                        velocity,
                    });
                    sounding.push(pitch);
                } else if let Some(i) = sounding.iter().position(|&p| p == pitch) {
                    sounding.swap_remove(i);
                    play(MidiMessage::NoteOff { note: pitch });
                }
            }
            for pitch in sounding {
                play(MidiMessage::NoteOff { note: pitch });
            }
            if voice.is_some() {
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
