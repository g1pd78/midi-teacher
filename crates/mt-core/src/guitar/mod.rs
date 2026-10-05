//! Гитара и бас: вход звука, прослушивание себя, тюнер, калибровка задержки.
//!
//! Путь сигнала:
//! - входной поток (в аудиодвижке, см. `audio.rs`) берёт один канал, умножает на
//!   усиление и кладёт сэмплы в две очереди без блокировок: для анализатора и —
//!   если включено прослушивание — через обработку тембра для вывода;
//! - выходной поток подмешивает прослушивание ([`MonitorReader`] подстраивает
//!   частоту, если вход и выход работают на разных частотах или часах);
//! - поток анализатора считает уровень, высоту (тюнер), начала нот (для
//!   калибровки и этапа «звук → ноты») и пишет WAV.

pub mod chord;
pub mod dsp;
pub mod notes;

use crate::clock;
use chord::ChordListener;
use crossbeam_channel::{unbounded, Receiver, RecvTimeoutError, Sender};
use crossbeam_queue::ArrayQueue;
use dsp::{Decimator, OnsetDetector, ToneKind};
use notes::{NoteTracker, TrackEvent};
use parking_lot::{Mutex, RwLock};
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, AtomicU8, AtomicUsize, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

/// Имя входа «каналы ASIO-драйвера вывода»: при ASIO вход и выход — один драйвер.
pub const ASIO_INPUT: &str = "ASIO";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum Instrument {
    #[default]
    Guitar,
    Bass,
}

impl Instrument {
    /// Стандартный строй, от низкой струны к высокой (MIDI).
    pub fn tuning(self) -> &'static [u8] {
        match self {
            Instrument::Bass => &[28, 33, 38, 43],
            Instrument::Guitar => &[40, 45, 50, 55, 59, 64],
        }
    }

    /// Полоса частот для определения высоты.
    pub fn range(self) -> (f32, f32) {
        match self {
            Instrument::Bass => (35.0, 450.0),
            Instrument::Guitar => (70.0, dsp::FMAX),
        }
    }

    /// Полоса частот с учётом самой низкой открытой струны (пониженные строи).
    pub fn range_from(self, lowest: u8) -> (f32, f32) {
        let (fmin, fmax) = self.range();
        (fmin.min(dsp::midi_to_hz(lowest as f32) * 0.85), fmax)
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct GuitarConfig {
    /// Слушать вход.
    pub enabled: bool,
    /// Имя входа: системное устройство, [`ASIO_INPUT`] или `None` — по умолчанию.
    pub device: Option<String>,
    /// Канал входа (с нуля).
    pub channel: u16,
    pub instrument: Instrument,
    /// Усиление входа (0,25…8).
    pub gain: f32,
    /// Слышать себя через приложение.
    pub monitor: bool,
    pub monitor_volume: f32,
    pub tone: ToneKind,
    /// Задержка входа по калибровке, мс: на неё поправляется время нот.
    pub latency_ms: Option<f32>,
    /// Строй: открытые струны от низкой (MIDI); `None` — стандартный.
    pub tuning: Option<Vec<u8>>,
    /// Каподастр на ладу (0 — нет).
    pub capo: u8,
}

impl GuitarConfig {
    /// Открытые струны с учётом каподастра (звучащие ноты).
    pub fn sounding(&self) -> Vec<u8> {
        let base = self.instrument.tuning();
        let t = self
            .tuning
            .as_ref()
            .filter(|t| t.len() == base.len())
            .map(|t| t.as_slice())
            .unwrap_or(base);
        t.iter().map(|&m| m.saturating_add(self.capo)).collect()
    }

    /// Самая низкая звучащая открытая струна.
    pub fn lowest(&self) -> u8 {
        self.sounding().into_iter().min().unwrap_or(40)
    }
}

impl Default for GuitarConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            device: None,
            channel: 0,
            instrument: Instrument::Guitar,
            gain: 1.0,
            monitor: true,
            monitor_volume: 0.8,
            tone: ToneKind::Clean,
            latency_ms: None,
            tuning: None,
            capo: 0,
        }
    }
}

/// Вход, который можно выбрать.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InputInfo {
    pub name: String,
    pub channels: u16,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PitchReading {
    pub hz: f32,
    pub midi: u8,
    /// Отклонение от ближайшей ноты, центы (−50…50).
    pub cents: f32,
    pub clarity: f32,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingState {
    pub elapsed_sec: f32,
    pub total_sec: f32,
    /// Файл сохранён.
    pub path: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GuitarStatus {
    /// Входной поток открыт.
    pub running: bool,
    pub device: String,
    pub sample_rate: u32,
    pub channels: u16,
    /// Размер последнего входного буфера, сэмплов.
    pub buffer_frames: u32,
    pub error: Option<String>,
    /// Уровень (среднеквадратичный) и пик, дБ полной шкалы.
    pub level_db: f32,
    pub peak_db: f32,
    /// Сигнал недавно упирался в предел — убавь усиление.
    pub clipping: bool,
    pub pitch: Option<PitchReading>,
    pub recording: Option<RecordingState>,
    /// Последние распознанные ноты (MIDI), новые в конце.
    pub recent_notes: Vec<u8>,
}

/// Распознанная нота: нажата/отпущена, время по часам приложения (с поправкой на задержку).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct NoteEvent {
    pub on: bool,
    pub pitch: u8,
    pub velocity: u8,
    pub time_us: u64,
    pub instrument: Instrument,
}

/// Отметки времени входа: номер последнего сэмпла и время его получения.
#[derive(Default)]
pub struct Timing {
    end_index: AtomicU64,
    end_us: AtomicU64,
}

impl Timing {
    pub fn mark(&self, end_index: u64, now_us: u64) {
        self.end_index.store(end_index, Ordering::Relaxed);
        self.end_us.store(now_us, Ordering::Relaxed);
    }
}

/// Всё, что входной поток передаёт при открытии.
pub struct InputLink {
    pub analysis: Arc<ArrayQueue<f32>>,
    pub monitor: Arc<ArrayQueue<f32>>,
    pub timing: Arc<Timing>,
    /// Размер входного буфера (для запаса прослушивания).
    pub chunk: Arc<AtomicUsize>,
    pub rate: u32,
}

impl InputLink {
    pub fn new(rate: u32) -> Self {
        let cap = (rate as usize / 2).max(4096); // до 0,5 с
        Self {
            analysis: Arc::new(ArrayQueue::new(cap)),
            monitor: Arc::new(ArrayQueue::new(cap)),
            timing: Arc::new(Timing::default()),
            chunk: Arc::new(AtomicUsize::new(256)),
            rate,
        }
    }
}

enum Msg {
    Input(Option<(Arc<ArrayQueue<f32>>, Arc<Timing>, u32)>),
    Inject(Vec<f32>, u32),
    Record(PathBuf, f32),
    StopRecord,
}

/// Общее состояние гитарного входа: настройки для аудиопотоков (атомики),
/// состояние для интерфейса, начала нот, связь с анализатором.
pub struct GuitarShared {
    config: RwLock<GuitarConfig>,
    status: RwLock<GuitarStatus>,
    inputs: RwLock<Vec<InputInfo>>,
    monitor_on: AtomicBool,
    monitor_volume: AtomicU32,
    gain: AtomicU32,
    tone: AtomicU8,
    bass: AtomicBool,
    frames: AtomicU32,
    onsets: Mutex<VecDeque<u64>>,
    /// Ноты, которые сейчас ждёт пьеса (подсказка для октавы).
    expected: Mutex<Vec<u8>>,
    /// Аккорды, которые сейчас ждут (непусто — режим аккорда: удар → проверка по спектру).
    expected_chords: Mutex<Vec<Vec<u8>>>,
    /// Куда отправлять распознанные ноты.
    note_sink: Mutex<Option<Sender<NoteEvent>>>,
    /// Прослушивание: читает выходной поток.
    pub monitor: Mutex<Option<MonitorReader>>,
    tx: Sender<Msg>,
}

impl GuitarShared {
    /// Создаёт состояние и запускает поток анализатора.
    pub fn start(config: GuitarConfig) -> Arc<Self> {
        let (tx, rx) = unbounded();
        let shared = Arc::new(Self {
            config: RwLock::new(config.clone()),
            status: RwLock::new(GuitarStatus::default()),
            inputs: RwLock::new(Vec::new()),
            monitor_on: AtomicBool::new(false),
            monitor_volume: AtomicU32::new(0),
            gain: AtomicU32::new(0),
            tone: AtomicU8::new(0),
            bass: AtomicBool::new(false),
            frames: AtomicU32::new(0),
            onsets: Mutex::new(VecDeque::new()),
            expected: Mutex::new(Vec::new()),
            expected_chords: Mutex::new(Vec::new()),
            note_sink: Mutex::new(None),
            monitor: Mutex::new(None),
            tx,
        });
        shared.apply_live(&config);
        let weak = Arc::downgrade(&shared);
        thread::Builder::new()
            .name("mt-guitar-analyzer".into())
            .spawn(move || Analyzer::new(weak).run(rx))
            .expect("не удалось запустить анализатор гитары");
        shared
    }

    pub fn config(&self) -> GuitarConfig {
        self.config.read().clone()
    }

    /// Новые настройки. Возвращает `true`, если нужно переоткрыть входной поток.
    pub fn set_config(&self, config: GuitarConfig) -> bool {
        let mut cur = self.config.write();
        let reopen = cur.enabled != config.enabled
            || cur.device != config.device
            || cur.channel != config.channel;
        self.apply_live(&config);
        *cur = config;
        reopen
    }

    fn apply_live(&self, c: &GuitarConfig) {
        self.monitor_on
            .store(c.enabled && c.monitor, Ordering::Relaxed);
        self.monitor_volume.store(
            c.monitor_volume.clamp(0.0, 1.5).to_bits(),
            Ordering::Relaxed,
        );
        self.gain
            .store(c.gain.clamp(0.25, 8.0).to_bits(), Ordering::Relaxed);
        self.tone
            .store(matches!(c.tone, ToneKind::Drive) as u8, Ordering::Relaxed);
        self.bass
            .store(c.instrument == Instrument::Bass, Ordering::Relaxed);
    }

    pub fn status(&self) -> GuitarStatus {
        let mut st = self.status.read().clone();
        st.buffer_frames = self.frames.load(Ordering::Relaxed);
        st
    }

    pub fn inputs(&self) -> Vec<InputInfo> {
        self.inputs.read().clone()
    }

    pub fn set_inputs(&self, inputs: Vec<InputInfo>) {
        *self.inputs.write() = inputs;
    }

    /// Состояние входного потока (из аудиодвижка).
    pub fn set_stream(
        &self,
        running: bool,
        device: String,
        rate: u32,
        channels: u16,
        error: Option<String>,
    ) {
        let mut st = self.status.write();
        st.running = running;
        st.device = device;
        st.sample_rate = rate;
        st.channels = channels;
        st.error = error;
        if !running {
            st.level_db = -120.0;
            st.peak_db = -120.0;
            st.pitch = None;
            st.clipping = false;
        }
    }

    /// Вход открыт или закрыт: анализатору — очередь, выходу — прослушивание.
    pub fn connect(&self, link: Option<&InputLink>) {
        *self.monitor.lock() =
            link.map(|l| MonitorReader::new(l.monitor.clone(), l.rate, l.chunk.clone()));
        let _ = self.tx.send(Msg::Input(
            link.map(|l| (l.analysis.clone(), l.timing.clone(), l.rate)),
        ));
    }

    // --- Для аудиопотоков ---

    /// Размер входного буфера (из входного потока, без блокировок).
    pub fn note_frames(&self, frames: u32) {
        self.frames.store(frames, Ordering::Relaxed);
    }

    pub fn monitor_on(&self) -> bool {
        self.monitor_on.load(Ordering::Relaxed)
    }

    pub fn monitor_volume(&self) -> f32 {
        f32::from_bits(self.monitor_volume.load(Ordering::Relaxed))
    }

    pub fn gain(&self) -> f32 {
        f32::from_bits(self.gain.load(Ordering::Relaxed))
    }

    pub fn tone(&self) -> (ToneKind, bool) {
        let kind = if self.tone.load(Ordering::Relaxed) == 1 {
            ToneKind::Drive
        } else {
            ToneKind::Clean
        };
        (kind, self.bass.load(Ordering::Relaxed))
    }

    // --- Для приложения ---

    /// Начала нот (время по часам приложения, мкс) не раньше `since_us`.
    pub fn onsets_since(&self, since_us: u64) -> Vec<u64> {
        self.onsets
            .lock()
            .iter()
            .copied()
            .filter(|&t| t >= since_us)
            .collect()
    }

    /// Какие ноты сейчас ждёт пьеса (пусто — без подсказки).
    pub fn set_expected(&self, pitches: Vec<u8>) {
        *self.expected.lock() = pitches;
    }

    /// Какие аккорды сейчас ждут (ноты MIDI каждого; пусто — одноголосие).
    pub fn set_expected_chords(&self, chords: Vec<Vec<u8>>) {
        *self.expected_chords.lock() = chords.into_iter().filter(|c| !c.is_empty()).collect();
    }

    /// Получатель распознанных нот (приложение передаёт их как MIDI-устройство).
    pub fn set_note_sink(&self, tx: Sender<NoteEvent>) {
        *self.note_sink.lock() = Some(tx);
    }

    /// Подать сэмплы как со входа (тесты, режим разработчика).
    pub fn inject(&self, samples: Vec<f32>, rate: u32) {
        let _ = self.tx.send(Msg::Inject(samples, rate));
    }

    /// Записать вход в WAV на `secs` секунд.
    pub fn record(&self, path: PathBuf, secs: f32) {
        let _ = self.tx.send(Msg::Record(path, secs));
    }

    pub fn stop_record(&self) {
        let _ = self.tx.send(Msg::StopRecord);
    }
}

/// Прослушивание в выходном потоке: читает очередь входа с линейной
/// интерполяцией и слегка подстраивает скорость по заполнению очереди, чтобы
/// задержка не росла и не было щелчков от опустошения.
pub struct MonitorReader {
    q: Arc<ArrayQueue<f32>>,
    in_rate: f32,
    chunk: Arc<AtomicUsize>,
    a: f32,
    b: f32,
    t: f32,
    primed: bool,
}

impl MonitorReader {
    pub fn new(q: Arc<ArrayQueue<f32>>, in_rate: u32, chunk: Arc<AtomicUsize>) -> Self {
        Self {
            q,
            in_rate: in_rate as f32,
            chunk,
            a: 0.0,
            b: 0.0,
            t: 0.0,
            primed: false,
        }
    }

    /// Запас в очереди: один входной буфер, не меньше 64 сэмплов.
    fn target(&self) -> usize {
        self.chunk.load(Ordering::Relaxed).max(64)
    }

    pub fn fill(&mut self, out_rate: f32, out: &mut [f32]) {
        let target = self.target();
        let fill = self.q.len();
        if !self.primed {
            if fill < target {
                // Плавно гасим последний сэмпл, чтобы не щёлкало.
                for o in out.iter_mut() {
                    self.a *= 0.995;
                    *o = self.a;
                }
                return;
            }
            self.primed = true;
        }
        // Накопилось слишком много (выход отставал) — догоняем, иначе задержка растёт.
        if fill > target * 4 {
            for _ in 0..fill - target {
                self.q.pop();
            }
        }
        let fill = self.q.len() as f32;
        let corr = 1.0 + ((fill - target as f32) / target as f32 * 0.005).clamp(-0.005, 0.005);
        let step = self.in_rate / out_rate * corr;
        for o in out.iter_mut() {
            self.t += step;
            while self.t >= 1.0 {
                self.t -= 1.0;
                self.a = self.b;
                match self.q.pop() {
                    Some(v) => self.b = v,
                    None => {
                        self.primed = false;
                        self.b *= 0.9;
                    }
                }
            }
            *o = self.a + (self.b - self.a) * self.t;
        }
    }
}

/// Итог калибровки задержки.
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Calibration {
    /// Насколько звук со входа запаздывает относительно щелчков, мс.
    pub offset_ms: f32,
    /// Разброс ударов (среднее отклонение от медианы), мс.
    pub spread_ms: f32,
    pub matched: usize,
    pub total: usize,
}

/// Сопоставить щелчки (когда они прозвучали) и найденные начала нот: у каждого
/// щелчка — ближайший удар в пределах ±300 мс. Нужно не меньше половины совпадений.
pub fn calibrate(clicks_us: &[u64], onsets_us: &[u64]) -> Option<Calibration> {
    const WINDOW_US: i64 = 300_000;
    let mut deltas: Vec<f32> = clicks_us
        .iter()
        .filter_map(|&c| {
            onsets_us
                .iter()
                .map(|&o| o as i64 - c as i64)
                .filter(|d| d.abs() <= WINDOW_US)
                .min_by_key(|d| d.abs())
                .map(|d| d as f32 / 1000.0)
        })
        .collect();
    if deltas.len() * 2 < clicks_us.len().max(1) || deltas.len() < 3 {
        return None;
    }
    deltas.sort_by(|a, b| a.total_cmp(b));
    let median = deltas[deltas.len() / 2];
    let spread = deltas.iter().map(|d| (d - median).abs()).sum::<f32>() / deltas.len() as f32;
    Some(Calibration {
        offset_ms: median,
        spread_ms: spread,
        matched: deltas.len(),
        total: clicks_us.len(),
    })
}

// --- Анализатор ---

const LOW_WINDOW: usize = 1024; // ~85 мс после понижения частоты ×4 при 48 кГц
const FULL_WINDOW: usize = 4096;
const DECIMATE: usize = 4;

struct Recording {
    path: PathBuf,
    total: usize,
    samples: Vec<f32>,
    rate: u32,
}

struct Analyzer {
    shared: std::sync::Weak<GuitarShared>,
    input: Option<(Arc<ArrayQueue<f32>>, Arc<Timing>, u32)>,
    rate: u32,
    index: u64,
    decimator: Decimator,
    onset: OnsetDetector,
    low: VecDeque<f32>,
    full: VecDeque<f32>,
    low_since_pitch: usize,
    history: VecDeque<PitchReading>,
    sum_sq: f32,
    peak: f32,
    level_count: usize,
    peak_hold: f32,
    clip_until: u64,
    recording: Option<Recording>,
    buf: Vec<f32>,
    tracker: NoteTracker,
    /// Инструмент и самая низкая струна, под которые настроен распознаватель.
    tracker_for: (Instrument, u8),
    track_events: Vec<TrackEvent>,
    chord: ChordListener,
    /// Был ли режим аккорда на прошлом блоке.
    chord_mode: bool,
}

impl Analyzer {
    fn new(shared: std::sync::Weak<GuitarShared>) -> Self {
        Self {
            shared,
            input: None,
            rate: 0,
            index: 0,
            decimator: Decimator::new(48_000.0, DECIMATE),
            onset: OnsetDetector::new(48_000.0),
            low: VecDeque::with_capacity(LOW_WINDOW),
            full: VecDeque::with_capacity(FULL_WINDOW),
            low_since_pitch: 0,
            history: VecDeque::new(),
            sum_sq: 0.0,
            peak: 0.0,
            level_count: 0,
            peak_hold: 0.0,
            clip_until: 0,
            recording: None,
            buf: Vec::with_capacity(8192),
            tracker: NoteTracker::new(48_000.0, Instrument::Guitar, 40),
            tracker_for: (Instrument::Guitar, 40),
            track_events: Vec::new(),
            chord: ChordListener::new(48_000.0),
            chord_mode: false,
        }
    }

    fn reset(&mut self, rate: u32) {
        self.rate = rate;
        self.index = 0;
        self.decimator = Decimator::new(rate as f32, DECIMATE);
        self.onset = OnsetDetector::new(rate as f32);
        self.low.clear();
        self.full.clear();
        self.low_since_pitch = 0;
        self.history.clear();
        self.tracker = NoteTracker::new(rate as f32, self.tracker_for.0, self.tracker_for.1);
        self.chord = ChordListener::new(rate as f32);
    }

    fn run(mut self, rx: Receiver<Msg>) {
        loop {
            match rx.recv_timeout(Duration::from_millis(5)) {
                Ok(msg) => self.handle(msg),
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => return,
            }
            let Some(shared) = self.shared.upgrade() else {
                return;
            };
            if let Some((q, timing, rate)) = self.input.clone() {
                if rate != self.rate {
                    self.reset(rate);
                }
                self.buf.clear();
                while let Some(v) = q.pop() {
                    self.buf.push(v);
                }
                if !self.buf.is_empty() {
                    let end_index = timing.end_index.load(Ordering::Relaxed);
                    let end_us = timing.end_us.load(Ordering::Relaxed);
                    let samples = std::mem::take(&mut self.buf);
                    self.process(&shared, &samples, end_index, end_us);
                    self.buf = samples;
                }
            }
        }
    }

    fn handle(&mut self, msg: Msg) {
        match msg {
            Msg::Input(input) => {
                self.input = input;
                if let Some((_, _, rate)) = &self.input {
                    self.reset(*rate);
                }
            }
            Msg::Inject(samples, rate) => {
                let Some(shared) = self.shared.upgrade() else {
                    return;
                };
                if rate != self.rate || self.input.is_some() {
                    self.reset(rate);
                }
                let end = self.index + samples.len() as u64;
                self.process(&shared, &samples, end, clock::now_us());
            }
            Msg::Record(path, secs) => {
                let rate = if self.rate > 0 { self.rate } else { 48_000 };
                let total = (secs.clamp(1.0, 120.0) * rate as f32) as usize;
                self.recording = Some(Recording {
                    path,
                    total,
                    samples: Vec::with_capacity(total),
                    rate,
                });
                if let Some(s) = self.shared.upgrade() {
                    s.status.write().recording = Some(RecordingState {
                        elapsed_sec: 0.0,
                        total_sec: secs,
                        path: None,
                        error: None,
                    });
                }
            }
            Msg::StopRecord => {
                if let Some(s) = self.shared.upgrade() {
                    self.finish_recording(&s);
                }
            }
        }
    }

    fn finish_recording(&mut self, shared: &GuitarShared) {
        let Some(rec) = self.recording.take() else {
            return;
        };
        let bytes = dsp::wav_bytes(&rec.samples, rec.rate);
        let result = rec
            .path
            .parent()
            .map_or(Ok(()), std::fs::create_dir_all)
            .and_then(|_| std::fs::write(&rec.path, bytes));
        let secs = rec.samples.len() as f32 / rec.rate as f32;
        shared.status.write().recording = Some(match result {
            Ok(()) => RecordingState {
                elapsed_sec: secs,
                total_sec: secs,
                path: Some(rec.path.display().to_string()),
                error: None,
            },
            Err(e) => RecordingState {
                elapsed_sec: secs,
                total_sec: secs,
                path: None,
                error: Some(format!("не удалось сохранить {}: {e}", rec.path.display())),
            },
        });
    }

    fn process(&mut self, shared: &GuitarShared, samples: &[f32], end_index: u64, end_us: u64) {
        let rate = self.rate.max(1) as f64;
        let time_of = |i: u64| -> u64 {
            let back = end_index.saturating_sub(i) as f64 * 1e6 / rate;
            end_us.saturating_sub(back as u64)
        };
        let (instrument, lowest, latency_ms) = {
            let c = shared.config.read();
            (
                c.instrument,
                c.lowest(),
                c.latency_ms.unwrap_or(0.0).max(0.0),
            )
        };
        if (instrument, lowest) != self.tracker_for {
            self.tracker_for = (instrument, lowest);
            self.tracker = NoteTracker::new(self.rate.max(1) as f32, instrument, lowest);
        }
        let expected = shared.expected.lock().clone();
        let chords = shared.expected_chords.lock().clone();
        let chord_mode = !chords.is_empty();
        let first_index = end_index.saturating_sub(samples.len() as u64);
        if chord_mode != self.chord_mode {
            // Смена режима: отпускаем то, что звучало в прежнем.
            self.chord_mode = chord_mode;
            if chord_mode {
                self.tracker.release(first_index, &mut self.track_events);
            } else {
                self.chord.release(first_index, &mut self.track_events);
            }
        }
        let latency_us = (latency_ms * 1000.0) as u64;
        let mut notes_out: Vec<NoteEvent> = Vec::new();
        let level_block = (self.rate / 20).max(1) as usize; // 50 мс
        let mut new_onsets = Vec::new();
        let mut reading = None;
        let mut level = None;
        let first = end_index.saturating_sub(samples.len() as u64);
        for (k, &x) in samples.iter().enumerate() {
            let i = first + k as u64;
            self.index = i + 1;
            // Уровень.
            self.sum_sq += x * x;
            self.peak = self.peak.max(x.abs());
            if x.abs() >= 0.99 {
                self.clip_until = i + self.rate as u64; // держим 1 с
            }
            self.level_count += 1;
            if self.level_count >= level_block {
                let rms = (self.sum_sq / self.level_count as f32).sqrt();
                self.peak_hold = (self.peak_hold * 0.85).max(self.peak);
                level = Some((db(rms), db(self.peak_hold), i < self.clip_until));
                self.sum_sq = 0.0;
                self.peak = 0.0;
                self.level_count = 0;
            }
            // Начала нот.
            let onset = self.onset.push(x, i);
            if let Some(at) = onset {
                new_onsets.push(time_of(at));
            }
            // Ноты: одноголосие или аккорд по удару.
            if chord_mode {
                self.chord
                    .push(x, i, onset, &chords, &mut self.track_events);
            } else {
                self.tracker.push(x, &expected, &mut self.track_events);
            }
            for ev in self.track_events.drain(..) {
                let (on, pitch, velocity, at) = match ev {
                    TrackEvent::On {
                        pitch,
                        velocity,
                        at,
                    } => (true, pitch, velocity, at),
                    TrackEvent::Off { pitch, at } => (false, pitch, 0, at),
                };
                notes_out.push(NoteEvent {
                    on,
                    pitch,
                    velocity,
                    time_us: time_of(at).saturating_sub(latency_us),
                    instrument,
                });
            }
            // Высота.
            if self.full.len() == FULL_WINDOW {
                self.full.pop_front();
            }
            self.full.push_back(x);
            if let Some(y) = self.decimator.push(x) {
                if self.low.len() == LOW_WINDOW {
                    self.low.pop_front();
                }
                self.low.push_back(y);
                self.low_since_pitch += 1;
                if self.low_since_pitch >= LOW_WINDOW / 4 && self.low.len() == LOW_WINDOW {
                    self.low_since_pitch = 0;
                    reading = Some(self.pitch(instrument, lowest));
                }
            }
            // Запись.
            if let Some(rec) = &mut self.recording {
                if rec.samples.len() < rec.total {
                    rec.samples.push(x);
                }
            }
        }

        if let Some(rec) = &self.recording {
            if rec.samples.len() >= rec.total {
                self.finish_recording(shared);
            } else if let Some(state) = &mut shared.status.write().recording {
                state.elapsed_sec = rec.samples.len() as f32 / rec.rate as f32;
            }
        }
        if !new_onsets.is_empty() {
            let mut q = shared.onsets.lock();
            q.extend(new_onsets);
            while q.len() > 128 {
                q.pop_front();
            }
        }
        if !notes_out.is_empty() {
            if let Some(tx) = shared.note_sink.lock().as_ref() {
                for ev in &notes_out {
                    let _ = tx.send(*ev);
                }
            }
            let mut st = shared.status.write();
            for ev in notes_out.iter().filter(|e| e.on) {
                st.recent_notes.push(ev.pitch);
            }
            let n = st.recent_notes.len();
            if n > 8 {
                st.recent_notes.drain(..n - 8);
            }
        }
        if level.is_some() || reading.is_some() {
            let mut st = shared.status.write();
            if let Some((l, p, clip)) = level {
                st.level_db = l;
                st.peak_db = p;
                st.clipping = clip;
            }
            if let Some(r) = reading {
                st.pitch = r;
            }
        }
    }

    /// Высота по последнему окну; сглаживание — медиана трёх последних
    /// значений одной и той же ноты (тюнеру важна устойчивость стрелки).
    fn pitch(&mut self, instrument: Instrument, lowest: u8) -> Option<PitchReading> {
        let low: Vec<f32> = self.low.iter().copied().collect();
        let rms = (low.iter().map(|x| x * x).sum::<f32>() / low.len() as f32).sqrt();
        if rms < 0.001 {
            self.history.clear();
            return None;
        }
        let (fmin, fmax) = instrument.range_from(lowest);
        let rate = self.rate as f32;
        let p = dsp::mpm(&low, rate / DECIMATE as f32, fmin, fmax)?;
        if p.clarity < 0.85 {
            self.history.clear();
            return None;
        }
        let full: Vec<f32> = self.full.iter().copied().collect();
        let hz = dsp::refine(&full, rate, p.hz);
        let (midi, cents) = dsp::hz_to_midi(hz);
        let r = PitchReading {
            hz,
            midi,
            cents,
            clarity: p.clarity,
        };
        if self.history.back().is_some_and(|h| h.midi != midi) {
            self.history.clear();
        }
        self.history.push_back(r);
        while self.history.len() > 3 {
            self.history.pop_front();
        }
        let mut hs: Vec<f32> = self.history.iter().map(|h| h.hz).collect();
        hs.sort_by(|a, b| a.total_cmp(b));
        let hz = hs[hs.len() / 2];
        let (midi, cents) = dsp::hz_to_midi(hz);
        Some(PitchReading {
            hz,
            midi,
            cents,
            ..r
        })
    }
}

fn db(x: f32) -> f32 {
    if x <= 1e-6 {
        -120.0
    } else {
        20.0 * x.log10()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wait_for<T>(what: &str, mut f: impl FnMut() -> Option<T>) -> T {
        for _ in 0..200 {
            if let Some(v) = f() {
                return v;
            }
            thread::sleep(Duration::from_millis(10));
        }
        panic!("не дождались: {what}");
    }

    #[test]
    fn analyzer_reports_tuner_level_and_onsets_from_injected_signal() {
        let shared = GuitarShared::start(GuitarConfig {
            instrument: Instrument::Bass,
            ..Default::default()
        });
        let t0 = clock::now_us();
        // Бас A1 (55 Гц), немного выше строя: +10 центов.
        let hz = 55.0 * 2f32.powf(10.0 / 1200.0);
        shared.inject(dsp::sine(hz, 48_000.0, 0.5, 0.3), 48_000);
        let r = wait_for("высота", || shared.status().pitch);
        assert_eq!(r.midi, 33);
        assert!((r.cents - 10.0).abs() < 2.0, "{}", r.cents);
        let st = shared.status();
        assert!(st.level_db > -15.0 && st.level_db < -8.0, "{}", st.level_db);
        assert!(!st.clipping);
        let onsets = wait_for("начало ноты", || {
            Some(shared.onsets_since(t0)).filter(|o| !o.is_empty())
        });
        assert_eq!(onsets.len(), 1);
    }

    #[test]
    fn chord_mode_turns_a_strum_into_chord_notes() {
        let shared = GuitarShared::start(GuitarConfig::default());
        let (tx, rx) = unbounded();
        shared.set_note_sink(tx);
        // Ждём ля минор или до мажор; играем до мажор.
        let am = vec![45u8, 52, 57, 60, 64];
        let c = vec![48u8, 52, 55, 60, 64];
        shared.set_expected_chords(vec![am, c.clone()]);
        let mut sig = vec![0.0f32; 4800];
        sig.extend(chord::strum(&c, 48_000.0, 0.5, 12.0));
        sig.extend(vec![0.0f32; 9600]);
        shared.inject(sig, 48_000);
        let mut ons = Vec::new();
        while let Ok(ev) = rx.recv_timeout(Duration::from_millis(500)) {
            if ev.on {
                ons.push(ev.pitch);
            }
        }
        assert_eq!(ons, c);
        // Без ожидаемых аккордов — снова одноголосие.
        shared.set_expected_chords(Vec::new());
        let mut sig = vec![0.0f32; 4800];
        sig.extend(dsp::pluck(dsp::midi_to_hz(57.0), 48_000.0, 0.4, 0.4, 2));
        shared.inject(sig, 48_000);
        let ev = rx
            .recv_timeout(Duration::from_secs(2))
            .expect("нота не распознана");
        assert_eq!((ev.on, ev.pitch), (true, 57));
    }

    #[test]
    fn recognized_notes_go_to_sink_with_latency_correction() {
        let shared = GuitarShared::start(GuitarConfig {
            latency_ms: Some(30.0),
            ..Default::default()
        });
        let (tx, rx) = unbounded();
        shared.set_note_sink(tx);
        let mut sig = vec![0.0f32; 4800];
        sig.extend(dsp::pluck(dsp::midi_to_hz(57.0), 48_000.0, 0.4, 0.4, 2));
        sig.extend(vec![0.0f32; 9600]);
        let before = clock::now_us();
        shared.inject(sig, 48_000);
        let ev = rx
            .recv_timeout(Duration::from_secs(2))
            .expect("нота не распознана");
        assert!(ev.on);
        assert_eq!(ev.pitch, 57);
        // Сигнал «пришёл» целиком в момент подачи: начало ноты ~0,6 с раньше, плюс поправка 30 мс.
        let expect = before.saturating_sub(600_000 + 30_000);
        assert!(
            (ev.time_us as i64 - expect as i64).abs() < 60_000,
            "{} против {}",
            ev.time_us,
            expect
        );
        let st = wait_for("список нот", || {
            Some(shared.status()).filter(|s| !s.recent_notes.is_empty())
        });
        assert_eq!(st.recent_notes, vec![57]);
    }

    #[test]
    fn recording_writes_wav() {
        let shared = GuitarShared::start(GuitarConfig::default());
        let path = std::env::temp_dir().join(format!("mt-guitar-{}.wav", std::process::id()));
        shared.inject(vec![0.0; 10], 48_000); // задаёт частоту
        thread::sleep(Duration::from_millis(30));
        shared.record(path.clone(), 1.0);
        thread::sleep(Duration::from_millis(30));
        shared.inject(dsp::sine(220.0, 48_000.0, 1.2, 0.5), 48_000);
        let st = wait_for("файл записи", || {
            shared.status().recording.filter(|r| r.path.is_some())
        });
        assert!((st.elapsed_sec - 1.0).abs() < 0.01);
        let (samples, rate) = dsp::read_wav(&std::fs::read(&path).unwrap()).unwrap();
        assert_eq!((samples.len(), rate), (48_000, 48_000));
        std::fs::remove_file(path).ok();
    }

    #[test]
    fn monitor_reader_resamples_and_keeps_latency_bounded() {
        let q = Arc::new(ArrayQueue::new(48_000));
        let chunk = Arc::new(AtomicUsize::new(128));
        let mut r = MonitorReader::new(q.clone(), 48_000, chunk);
        let mut out = vec![0.0f32; 441];
        // Пока запаса нет — тишина.
        r.fill(44_100.0, &mut out);
        assert!(out.iter().all(|&x| x == 0.0));
        // Вход 48 кГц, выход 44,1 кГц: за 100 буферов очередь не растёт и не пустеет.
        let tone = dsp::sine(1000.0, 48_000.0, 1.0, 0.5);
        let mut fed = 0;
        for _ in 0..100 {
            for &v in &tone[fed..fed + 480] {
                q.push(v).unwrap();
            }
            fed += 480;
            r.fill(44_100.0, &mut out);
        }
        assert!(q.len() < 1200, "в очереди {}", q.len());
        let peak = out.iter().fold(0.0f32, |m, x| m.max(x.abs()));
        assert!(peak > 0.45, "пик {peak}");
        // Выход отставал и накопилось много — догоняет до запаса.
        for &v in tone.iter().take(20_000) {
            let _ = q.push(v);
        }
        r.fill(44_100.0, &mut out);
        assert!(q.len() < 1000, "в очереди {}", q.len());
    }

    #[test]
    fn calibration_matches_clicks_and_hits() {
        let clicks: Vec<u64> = (0..8).map(|k| 1_000_000 + k * 600_000).collect();
        // Удары на 40 мс позже щелчков (±5 мс), один пропущен, один лишний.
        let mut hits: Vec<u64> = clicks
            .iter()
            .enumerate()
            .filter(|(k, _)| *k != 3)
            .map(|(k, &c)| c + 40_000 + (k as u64 % 3) * 5_000)
            .collect();
        hits.push(2_900_000);
        let c = calibrate(&clicks, &hits).unwrap();
        assert_eq!((c.matched, c.total), (8, 8)); // лишний удар попал в окно пропущенного щелчка
        assert!((c.offset_ms - 45.0).abs() <= 5.0, "{}", c.offset_ms);
        assert!(calibrate(&clicks, &hits[..2]).is_none());
    }
}
