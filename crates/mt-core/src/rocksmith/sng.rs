//! Партия Rocksmith (SNG): заголовок, вектор AES-256-CTR, затем сжатые zlib данные —
//! массивы долей, фраз, аккордов, уровней сложности с нотами и метаданные.
//! Порядок байтов — little-endian и на ПК, и на Mac; у Mac свой ключ.
//!
//! Раскладка структур — по открытой реализации Rocksmith2014.NET (MIT).

use aes::Aes256;
use anyhow::{bail, Context, Result};
use ctr::cipher::{KeyIvInit, StreamCipher};
use flate2::read::ZlibDecoder;
use std::io::Read;

const SNG_KEY_PC: [u8; 32] = [
    0xCB, 0x64, 0x8D, 0xF3, 0xD1, 0x2A, 0x16, 0xBF, 0x71, 0x70, 0x14, 0x14, 0xE6, 0x96, 0x19, 0xEC,
    0x17, 0x1C, 0xCA, 0x5D, 0x2A, 0x14, 0x2E, 0x3E, 0x59, 0xDE, 0x7A, 0xDD, 0xA1, 0x8A, 0x3A, 0x30,
];
const SNG_KEY_MAC: [u8; 32] = [
    0x98, 0x21, 0x33, 0x0E, 0x34, 0xB9, 0x1F, 0x70, 0xD0, 0xA4, 0x8C, 0xBD, 0x62, 0x59, 0x93, 0x12,
    0x69, 0x70, 0xCE, 0xA0, 0x91, 0x92, 0xC0, 0xE6, 0xCD, 0xA6, 0x76, 0xCC, 0x98, 0x38, 0x28, 0x9D,
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Platform {
    Pc,
    Mac,
}

/// Маски приёмов ноты (как в игре).
pub mod mask {
    pub const CHORD: u32 = 0x2;
    pub const FRET_HAND_MUTE: u32 = 0x8;
    pub const TREMOLO: u32 = 0x10;
    pub const HARMONIC: u32 = 0x20;
    pub const PALM_MUTE: u32 = 0x40;
    pub const SLAP: u32 = 0x80;
    pub const PLUCK: u32 = 0x100;
    pub const HAMMER_ON: u32 = 0x200;
    pub const PULL_OFF: u32 = 0x400;
    pub const SLIDE: u32 = 0x800;
    pub const BEND: u32 = 0x1000;
    pub const TAP: u32 = 0x4000;
    pub const PINCH_HARMONIC: u32 = 0x8000;
    pub const VIBRATO: u32 = 0x10000;
    pub const MUTE: u32 = 0x20000;
    pub const IGNORE: u32 = 0x40000;
    pub const UNPITCHED_SLIDE: u32 = 0x400000;
    pub const ACCENT: u32 = 0x4000000;
}

#[derive(Debug, Clone, PartialEq)]
pub struct Beat {
    pub time: f32,
    /// Номер такта (у всех долей такта).
    pub measure: i16,
    /// Номер доли в такте.
    pub beat: i16,
    /// Первая доля такта.
    pub first: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Phrase {
    pub max_difficulty: i32,
    pub name: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ChordTemplate {
    pub frets: [i8; 6],
    pub fingers: [i8; 6],
    pub name: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ChordNotes {
    pub mask: [u32; 6],
    pub slide_to: [i8; 6],
}

#[derive(Debug, Clone, PartialEq)]
pub struct PhraseIteration {
    pub phrase_id: i32,
    pub start: f32,
    pub end: f32,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Section {
    pub name: String,
    pub number: i32,
    pub start: f32,
    pub end: f32,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Note {
    pub mask: u32,
    pub time: f32,
    pub string: i8,
    pub fret: i8,
    pub chord_id: i32,
    pub chord_notes_id: i32,
    pub phrase_iteration_id: i32,
    pub slide_to: i8,
    pub slide_unpitch_to: i8,
    pub sustain: f32,
    pub max_bend: f32,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Level {
    pub difficulty: i32,
    pub notes: Vec<Note>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Sng {
    pub beats: Vec<Beat>,
    pub phrases: Vec<Phrase>,
    pub chords: Vec<ChordTemplate>,
    pub chord_notes: Vec<ChordNotes>,
    pub vocals: usize,
    pub phrase_iterations: Vec<PhraseIteration>,
    pub sections: Vec<Section>,
    pub levels: Vec<Level>,
    pub capo: i8,
    pub song_length: f32,
    /// Смещения струн от стандартного строя (полутона).
    pub tuning: Vec<i16>,
}

struct Reader<'a> {
    data: &'a [u8],
    pos: usize,
}

impl<'a> Reader<'a> {
    fn bytes(&mut self, n: usize) -> Result<&'a [u8]> {
        let s = self
            .data
            .get(self.pos..self.pos + n)
            .context("SNG обрезан")?;
        self.pos += n;
        Ok(s)
    }
    fn skip(&mut self, n: usize) -> Result<()> {
        self.bytes(n).map(|_| ())
    }
    fn arr<const N: usize>(&mut self) -> Result<[u8; N]> {
        Ok(self.bytes(N)?.try_into()?)
    }
    fn u32(&mut self) -> Result<u32> {
        Ok(u32::from_le_bytes(self.arr()?))
    }
    fn i32(&mut self) -> Result<i32> {
        Ok(i32::from_le_bytes(self.arr()?))
    }
    fn i16(&mut self) -> Result<i16> {
        Ok(i16::from_le_bytes(self.arr()?))
    }
    fn i8(&mut self) -> Result<i8> {
        Ok(self.bytes(1)?[0] as i8)
    }
    fn f32(&mut self) -> Result<f32> {
        Ok(f32::from_le_bytes(self.arr()?))
    }
    fn text(&mut self, n: usize) -> Result<String> {
        let b = self.bytes(n)?;
        let end = b.iter().position(|&c| c == 0).unwrap_or(n);
        Ok(String::from_utf8_lossy(&b[..end]).into_owned())
    }
    fn count(&mut self) -> Result<usize> {
        let n = self.i32()?;
        if n < 0 || n as usize > self.data.len() {
            bail!("неверная длина массива в SNG");
        }
        Ok(n as usize)
    }
    fn list<T>(&mut self, mut f: impl FnMut(&mut Self) -> Result<T>) -> Result<Vec<T>> {
        let n = self.count()?;
        (0..n).map(|_| f(self)).collect()
    }
    /// Массив записей фиксированного размера, которые нам не нужны.
    fn skip_list(&mut self, size: usize) -> Result<usize> {
        let n = self.count()?;
        self.skip(n * size)?;
        Ok(n)
    }
}

/// Расшифровать и распаковать SNG из архива.
pub fn unpack(data: &[u8], platform: Platform) -> Result<Vec<u8>> {
    if data.len() < 24 {
        bail!("SNG слишком короткий");
    }
    if u32::from_le_bytes(data[0..4].try_into()?) != 0x4A {
        bail!("это не SNG");
    }
    let iv: [u8; 16] = data[8..24].try_into()?;
    let key = if platform == Platform::Pc {
        SNG_KEY_PC
    } else {
        SNG_KEY_MAC
    };
    let mut payload = data[24..].to_vec();
    ctr::Ctr128BE::<Aes256>::new(&key.into(), &iv.into()).apply_keystream(&mut payload);
    // Длина распакованных данных, затем поток zlib.
    let mut out = Vec::new();
    ZlibDecoder::new(&payload[4..])
        .read_to_end(&mut out)
        .context("SNG не распаковался")?;
    Ok(out)
}

/// Разобрать распакованный SNG.
pub fn parse(plain: &[u8]) -> Result<Sng> {
    let mut r = Reader {
        data: plain,
        pos: 0,
    };
    let beats = r.list(|r| {
        let time = r.f32()?;
        let measure = r.i16()?;
        let beat = r.i16()?;
        r.skip(4)?; // итерация фразы
        let mask = r.u32()?;
        Ok(Beat {
            time,
            measure,
            beat,
            first: mask & 1 != 0,
        })
    })?;
    let phrases = r.list(|r| {
        r.skip(4)?; // соло, разброс, игнор, выравнивание
        let max_difficulty = r.i32()?;
        r.skip(4)?; // число повторов
        Ok(Phrase {
            max_difficulty,
            name: r.text(32)?,
        })
    })?;
    let chords = r.list(|r| {
        r.skip(4)?; // маска
        let mut frets = [0i8; 6];
        let mut fingers = [0i8; 6];
        for f in frets.iter_mut() {
            *f = r.i8()?;
        }
        for f in fingers.iter_mut() {
            *f = r.i8()?;
        }
        r.skip(24)?; // MIDI-ноты струн
        Ok(ChordTemplate {
            frets,
            fingers,
            name: r.text(32)?,
        })
    })?;
    let chord_notes = r.list(|r| {
        let mut mask = [0u32; 6];
        for m in mask.iter_mut() {
            *m = r.u32()?;
        }
        r.skip(6 * (32 * 12 + 4))?; // данные бендов
        let mut slide_to = [0i8; 6];
        for s in slide_to.iter_mut() {
            *s = r.i8()?;
        }
        r.skip(6 + 12)?; // слайды без высоты, вибрато
        Ok(ChordNotes { mask, slide_to })
    })?;
    let vocals = r.skip_list(4 + 4 + 4 + 48)?;
    if vocals > 0 {
        r.skip_list(32)?; // заголовки символов
        r.skip_list(128 + 16)?; // текстуры
        r.skip_list(12 + 32)?; // определения
    }
    let phrase_iterations = r.list(|r| {
        let pi = PhraseIteration {
            phrase_id: r.i32()?,
            start: r.f32()?,
            end: r.f32()?,
        };
        r.skip(12)?; // сложность
        Ok(pi)
    })?;
    r.skip_list(16)?; // доп. сведения фраз
    r.list(|r| {
        r.skip(4)?;
        r.skip_list(4)
    })?; // связанные уровни
    r.skip_list(4 + 256)?; // действия
    r.skip_list(4 + 256)?; // события
    r.skip_list(8)?; // звуки
    r.skip_list(8)?; // DNA
    let sections = r.list(|r| {
        let name = r.text(32)?;
        let number = r.i32()?;
        let start = r.f32()?;
        let end = r.f32()?;
        r.skip(8 + 36)?;
        Ok(Section {
            name,
            number,
            start,
            end,
        })
    })?;
    let levels = r.list(|r| {
        let difficulty = r.i32()?;
        r.skip_list(28)?; // якоря
        r.skip_list(12)?; // расширения якорей
        r.skip_list(20)?; // формы руки
        r.skip_list(20)?; // арпеджио
        let notes = r.list(|r| {
            let mask = r.u32()?;
            r.skip(8)?; // флаги, хэш
            let time = r.f32()?;
            let string = r.i8()?;
            let fret = r.i8()?;
            r.skip(2)?; // якорь
            let chord_id = r.i32()?;
            let chord_notes_id = r.i32()?;
            r.skip(4)?; // фраза
            let phrase_iteration_id = r.i32()?;
            r.skip(4 + 6)?; // отпечатки, соседние ноты
            let slide_to = r.i8()?;
            let slide_unpitch_to = r.i8()?;
            r.skip(5 + 2)?; // левая рука, тэп, штрих, слэп, щипок, вибрато
            let sustain = r.f32()?;
            let max_bend = r.f32()?;
            r.skip_list(12)?; // точки бенда
            Ok(Note {
                mask,
                time,
                string,
                fret,
                chord_id,
                chord_notes_id,
                phrase_iteration_id,
                slide_to,
                slide_unpitch_to,
                sustain,
                max_bend,
            })
        })?;
        r.skip_list(4)?;
        r.skip_list(4)?;
        r.skip_list(4)?;
        Ok(Level { difficulty, notes })
    })?;
    r.skip(32 + 8)?; // счёт, начало
    let capo = r.i8()?;
    r.skip(32 + 2)?; // дата, часть
    let song_length = r.f32()?;
    let tuning = r.list(|r| r.i16())?;
    Ok(Sng {
        beats,
        phrases,
        chords,
        chord_notes,
        vocals,
        phrase_iterations,
        sections,
        levels,
        capo,
        song_length,
        tuning,
    })
}
