//! Режим ритма: драйвер транспорта с собственным потоком.
//!
//! Поток спит до ближайшего дела (нота второй руки, щелчок, окно пропуска),
//! но не дольше `MAX_SLEEP`, чтобы быстро заметить остановку. На Windows
//! `thread::sleep` в Rust использует таймеры высокого разрешения (~1 мс).

use mt_core::audio::AudioEngine;
use mt_core::clock;
use mt_core::devices::DeviceManager;
use mt_core::midi::MidiMessage;
use mt_core::piece::PieceNote;
use mt_core::rhythm::{Action, Beat, RhythmConfig, RhythmSession};
use parking_lot::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};

const MAX_SLEEP_US: u64 = 20_000;

pub struct RhythmHub {
    session: Mutex<Option<RhythmSession>>,
    generation: AtomicU64,
    devices: Arc<DeviceManager>,
    audio: AudioEngine,
    app: AppHandle,
}

impl RhythmHub {
    pub fn new(devices: Arc<DeviceManager>, audio: AudioEngine, app: AppHandle) -> Self {
        Self {
            session: Mutex::new(None),
            generation: AtomicU64::new(0),
            devices,
            audio,
            app,
        }
    }

    pub fn on_note_on(&self, pitch: u8, time_us: u64) {
        let actions = match self.session.lock().as_mut() {
            Some(s) => s.on_note_on(pitch, time_us),
            None => return,
        };
        self.run(actions);
    }

    fn run(&self, actions: Vec<Action>) {
        for a in actions {
            match a {
                Action::Event(e) => {
                    let _ = self.app.emit("rhythm", e);
                }
                Action::AppNoteOn { pitch, velocity } => {
                    self.devices.play_app(MidiMessage::NoteOn {
                        note: pitch,
                        velocity,
                    })
                }
                Action::AppNoteOff { pitch } => {
                    self.devices.play_app(MidiMessage::NoteOff { note: pitch })
                }
                Action::Click { accent } => self.audio.click(accent),
            }
        }
    }

    pub fn stop(&self) {
        self.generation.fetch_add(1, Ordering::SeqCst);
        let actions = self
            .session
            .lock()
            .take()
            .map(|mut s| s.stop())
            .unwrap_or_default();
        self.run(actions);
        self.devices.set_extra_sound_demand(false);
    }

    fn drive(self: Arc<Self>, gen: u64) {
        loop {
            if self.generation.load(Ordering::SeqCst) != gen {
                return;
            }
            let now = clock::now_us();
            let (actions, next, finished) = {
                let mut guard = self.session.lock();
                let Some(s) = guard.as_mut() else { return };
                let actions = s.advance(now);
                (actions, s.next_wakeup(now), s.is_finished())
            };
            self.run(actions);
            if finished {
                if self.generation.load(Ordering::SeqCst) == gen {
                    *self.session.lock() = None;
                    self.devices.set_extra_sound_demand(false);
                }
                return;
            }
            let wait = next
                .map(|t| t.saturating_sub(clock::now_us()))
                .unwrap_or(MAX_SLEEP_US)
                .clamp(200, MAX_SLEEP_US);
            thread::sleep(Duration::from_micros(wait));
        }
    }
}

#[tauri::command]
pub fn rhythm_start(
    hub: State<Arc<RhythmHub>>,
    pieces: State<Arc<crate::piece::PieceHub>>,
    notes: Vec<PieceNote>,
    beats: Vec<Beat>,
    config: RhythmConfig,
) {
    pieces.stop();
    hub.stop();
    // Щелчки звучат через встроенный вывод — держим его открытым.
    hub.devices
        .set_extra_sound_demand(config.metronome || config.count_in);
    let mut session = RhythmSession::new(notes, beats, config);
    let actions = session.start(clock::now_us());
    *hub.session.lock() = Some(session);
    hub.run(actions);
    let gen = hub.generation.load(Ordering::SeqCst);
    let driver = Arc::clone(&hub);
    thread::Builder::new()
        .name("mt-rhythm".into())
        .spawn(move || driver.drive(gen))
        .expect("не удалось запустить поток ритма");
}

#[tauri::command]
pub fn rhythm_stop(hub: State<Arc<RhythmHub>>) {
    hub.stop();
}

/// Часы ядра (мкс) — интерфейс сверяет по ним анимацию.
#[tauri::command]
pub fn clock_now() -> u64 {
    clock::now_us()
}
