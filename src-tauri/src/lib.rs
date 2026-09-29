//! Оболочка приложения: связывает ядро `mt-core` с интерфейсом через
//! команды и события Tauri и хранит настройки.

mod settings;
mod trainer;

use crossbeam_channel::unbounded;
use mt_core::audio::{AudioConfig, AudioDevices, AudioEngine, AudioMeters, AudioStatus};
use mt_core::devices::{DeviceEvent, DeviceManager, DevicesSnapshot, InputSettings, SoundRoute};
use mt_core::midi::MidiMessage;
use mt_core::store::Store;
use parking_lot::Mutex;
use serde::Serialize;
use settings::{AppSettings, UiPrefs};
use std::path::PathBuf;
use std::sync::Arc;
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};
use trainer::TrainerHub;

struct AppState {
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
            let settings = AppSettings::load(&settings_path);
            log::info!("настройки: {}", settings_path.display());

            let audio = AudioEngine::start(settings.audio.clone());
            // Прогресс обучения. Если база недоступна, тренажёр работает без сохранения.
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            let store = match Store::open(&data_dir.join("progress.db")) {
                Ok(s) => Some(s),
                Err(e) => {
                    log::error!("база прогресса недоступна: {e:#}");
                    None
                }
            };
            let hub = Arc::new(TrainerHub::new(store));

            let (tx, rx) = unbounded::<DeviceEvent>();
            let devices = DeviceManager::start(audio.clone(), tx, settings.devices.clone());

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
            thread::Builder::new()
                .name("mt-events".into())
                .spawn(move || {
                    for ev in rx {
                        match ev {
                            DeviceEvent::Midi(e) => {
                                if let MidiMessage::NoteOn { note, .. } = e.msg {
                                    trainer_hub.on_note_on(&handle, note, e.time_us);
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
            if let Some(path) = sf {
                let audio = audio.clone();
                thread::spawn(move || match audio.load_soundfont(path.clone()) {
                    Ok(name) => log::info!("{name} загружен"),
                    Err(e) => log::warn!("SoundFont {}: {e}", path.display()),
                });
            }

            app.manage(state);
            app.manage(hub);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_state,
            get_audio_meters,
            list_audio_devices,
            set_input,
            set_app_route,
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
        ])
        .run(tauri::generate_context!())
        .expect("ошибка запуска приложения");
}
