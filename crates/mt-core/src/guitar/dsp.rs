//! Обработка сигнала гитары и баса: фильтры, понижение частоты дискретизации,
//! определение высоты (метод Маклеода, MPM), поиск начала ноты, звук для
//! прослушивания («чистый» и «перегруз»), запись в WAV.
//!
//! Всё здесь — чистые вычисления без потоков и устройств: проверяется тестами
//! на синтезированных звуках струн.

use std::f32::consts::TAU;

/// Биквадратный фильтр (формулы RBJ), транспонированная прямая форма II.
#[derive(Debug, Clone, Copy)]
pub struct Biquad {
    b0: f32,
    b1: f32,
    b2: f32,
    a1: f32,
    a2: f32,
    z1: f32,
    z2: f32,
}

impl Biquad {
    fn from(b: [f32; 3], a: [f32; 3]) -> Self {
        Self {
            b0: b[0] / a[0],
            b1: b[1] / a[0],
            b2: b[2] / a[0],
            a1: a[1] / a[0],
            a2: a[2] / a[0],
            z1: 0.0,
            z2: 0.0,
        }
    }

    pub fn lowpass(rate: f32, freq: f32, q: f32) -> Self {
        let w = TAU * (freq / rate).min(0.49);
        let (s, c) = w.sin_cos();
        let alpha = s / (2.0 * q);
        Self::from(
            [(1.0 - c) / 2.0, 1.0 - c, (1.0 - c) / 2.0],
            [1.0 + alpha, -2.0 * c, 1.0 - alpha],
        )
    }

    pub fn highpass(rate: f32, freq: f32, q: f32) -> Self {
        let w = TAU * (freq / rate).min(0.49);
        let (s, c) = w.sin_cos();
        let alpha = s / (2.0 * q);
        Self::from(
            [(1.0 + c) / 2.0, -(1.0 + c), (1.0 + c) / 2.0],
            [1.0 + alpha, -2.0 * c, 1.0 - alpha],
        )
    }

    #[inline]
    pub fn process(&mut self, x: f32) -> f32 {
        let y = self.b0 * x + self.z1;
        self.z1 = self.b1 * x - self.a1 * y + self.z2;
        self.z2 = self.b2 * x - self.a2 * y;
        y
    }
}

/// Понижение частоты в `factor` раз: фильтр Баттерворта 4-го порядка, затем каждый N-й сэмпл.
#[derive(Debug, Clone)]
pub struct Decimator {
    factor: usize,
    phase: usize,
    f1: Biquad,
    f2: Biquad,
}

impl Decimator {
    pub fn new(rate: f32, factor: usize) -> Self {
        let cutoff = rate / factor as f32 * 0.4;
        Self {
            factor: factor.max(1),
            phase: 0,
            f1: Biquad::lowpass(rate, cutoff, 0.541),
            f2: Biquad::lowpass(rate, cutoff, 1.307),
        }
    }

    #[inline]
    pub fn push(&mut self, x: f32) -> Option<f32> {
        let y = self.f2.process(self.f1.process(x));
        self.phase += 1;
        if self.phase == self.factor {
            self.phase = 0;
            Some(y)
        } else {
            None
        }
    }
}

/// Окно без постоянной составляющей (она делает NSDF положительной везде).
fn centered(x: &[f32]) -> Vec<f32> {
    let mean = x.iter().sum::<f32>() / x.len().max(1) as f32;
    x.iter().map(|v| v - mean).collect()
}

/// Нормированная разностная функция (NSDF) на одном сдвиге.
fn nsdf_at(x: &[f32], tau: usize) -> f32 {
    if tau == 0 || tau >= x.len() {
        return 0.0;
    }
    let (mut r, mut m) = (0.0f32, 0.0f32);
    for j in 0..x.len() - tau {
        let (a, b) = (x[j], x[j + tau]);
        r += a * b;
        m += a * a + b * b;
    }
    if m > 0.0 {
        2.0 * r / m
    } else {
        0.0
    }
}

/// Уточнение вершины параболой по трём точкам: смещение от центра (−0,5…0,5) и высота.
fn parabola(l: f32, c: f32, r: f32) -> (f32, f32) {
    let d = l - 2.0 * c + r;
    if d.abs() < 1e-12 {
        return (0.0, c);
    }
    let off = (0.5 * (l - r) / d).clamp(-0.5, 0.5);
    (off, c - 0.25 * (l - r) * off)
}

/// Результат определения высоты.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Pitch {
    pub hz: f32,
    /// «Чистота» периодичности 0…1: у ноты струны обычно выше 0,9.
    pub clarity: f32,
}

/// Метод Маклеода (MPM): среди максимумов NSDF берётся первый, который не ниже
/// `K` от самого высокого. Так не путаются октавы вниз (удвоенный период).
pub fn mpm(x: &[f32], rate: f32, fmin: f32, fmax: f32) -> Option<Pitch> {
    const K: f32 = 0.9;
    let min_lag = ((rate / fmax).floor() as usize).max(2);
    let max_lag = ((rate / fmin).ceil() as usize).min(x.len() / 2);
    if max_lag <= min_lag + 2 {
        return None;
    }
    let x = &centered(x);
    let n: Vec<f32> = (0..=max_lag + 1).map(|t| nsdf_at(x, t)).collect();
    // Ключевые максимумы: по одному между переходом через ноль вверх и вниз.
    let mut peaks: Vec<usize> = Vec::new();
    let mut t = 1;
    while t <= max_lag && n[t] > 0.0 {
        t += 1; // пропускаем начальный горб около нуля
    }
    while t <= max_lag {
        while t <= max_lag && n[t] <= 0.0 {
            t += 1;
        }
        let mut best: Option<usize> = None;
        while t <= max_lag && n[t] > 0.0 {
            if best.is_none_or(|b| n[t] > n[b]) {
                best = Some(t);
            }
            t += 1;
        }
        if let Some(b) = best {
            if b >= min_lag {
                peaks.push(b);
            }
        }
    }
    let top = peaks.iter().map(|&p| n[p]).fold(0.0f32, f32::max);
    if top <= 0.0 {
        return None;
    }
    let p = *peaks.iter().find(|&&p| n[p] >= K * top)?;
    let (off, clarity) = parabola(n[p - 1], n[p], n[p + 1]);
    let lag = p as f32 + off;
    Some(Pitch {
        hz: rate / lag,
        clarity: clarity.min(1.0),
    })
}

/// Уточнить частоту по сигналу полной частоты около найденного периода.
pub fn refine(x: &[f32], rate: f32, hz: f32) -> f32 {
    let lag = rate / hz;
    let lo = (lag.floor() as usize).saturating_sub(4).max(2);
    let hi = (lag.ceil() as usize + 4).min(x.len() / 2);
    if hi <= lo + 2 {
        return hz;
    }
    let x = &centered(x);
    let vals: Vec<f32> = (lo..=hi).map(|t| nsdf_at(x, t)).collect();
    let (i, _) = vals
        .iter()
        .enumerate()
        .skip(1)
        .take(vals.len() - 2)
        .max_by(|a, b| a.1.total_cmp(b.1))
        .unwrap();
    let (off, _) = parabola(vals[i - 1], vals[i], vals[i + 1]);
    rate / ((lo + i) as f32 + off)
}

/// MIDI-высота и отклонение в центах от ближайшей ноты.
pub fn hz_to_midi(hz: f32) -> (u8, f32) {
    let m = 69.0 + 12.0 * (hz / 440.0).log2();
    let near = m.round();
    (near.clamp(0.0, 127.0) as u8, (m - near) * 100.0)
}

pub fn midi_to_hz(midi: f32) -> f32 {
    440.0 * 2f32.powf((midi - 69.0) / 12.0)
}

/// Поиск начала ноты по скачку энергии (после фильтра верхних частот, чтобы
/// тянущийся бас не маскировал новый щипок).
///
/// Энергия считается окнами по ~3 мс. «Быстрая» энергия — среднее за 4 окна
/// (~12 мс, сглаживает биения низких нот), фон — плавное среднее (~60 мс),
/// взятое с задержкой в 4 окна. Начало ноты — когда быстрая энергия выше фона в
/// `RATIO` раз; время — первое из последних окон, где энергия заметно выросла.
#[derive(Debug, Clone)]
pub struct OnsetDetector {
    hp: Biquad,
    hop: usize,
    acc: f32,
    count: usize,
    hop_start: u64,
    /// Энергии и начала последних окон.
    recent: [(f32, u64); 4],
    slow: f32,
    slow_hist: [f32; 4],
    last: Option<u64>,
    refractory: u64,
    floor: f32,
}

impl OnsetDetector {
    /// Во сколько раз быстрая энергия должна превысить фон.
    const RATIO: f32 = 2.5;

    pub fn new(rate: f32) -> Self {
        let hop = ((rate * 0.003) as usize).max(32);
        Self {
            hp: Biquad::highpass(rate, 150.0, 0.707),
            hop,
            acc: 0.0,
            count: 0,
            hop_start: 0,
            recent: [(0.0, 0); 4],
            slow: 0.0,
            slow_hist: [0.0; 4],
            last: None,
            refractory: (rate * 0.07) as u64,
            // Порог тишины: среднеквадратичное ~ −54 дБ.
            floor: 4e-6,
        }
    }

    /// Очередной сэмпл с его номером; возвращает номер сэмпла начала ноты.
    pub fn push(&mut self, x: f32, index: u64) -> Option<u64> {
        let y = self.hp.process(x);
        if self.count == 0 {
            self.hop_start = index;
        }
        self.acc += y * y;
        self.count += 1;
        if self.count < self.hop {
            return None;
        }
        let e = self.acc / self.count as f32;
        self.acc = 0.0;
        self.count = 0;
        self.recent.rotate_left(1);
        self.recent[3] = (e, self.hop_start);
        let fast = self.recent.iter().map(|r| r.0).sum::<f32>() / 4.0;
        let base = self.slow_hist[0];
        let fired = fast > self.floor
            && fast > Self::RATIO * base
            && self
                .last
                .is_none_or(|l| self.hop_start >= l + self.refractory);
        self.slow += 0.05 * (e - self.slow);
        self.slow_hist.rotate_left(1);
        self.slow_hist[3] = self.slow;
        if !fired {
            return None;
        }
        let at = self
            .recent
            .iter()
            .find(|r| r.0 > 1.5 * base.max(self.floor))
            .map_or(self.hop_start, |r| r.1);
        // Повтор внутри запрета на повтор — не новая нота.
        if self.last.is_some_and(|l| at < l + self.refractory) {
            return None;
        }
        self.last = Some(at);
        Some(at)
    }
}

/// Звук для прослушивания себя.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ToneKind {
    #[default]
    Clean,
    /// Лёгкий перегруз: мягкое ограничение и «динамик» (срез верхов).
    Drive,
}

#[derive(Debug, Clone)]
pub struct Tone {
    kind: ToneKind,
    hp: Biquad,
    lp1: Biquad,
    lp2: Biquad,
}

impl Tone {
    pub fn new(rate: f32, kind: ToneKind, bass: bool) -> Self {
        match kind {
            ToneKind::Clean => Self {
                kind,
                hp: Biquad::highpass(rate, if bass { 30.0 } else { 70.0 }, 0.707),
                lp1: Biquad::lowpass(rate, if bass { 5000.0 } else { 8000.0 }, 0.707),
                lp2: Biquad::lowpass(rate, 16000.0, 0.707),
            },
            ToneKind::Drive => Self {
                kind,
                hp: Biquad::highpass(rate, if bass { 45.0 } else { 110.0 }, 0.707),
                lp1: Biquad::lowpass(rate, if bass { 2800.0 } else { 4200.0 }, 0.707),
                lp2: Biquad::lowpass(rate, if bass { 3500.0 } else { 5500.0 }, 0.707),
            },
        }
    }

    pub fn kind(&self) -> ToneKind {
        self.kind
    }

    #[inline]
    pub fn process(&mut self, x: f32) -> f32 {
        let y = self.hp.process(x);
        match self.kind {
            ToneKind::Clean => self.lp2.process(self.lp1.process(y)),
            ToneKind::Drive => {
                // Несимметричное мягкое ограничение: чётные гармоники, «ламповый» характер.
                const BIAS: f32 = 0.15;
                let d = (y * 14.0 + BIAS).tanh() - BIAS.tanh();
                self.lp2.process(self.lp1.process(d)) * 0.4
            }
        }
    }
}

/// WAV, 16 бит, моно.
pub fn wav_bytes(samples: &[f32], rate: u32) -> Vec<u8> {
    let data_len = (samples.len() * 2) as u32;
    let mut out = Vec::with_capacity(44 + data_len as usize);
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + data_len).to_le_bytes());
    out.extend_from_slice(b"WAVEfmt ");
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes()); // PCM
    out.extend_from_slice(&1u16.to_le_bytes()); // моно
    out.extend_from_slice(&rate.to_le_bytes());
    out.extend_from_slice(&(rate * 2).to_le_bytes());
    out.extend_from_slice(&2u16.to_le_bytes());
    out.extend_from_slice(&16u16.to_le_bytes());
    out.extend_from_slice(b"data");
    out.extend_from_slice(&data_len.to_le_bytes());
    for &s in samples {
        out.extend_from_slice(&((s.clamp(-1.0, 1.0) * 32767.0) as i16).to_le_bytes());
    }
    out
}

/// Прочитать WAV (16 бит или 32 бит float, любое число каналов — берётся первый).
/// Нужен для тестов на записях.
pub fn read_wav(bytes: &[u8]) -> Option<(Vec<f32>, u32)> {
    if bytes.len() < 12 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return None;
    }
    let u16_at = |i: usize| u16::from_le_bytes([bytes[i], bytes[i + 1]]);
    let u32_at =
        |i: usize| u32::from_le_bytes([bytes[i], bytes[i + 1], bytes[i + 2], bytes[i + 3]]);
    let (mut pos, mut fmt) = (12, None);
    while pos + 8 <= bytes.len() {
        let id = &bytes[pos..pos + 4];
        let len = u32_at(pos + 4) as usize;
        let body = pos + 8;
        if id == b"fmt " && body + 16 <= bytes.len() {
            fmt = Some((
                u16_at(body),
                u16_at(body + 2) as usize,
                u32_at(body + 4),
                u16_at(body + 14),
            ));
        } else if id == b"data" {
            let (format, channels, rate, bits) = fmt?;
            let data = &bytes[body..(body + len).min(bytes.len())];
            let step = channels.max(1) * (bits as usize / 8);
            let samples = data
                .chunks_exact(step)
                .map(|f| match (format, bits) {
                    (1, 16) => i16::from_le_bytes([f[0], f[1]]) as f32 / 32768.0,
                    (1, 24) => {
                        (i32::from_le_bytes([0, f[0], f[1], f[2]]) >> 8) as f32 / 8_388_608.0
                    }
                    (3, 32) => f32::from_le_bytes([f[0], f[1], f[2], f[3]]),
                    _ => 0.0,
                })
                .collect();
            return Some((samples, rate));
        }
        pos = body + len + (len & 1);
    }
    None
}

/// Синтез «щипка» струны (Карплус — Стронг) для тестов и демо.
pub fn pluck(hz: f32, rate: f32, secs: f32, amp: f32, seed: u32) -> Vec<f32> {
    let period = (rate / hz).round().max(2.0) as usize;
    let mut state = seed.wrapping_mul(747_796_405).wrapping_add(2_891_336_453);
    let mut buf: Vec<f32> = (0..period)
        .map(|_| {
            state ^= state << 13;
            state ^= state >> 17;
            state ^= state << 5;
            (state as f32 / u32::MAX as f32) * 2.0 - 1.0
        })
        .collect();
    // Смягчение начального шума — ближе к щипку пальцем.
    for _ in 0..2 {
        let prev = buf.clone();
        for i in 0..period {
            buf[i] = 0.5 * (prev[i] + prev[(i + 1) % period]);
        }
    }
    let n = (secs * rate) as usize;
    let mut out = Vec::with_capacity(n);
    let mut i = 0;
    for _ in 0..n {
        let next = (i + 1) % period;
        let v = buf[i];
        buf[i] = 0.996 * 0.5 * (buf[i] + buf[next]);
        out.push(v * amp);
        i = next;
    }
    out
}

/// Синус (для тестов тюнера).
pub fn sine(hz: f32, rate: f32, secs: f32, amp: f32) -> Vec<f32> {
    (0..(secs * rate) as usize)
        .map(|i| amp * (TAU * hz * i as f32 / rate).sin())
        .collect()
}

/// Полоса частот, которую слушает тюнер.
pub const FMIN: f32 = 35.0;
pub const FMAX: f32 = 1400.0;

#[cfg(test)]
mod tests {
    use super::*;

    const RATE: f32 = 48_000.0;

    /// Полный путь определения: понижение частоты ×4, MPM, уточнение.
    fn detect(sig: &[f32]) -> Option<Pitch> {
        let mut dec = Decimator::new(RATE, 4);
        let low: Vec<f32> = sig.iter().filter_map(|&x| dec.push(x)).collect();
        let window = &low[low.len().saturating_sub(1024)..];
        let p = mpm(window, RATE / 4.0, FMIN, FMAX)?;
        let full = &sig[sig.len().saturating_sub(4096)..];
        Some(Pitch {
            hz: refine(full, RATE, p.hz),
            clarity: p.clarity,
        })
    }

    fn cents(a: f32, b: f32) -> f32 {
        1200.0 * (a / b).log2()
    }

    #[test]
    fn open_strings_of_bass_and_guitar() {
        // Бас E1 A1 D2 G2, гитара E2 A2 D3 G3 B3 E4, и высокий лад гитары.
        for midi in [28u8, 33, 38, 43, 40, 45, 50, 55, 59, 64, 76, 88] {
            let target = midi_to_hz(midi as f32);
            let sig = pluck(target, RATE, 0.25, 0.4, midi as u32);
            // Настоящая высота синтеза: период линии задержки минус полсэмпла усреднения.
            let hz = RATE / ((RATE / target).round() - 0.5);
            let p = detect(&sig).unwrap_or_else(|| panic!("нет высоты для {midi}"));
            assert!(
                cents(p.hz, hz).abs() < 3.0,
                "{midi}: {} Гц вместо {hz}",
                p.hz
            );
            assert!(p.clarity > 0.8, "{midi}: чистота {}", p.clarity);
            assert_eq!(hz_to_midi(p.hz).0, midi);
        }
    }

    #[test]
    fn tuner_precision_on_sines() {
        for hz in [41.2, 55.0, 82.41, 110.0, 146.83, 196.0, 246.94, 329.63] {
            for detune in [-30.0f32, -7.0, 0.0, 4.0, 25.0] {
                let f = hz * 2f32.powf(detune / 1200.0);
                let p = detect(&sine(f, RATE, 0.2, 0.3)).unwrap();
                let (_, c) = hz_to_midi(p.hz);
                let (_, want) = hz_to_midi(f);
                assert!((c - want).abs() < 1.5, "{hz} {detune}: {c} вместо {want}");
            }
        }
    }

    #[test]
    fn weak_fundamental_is_not_an_octave_error() {
        // Бас E1 со слабой основной частотой (как у звукоснимателя у бриджа).
        let f = 41.2;
        let sig: Vec<f32> = (0..(0.25 * RATE) as usize)
            .map(|i| {
                let t = i as f32 / RATE;
                0.05 * (TAU * f * t).sin()
                    + 0.3 * (TAU * 2.0 * f * t).sin()
                    + 0.2 * (TAU * 3.0 * f * t).sin()
            })
            .collect();
        let p = detect(&sig).unwrap();
        assert_eq!(hz_to_midi(p.hz).0, 28, "{} Гц", p.hz);
    }

    #[test]
    fn noise_and_silence_give_no_confident_pitch() {
        let mut s = 1u32;
        let noise: Vec<f32> = (0..12_000)
            .map(|_| {
                s = s.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                (s >> 8) as f32 / (1u32 << 24) as f32 - 0.5
            })
            .collect();
        assert!(detect(&noise).is_none_or(|p| p.clarity < 0.6));
        assert!(detect(&vec![0.0; 12_000]).is_none());
    }

    #[test]
    fn onsets_found_on_time_including_repeated_note() {
        // Четыре щипка каждые 400 мс, два последних — та же нота поверх звучащей.
        // Повторный щипок той же струны глушит прежнее колебание — как на настоящей гитаре.
        let mut sig = vec![0.0f32; (2.0 * RATE) as usize];
        let times = [0.1f32, 0.5, 0.9, 1.3];
        let mut string_a = vec![0.0f32; sig.len()];
        let mut string_e = vec![0.0f32; sig.len()];
        for (k, &t) in times.iter().enumerate() {
            let (hz, string) = if k < 2 {
                (110.0, &mut string_a)
            } else {
                (82.41, &mut string_e)
            };
            let start = (t * RATE) as usize;
            string[start..].fill(0.0);
            for (i, v) in pluck(hz, RATE, 0.9, 0.3, k as u32 + 1)
                .into_iter()
                .enumerate()
            {
                if start + i < string.len() {
                    string[start + i] = v;
                }
            }
        }
        for i in 0..sig.len() {
            sig[i] = string_a[i] + string_e[i];
        }
        let mut det = OnsetDetector::new(RATE);
        let found: Vec<f32> = sig
            .iter()
            .enumerate()
            .filter_map(|(i, &x)| det.push(x, i as u64))
            .map(|i| i as f32 / RATE)
            .collect();
        assert_eq!(found.len(), 4, "{found:?}");
        for (f, t) in found.iter().zip(times) {
            assert!((f - t).abs() < 0.008, "{f} вместо {t}");
        }
    }

    #[test]
    fn no_false_onsets_on_sustain_and_hum() {
        // Долгая нота баса — одно начало; сетевой фон 50 Гц с гармониками — ни одного.
        let bass = pluck(41.2, RATE, 2.5, 0.5, 3);
        let hum: Vec<f32> = (0..(2.0 * RATE) as usize)
            .map(|i| {
                let t = i as f32 / RATE;
                (1..8)
                    .map(|k| 0.004 / k as f32 * (TAU * 50.0 * k as f32 * t).sin())
                    .sum()
            })
            .collect();
        for (sig, want) in [(bass, 1), (hum, 0)] {
            let mut det = OnsetDetector::new(RATE);
            let n = sig
                .iter()
                .enumerate()
                .filter_map(|(i, &x)| det.push(x, i as u64))
                .count();
            assert_eq!(n, want);
        }
    }

    #[test]
    fn tone_is_bounded_and_clean_passes_signal() {
        let sig = pluck(110.0, RATE, 0.5, 0.9, 7);
        for kind in [ToneKind::Clean, ToneKind::Drive] {
            let mut t = Tone::new(RATE, kind, false);
            let out: Vec<f32> = sig.iter().map(|&x| t.process(x)).collect();
            let peak = out.iter().fold(0.0f32, |m, x| m.max(x.abs()));
            assert!(peak < 1.2 && peak > 0.05, "{kind:?}: пик {peak}");
        }
    }

    #[test]
    fn wav_round_trip() {
        let sig = sine(440.0, 8000.0, 0.01, 0.5);
        let (back, rate) = read_wav(&wav_bytes(&sig, 8000)).unwrap();
        assert_eq!(rate, 8000);
        assert_eq!(back.len(), sig.len());
        assert!(back.iter().zip(&sig).all(|(a, b)| (a - b).abs() < 1e-3));
    }
}
