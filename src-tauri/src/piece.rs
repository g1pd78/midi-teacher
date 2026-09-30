//! Разучивание пьесы: запуск сессии, подача нажатий, звук второй руки, таймеры.

use mt_core::audio::AudioEngine;
use mt_core::clock;
use mt_core::devices::DeviceManager;
use mt_core::midi::MidiMessage;
use mt_core::piece::{Action, PieceConfig, PieceNote, PieceSession};
use parking_lot::Mutex;
use std::sync::Arc;
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};

pub struct PieceHub {
    session: Mutex<Option<PieceSession>>,
    devices: Arc<DeviceManager>,
    audio: AudioEngine,
    app: AppHandle,
}

impl PieceHub {
    pub fn new(devices: Arc<DeviceManager>, audio: AudioEngine, app: AppHandle) -> Self {
        Self {
            session: Mutex::new(None),
            devices,
            audio,
            app,
        }
    }

    pub fn on_note_on(self: &Arc<Self>, pitch: u8, time_us: u64) {
        let actions = match self.session.lock().as_mut() {
            Some(s) => s.on_note_on(pitch, time_us),
            None => return,
        };
        self.run(actions);
    }

    fn on_timer(self: &Arc<Self>, token: u64) {
        let actions = match self.session.lock().as_mut() {
            Some(s) => s.on_timer(token, clock::now_us()),
            None => return,
        };
        self.run(actions);
    }

    fn run(self: &Arc<Self>, actions: Vec<Action>) {
        for a in actions {
            match a {
                Action::Event(e) => {
                    let _ = self.app.emit("piece", e);
                }
                Action::AppNoteOn { pitch, velocity } => {
                    self.devices.play_app(MidiMessage::NoteOn {
                        note: pitch,
                        velocity,
                    });
                }
                Action::AppNoteOff { pitch } => {
                    self.devices.play_app(MidiMessage::NoteOff { note: pitch });
                }
                // Без GM-банка аккомпанемент звучит как «звук приложения».
                Action::GmNoteOn {
                    channel,
                    program,
                    pitch,
                    velocity,
                } => {
                    let msg = MidiMessage::NoteOn {
                        note: pitch,
                        velocity,
                    };
                    if self.audio.status().gm.is_some() {
                        self.audio.gm_send(channel, program, msg)
                    } else if channel != 9 {
                        self.devices.play_app(msg)
                    }
                }
                Action::GmNoteOff { channel, pitch } => {
                    let msg = MidiMessage::NoteOff { note: pitch };
                    if self.audio.status().gm.is_some() {
                        self.audio.gm_send(channel, None, msg)
                    } else if channel != 9 {
                        self.devices.play_app(msg)
                    }
                }
                Action::Schedule { token, delay_ms } => {
                    let hub = self.clone();
                    thread::spawn(move || {
                        thread::sleep(Duration::from_millis(delay_ms as u64));
                        hub.on_timer(token);
                    });
                }
            }
        }
    }

    pub fn stop(self: &Arc<Self>) {
        let actions = self
            .session
            .lock()
            .take()
            .map(|mut s| s.stop())
            .unwrap_or_default();
        self.run(actions);
    }
}

#[tauri::command]
pub fn piece_start(
    hub: State<Arc<PieceHub>>,
    rhythm: State<Arc<crate::rhythm::RhythmHub>>,
    notes: Vec<PieceNote>,
    config: PieceConfig,
) -> usize {
    rhythm.stop();
    hub.stop();
    // Аккомпанемент GM звучит встроенным синтезатором — держим вывод открытым.
    hub.devices
        .set_extra_sound_demand(notes.iter().any(|n| n.channel.is_some()));
    let mut session = PieceSession::new(notes, config);
    let steps = session.steps().len();
    let actions = session.start(clock::now_us());
    *hub.session.lock() = Some(session);
    hub.run(actions);
    steps
}

#[tauri::command]
pub fn piece_stop(hub: State<Arc<PieceHub>>) {
    hub.stop();
    hub.devices.set_extra_sound_demand(false);
}
