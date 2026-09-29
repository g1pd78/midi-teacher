//! Синтезаторы звука рояля.
//!
//! [`FallbackSynth`] работает всегда и ничего не загружает. [`SoundFontSynth`]
//! звучит как настоящий рояль, но требует файл `.sf2` и время на загрузку.

mod fallback;
mod soundfont;

pub use fallback::FallbackSynth;
pub use soundfont::SoundFontSynth;

use crate::midi::MidiMessage;

/// Общий интерфейс синтезатора. Все методы вызываются из аудиопотока,
/// поэтому не должны выделять память или блокироваться.
pub trait Synth: Send {
    fn note_on(&mut self, channel: u8, note: u8, velocity: u8);
    fn note_off(&mut self, channel: u8, note: u8);
    fn control_change(&mut self, channel: u8, controller: u8, value: u8);
    /// Немедленно заглушить все звуки (смена синтезатора, пауза).
    fn all_notes_off(&mut self);
    /// Заполнить стереобуфер. Длина `left` и `right` одинакова.
    fn render(&mut self, left: &mut [f32], right: &mut [f32]);
    /// Название для экрана диагностики.
    fn name(&self) -> String;

    fn handle(&mut self, channel: u8, msg: MidiMessage) {
        match msg {
            MidiMessage::NoteOn { note, velocity } => self.note_on(channel, note, velocity),
            MidiMessage::NoteOff { note } => self.note_off(channel, note),
            MidiMessage::ControlChange { controller, value } => {
                self.control_change(channel, controller, value)
            }
        }
    }
}
