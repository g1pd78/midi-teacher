//! Звук → аккорд. После удара по струнам берём окно ~170 мс (с паузой на сам
//! удар: струны звучат не одновременно), спектр (БПФ с окном Ханна) и его пики.
//! Пики сверяются с аккордом, который сейчас ждут:
//! - звук аккорда «слышен», если есть пик на его частоте или на 2-й/4-й гармонике;
//! - пик «лишний», если он сильный и не объясняется ни гармониками звуков аккорда,
//!   ни звуком аккорда в другой октаве (незаглушённая струна, не тот лад).
//!
//! Засчитывается, если слышны все звуки аккорда (по названиям, октава любая) и
//! нет лишних. Тогда наружу уходят все ноты аккорда, иначе — слышные и лишние:
//! дальше их оценивает обычная логика пьесы, как аккорд с клавиатуры.

use super::dsp;
use super::notes::TrackEvent;
use std::collections::VecDeque;

/// Пик спектра: частота и уровень, дБ.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Peak {
    pub hz: f32,
    pub db: f32,
}

/// Итог сверки с аккордом.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct ChordCheck {
    /// Какой из ожидаемых аккордов подошёл лучше всего.
    pub candidate: usize,
    pub present: Vec<u8>,
    pub missing: Vec<u8>,
    /// Лишние звуки (ближайшая нота MIDI).
    pub foreign: Vec<u8>,
    /// Звуки аккорда (классы высоты), которых не слышно ни в какой октаве.
    pub missing_pcs: Vec<u8>,
    pub ok: bool,
}

/// Быстрое преобразование Фурье по основанию 2, на месте.
pub fn fft(re: &mut [f32], im: &mut [f32]) {
    let n = re.len();
    debug_assert!(n.is_power_of_two() && im.len() == n);
    let mut j = 0;
    for i in 1..n {
        let mut bit = n >> 1;
        while j & bit != 0 {
            j ^= bit;
            bit >>= 1;
        }
        j |= bit;
        if i < j {
            re.swap(i, j);
            im.swap(i, j);
        }
    }
    let mut len = 2;
    while len <= n {
        let ang = -std::f32::consts::TAU / len as f32;
        let (wr, wi) = (ang.cos(), ang.sin());
        for start in (0..n).step_by(len) {
            let (mut cr, mut ci) = (1.0f32, 0.0f32);
            for k in 0..len / 2 {
                let (a, b) = (start + k, start + k + len / 2);
                let tr = re[b] * cr - im[b] * ci;
                let ti = re[b] * ci + im[b] * cr;
                re[b] = re[a] - tr;
                im[b] = im[a] - ti;
                re[a] += tr;
                im[a] += ti;
                let nr = cr * wr - ci * wi;
                ci = cr * wi + ci * wr;
                cr = nr;
            }
        }
        len <<= 1;
    }
}

/// Полоса, в которой ищем пики: ниже — гул сети, выше — густые верхние гармоники.
const PEAK_MIN_HZ: f32 = 60.0;
const PEAK_MAX_HZ: f32 = 2000.0;

/// Пики спектра отрезка (окно Ханна, дополнение нулями до степени двойки ×2).
pub fn spectrum_peaks(x: &[f32], rate: f32) -> Vec<Peak> {
    if x.len() < 64 {
        return Vec::new();
    }
    let n = (x.len().next_power_of_two() * 2).max(4096);
    let mut re = vec![0.0f32; n];
    let mut im = vec![0.0f32; n];
    let len = x.len() as f32;
    for (i, &v) in x.iter().enumerate() {
        let w = 0.5 - 0.5 * (std::f32::consts::TAU * i as f32 / (len - 1.0)).cos();
        re[i] = v * w;
    }
    fft(&mut re, &mut im);
    let bin_hz = rate / n as f32;
    let db: Vec<f32> = (0..n / 2)
        .map(|k| 10.0 * (re[k] * re[k] + im[k] * im[k] + 1e-20).log10())
        .collect();
    let lo = ((PEAK_MIN_HZ / bin_hz) as usize).max(2);
    let hi = ((PEAK_MAX_HZ / bin_hz) as usize).min(n / 2 - 2);
    let top = db[lo..hi].iter().copied().fold(f32::MIN, f32::max);
    let mut peaks = Vec::new();
    for k in lo..hi {
        let v = db[k];
        // Локальный максимум в окрестности ±2 бина, не ниже −50 дБ от самого сильного.
        if v < top - 50.0 || v < db[k - 1] || v <= db[k + 1] || v < db[k - 2] || v < db[k + 2] {
            continue;
        }
        // Уточнение частоты параболой по трём бинам.
        let (a, b, c) = (db[k - 1], v, db[k + 1]);
        let d = a - 2.0 * b + c;
        let shift = if d.abs() > 1e-9 {
            0.5 * (a - c) / d
        } else {
            0.0
        };
        peaks.push(Peak {
            hz: (k as f32 + shift.clamp(-0.5, 0.5)) * bin_hz,
            db: b - 0.25 * (a - c) * shift,
        });
    }
    peaks
}

fn cents(a: f32, b: f32) -> f32 {
    1200.0 * (a / b).log2()
}

/// Сверка пиков с аккордом (ноты MIDI, как звучат на грифе).
pub fn check_chord(peaks: &[Peak], chord: &[u8]) -> ChordCheck {
    let mut chord: Vec<u8> = chord.to_vec();
    chord.sort_unstable();
    chord.dedup();
    let top = peaks.iter().map(|p| p.db).fold(f32::MIN, f32::max);
    let pcs: Vec<u8> = {
        let mut v: Vec<u8> = chord.iter().map(|m| m % 12).collect();
        v.sort_unstable();
        v.dedup();
        v
    };
    let near = |hz: f32, f: f32, tol: f32| cents(hz, f).abs() < tol;
    // Пик — обертон (2-й и выше) другого звука аккорда, не октава этого же звука.
    let overtone_of_other = |hz: f32, m: u8| {
        chord.iter().any(|&o| {
            o % 12 != m % 12 && {
                let f = dsp::midi_to_hz(o as f32);
                (2..=8).any(|k| near(hz, f * k as f32, 30.0 + 3.0 * k as f32))
            }
        })
    };
    let mut present = Vec::new();
    let mut missing = Vec::new();
    for &m in &chord {
        let f = dsp::midi_to_hz(m as f32);
        let heard = peaks.iter().any(|p| {
            p.db >= top - 35.0
                && (near(p.hz, f, 40.0)
                    || [2.0, 4.0].iter().any(|k| near(p.hz, f * k, 40.0))
                        && !overtone_of_other(p.hz, m))
        });
        if heard {
            present.push(m);
        } else {
            missing.push(m);
        }
    }
    let mut strange: Vec<(f32, u8)> = Vec::new();
    // Лишние звуки ищем до ~1 кГц (12-й лад первой струны): выше обертоны слишком густые.
    for p in peaks
        .iter()
        .filter(|p| p.db >= top - 18.0 && p.hz >= 70.0 && p.hz <= 1000.0)
    {
        let harmonic = chord.iter().any(|&m| {
            let f = dsp::midi_to_hz(m as f32);
            (1..=12).any(|k| near(p.hz, f * k as f32, 30.0 + 3.0 * k as f32))
        });
        if harmonic {
            continue;
        }
        let (midi, off) = dsp::hz_to_midi(p.hz);
        // Звук аккорда в другой октаве — не ошибка.
        if pcs.contains(&(midi % 12)) && off.abs() < 40.0 {
            continue;
        }
        strange.push((p.hz, midi));
    }
    // Обертоны лишнего звука — не отдельные лишние звуки.
    strange.sort_by(|a, b| a.0.total_cmp(&b.0));
    let mut foreign: Vec<u8> = Vec::new();
    let mut roots: Vec<f32> = Vec::new();
    for (hz, midi) in strange {
        if roots
            .iter()
            .any(|&f| (2..=8).any(|k| near(hz, f * k as f32, 30.0 + 3.0 * k as f32)))
        {
            continue;
        }
        roots.push(hz);
        if !foreign.contains(&midi) {
            foreign.push(midi);
        }
    }
    foreign.sort_unstable();
    let heard_pcs: Vec<u8> = present.iter().map(|m| m % 12).collect();
    let missing_pcs: Vec<u8> = pcs
        .iter()
        .copied()
        .filter(|pc| !heard_pcs.contains(pc))
        .collect();
    let ok = !chord.is_empty() && missing_pcs.is_empty() && foreign.is_empty();
    ChordCheck {
        candidate: 0,
        present,
        missing,
        foreign,
        missing_pcs,
        ok,
    }
}

/// Лучший из ожидаемых аккордов (в ритме ждём текущий и соседние).
pub fn best_chord(peaks: &[Peak], chords: &[Vec<u8>]) -> Option<ChordCheck> {
    chords
        .iter()
        .enumerate()
        .map(|(i, c)| ChordCheck {
            candidate: i,
            ..check_chord(peaks, c)
        })
        .min_by_key(|c| {
            (
                !c.ok as usize,
                c.missing_pcs.len() * 4 + c.foreign.len() * 2 + c.missing.len(),
            )
        })
}

/// Удар по струнам → события нот аккорда (в режиме аккорда вместо одноголосия).
pub struct ChordListener {
    rate: f32,
    ring: VecDeque<f32>,
    /// Номер следующего сэмпла.
    index: u64,
    delay: u64,
    window: u64,
    pending: Option<(u64, f32)>,
    sounding: Vec<u8>,
    /// Последняя проверка: аккорд, что вышло и когда (для частых ударов).
    last: Option<(Vec<u8>, Vec<u8>, u64)>,
    rms_acc: f32,
    rms_count: usize,
    rms_peak: f32,
    pub last_check: Option<ChordCheck>,
}

impl ChordListener {
    pub fn new(rate: f32) -> Self {
        let cap = (rate * 0.3) as usize;
        Self {
            rate,
            ring: VecDeque::with_capacity(cap + 1),
            index: 0,
            delay: (rate * 0.04) as u64,
            window: (rate * 0.17) as u64,
            pending: None,
            sounding: Vec::new(),
            last: None,
            rms_acc: 0.0,
            rms_count: 0,
            rms_peak: 0.0,
            last_check: None,
        }
    }

    /// Задержка проверки после удара, мс.
    pub fn latency_ms(&self) -> f32 {
        (self.delay + self.window) as f32 / self.rate * 1000.0
    }

    /// Очередной сэмпл `i`, начало ноты (если найдено) и ожидаемые аккорды.
    pub fn push(
        &mut self,
        x: f32,
        i: u64,
        onset: Option<u64>,
        chords: &[Vec<u8>],
        out: &mut Vec<TrackEvent>,
    ) {
        self.index = i + 1;
        if self.ring.len() >= (self.rate * 0.3) as usize {
            self.ring.pop_front();
        }
        self.ring.push_back(x);
        if let Some((_, peak)) = &mut self.pending {
            *peak = peak.max(x.abs());
        }
        if let Some(at) = onset {
            // Новый удар раньше конца окна — проверяем то, что успело прозвучать.
            if self.pending.is_some() {
                self.evaluate(chords, out);
            }
            self.pending = Some((at, x.abs()));
            self.rms_peak = 0.0;
        }
        if let Some((at, _)) = self.pending {
            if i + 1 >= at + self.delay + self.window {
                self.evaluate(chords, out);
            }
        }
        // Затухание: конец звучащего аккорда.
        self.rms_acc += x * x;
        self.rms_count += 1;
        if self.rms_count >= (self.rate * 0.02) as usize {
            let rms = (self.rms_acc / self.rms_count as f32).sqrt();
            self.rms_acc = 0.0;
            self.rms_count = 0;
            self.rms_peak = self.rms_peak.max(rms);
            if !self.sounding.is_empty()
                && self.pending.is_none()
                && rms < (self.rms_peak * 0.06).max(0.0015)
            {
                self.release(i, out);
            }
        }
    }

    /// Отпустить звучащие ноты (смена режима, затухание).
    pub fn release(&mut self, at: u64, out: &mut Vec<TrackEvent>) {
        for pitch in self.sounding.drain(..) {
            out.push(TrackEvent::Off { pitch, at });
        }
    }

    fn segment(&self, from: u64, to: u64) -> Vec<f32> {
        let first = self.index - self.ring.len() as u64;
        let a = from.max(first);
        let b = to.min(self.index);
        if b <= a {
            return Vec::new();
        }
        self.ring
            .range((a - first) as usize..(b - first) as usize)
            .copied()
            .collect()
    }

    fn evaluate(&mut self, chords: &[Vec<u8>], out: &mut Vec<TrackEvent>) {
        let Some((at, peak)) = self.pending.take() else {
            return;
        };
        if chords.is_empty() {
            return;
        }
        let end = (at + self.delay + self.window).min(self.index);
        let mut seg = self.segment(at + self.delay, end);
        let short = (seg.len() as f32) < self.rate * 0.07;
        let pitches = if short {
            // Частые удары (шестнадцатые): тот же аккорд, что недавно, — без новой проверки.
            match &self.last {
                Some((c, p, when))
                    if chords.contains(c)
                        && at.saturating_sub(*when) < (self.rate * 2.0) as u64 =>
                {
                    Some(p.clone())
                }
                _ => {
                    seg = self.segment(at, end);
                    None
                }
            }
        } else {
            None
        };
        let pitches = match pitches {
            Some(p) => p,
            None => {
                let peaks = spectrum_peaks(&seg, self.rate);
                let Some(check) = best_chord(&peaks, chords) else {
                    return;
                };
                let chord = chords[check.candidate].clone();
                let mut p = if check.ok {
                    chord.clone()
                } else {
                    let mut v = check.present.clone();
                    v.extend(&check.foreign);
                    v
                };
                p.sort_unstable();
                p.dedup();
                self.last = Some((chord, p.clone(), at));
                self.last_check = Some(check);
                p
            }
        };
        self.release(at, out);
        let velocity = (20.0 + 107.0 * (peak / 0.6).sqrt()).clamp(1.0, 127.0) as u8;
        for &pitch in &pitches {
            out.push(TrackEvent::On {
                pitch,
                velocity,
                at,
            });
        }
        self.sounding = pitches;
    }
}

/// Удар по струнам для тестов и тестового сигнала: щипки с разбросом `strum_ms`.
pub fn strum(pitches: &[u8], rate: f32, secs: f32, strum_ms: f32) -> Vec<f32> {
    let mut out = vec![0.0f32; (secs * rate) as usize];
    let amp = 0.5 / (pitches.len().max(1) as f32).sqrt();
    for (k, &m) in pitches.iter().enumerate() {
        let start = (k as f32 * strum_ms * rate / 1000.0) as usize;
        let p = dsp::pluck(
            dsp::midi_to_hz(m as f32),
            rate,
            secs,
            amp,
            k as u32 * 7 + 11,
        );
        for (i, v) in p.into_iter().enumerate() {
            if let Some(o) = out.get_mut(start + i) {
                // Затухание как у настоящей струны (~−7 дБ за 0,2 с).
                *o += v * (-4.0 * i as f32 / rate).exp();
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const RATE: f32 = 48_000.0;
    // Открытые аккорды (ноты MIDI от 6-й струны к 1-й, без заглушённых).
    const C: [u8; 5] = [48, 52, 55, 60, 64]; // x32010
    const G: [u8; 6] = [43, 47, 50, 55, 59, 67]; // 320003
    const D: [u8; 4] = [50, 57, 62, 66]; // xx0232
    const AM: [u8; 5] = [45, 52, 57, 60, 64]; // x02210
    const E: [u8; 6] = [40, 47, 52, 56, 59, 64]; // 022100

    fn check(played: &[u8], expected: &[u8]) -> ChordCheck {
        let sig = strum(played, RATE, 0.3, 12.0);
        let seg = &sig[(0.04 * RATE) as usize + 6 * 600..(0.21 * RATE) as usize + 6 * 600];
        check_chord(&spectrum_peaks(seg, RATE), expected)
    }

    #[test]
    fn fft_finds_a_sine() {
        let x = dsp::sine(440.0, RATE, 0.17, 0.5);
        let peaks = spectrum_peaks(&x, RATE);
        let top = peaks.iter().max_by(|a, b| a.db.total_cmp(&b.db)).unwrap();
        assert!((top.hz - 440.0).abs() < 1.5, "{}", top.hz);
    }

    #[test]
    fn clean_open_chords_pass() {
        for (name, ch) in [
            ("C", &C[..]),
            ("G", &G[..]),
            ("D", &D[..]),
            ("Am", &AM[..]),
            ("E", &E[..]),
        ] {
            let r = check(ch, ch);
            assert!(r.ok, "{name}: {r:?}");
        }
    }

    #[test]
    fn unmuted_low_string_is_foreign() {
        // Ре мажор, а открытая 6-я (ми) не заглушена.
        let mut played = vec![40u8];
        played.extend(D);
        let r = check(&played, &D);
        assert!(!r.ok, "{r:?}");
        assert!(r.foreign.iter().any(|m| m % 12 == 4), "{r:?}");
    }

    #[test]
    fn wrong_fret_is_foreign() {
        // До мажор, на 2-й струне до-диез вместо до (2-й лад вместо 1-го).
        let r = check(&[48, 52, 55, 61, 64], &C);
        assert!(!r.ok, "{r:?}");
        assert!(r.foreign.contains(&61), "{r:?}");
    }

    #[test]
    fn missing_chord_tone_is_reported() {
        // До мажор без 3-й струны (соль) — соли нет ни в какой октаве.
        let r = check(&[48, 52, 60, 64], &C);
        assert!(!r.ok, "{r:?}");
        assert_eq!(r.missing_pcs, vec![7]);
        assert!(r.missing.contains(&55));
    }

    #[test]
    fn minor_instead_of_major_is_caught() {
        // Ждали ми мажор, сыграли ми минор (соль вместо соль-диеза).
        let r = check(&[40, 47, 52, 55, 59, 64], &E);
        assert!(!r.ok, "{r:?}");
        assert!(
            r.foreign.contains(&55) || r.missing_pcs.contains(&8),
            "{r:?}"
        );
    }

    #[test]
    fn best_of_candidates() {
        let sig = strum(&G, RATE, 0.3, 12.0);
        let seg = &sig[(0.1 * RATE) as usize..(0.27 * RATE) as usize];
        let r = best_chord(
            &spectrum_peaks(seg, RATE),
            &[C.to_vec(), G.to_vec(), D.to_vec()],
        )
        .unwrap();
        assert_eq!(r.candidate, 1);
        assert!(r.ok);
    }

    fn listen(sig: &[f32], chords: &[Vec<u8>]) -> Vec<TrackEvent> {
        let mut l = ChordListener::new(RATE);
        let mut onset = dsp::OnsetDetector::new(RATE);
        let mut out = Vec::new();
        for (i, &x) in sig.iter().enumerate() {
            let o = onset.push(x, i as u64);
            l.push(x, i as u64, o, chords, &mut out);
        }
        out
    }

    #[test]
    fn listener_emits_whole_chord_at_strum_time() {
        let mut sig = vec![0.0f32; (0.1 * RATE) as usize];
        sig.extend(strum(&AM, RATE, 0.6, 15.0));
        // Аккорд заглушён ладонью.
        sig.extend(vec![0.0f32; (0.2 * RATE) as usize]);
        let ev = listen(&sig, &[AM.to_vec()]);
        let ons: Vec<(u8, f32)> = ev
            .iter()
            .filter_map(|e| match *e {
                TrackEvent::On { pitch, at, .. } => Some((pitch, at as f32 / RATE)),
                _ => None,
            })
            .collect();
        assert_eq!(
            ons.iter().map(|o| o.0).collect::<Vec<_>>(),
            AM.to_vec(),
            "{ev:?}"
        );
        assert!(ons.iter().all(|o| (o.1 - 0.1).abs() < 0.01), "{ons:?}");
        // Затухание — ноты отпущены.
        assert!(ev.iter().any(|e| matches!(e, TrackEvent::Off { .. })));
    }

    #[test]
    fn listener_reports_wrong_notes() {
        let mut sig = vec![0.0f32; (0.1 * RATE) as usize];
        sig.extend(strum(&[48, 52, 55, 61, 64], RATE, 0.5, 12.0));
        let ev = listen(&sig, &[C.to_vec()]);
        let ons: Vec<u8> = ev
            .iter()
            .filter_map(|e| match *e {
                TrackEvent::On { pitch, .. } => Some(pitch),
                _ => None,
            })
            .collect();
        assert!(ons.contains(&61), "{ons:?}");
        assert!(
            !ons.iter().any(|m| *m > 80),
            "обертон лишнего звука — не отдельная нота: {ons:?}"
        );
    }

    #[test]
    fn fast_strums_reuse_last_check() {
        // Шестнадцатые при 140 уд/мин: удары через 107 мс — окно проверки не успевает,
        // повторные удары того же аккорда берут прошлый итог. Начала ударов заданы явно.
        let times = [0.1f32, 0.314, 0.421, 0.528, 0.635];
        let mut sig = vec![0.0f32; (1.0 * RATE) as usize];
        for (k, t) in times.iter().enumerate() {
            let s = strum(if k % 2 == 0 { &G } else { &G[2..] }, RATE, 0.4, 8.0);
            let start = (t * RATE) as usize;
            for v in sig.iter_mut().skip(start) {
                *v *= 0.15;
            }
            for (i, v) in s.into_iter().enumerate() {
                if let Some(o) = sig.get_mut(start + i) {
                    *o += v;
                }
            }
        }
        let onsets: Vec<u64> = times.iter().map(|t| (t * RATE) as u64).collect();
        let mut l = ChordListener::new(RATE);
        let mut ev = Vec::new();
        for (i, &x) in sig.iter().enumerate() {
            let o = onsets.contains(&(i as u64)).then_some(i as u64);
            l.push(x, i as u64, o, &[G.to_vec()], &mut ev);
        }
        let strums: Vec<(u64, usize)> = onsets
            .iter()
            .map(|&at| {
                (
                    at,
                    ev.iter()
                        .filter(|e| matches!(e, TrackEvent::On { at: a, .. } if *a == at))
                        .count(),
                )
            })
            .collect();
        assert!(strums.iter().all(|s| s.1 == G.len()), "{strums:?}");
    }
}
