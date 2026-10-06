//! Оболочка приложения: связывает ядро `mt-core` с интерфейсом через
//! команды и события Tauri и хранит настройки.

mod backup;
mod guitar;
mod journal;
mod library;
mod midi_import;
mod piece;
mod practice;
mod rhythm;
mod settings;
mod studio;
mod trainer;

use crossbeam_channel::unbounded;
use midi_import::MidiHub;
use mt_core::audio::{AudioConfig, AudioDevices, AudioEngine, AudioMeters, AudioStatus};
use mt_core::devices::{
    DeviceEvent, DeviceManager, DevicesSnapshot, InputSettings, PadBinding, SoundRoute,
};
use mt_core::midi::MidiMessage;
use mt_core::store::Store;
use parking_lot::Mutex;
use piece::PieceHub;
use practice::PracticeHub;
use rhythm::RhythmHub;
use serde::Serialize;
use settings::{AppSettings, UiPrefs};
use std::path::PathBuf;
use std::sync::Arc;
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};
use trainer::TrainerHub;

pub(crate) struct AppState {
    devices: Arc<DeviceManager>,
    audio: AudioEngine,
    settings: Mutex<AppSettings>,
    settings_path: PathBuf,
    resource_dir: Option<PathBuf>,
}

impl AppState {
    /// Собирает актуальные настройки из ядра и сохраняет на диск.
    fn save(&self) {
        let mut s = self.settings.lock();
        s.devices = self.devices.settings();
        if let Err(e) = s.save(&self.settings_path) {
            log::warn!("настройки не сохранены: {e}");
        }
    }

    /// GM-банк аккомпанемента, поставляемый вместе с приложением.
    fn bundled_gm(&self) -> Option<PathBuf> {
        let dir = self.resource_dir.as_ref()?.join("gm");
        std::fs::read_dir(dir)
            .ok()?
            .filter_map(|e| e.ok().map(|e| e.path()))
            .find(|p| p.extension().is_some_and(|x| x.eq_ignore_ascii_case("sf2")))
    }

    /// SoundFont, поставляемый вместе с приложением.
    fn bundled_soundfont(&self) -> Option<PathBuf> {
        let dir = self.resource_dir.as_ref()?.join("soundfonts");
        let mut files: Vec<PathBuf> = std::fs::read_dir(dir)
            .ok()?
            .filter_map(|e| e.ok().map(|e| e.path()))
            .filter(|p| p.extension().is_some_and(|x| x.eq_ignore_ascii_case("sf2")))
            .collect();
        files.sort();
        files.into_iter().next()
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FullState {
    prefs: UiPrefs,
    audio_config: AudioConfig,
    custom_soundfont: Option<PathBuf>,
    devices: DevicesSnapshot,
    audio: AudioStatus,
    audio_devices: AudioDevices,
}

#[tauri::command]
fn get_state(state: State<AppState>) -> FullState {
    let s = state.settings.lock();
    FullState {
        prefs: s.prefs.clone(),
        audio_config: s.audio.clone(),
        custom_soundfont: s.soundfont.clone(),
        devices: state.devices.snapshot(),
        audio: state.audio.status(),
        audio_devices: state.audio.devices(),
    }
}

#[tauri::command]
fn get_audio_meters(state: State<AppState>) -> AudioMeters {
    state.audio.meters()
}

#[tauri::command]
async fn list_audio_devices(state: State<'_, AppState>) -> Result<AudioDevices, String> {
    let audio = state.audio.clone();
    tauri::async_runtime::spawn_blocking(move || audio.refresh_devices())
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn set_input(state: State<AppState>, name: String, input: InputSettings) {
    state.devices.set_input(&name, input);
    state.save();
}

#[tauri::command]
fn set_app_route(state: State<AppState>, route: SoundRoute, channel: u8) {
    state.devices.set_app_route(route, channel);
    state.save();
}

/// Пэды MIDI-клавиатуры как барабаны (мастер на вкладке «Барабаны»).
#[tauri::command]
fn set_drum_pads(state: State<AppState>, pads: Vec<PadBinding>) {
    state.devices.set_pads(pads);
    state.save();
}

/// Удар по экранному пэду: барабан звучит и засчитывается, как удар по настоящему.
#[tauri::command]
fn hit_drum(state: State<AppState>, drum: u8, velocity: u8) {
    state.devices.hit_drum(drum, velocity);
}

#[tauri::command]
fn set_audio_config(state: State<AppState>, config: AudioConfig) {
    state.audio.apply(config.clone());
    state.settings.lock().audio = config;
    state.save();
}

#[tauri::command]
fn set_prefs(state: State<AppState>, prefs: UiPrefs) {
    state.settings.lock().prefs = prefs;
    state.save();
}

/// Загрузить SoundFont: указанный файл или встроенный (`path = None`).
#[tauri::command]
async fn load_soundfont(
    app: AppHandle,
    state: State<'_, AppState>,
    path: Option<PathBuf>,
) -> Result<String, String> {
    let target = match &path {
        Some(p) => p.clone(),
        None => state
            .bundled_soundfont()
            .ok_or("встроенный SoundFont не найден в этой сборке")?,
    };
    let audio = state.audio.clone();
    let name = tauri::async_runtime::spawn_blocking(move || audio.load_soundfont(target))
        .await
        .map_err(|e| e.to_string())??;
    state.settings.lock().soundfont = path;
    state.save();
    let _ = app.emit("audio", state.audio.status());
    Ok(name)
}

#[tauri::command]
fn use_fallback_synth(state: State<AppState>) {
    state.audio.use_fallback_synth();
}

/// Нажатие на экранной клавиатуре: звучит как «звук приложения».
#[tauri::command]
fn play_note(state: State<AppState>, note: u8, velocity: u8, on: bool) {
    let msg = if on {
        MidiMessage::NoteOn {
            note,
            velocity: velocity.max(1),
        }
    } else {
        MidiMessage::NoteOff { note }
    };
    state.devices.play_app(msg);
}

#[tauri::command]
fn rescan_devices(state: State<AppState>) -> DevicesSnapshot {
    state.devices.rescan();
    state.devices.snapshot()
}

/// Имитация MIDI-входа для тестов и режима разработчика.
#[tauri::command]
fn simulate_midi(state: State<AppState>, device: String, bytes: Vec<u8>) {
    state.devices.inject(&device, &bytes);
}

pub fn run() {
    tauri::Builder::default()
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Info)
                .build(),
        )
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let config_dir = app.path().app_config_dir()?;
            std::fs::create_dir_all(&config_dir)?;
            let settings_path = config_dir.join("settings.json");
            backup::apply_pending(&settings_path);
            let settings = AppSettings::load(&settings_path);
            log::info!("настройки: {}", settings_path.display());

            let audio = AudioEngine::start(settings.audio.clone(), settings.guitar.clone());
            // Прогресс обучения. Если база недоступна, тренажёр работает без сохранения.
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            backup::apply_pending(&data_dir.join("progress.db"));
            let store = match Store::open(&data_dir.join("progress.db")) {
                Ok(s) => Some(s),
                Err(e) => {
                    log::error!("база прогресса недоступна: {e:#}");
                    None
                }
            };
            let store = Arc::new(Mutex::new(store));
            app.manage(backup::StoreHandle(store.clone()));
            let hub = Arc::new(TrainerHub::new(store.clone()));
            let practice_hub = Arc::new(PracticeHub::new(store));
            let practice_events = practice_hub.clone();

            let (tx, rx) = unbounded::<DeviceEvent>();
            let devices = DeviceManager::start(audio.clone(), tx, settings.devices.clone());
            devices.set_guitar_sound_demand(settings.guitar.enabled);
            // Ноты, распознанные по звуку гитары/баса, — как ещё одно MIDI-устройство (без звука).
            let (note_tx, note_rx) = unbounded::<mt_core::guitar::NoteEvent>();
            audio.guitar().set_note_sink(note_tx);
            let note_devices = devices.clone();
            thread::Builder::new()
                .name("mt-guitar-notes".into())
                .spawn(move || {
                    for ev in note_rx {
                        let name = match ev.instrument {
                            mt_core::guitar::Instrument::Bass => guitar::BASS_DEVICE,
                            mt_core::guitar::Instrument::Guitar => guitar::GUITAR_DEVICE,
                        };
                        let msg = if ev.on {
                            MidiMessage::NoteOn {
                                note: ev.pitch,
                                velocity: ev.velocity.max(1),
                            }
                        } else {
                            MidiMessage::NoteOff { note: ev.pitch }
                        };
                        note_devices.inject_event(name, 0, msg, ev.time_us);
                    }
                })?;

            let state = AppState {
                devices: devices.clone(),
                audio: audio.clone(),
                settings: Mutex::new(settings),
                settings_path,
                resource_dir: app.path().resource_dir().ok(),
            };

            // События ядра → интерфейс.
            let handle = app.handle().clone();
            let dev = devices.clone();
            let trainer_hub = hub.clone();
            let piece_hub = Arc::new(PieceHub::new(
                devices.clone(),
                audio.clone(),
                app.handle().clone(),
            ));
            let piece_events = piece_hub.clone();
            let rhythm_hub = Arc::new(RhythmHub::new(
                devices.clone(),
                audio.clone(),
                app.handle().clone(),
            ));
            let rhythm_events = rhythm_hub.clone();
            let midi_hub = Arc::new(MidiHub::new(devices.clone(), audio.clone()));
            let studio_hub = Arc::new(studio::StudioHub::new(
                devices.clone(),
                audio.clone(),
                app.handle().clone(),
            ));
            let midi_events = midi_hub.clone();
            let studio_events = studio_hub.clone();
            thread::Builder::new()
                .name("mt-events".into())
                .spawn(move || {
                    for ev in rx {
                        match ev {
                            DeviceEvent::Midi(e) => {
                                midi_events.on_midi(e.channel, e.msg, e.time_us);
                                studio_events.on_midi(e.msg, e.time_us);
                                if let MidiMessage::NoteOn { note, velocity } = e.msg {
                                    trainer_hub.on_note_on(&handle, note, e.time_us);
                                    let pads = e.device == mt_core::devices::PADS_DEVICE;
                                    piece_events.on_note_on(note, pads, e.time_us);
                                    rhythm_events.on_note_on(note, velocity, pads, e.time_us);
                                    practice_events.on_note_on(e.time_us);
                                }
                                let _ = handle.emit("midi", e);
                            }
                            DeviceEvent::Changed => {
                                let _ = handle.emit("devices", dev.snapshot());
                            }
                        }
                    }
                })?;

            // Состояние аудио меняется асинхронно (переподключение, откат на WASAPI).
            let handle = app.handle().clone();
            let watch = audio.clone();
            thread::Builder::new()
                .name("mt-audio-watch".into())
                .spawn(move || {
                    let mut last = String::new();
                    loop {
                        thread::sleep(Duration::from_millis(500));
                        let st = watch.status();
                        let key = serde_json::to_string(&st).unwrap_or_default();
                        if key != last {
                            last = key;
                            let _ = handle.emit("audio", st);
                        }
                    }
                })?;

            // SoundFont грузится в фоне: до конца загрузки звучит простой синтез.
            let sf = state
                .settings
                .lock()
                .soundfont
                .clone()
                .filter(|p| p.exists())
                .or_else(|| state.bundled_soundfont());
            let gm = state.bundled_gm();
            {
                let audio = audio.clone();
                thread::spawn(move || {
                    if let Some(path) = sf {
                        match audio.load_soundfont(path.clone()) {
                            Ok(name) => log::info!("{name} загружен"),
                            Err(e) => log::warn!("SoundFont {}: {e}", path.display()),
                        }
                    }
                    // GM-банк аккомпанемента (барабаны, инструменты MIDI-дорожек) — после рояля.
                    if let Some(path) = gm {
                        match audio.load_gm(path.clone()) {
                            Ok(name) => log::info!("GM-банк: {name}"),
                            Err(e) => log::warn!("GM-банк {}: {e}", path.display()),
                        }
                    }
                });
            }

            app.manage(state);
            app.manage(hub);
            app.manage(piece_hub);
            app.manage(rhythm_hub);
            app.manage(practice_hub);
            app.manage(midi_hub);
            app.manage(studio_hub);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_state,
            get_audio_meters,
            list_audio_devices,
            set_input,
            set_app_route,
            set_drum_pads,
            hit_drum,
            set_audio_config,
            set_prefs,
            load_soundfont,
            use_fallback_synth,
            play_note,
            rescan_devices,
            simulate_midi,
            trainer::trainer_overview,
            trainer::trainer_start,
            trainer::trainer_ready,
            trainer::trainer_stop,
            library::library_list,
            library::library_read,
            library::library_import,
            library::library_open_folder,
            journal::journal_folder,
            journal::journal_read,
            journal::journal_write,
            journal::journal_delete,
            journal::journal_open_folder,
            practice::journal_events,
            library::rocksmith_open,
            library::library_add_text,
            piece::piece_start,
            piece::piece_stop,
            rhythm::rhythm_start,
            rhythm::rhythm_stop,
            rhythm::clock_now,
            practice::practice_open,
            practice::practice_set_fragments,
            practice::practice_set_level,
            practice::practice_record,
            practice::progress_overview,
            practice::fingering_get,
            practice::fingering_set,
            practice::exercise_stats,
            practice::exercise_record,
            practice::exercise_history,
            practice::warmup_done,
            practice::today_status,
            midi_import::midi_inspect,
            midi_import::midi_convert,
            midi_import::midi_preview,
            midi_import::midi_preview_stop,
            midi_import::record_start,
            midi_import::record_status,
            midi_import::record_stop,
            midi_import::record_take_stop,
            midi_import::record_take_play,
            midi_import::play_notes,
            midi_import::jam_save,
            midi_import::record_take_save,
            midi_import::record_take_discard,
            backup::backup_export,
            backup::backup_import,
            backup::restart_app,
            studio::studio_list,
            studio::studio_load,
            studio::studio_save,
            studio::studio_delete,
            studio::studio_from_midi,
            studio::studio_play,
            studio::studio_stop,
            studio::studio_export_midi,
            studio::studio_export_wav,
            midi_import::save_text_file,
            guitar::guitar_state,
            guitar::guitar_inputs,
            guitar::guitar_set,
            guitar::guitar_calibrate,
            guitar::guitar_record,
            guitar::guitar_stop_record,
            guitar::guitar_test_signal,
            guitar::guitar_expect,
            guitar::guitar_expect_chords,
            guitar::guitar_test_chord,
        ])
        .run(tauri::generate_context!())
        .expect("ошибка запуска приложения");
}
