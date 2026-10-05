//! Запись своей игры в MIDI-файл.

use super::*;

// --- Запись своей игры ---

/// Стандартный MIDI-файл (формат 0) из записанных событий: время в микросекундах от начала.
pub fn write_smf(events: &[(u64, MidiMessage)], bpm: f64, name: &str) -> Vec<u8> {
    let with_channel: Vec<(u64, u8, MidiMessage)> =
        events.iter().map(|&(t, m)| (t, 0, m)).collect();
    write_smf_channels(&with_channel, bpm, name)
}

/// То же с каналами: удары по пэдам пишутся на канал ударных (10-й), клавиши — на 1-й.
pub fn write_smf_channels(events: &[(u64, u8, MidiMessage)], bpm: f64, name: &str) -> Vec<u8> {
    const PPQ: u64 = 480;
    let us_per_tick = 60_000_000.0 / bpm / PPQ as f64;
    let mut body: Vec<u8> = Vec::new();
    let vlq = |v: u64, out: &mut Vec<u8>| {
        let mut buf = vec![(v & 0x7f) as u8];
        let mut x = v >> 7;
        while x > 0 {
            buf.push((x & 0x7f) as u8 | 0x80);
            x >>= 7;
        }
        buf.reverse();
        out.extend(buf);
    };
    // Имя, темп, размер 4/4.
    vlq(0, &mut body);
    body.extend([0xff, 0x03, name.len().min(127) as u8]);
    body.extend(name.as_bytes().iter().take(127));
    let tempo = (60_000_000.0 / bpm).round() as u32;
    vlq(0, &mut body);
    body.extend([
        0xff,
        0x51,
        0x03,
        (tempo >> 16) as u8,
        (tempo >> 8) as u8,
        tempo as u8,
    ]);
    vlq(0, &mut body);
    body.extend([0xff, 0x58, 0x04, 4, 2, 24, 8]);
    let mut last = 0u64;
    let mut sorted: Vec<&(u64, u8, MidiMessage)> = events.iter().collect();
    sorted.sort_by_key(|e| e.0);
    for (t, ch, msg) in sorted {
        let ch = ch & 0x0f;
        let bytes: Vec<u8> = match *msg {
            MidiMessage::NoteOn { note, velocity } => vec![0x90 | ch, note, velocity.max(1)],
            MidiMessage::NoteOff { note } => vec![0x80 | ch, note, 0],
            MidiMessage::ControlChange { controller, value } => vec![0xb0 | ch, controller, value],
        };
        let tick = (*t as f64 / us_per_tick).round() as u64;
        vlq(tick.saturating_sub(last), &mut body);
        last = tick.max(last);
        body.extend(bytes);
    }
    vlq(0, &mut body);
    body.extend([0xff, 0x2f, 0x00]);
    let mut out = Vec::new();
    out.extend(b"MThd");
    out.extend(6u32.to_be_bytes());
    out.extend(0u16.to_be_bytes());
    out.extend(1u16.to_be_bytes());
    out.extend((PPQ as u16).to_be_bytes());
    out.extend(b"MTrk");
    out.extend((body.len() as u32).to_be_bytes());
    out.extend(body);
    out
}
