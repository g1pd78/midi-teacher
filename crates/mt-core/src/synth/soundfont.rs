//! Синтезатор на SoundFont (`.sf2`) через `rustysynth`.

use super::Synth;
use anyhow::{Context, Result};
use rustysynth::{SoundFont, Synthesizer, SynthesizerSettings};
use std::fs::File;
use std::io::BufReader;
use std::path::{Path, PathBuf};
use std::sync::Arc;

pub struct SoundFontSynth {
    sound_font: Arc<SoundFont>,
    path: PathBuf,
    synth: Synthesizer,
}

impl SoundFontSynth {
    /// Загружает файл целиком в память. Для большого SoundFont это секунды,
    /// поэтому вызывать нужно не из аудиопотока.
    pub fn load(path: &Path, sample_rate: u32) -> Result<Self> {
        let file =
            File::open(path).with_context(|| format!("не удалось открыть {}", path.display()))?;
        let sound_font = SoundFont::new(&mut BufReader::new(file))
            .map_err(|e| anyhow::anyhow!("файл не похож на SoundFont: {e:?}"))?;
        Self::from_sound_font(Arc::new(sound_font), path.to_path_buf(), sample_rate)
    }

    /// Пересоздаёт синтезатор под другую частоту дискретизации без повторного чтения файла.
    pub fn with_sample_rate(&self, sample_rate: u32) -> Result<Self> {
        Self::from_sound_font(self.sound_font.clone(), self.path.clone(), sample_rate)
    }

    fn from_sound_font(
        sound_font: Arc<SoundFont>,
        path: PathBuf,
        sample_rate: u32,
    ) -> Result<Self> {
        let mut settings = SynthesizerSettings::new(sample_rate as i32);
        settings.maximum_polyphony = 128;
        settings.enable_reverb_and_chorus = true;
        let synth = Synthesizer::new(&sound_font, &settings)
            .map_err(|e| anyhow::anyhow!("не удалось создать синтезатор: {e:?}"))?;
        Ok(Self {
            sound_font,
            path,
            synth,
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }
}

impl Synth for SoundFontSynth {
    fn note_on(&mut self, channel: u8, note: u8, velocity: u8) {
        self.synth
            .note_on(channel as i32, note as i32, velocity as i32);
    }

    fn note_off(&mut self, channel: u8, note: u8) {
        self.synth.note_off(channel as i32, note as i32);
    }

    fn control_change(&mut self, channel: u8, controller: u8, value: u8) {
        self.synth
            .process_midi_message(channel as i32, 0xB0, controller as i32, value as i32);
    }

    fn all_notes_off(&mut self) {
        self.synth.note_off_all(true);
    }

    fn render(&mut self, left: &mut [f32], right: &mut [f32]) {
        self.synth.render(left, right);
    }

    fn name(&self) -> String {
        let file = self
            .path
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        format!("SoundFont: {file}")
    }
}
