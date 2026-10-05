//! Гитара и бас: вход звука, прослушивание, тюнер, калибровка задержки, запись WAV.

use crate::library::library_dir;
use crate::AppState;
use mt_core::clock;
use mt_core::guitar::{calibrate, chord, dsp, Calibration, GuitarConfig, GuitarStatus, InputInfo};
use serde::Serialize;
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, State};

/// Имена «устройств» для нот, распознанных по звуку.
pub const GUITAR_DEVICE: &str = "Гитара (звук)";
pub const BASS_DEVICE: &str = "Бас (звук)";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GuitarState {
    config: GuitarConfig,
    status: GuitarStatus,
    inputs: Vec<InputInfo>,
}

/// Настройки, состояние входа, тюнер и список входов (интерфейс опрашивает ~15 раз в секунду).
#[tauri::command]
pub fn guitar_state(state: State<AppState>) -> GuitarState {
    let g = state.audio.guitar();
    GuitarState {
        config: g.config(),
        status: g.status(),
        inputs: g.inputs(),
    }
}

/// Перечитать список входов (подключили кабель или звуковую карту).
#[tauri::command]
pub async fn guitar_inputs(state: State<'_, AppState>) -> Result<Vec<InputInfo>, String> {
    let audio = state.audio.clone();
    tauri::async_runtime::spawn_blocking(move || {
        audio.refresh_devices();
        audio.guitar().inputs()
    })
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn guitar_set(state: State<AppState>, config: GuitarConfig) {
    state.devices.set_guitar_sound_demand(config.enabled);
    state.audio.set_guitar(config.clone());
    state.settings.lock().guitar = config;
    state.save();
}

/// Калибровка задержки: `count` щелчков в темпе `bpm`, ученик бьёт по заглушённой
/// струне на каждый. Возвращает сдвиг «щелчок → удар на входе».
#[tauri::command]
pub async fn guitar_calibrate(
    state: State<'_, AppState>,
    bpm: f64,
    count: u32,
) -> Result<Option<Calibration>, String> {
    let audio = state.audio.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let beat_us = (60_000_000.0 / bpm.clamp(40.0, 200.0)) as u64;
        let count = count.clamp(4, 16) as u64;
        let start = clock::now_us() + 800_000;
        let mut clicks = Vec::new();
        for k in 0..count {
            let due = start + k * beat_us;
            let now = clock::now_us();
            if due > now {
                thread::sleep(Duration::from_micros(due - now));
            }
            audio.click(k == 0);
            // Щелчок слышен после выходного буфера.
            let out_us = (audio.meters().output_latency_ms * 1000.0) as u64;
            clicks.push(clock::now_us() + out_us);
        }
        thread::sleep(Duration::from_millis(500));
        let onsets = audio.guitar().onsets_since(start.saturating_sub(300_000));
        Ok(calibrate(&clicks, &onsets))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Записать вход в WAV (папка библиотеки → «Гитара»). Возвращает путь файла.
#[tauri::command]
pub fn guitar_record(
    app: AppHandle,
    state: State<AppState>,
    name: String,
    secs: f32,
) -> Result<String, String> {
    let clean: String = name
        .chars()
        .map(|c| if "/\\:*?\"<>|".contains(c) { '-' } else { c })
        .collect();
    let path = library_dir(&app)?
        .join("Гитара")
        .join(format!("{}.wav", clean.trim()));
    state.audio.guitar().record(path.clone(), secs);
    Ok(path.display().to_string())
}

#[tauri::command]
pub fn guitar_stop_record(state: State<AppState>) {
    state.audio.guitar().stop_record();
}

/// Тестовый сигнал вместо входа (сквозные тесты, режим разработчика):
/// `pluck` — щипок струны, иначе синус.
#[tauri::command]
pub fn guitar_test_signal(state: State<AppState>, hz: f32, secs: f32, kind: String) {
    const RATE: u32 = 48_000;
    let samples = if kind == "pluck" {
        dsp::pluck(hz, RATE as f32, secs, 0.4, 1)
    } else {
        dsp::sine(hz, RATE as f32, secs, 0.3)
    };
    state.audio.guitar().inject(samples, RATE);
}

/// Ноты, которые сейчас ждёт пьеса: подсказка распознаванию (ошибки на октаву).
#[tauri::command]
pub fn guitar_expect(state: State<AppState>, pitches: Vec<u8>) {
    state.audio.guitar().set_expected(pitches);
}

/// Аккорды, которые сейчас ждут (ноты MIDI): удар по струнам проверяется по спектру.
/// Пустой список — снова одноголосие.
#[tauri::command]
pub fn guitar_expect_chords(state: State<AppState>, chords: Vec<Vec<u8>>) {
    state.audio.guitar().set_expected_chords(chords);
}

/// Тестовый удар по струнам (сквозные тесты, режим разработчика): ноты MIDI, разброс струн 12 мс.
#[tauri::command]
pub fn guitar_test_chord(state: State<AppState>, pitches: Vec<u8>, secs: f32) {
    const RATE: u32 = 48_000;
    let mut samples = vec![0.0f32; (RATE / 20) as usize];
    samples.extend(chord::strum(
        &pitches,
        RATE as f32,
        secs.clamp(0.2, 4.0),
        12.0,
    ));
    state.audio.guitar().inject(samples, RATE);
}
