//! Разбор MIDI-сообщений и названия нот.

use serde::Serialize;

/// Сообщение, которое интересно приложению. Всё остальное (Active Sensing,
/// MIDI Clock, SysEx) отбрасывается ещё при разборе.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum MidiMessage {
    NoteOn { note: u8, velocity: u8 },
    NoteOff { note: u8 },
    ControlChange { controller: u8, value: u8 },
}

/// Номер контроллера правой педали (sustain).
pub const CC_SUSTAIN: u8 = 64;

/// Разбирает сырое сообщение. Возвращает канал (0–15) и сообщение.
///
/// NoteOn с силой 0 по стандарту означает NoteOff: так шлют многие цифровые пианино.
pub fn parse(bytes: &[u8]) -> Option<(u8, MidiMessage)> {
    let (&status, data) = bytes.split_first()?;
    if !(0x80..0xF0).contains(&status) {
        return None;
    }
    let channel = status & 0x0F;
    let d1 = *data.first()? & 0x7F;
    let d2 = data.get(1).map(|b| b & 0x7F);
    let msg = match status & 0xF0 {
        0x90 => match d2? {
            0 => MidiMessage::NoteOff { note: d1 },
            velocity => MidiMessage::NoteOn { note: d1, velocity },
        },
        0x80 => MidiMessage::NoteOff { note: d1 },
        0xB0 => MidiMessage::ControlChange {
            controller: d1,
            value: d2?,
        },
        _ => return None,
    };
    Some((channel, msg))
}

/// Собирает сырое сообщение для отправки на MIDI-выход.
pub fn encode(channel: u8, msg: MidiMessage) -> [u8; 3] {
    let ch = channel & 0x0F;
    match msg {
        MidiMessage::NoteOn { note, velocity } => [0x90 | ch, note & 0x7F, velocity & 0x7F],
        MidiMessage::NoteOff { note } => [0x80 | ch, note & 0x7F, 0],
        MidiMessage::ControlChange { controller, value } => {
            [0xB0 | ch, controller & 0x7F, value & 0x7F]
        }
    }
}

/// Самая низкая и самая высокая клавиши 88-клавишного фортепиано (A0 и C8).
pub const PIANO_LOWEST: u8 = 21;
pub const PIANO_HIGHEST: u8 = 108;

/// Октава в научной нотации (C4 = 60, «до первой октавы»).
pub fn octave(note: u8) -> i32 {
    note as i32 / 12 - 1
}

/// Чёрная ли клавиша.
pub fn is_black(note: u8) -> bool {
    matches!(note % 12, 1 | 3 | 6 | 8 | 10)
}

const LATIN: [&str; 12] = [
    "C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B",
];

/// Латинское название с октавой: `C4`, `F#3`.
pub fn latin_name(note: u8) -> String {
    format!("{}{}", LATIN[(note % 12) as usize], octave(note))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn note_on_and_off() {
        assert_eq!(
            parse(&[0x90, 60, 100]),
            Some((
                0,
                MidiMessage::NoteOn {
                    note: 60,
                    velocity: 100
                }
            ))
        );
        assert_eq!(
            parse(&[0x83, 60, 64]),
            Some((3, MidiMessage::NoteOff { note: 60 }))
        );
    }

    #[test]
    fn note_on_with_zero_velocity_is_note_off() {
        assert_eq!(
            parse(&[0x91, 64, 0]),
            Some((1, MidiMessage::NoteOff { note: 64 }))
        );
    }

    #[test]
    fn sustain_pedal() {
        assert_eq!(
            parse(&[0xB0, 64, 127]),
            Some((
                0,
                MidiMessage::ControlChange {
                    controller: CC_SUSTAIN,
                    value: 127
                }
            ))
        );
    }

    #[test]
    fn ignores_realtime_sysex_and_garbage() {
        assert_eq!(parse(&[0xFE]), None); // Active Sensing: цифровые пианино шлют постоянно
        assert_eq!(parse(&[0xF8]), None); // MIDI Clock
        assert_eq!(parse(&[0xF0, 0x7E, 0xF7]), None);
        assert_eq!(parse(&[]), None);
        assert_eq!(parse(&[0x90]), None);
        assert_eq!(parse(&[0x90, 60]), None);
        assert_eq!(parse(&[0x40, 60, 60]), None);
        assert_eq!(parse(&[0xC0, 5]), None); // Program Change не нужен
    }

    #[test]
    fn encode_roundtrip() {
        for msg in [
            MidiMessage::NoteOn {
                note: 21,
                velocity: 1,
            },
            MidiMessage::NoteOff { note: 108 },
            MidiMessage::ControlChange {
                controller: 64,
                value: 0,
            },
        ] {
            assert_eq!(parse(&encode(5, msg)), Some((5, msg)));
        }
    }

    #[test]
    fn names() {
        assert_eq!(latin_name(60), "C4");
        assert_eq!(latin_name(21), "A0");
        assert_eq!(latin_name(108), "C8");
        assert_eq!(latin_name(66), "F#4");
        assert!(is_black(61) && !is_black(60) && !is_black(64) && is_black(70));
    }
}
