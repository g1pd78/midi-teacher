//! Простой встроенный синтез «под рояль» без сэмплов.
//!
//! Звучит скромно, зато доступен сразу после запуска: пока грузится SoundFont
//! или если файла нет вовсе. Каждый голос — сумма нескольких гармоник
//! с небольшой негармоничностью (как у струны) и затуханием, которое быстрее
//! у высоких гармоник и высоких нот.

use super::Synth;
use crate::midi::CC_SUSTAIN;
use std::f32::consts::TAU;

const MAX_VOICES: usize = 64;
const PARTIALS: usize = 6;
/// Негармоничность струны: частота k-й гармоники = f·k·√(1 + B·k²).
const INHARMONICITY: f32 = 0.0004;
const ATTACK_SEC: f32 = 0.003;
const RELEASE_SEC: f32 = 0.12;
const STEAL_RELEASE_SEC: f32 = 0.02;
const SILENCE: f32 = 1e-3; // −60 дБ

#[derive(Clone, Copy)]
struct Voice {
    active: bool,
    channel: u8,
    note: u8,
    /// Клавиша отпущена, но звук держит педаль.
    held_by_pedal: bool,
    releasing: bool,
    phase: [f32; PARTIALS],
    phase_inc: [f32; PARTIALS],
    amp: [f32; PARTIALS],
    partial_decay: [f32; PARTIALS],
    env: f32,
    release_mul: f32,
    attack_left: u32,
    attack_step: f32,
    attack_level: f32,
    gain_l: f32,
    gain_r: f32,
}

impl Voice {
    const SILENT: Voice = Voice {
        active: false,
        channel: 0,
        note: 0,
        held_by_pedal: false,
        releasing: false,
        phase: [0.0; PARTIALS],
        phase_inc: [0.0; PARTIALS],
        amp: [0.0; PARTIALS],
        partial_decay: [1.0; PARTIALS],
        env: 0.0,
        release_mul: 1.0,
        attack_left: 0,
        attack_step: 0.0,
        attack_level: 0.0,
        gain_l: 0.0,
        gain_r: 0.0,
    };

    fn release(&mut self, sample_rate: f32, seconds: f32) {
        self.releasing = true;
        self.held_by_pedal = false;
        self.release_mul = (-1.0 / (seconds * sample_rate)).exp();
    }
}

pub struct FallbackSynth {
    sample_rate: f32,
    voices: Box<[Voice; MAX_VOICES]>,
    sustain: [bool; 16],
    volume: f32,
}

impl FallbackSynth {
    pub fn new(sample_rate: u32) -> Self {
        Self {
            sample_rate: sample_rate as f32,
            voices: Box::new([Voice::SILENT; MAX_VOICES]),
            sustain: [false; 16],
            volume: 0.8,
        }
    }

    fn free_slot(&self) -> usize {
        if let Some(i) = self.voices.iter().position(|v| !v.active) {
            return i;
        }
        // Все голоса заняты: забираем самый тихий.
        self.voices
            .iter()
            .enumerate()
            .min_by(|a, b| a.1.env.total_cmp(&b.1.env))
            .map(|(i, _)| i)
            .unwrap_or(0)
    }

    pub fn active_voices(&self) -> usize {
        self.voices.iter().filter(|v| v.active).count()
    }
}

impl Synth for FallbackSynth {
    fn note_on(&mut self, channel: u8, note: u8, velocity: u8) {
        let sr = self.sample_rate;
        // Повторное нажатие той же клавиши: старый звук быстро гасим.
        for v in self.voices.iter_mut() {
            if v.active && v.channel == channel && v.note == note && !v.releasing {
                v.release(sr, STEAL_RELEASE_SEC);
            }
        }

        let slot = self.free_slot();
        let vel = velocity.max(1) as f32 / 127.0;
        let freq = 440.0 * 2f32.powf((note as f32 - 69.0) / 12.0);
        // Низкие ноты звучат дольше: ~4 с у A0, ~0.5 с у C8.
        let pos = ((note as f32 - 21.0) / 87.0).clamp(0.0, 1.0);
        let base_tau = 4.0 * (0.5f32 / 4.0).powf(pos);
        let brightness = 0.35 + 0.5 * vel;
        let nyquist = sr * 0.45;

        let mut voice = Voice::SILENT;
        for k in 0..PARTIALS {
            let n = (k + 1) as f32;
            let f = freq * n * (1.0 + INHARMONICITY * n * n).sqrt();
            if f < nyquist {
                voice.phase_inc[k] = TAU * f / sr;
                voice.amp[k] = brightness.powi(k as i32) / n.powf(1.2);
            }
            let tau = base_tau / (1.0 + 0.6 * k as f32);
            voice.partial_decay[k] = (-1.0 / (tau * sr)).exp();
        }
        let norm: f32 = voice.amp.iter().sum::<f32>().max(1e-6);
        for a in voice.amp.iter_mut() {
            *a /= norm;
        }

        let pan = pos - 0.5; // слева басы, справа верх
        let angle = (pan * 0.6 + 0.5) * std::f32::consts::FRAC_PI_2;
        let gain = 0.35 * vel.powf(1.5);
        voice.gain_l = gain * angle.cos();
        voice.gain_r = gain * angle.sin();

        voice.active = true;
        voice.channel = channel;
        voice.note = note;
        voice.env = 1.0;
        voice.attack_left = (ATTACK_SEC * sr) as u32;
        voice.attack_step = 1.0 / voice.attack_left.max(1) as f32;
        voice.attack_level = 0.0;
        self.voices[slot] = voice;
    }

    fn note_off(&mut self, channel: u8, note: u8) {
        let sr = self.sample_rate;
        let pedal = self.sustain[(channel & 0x0F) as usize];
        for v in self.voices.iter_mut() {
            if v.active && v.channel == channel && v.note == note && !v.releasing {
                if pedal {
                    v.held_by_pedal = true;
                } else {
                    v.release(sr, RELEASE_SEC);
                }
            }
        }
    }

    fn control_change(&mut self, channel: u8, controller: u8, value: u8) {
        if controller != CC_SUSTAIN {
            return;
        }
        let ch = (channel & 0x0F) as usize;
        let down = value >= 64;
        self.sustain[ch] = down;
        if !down {
            let sr = self.sample_rate;
            for v in self.voices.iter_mut() {
                if v.active && v.channel == channel && v.held_by_pedal {
                    v.release(sr, RELEASE_SEC);
                }
            }
        }
    }

    fn all_notes_off(&mut self) {
        let sr = self.sample_rate;
        self.sustain = [false; 16];
        for v in self.voices.iter_mut().filter(|v| v.active) {
            v.release(sr, STEAL_RELEASE_SEC);
        }
    }

    fn render(&mut self, left: &mut [f32], right: &mut [f32]) {
        left.fill(0.0);
        right.fill(0.0);
        for v in self.voices.iter_mut().filter(|v| v.active) {
            for (l, r) in left.iter_mut().zip(right.iter_mut()) {
                let mut s = 0.0;
                for k in 0..PARTIALS {
                    if v.amp[k] == 0.0 {
                        continue;
                    }
                    s += v.amp[k] * v.phase[k].sin();
                    v.phase[k] += v.phase_inc[k];
                    if v.phase[k] >= TAU {
                        v.phase[k] -= TAU;
                    }
                    v.amp[k] *= v.partial_decay[k];
                }
                if v.attack_left > 0 {
                    v.attack_left -= 1;
                    v.attack_level = (v.attack_level + v.attack_step).min(1.0);
                } else {
                    v.attack_level = 1.0;
                }
                if v.releasing {
                    v.env *= v.release_mul;
                }
                let out = s * v.env * v.attack_level;
                *l += out * v.gain_l;
                *r += out * v.gain_r;
            }
            let loudness: f32 = v.amp.iter().sum::<f32>() * v.env;
            if loudness < SILENCE {
                v.active = false;
            }
        }
        for x in left.iter_mut().chain(right.iter_mut()) {
            *x = (*x * self.volume).tanh();
        }
    }

    fn name(&self) -> String {
        "Встроенный простой синтез".into()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn render_frames(s: &mut FallbackSynth, frames: usize) -> (Vec<f32>, Vec<f32>) {
        let mut l = vec![0.0; frames];
        let mut r = vec![0.0; frames];
        s.render(&mut l, &mut r);
        (l, r)
    }

    fn peak(buf: &[f32]) -> f32 {
        buf.iter().fold(0.0f32, |m, x| m.max(x.abs()))
    }

    #[test]
    fn silent_without_notes() {
        let mut s = FallbackSynth::new(48_000);
        let (l, r) = render_frames(&mut s, 256);
        assert_eq!(peak(&l), 0.0);
        assert_eq!(peak(&r), 0.0);
    }

    #[test]
    fn note_sounds_and_stays_in_range() {
        let mut s = FallbackSynth::new(48_000);
        s.note_on(0, 60, 127);
        let (l, r) = render_frames(&mut s, 4800);
        assert!(peak(&l) > 0.01 && peak(&r) > 0.01);
        assert!(peak(&l) <= 1.0 && peak(&r) <= 1.0);
    }

    #[test]
    fn note_off_releases_voice() {
        let mut s = FallbackSynth::new(48_000);
        s.note_on(0, 60, 100);
        render_frames(&mut s, 480);
        s.note_off(0, 60);
        render_frames(&mut s, 48_000);
        assert_eq!(s.active_voices(), 0);
    }

    #[test]
    fn sustain_pedal_holds_note_until_released() {
        let mut s = FallbackSynth::new(48_000);
        s.control_change(0, CC_SUSTAIN, 127);
        s.note_on(0, 72, 100);
        s.note_off(0, 72);
        render_frames(&mut s, 9_600); // 0.2 с: без педали голос бы уже затих
        assert_eq!(s.active_voices(), 1);
        s.control_change(0, CC_SUSTAIN, 0);
        render_frames(&mut s, 48_000);
        assert_eq!(s.active_voices(), 0);
    }

    #[test]
    fn voice_stealing_never_exceeds_limit() {
        let mut s = FallbackSynth::new(48_000);
        for i in 0..200u32 {
            s.note_on(0, 21 + (i % 88) as u8, 90);
        }
        assert!(s.active_voices() <= MAX_VOICES);
        let (l, _) = render_frames(&mut s, 512);
        assert!(peak(&l) <= 1.0);
    }
}
