//! Ядро MIDI Teacher: ввод MIDI, маршрутизация звука, синтезатор.
//!
//! Крейт не зависит от Tauri, поэтому его можно тестировать и запускать
//! отдельно от интерфейса.

pub mod audio;
pub mod clock;
pub mod devices;
pub mod fingering;
pub mod guitar;
pub mod midi;
pub mod midifile;
pub mod piece;
pub mod practice;
pub mod rhythm;
pub mod rocksmith;
pub mod song;
pub mod store;
pub mod synth;
pub mod trainer;
