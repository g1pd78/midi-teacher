//! «Студия»: свои треки из дорожек. Хранение (папка «Треки» библиотеки),
//! воспроизведение дорожек, запись новой дорожки или куска поверх остальных, экспорт.

use crate::library::{library_dir, safe_path, unique_name};
use mt_core::audio::AudioEngine;
use mt_core::clock;
use mt_core::devices::DeviceManager;
use mt_core::midi::{MidiMessage, CC_SUSTAIN};
use mt_core::midifile;
use mt_core::song::{self, Exclude, Song, SongCc, SongNote, Voice};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};

const FOLDER: &str = "Треки";
/// Нажатия чуть раньше начала записи (перед первой долей после отсчёта) ещё попадают в дубль.
const EARLY_MS: f64 = 150.0;

/// Что пишется сейчас: время трека считается от `origin_us` (мкс по часам приложения).
struct Capture {
    origin_us: i64,
    /// Кусок, который перезаписывается [от, до) в мс; без куска — с начала воспроизведения.
    keep: (f64, f64),
    open: HashMap<u8, (f64, u8)>,
    notes: Vec<SongNote>,
    cc: Vec<SongCc>,
}

pub struct StudioHub {
    devices: Arc<DeviceManager>,
    audio: AudioEngine,
    app: AppHandle,
    gen: AtomicU64,
    capture: Mutex<Option<Capture>>,
}

/// Начало воспроизведения: по нему интерфейс двигает курсор (время трека = from_ms +
/// (сейчас − origin)/1000).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayInfo {
    /// Момент, когда трек был бы в нуле, мкс по часам приложения (может быть отрицательным).
    origin_us: i64,
    from_ms: f64,
    /// Начало первой доли после отсчёта, мкс.
    start_us: i64,
}

/// Записанное: ноты и педаль во времени трека.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Recorded {
    notes: Vec<SongNote>,
    cc: Vec<SongCc>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordRequest {
    /// Какая дорожка пишется (она не звучит — или не звучит только перезаписываемый кусок).
    track: usize,
    /// Перезапись тактов [от, до] (включительно).
    punch: Option<(u32, u32)>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SongSummary {
    file: String,
    name: String,
    bpm: f64,
    bars: u32,
    tracks: usize,
    modified: u64,
}

impl StudioHub {
    pub fn new(devices: Arc<DeviceManager>, audio: AudioEngine, app: AppHandle) -> Self {
        Self {
            devices,
            audio,
            app,
            gen: AtomicU64::new(0),
            capture: Mutex::new(None),
        }
    }

    /// Сообщения со всех входов: во время записи — в дубль.
    pub fn on_midi(&self, msg: MidiMessage, time_us: u64) {
        let mut guard = self.capture.lock();
        let Some(c) = guard.as_mut() else { return };
        let at = (time_us as i64 - c.origin_us) as f64 / 1000.0;
        if at < c.keep.0 - EARLY_MS {
            return; // отсчёт
        }
        // Чуть ранние нажатия (до начала записи) считаются началом записи.
        let at = at.max(c.keep.0).max(0.0);
        match msg {
            MidiMessage::NoteOn { note, velocity } => {
                if let Some((start, vel)) = c.open.remove(&note) {
                    c.notes.push(SongNote {
                        start_ms: start,
                        dur_ms: (at - start).max(20.0),
                        pitch: note,
                        velocity: vel,
                    });
                }
                c.open.insert(note, (at.max(0.0), velocity));
            }
            MidiMessage::NoteOff { note } => {
                if let Some((start, vel)) = c.open.remove(&note) {
                    c.notes.push(SongNote {
                        start_ms: start,
                        dur_ms: (at - start).max(20.0),
                        pitch: note,
                        velocity: vel,
                    });
                }
            }
            MidiMessage::ControlChange { controller, value } if controller == CC_SUSTAIN => {
                c.cc.push(SongCc {
                    at_ms: at.max(0.0),
                    controller,
                    value,
                });
            }
            MidiMessage::ControlChange { .. } => {}
        }
    }

    fn send(&self, voice: Voice, msg: MidiMessage, gm: bool) {
        match voice {
            Voice::Piano { channel } => self.audio.send(channel, msg),
            Voice::Gm { channel, program } if gm => {
                let program = (channel != 9).then_some(program);
                self.audio.gm_send(channel, program, msg)
            }
            // Без GM-банка: инструменты — роялем, барабаны — щелчком.
            Voice::Gm { channel: 9, .. } => {
                if let MidiMessage::NoteOn { velocity, .. } = msg {
                    self.audio.click(velocity >= 90);
                }
            }
            Voice::Gm { .. } => self.audio.send(8, msg),
        }
    }

    fn stop_all(&self) -> Option<Recorded> {
        self.gen.fetch_add(1, Ordering::SeqCst);
        self.audio.all_notes_off();
        self.devices.set_extra_sound_demand(false);
        let mut c = self.capture.lock().take()?;
        let now = (clock::now_us() as i64 - c.origin_us) as f64 / 1000.0;
        for (pitch, (start, velocity)) in c.open.drain() {
            c.notes.push(SongNote {
                start_ms: start,
                dur_ms: (now - start).max(20.0),
                pitch,
                velocity,
            });
        }
        let (a, b) = c.keep;
        let mut notes: Vec<SongNote> = c
            .notes
            .into_iter()
            .filter(|n| n.start_ms >= a - EARLY_MS && n.start_ms < b)
            .map(|n| SongNote {
                start_ms: n.start_ms.max(a).max(0.0),
                ..n
            })
            .collect();
        notes.sort_by(|x, y| x.start_ms.total_cmp(&y.start_ms));
        let cc =
            c.cc.into_iter()
                .filter(|e| e.at_ms >= a - EARLY_MS && e.at_ms < b)
                .collect();
        Some(Recorded { notes, cc })
    }
}

fn songs_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = library_dir(app)?.join(FOLDER);
    std::fs::create_dir_all(&dir).map_err(|e| format!("не удалось создать папку {FOLDER}: {e}"))?;
    Ok(dir)
}

fn clean_name(name: &str) -> String {
    let s: String = name
        .chars()
        .map(|c| if "/\\:*?\"<>|".contains(c) { '-' } else { c })
        .collect();
    let s = s.trim().to_string();
    if s.is_empty() {
        "Мой трек".into()
    } else {
        s
    }
}

#[tauri::command]
pub fn studio_list(app: AppHandle) -> Result<Vec<SongSummary>, String> {
    let dir = songs_dir(&app)?;
    let mut out = Vec::new();
    for entry in std::fs::read_dir(&dir)
        .map_err(|e| e.to_string())?
        .flatten()
    {
        let path = entry.path();
        if path.extension().is_none_or(|x| x != "json") {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(&path) else {
            continue;
        };
        let Ok(song) = serde_json::from_str::<Song>(&text) else {
            continue;
        };
        let modified = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);
        out.push(SongSummary {
            file: entry.file_name().to_string_lossy().into_owned(),
            name: song.name,
            bpm: song.bpm,
            bars: song.bars,
            tracks: song.tracks.len(),
            modified,
        });
    }
    out.sort_by_key(|a| std::cmp::Reverse(a.modified));
    Ok(out)
}

#[tauri::command]
pub fn studio_load(app: AppHandle, file: String) -> Result<Song, String> {
    let path = safe_path(&songs_dir(&app)?, &file)?;
    let text =
        std::fs::read_to_string(&path).map_err(|e| format!("не удалось открыть трек: {e}"))?;
    let mut song: Song = serde_json::from_str(&text).map_err(|e| format!("трек повреждён: {e}"))?;
    song.file = file;
    Ok(song)
}

/// Сохранить трек; новый получает имя файла по названию.
#[tauri::command]
pub fn studio_save(app: AppHandle, mut song: Song) -> Result<Song, String> {
    let dir = songs_dir(&app)?;
    if song.file.is_empty() {
        song.file = unique_name(&dir, &format!("{}.json", clean_name(&song.name)));
    }
    let path = safe_path(&dir, &song.file)?;
    let text = serde_json::to_string(&song).map_err(|e| e.to_string())?;
    std::fs::write(&path, text).map_err(|e| format!("трек не сохранён: {e}"))?;
    Ok(song)
}

#[tauri::command]
pub fn studio_delete(app: AppHandle, file: String) -> Result<(), String> {
    let path = safe_path(&songs_dir(&app)?, &file)?;
    std::fs::remove_file(path).map_err(|e| e.to_string())
}

/// Новый трек из MIDI-песни библиотеки: дорожки файла — дорожки трека («Оригинал»).
#[tauri::command]
pub fn studio_from_midi(app: AppHandle, id: String) -> Result<Song, String> {
    let path = safe_path(&library_dir(&app)?, &id)?;
    let bytes = std::fs::read(&path).map_err(|e| format!("не удалось прочитать {id}: {e}"))?;
    let data = midifile::parse(&bytes).map_err(|e| e.to_string())?;
    let (bpm, meter, tracks) = midifile::file_tracks(&data);
    if tracks.is_empty() {
        return Err("в файле нет нот".into());
    }
    let name = std::path::Path::new(&id)
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "Трек".into());
    Ok(song::song_from_file(&name, &id, bpm, meter, &tracks))
}

/// Играть трек с такта `from_bar`; с `record` — пишется дорожка (или кусок) поверх остальных.
#[tauri::command]
pub fn studio_play(
    hub: State<Arc<StudioHub>>,
    song: Song,
    from_bar: u32,
    record: Option<RecordRequest>,
    metronome: bool,
    count_in: bool,
) -> PlayInfo {
    hub.stop_all();
    let gen = hub.gen.load(Ordering::SeqCst);
    let from_ms = song.bar_start(from_bar.max(1));
    let bar_us = (song.bar_ms() * 1000.0) as i64;
    let beat_us = (song.beat_ms() * 1000.0) as i64;
    let lead_us = if count_in { bar_us } else { 0 };
    let start_us = clock::now_us() as i64 + 150_000 + lead_us;
    let origin_us = start_us - (from_ms * 1000.0) as i64;
    let range = record.as_ref().and_then(|r| r.punch).map(|(a, b)| {
        (
            song.bar_start(a.max(1)),
            song.bar_start(b.max(a).max(1) + 1),
        )
    });
    let exclude = Exclude {
        track: record.as_ref().map(|r| r.track),
        range,
    };
    let events = song::song_events(&song, from_ms, exclude);
    let recording = record.is_some();
    if recording {
        *hub.capture.lock() = Some(Capture {
            origin_us,
            keep: range.unwrap_or((from_ms, f64::MAX)),
            open: HashMap::new(),
            notes: Vec::new(),
            cc: Vec::new(),
        });
    }
    hub.devices.set_extra_sound_demand(true);
    let end_ms = events
        .last()
        .map(|e| e.at_ms)
        .unwrap_or(from_ms)
        .max(song.bar_start(song.bars + 1));
    let beats_per_bar = song.meter.0.max(1) as i64;
    let hub = Arc::clone(&hub);
    let spawned = thread::Builder::new()
        .name("mt-studio".into())
        .spawn(move || {
            let gm = hub.audio.has_gm();
            // Щелчки: от начала отсчёта, по долям.
            let first_click = start_us - lead_us;
            let mut beat: i64 = 0;
            let mut next = 0;
            loop {
                if hub.gen.load(Ordering::SeqCst) != gen {
                    return;
                }
                let ev_due = events
                    .get(next)
                    .map(|e| origin_us + (e.at_ms * 1000.0) as i64);
                let click_due =
                    (metronome || beat * beat_us < lead_us).then_some(first_click + beat * beat_us);
                let due = match (ev_due, click_due) {
                    (Some(a), Some(b)) => a.min(b),
                    (Some(a), None) => a,
                    (None, Some(b)) => b,
                    (None, None) => i64::MAX,
                };
                // Конец трека: без записи — останавливаемся сами.
                let now = clock::now_us() as i64;
                let song_now = (now - origin_us) as f64 / 1000.0;
                if !recording && ev_due.is_none() && song_now > end_ms {
                    hub.gen.fetch_add(1, Ordering::SeqCst);
                    hub.devices.set_extra_sound_demand(false);
                    let _ = hub.app.emit("studio", "ended");
                    return;
                }
                if due > now {
                    let wait = (due - now).min(20_000);
                    thread::sleep(Duration::from_micros(wait as u64));
                    continue;
                }
                if click_due == Some(due) {
                    // Сильная доля такта — выше; при начале не с первого такта такты всё равно с долей.
                    hub.audio.click(beat % beats_per_bar == 0);
                    beat += 1;
                    continue;
                }
                let e = events[next];
                hub.send(e.voice, e.msg, gm);
                next += 1;
            }
        });
    if let Err(e) = spawned {
        log::warn!("воспроизведение трека не запущено: {e}");
    }
    PlayInfo {
        origin_us,
        from_ms,
        start_us,
    }
}

/// Остановить; если шла запись — вернуть записанное.
#[tauri::command]
pub fn studio_stop(hub: State<Arc<StudioHub>>) -> Option<Recorded> {
    hub.stop_all()
}

/// Многодорожечный MIDI в библиотеку («Мои файлы»): открывается и как пьеса.
#[tauri::command]
pub fn studio_export_midi(app: AppHandle, song: Song) -> Result<String, String> {
    let dir = library_dir(&app)?;
    let file = unique_name(&dir, &format!("{}.mid", clean_name(&song.name)));
    std::fs::write(dir.join(&file), song::write_song_smf(&song))
        .map_err(|e| format!("MIDI не сохранён: {e}"))?;
    Ok(file)
}

/// Сведение в WAV (папка «Треки»). Возвращает полный путь.
#[tauri::command]
pub async fn studio_export_wav(
    app: AppHandle,
    state: State<'_, crate::AppState>,
    song: Song,
) -> Result<String, String> {
    let dir = songs_dir(&app)?;
    // Те же SoundFont, что звучат в приложении: свой или встроенный рояль и GM-банк.
    let piano: Option<PathBuf> = state
        .settings
        .lock()
        .soundfont
        .clone()
        .or_else(|| state.bundled_soundfont());
    let gm = state.bundled_gm();
    tauri::async_runtime::spawn_blocking(move || {
        let wav = song::render_wav(&song, piano.as_deref(), gm.as_deref(), 44_100)
            .map_err(|e| e.to_string())?;
        let file = unique_name(&dir, &format!("{}.wav", clean_name(&song.name)));
        let path = dir.join(file);
        std::fs::write(&path, wav).map_err(|e| format!("WAV не сохранён: {e}"))?;
        Ok(path.display().to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}
