//! Звук → ноты (одноголосие): начало ноты по скачку энергии, высота через
//! 12 мс после атаки по окну, достаточному для самой низкой струны, смена высоты
//! без нового щипка (хаммер-он, слайд) — новая нота, затухание — конец ноты.
//!
//! Подсказка: если известно, какие ноты сейчас ждут (пьеса), ошибка на октаву
//! исправляется в их пользу — у баса основная частота бывает слабой.
//!
//! Работает в номерах сэмплов, время переводит анализатор.

use super::dsp::{self, Decimator, OnsetDetector};
use super::Instrument;
use std::collections::VecDeque;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrackEvent {
    On { pitch: u8, velocity: u8, at: u64 },
    Off { pitch: u8, at: u64 },
}

const DECIMATE: usize = 4;

struct Pending {
    onset: u64,
    eval_at: u64,
    retries: u8,
    peak: f32,
}

struct Sounding {
    pitch: u8,
    velocity: u8,
    peak_rms: f32,
    /// Кандидат на смену высоты: (высота, первый сэмпл, сколько раз подряд).
    change: Option<(u8, u64, u8)>,
}

pub struct NoteTracker {
    instrument: Instrument,
    /// Самая низкая открытая струна (MIDI).
    lowest: u8,
    index: u64,
    onset: OnsetDetector,
    decimator: Decimator,
    low: VecDeque<f32>,
    full: VecDeque<f32>,
    /// Окно высоты в сэмплах полной частоты и пропуск атаки.
    window: usize,
    skip: u64,
    check_every: u64,
    next_check: u64,
    rate: f32,
    pending: Option<Pending>,
    sounding: Option<Sounding>,
    /// Энергия последних сэмплов (для затухания).
    recent_sq: VecDeque<f32>,
    recent_sum: f32,
}

impl NoteTracker {
    pub fn new(rate: f32, instrument: Instrument, lowest: u8) -> Self {
        // Окно ~2,5 периода самой низкой открытой струны.
        let low_hz = dsp::midi_to_hz(lowest as f32);
        let window = ((2.5 * rate / low_hz) as usize).max((rate * 0.03) as usize);
        let window = window.div_ceil(DECIMATE) * DECIMATE;
        Self {
            instrument,
            lowest,
            index: 0,
            onset: OnsetDetector::new(rate),
            decimator: Decimator::new(rate, DECIMATE),
            low: VecDeque::with_capacity(window / DECIMATE + 1),
            full: VecDeque::with_capacity(window + 1),
            window,
            skip: (rate * 0.012) as u64,
            check_every: (rate * 0.02) as u64,
            next_check: 0,
            rate,
            pending: None,
            sounding: None,
            recent_sq: VecDeque::with_capacity((rate * 0.02) as usize + 1),
            recent_sum: 0.0,
        }
    }

    /// Отпустить звучащую ноту (смена режима распознавания).
    pub fn release(&mut self, at: u64, out: &mut Vec<TrackEvent>) {
        self.pending = None;
        if let Some(s) = self.sounding.take() {
            out.push(TrackEvent::Off { pitch: s.pitch, at });
        }
    }

    /// Задержка распознавания высоты после начала ноты, мс.
    pub fn latency_ms(&self) -> f32 {
        (self.skip as f32 + self.window as f32) / self.rate * 1000.0
    }

    pub fn push(&mut self, x: f32, expected: &[u8], out: &mut Vec<TrackEvent>) {
        let i = self.index;
        self.index += 1;
        if self.full.len() == self.window {
            self.full.pop_front();
        }
        self.full.push_back(x);
        if let Some(y) = self.decimator.push(x) {
            if self.low.len() == self.window / DECIMATE {
                self.low.pop_front();
            }
            self.low.push_back(y);
        }
        let sq = x * x;
        self.recent_sq.push_back(sq);
        self.recent_sum += sq;
        if self.recent_sq.len() > self.check_every as usize {
            self.recent_sum -= self.recent_sq.pop_front().unwrap_or(0.0);
        }

        if let Some(at) = self.onset.push(x, i) {
            self.pending = Some(Pending {
                onset: at,
                eval_at: at + self.skip + self.window as u64,
                retries: 0,
                peak: 0.0,
            });
        }
        if let Some(p) = &mut self.pending {
            if i < p.onset + (self.rate * 0.03) as u64 {
                p.peak = p.peak.max(x.abs());
            }
            if i >= p.eval_at {
                self.evaluate(expected, out);
            }
            return;
        }
        if self.sounding.is_some() && i >= self.next_check {
            self.next_check = i + self.check_every;
            self.sustain(i, expected, out);
        }
    }

    /// Высота нового щипка.
    fn evaluate(&mut self, expected: &[u8], out: &mut Vec<TrackEvent>) {
        let Some(p) = self.pending.take() else { return };
        match self.pitch(expected, 0.75) {
            Some(pitch) => {
                if let Some(s) = self.sounding.take() {
                    out.push(TrackEvent::Off {
                        pitch: s.pitch,
                        at: p.onset,
                    });
                }
                let velocity = (20.0 + 107.0 * (p.peak / 0.5).sqrt()).clamp(1.0, 127.0) as u8;
                out.push(TrackEvent::On {
                    pitch,
                    velocity,
                    at: p.onset,
                });
                self.sounding = Some(Sounding {
                    pitch,
                    velocity,
                    peak_rms: 0.0,
                    change: None,
                });
                self.next_check = self.index + self.check_every;
            }
            None if p.retries < 3 => {
                // Атака ещё шумит — попробуем чуть позже.
                self.pending = Some(Pending {
                    eval_at: self.index + (self.rate * 0.01) as u64,
                    retries: p.retries + 1,
                    ..p
                });
            }
            None => {}
        }
    }

    /// Звучащая нота: затухание и смена высоты без нового щипка.
    fn sustain(&mut self, i: u64, expected: &[u8], out: &mut Vec<TrackEvent>) {
        let rms = (self.recent_sum.max(0.0) / self.recent_sq.len().max(1) as f32).sqrt();
        let found = self.pitch(expected, 0.85);
        let Some(s) = &mut self.sounding else { return };
        s.peak_rms = s.peak_rms.max(rms);
        if rms < (s.peak_rms * 0.06).max(0.0015) {
            out.push(TrackEvent::Off {
                pitch: s.pitch,
                at: i,
            });
            self.sounding = None;
            return;
        }
        match found {
            // Октавные скачки на тянущейся ноте — обычно ошибка определения, не новая нота.
            Some(p) if p != s.pitch && (p as i32 - s.pitch as i32).abs() != 12 => {
                let change = match s.change {
                    Some((q, since, n)) if q == p => (q, since, n + 1),
                    _ => (p, i.saturating_sub(self.window as u64 / 2), 1),
                };
                if change.2 >= 2 {
                    out.push(TrackEvent::Off {
                        pitch: s.pitch,
                        at: change.1,
                    });
                    let velocity = (s.velocity as f32 * 0.8) as u8;
                    out.push(TrackEvent::On {
                        pitch: p,
                        velocity: velocity.max(1),
                        at: change.1,
                    });
                    *s = Sounding {
                        pitch: p,
                        velocity,
                        peak_rms: rms,
                        change: None,
                    };
                } else {
                    s.change = Some(change);
                }
            }
            _ => s.change = None,
        }
    }

    /// Высота по последнему окну (MIDI) с поправкой октавы по ожидаемым нотам.
    fn pitch(&self, expected: &[u8], min_clarity: f32) -> Option<u8> {
        if self.low.len() < self.window / DECIMATE {
            return None;
        }
        let low: Vec<f32> = self.low.iter().copied().collect();
        let rms = (low.iter().map(|v| v * v).sum::<f32>() / low.len() as f32).sqrt();
        if rms < 0.001 {
            return None;
        }
        let (fmin, fmax) = self.instrument.range_from(self.lowest);
        let rate = self.rate / DECIMATE as f32;
        let p = dsp::mpm(&low, rate, fmin, fmax)?;
        if p.clarity < min_clarity {
            return None;
        }
        let full: Vec<f32> = self.full.iter().copied().collect();
        let hz = dsp::refine(&full, self.rate, p.hz);
        let (mut midi, _) = dsp::hz_to_midi(hz);
        if !expected.is_empty() && !expected.contains(&midi) {
            for alt in [midi.saturating_sub(12), midi.saturating_add(12)] {
                if expected.contains(&alt) {
                    // Подтверждение: период альтернативы тоже заметен в сигнале.
                    let lag = (rate / dsp::midi_to_hz(alt as f32)).round() as usize;
                    if lag >= 2 && lag < low.len() / 2 && dsp::nsdf(&low, lag) > 0.5 {
                        midi = alt;
                        break;
                    }
                }
            }
        }
        Some(midi)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const RATE: f32 = 48_000.0;

    fn run(sig: &[f32], instrument: Instrument, expected: &[u8]) -> Vec<TrackEvent> {
        let mut t = NoteTracker::new(RATE, instrument, instrument.tuning()[0]);
        let mut out = Vec::new();
        for &x in sig {
            t.push(x, expected, &mut out);
        }
        out
    }

    fn ons(ev: &[TrackEvent]) -> Vec<(u8, f32)> {
        ev.iter()
            .filter_map(|e| match *e {
                TrackEvent::On { pitch, at, .. } => Some((pitch, at as f32 / RATE)),
                _ => None,
            })
            .collect()
    }

    /// Мелодия щипками: (MIDI, начало с, длительность с); повтор струны глушит прежний звук.
    fn melody(notes: &[(u8, f32, f32)], total: f32) -> Vec<f32> {
        let mut sig = vec![0.0f32; (total * RATE) as usize];
        for (k, &(m, t, d)) in notes.iter().enumerate() {
            let start = (t * RATE) as usize;
            let p = dsp::pluck(dsp::midi_to_hz(m as f32), RATE, d, 0.35, k as u32 + 3);
            for (i, v) in p.into_iter().enumerate() {
                if start + i < sig.len() {
                    sig[start + i] = v;
                }
            }
            // Глушим хвост после ноты (как при игре нон легато).
            let end = start + (d * RATE) as usize;
            let next = notes
                .get(k + 1)
                .map_or(sig.len(), |n| (n.1 * RATE) as usize);
            for v in sig.iter_mut().take(next).skip(end) {
                *v = 0.0;
            }
        }
        sig
    }

    #[test]
    fn guitar_melody_recognized_with_exact_times() {
        // «Ода к радости» в первой позиции: ми ми фа соль соль фа ми ре.
        let tune = [64u8, 64, 65, 67, 67, 65, 64, 62];
        let notes: Vec<(u8, f32, f32)> = tune
            .iter()
            .enumerate()
            .map(|(k, &m)| (m, 0.2 + k as f32 * 0.4, 0.35))
            .collect();
        let got = ons(&run(&melody(&notes, 3.6), Instrument::Guitar, &[]));
        assert_eq!(got.iter().map(|g| g.0).collect::<Vec<_>>(), tune);
        for (g, n) in got.iter().zip(&notes) {
            assert!((g.1 - n.1).abs() < 0.008, "{} вместо {}", g.1, n.1);
        }
    }

    #[test]
    fn melody_survives_noise_and_hum() {
        let tune = [64u8, 62, 60, 62, 64, 64, 64, 59];
        let notes: Vec<(u8, f32, f32)> = tune
            .iter()
            .enumerate()
            .map(|(k, &m)| (m, 0.2 + k as f32 * 0.35, 0.3))
            .collect();
        let mut sig = melody(&notes, 3.2);
        let mut seed = 7u32;
        for (i, v) in sig.iter_mut().enumerate() {
            seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            let noise = ((seed >> 8) as f32 / (1u32 << 24) as f32 - 0.5) * 0.01;
            let hum = 0.004 * (std::f32::consts::TAU * 50.0 * i as f32 / RATE).sin();
            *v += noise + hum;
        }
        let got = ons(&run(&sig, Instrument::Guitar, &[]));
        assert_eq!(got.iter().map(|g| g.0).collect::<Vec<_>>(), tune);
    }

    #[test]
    fn bass_line_on_open_and_fretted_notes() {
        let line = [28u8, 33, 35, 36, 38, 43, 40, 28];
        let notes: Vec<(u8, f32, f32)> = line
            .iter()
            .enumerate()
            .map(|(k, &m)| (m, 0.1 + k as f32 * 0.5, 0.45))
            .collect();
        let t = NoteTracker::new(RATE, Instrument::Bass, 28);
        assert!(t.latency_ms() < 170.0, "{}", t.latency_ms());
        let got = ons(&run(&melody(&notes, 4.3), Instrument::Bass, &[]));
        assert_eq!(got.iter().map(|g| g.0).collect::<Vec<_>>(), line);
    }

    #[test]
    fn drop_tunings_reach_below_standard_low_string() {
        // Drop C на гитаре: низкая струна — до (36), ниже стандартной ми (40).
        let line = [36u8, 38, 43, 36];
        let notes: Vec<(u8, f32, f32)> = line
            .iter()
            .enumerate()
            .map(|(k, &m)| (m, 0.1 + k as f32 * 0.5, 0.45))
            .collect();
        let sig = melody(&notes, 2.3);
        let mut t = NoteTracker::new(RATE, Instrument::Guitar, 36);
        let mut ev = Vec::new();
        for &x in &sig {
            t.push(x, &[], &mut ev);
        }
        assert_eq!(ons(&ev).iter().map(|g| g.0).collect::<Vec<_>>(), line);
        let cfg = crate::guitar::GuitarConfig {
            tuning: Some(vec![36, 43, 48, 53, 57, 62]),
            capo: 2,
            ..Default::default()
        };
        assert_eq!(cfg.lowest(), 38);
        assert_eq!(cfg.sounding()[5], 64);
        // Строй не той длины (бас с гитарным строем) — стандартный.
        let bass = crate::guitar::GuitarConfig {
            instrument: Instrument::Bass,
            tuning: Some(vec![36, 43, 48, 53, 57, 62]),
            ..Default::default()
        };
        assert_eq!(bass.sounding(), vec![28, 33, 38, 43]);
    }

    #[test]
    fn legato_change_without_pluck_is_a_new_note() {
        // Хаммер-он: 110 Гц → 123,5 Гц без нового щипка (плавный переход фазы).
        let mut sig = Vec::new();
        let mut phase = 0.0f32;
        for i in 0..(0.9 * RATE) as usize {
            let t = i as f32 / RATE;
            let f = if t < 0.45 { 110.0 } else { 123.47 };
            phase += std::f32::consts::TAU * f / RATE;
            let env = if t < 0.005 {
                t / 0.005
            } else {
                (-(t - 0.005) * 1.5).exp()
            };
            sig.push(0.3 * env * (phase.sin() + 0.4 * (2.0 * phase).sin()));
        }
        let ev = run(&sig, Instrument::Guitar, &[]);
        let got = ons(&ev);
        assert_eq!(
            got.iter().map(|g| g.0).collect::<Vec<_>>(),
            vec![45, 47],
            "{ev:?}"
        );
        assert!((got[1].1 - 0.45).abs() < 0.04, "{}", got[1].1);
    }

    #[test]
    fn release_ends_the_note() {
        let notes = [(57u8, 0.1f32, 0.3f32)];
        let ev = run(&melody(&notes, 1.0), Instrument::Guitar, &[]);
        let off = ev.iter().find_map(|e| match *e {
            TrackEvent::Off { at, .. } => Some(at as f32 / RATE),
            _ => None,
        });
        let off = off.expect("нота не закончилась");
        assert!(off > 0.35 && off < 0.5, "{off}");
    }

    #[test]
    fn expected_notes_fix_octave_of_weak_fundamental() {
        // Бас E1 почти без основной частоты: без подсказки легко услышать E2.
        let f = 41.2;
        let sig: Vec<f32> = (0..(0.6 * RATE) as usize)
            .map(|i| {
                let t = i as f32 / RATE;
                let env = if t < 0.1 {
                    0.0
                } else {
                    (-(t - 0.1) * 2.0).exp()
                };
                env * (0.02 * (std::f32::consts::TAU * f * t).sin()
                    + 0.3 * (std::f32::consts::TAU * 2.0 * f * t).sin()
                    + 0.15 * (std::f32::consts::TAU * 3.0 * f * t).sin())
            })
            .collect();
        let with_hint = ons(&run(&sig, Instrument::Bass, &[28]));
        assert_eq!(with_hint.first().map(|g| g.0), Some(28));
    }

    #[test]
    fn louder_pluck_gives_higher_velocity() {
        let vel = |amp: f32| {
            let mut sig = vec![0.0f32; (0.6 * RATE) as usize];
            for (i, v) in dsp::pluck(110.0, RATE, 0.4, amp, 5).into_iter().enumerate() {
                sig[4800 + i] = v;
            }
            run(&sig, Instrument::Guitar, &[])
                .iter()
                .find_map(|e| match *e {
                    TrackEvent::On { velocity, .. } => Some(velocity),
                    _ => None,
                })
        };
        assert!(vel(0.5).unwrap() > vel(0.1).unwrap());
    }
}
