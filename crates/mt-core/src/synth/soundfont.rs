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

    /// Одна нота «в сэмпл» для вкладки «Код»: моно, без реверберации и хоруса; держится `hold_ms`,
    /// затем отпускается, хвост обрезается, когда звук затих. Канал 9 — барабаны (программа не важна).
    pub fn render_one_shot(
        &self,
        channel: u8,
        program: u8,
        note: u8,
        velocity: u8,
        hold_ms: u32,
        rate: u32,
    ) -> Result<Vec<f32>> {
        let mut settings = SynthesizerSettings::new(rate as i32);
        settings.enable_reverb_and_chorus = false;
        let mut synth = Synthesizer::new(&self.sound_font, &settings)
            .map_err(|e| anyhow::anyhow!("не удалось создать синтезатор: {e:?}"))?;
        let ch = channel as i32;
        if channel != 9 {
            synth.process_midi_message(ch, 0xC0, program as i32, 0);
        }
        synth.note_on(ch, note as i32, velocity as i32);
        const BLOCK: usize = 256;
        let hold = (hold_ms as usize * rate as usize / 1000).max(BLOCK);
        let max = hold + rate as usize * 4;
        let quiet_needed = rate as usize / 20;
        let (mut l, mut r) = ([0.0f32; BLOCK], [0.0f32; BLOCK]);
        let mut out = Vec::with_capacity(hold + rate as usize);
        let mut quiet = 0usize;
        while out.len() < max {
            if out.len() >= hold && out.len() < hold + BLOCK {
                synth.note_off(ch, note as i32);
            }
            synth.render(&mut l, &mut r);
            let mut loud = false;
            for i in 0..BLOCK {
                let v = (l[i] + r[i]) * 0.5;
                loud |= v.abs() > 1e-4;
                out.push(v);
            }
            if out.len() > hold {
                quiet = if loud { 0 } else { quiet + BLOCK };
                if quiet >= quiet_needed {
                    break;
                }
            }
        }
        // Обрезать тишину в конце и сделать короткое затухание, чтобы не щёлкало.
        while out.last().is_some_and(|v| v.abs() <= 1e-4) {
            out.pop();
        }
        let fade = (rate as usize / 200).min(out.len());
        let n = out.len();
        for (i, v) in out[n - fade..].iter_mut().enumerate() {
            *v *= 1.0 - i as f32 / fade.max(1) as f32;
        }
        Ok(out)
    }

    /// Смена инструмента на канале (General MIDI; канал 9 — барабаны).
    pub fn program_change(&mut self, channel: u8, program: u8) {
        self.synth
            .process_midi_message(channel as i32, 0xC0, program as i32, 0);
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

#[cfg(test)]
mod tests {
    use super::*;

    /// GM-банк звучит: струнные (программа 48) и барабаны (канал 9).
    /// Банк не хранится в репозитории — тест проверяет его, если он скачан.
    #[test]
    fn gm_bank_plays_instruments_and_drums() {
        let path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../src-tauri/resources/gm/GeneralUser-GS.sf2");
        if !path.exists() {
            eprintln!("GM-банк не скачан — пропуск");
            return;
        }
        let mut s = SoundFontSynth::load(&path, 48_000).unwrap();
        let energy = |s: &mut SoundFontSynth| {
            let (mut l, mut r) = (vec![0.0f32; 4800], vec![0.0f32; 4800]);
            s.render(&mut l, &mut r);
            l.iter().chain(&r).map(|x| x * x).sum::<f32>()
        };
        assert_eq!(energy(&mut s), 0.0);
        s.program_change(2, 48);
        s.note_on(2, 55, 100);
        assert!(energy(&mut s) > 1e-3);
        s.all_notes_off();
        let _ = energy(&mut s);
        s.note_on(9, 36, 110);
        assert!(energy(&mut s) > 1e-3, "бочка на канале 10 не звучит");
    }

    /// Сэмпл одной ноты: звучит, отпускается и обрезается (а не тянется до предела в 4 с).
    #[test]
    fn one_shot_renders_and_trims() {
        let path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../src-tauri/resources/gm/GeneralUser-GS.sf2");
        if !path.exists() {
            eprintln!("GM-банк не скачан — пропуск");
            return;
        }
        let s = SoundFontSynth::load(&path, 32_000).unwrap();
        let kick = s.render_one_shot(9, 0, 36, 110, 100, 32_000).unwrap();
        assert!(
            kick.len() > 1_000 && kick.len() < 32_000 * 3,
            "бочка: {} отсчётов",
            kick.len()
        );
        assert!(kick.iter().any(|v| v.abs() > 0.05));
        let pluck = s.render_one_shot(0, 33, 40, 100, 800, 32_000).unwrap();
        assert!(
            pluck.len() > 32_000 * 8 / 10,
            "бас короче удержания: {}",
            pluck.len()
        );
        assert!(pluck.len() < 32_000 * 5);
        assert!(pluck.last().unwrap().abs() < 1e-3);
    }
}
