//! Аудиовывод встроенного синтезатора.
//!
//! Поток вывода живёт в отдельном управляющем потоке: там создаётся и
//! пересоздаётся `cpal::Stream` (смена бэкенда, буфера, потеря устройства).
//! Ноты приходят в аудиопоток через lock-free канал и применяются в начале
//! каждого аудиобуфера.
//!
//! Бэкенды: ASIO (Windows, feature `asio`) и системный (WASAPI на Windows).
//! Если ASIO не запустился, движок сам переходит на системный вывод и
//! сообщает об этом в [`AudioStatus::notice`].

use crate::clock;
use crate::guitar::dsp::Tone;
use crate::guitar::{GuitarConfig, GuitarShared, InputInfo, InputLink, ASIO_INPUT};
use crate::midi::MidiMessage;
use crate::synth::{FallbackSynth, SoundFontSynth, Synth};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{
    BufferSize, FromSample, Sample, SampleFormat, SizedSample, StreamConfig, SupportedBufferSize,
};
use crossbeam_channel::{bounded, unbounded, Receiver, Sender};
use parking_lot::{Mutex, RwLock};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::Arc;
use std::thread;

/// Какой звуковой бэкенд использовать.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum AudioBackend {
    /// ASIO, если в системе есть ASIO-драйвер, иначе системный вывод.
    #[default]
    Auto,
    Asio,
    /// Системный вывод: WASAPI на Windows.
    System,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AudioConfig {
    pub backend: AudioBackend,
    /// Имя устройства (для ASIO — имя драйвера). `None` — по умолчанию.
    pub device: Option<String>,
    /// Размер буфера в сэмплах. `None` — как решит драйвер.
    pub buffer_frames: Option<u32>,
    pub volume: f32,
}

impl Default for AudioConfig {
    fn default() -> Self {
        Self {
            backend: AudioBackend::Auto,
            device: None,
            buffer_frames: Some(128),
            volume: 0.8,
        }
    }
}

/// Состояние вывода для экрана диагностики.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioStatus {
    pub running: bool,
    /// Приостановлен, потому что звук приложения сейчас не нужен.
    pub suspended: bool,
    pub backend: String,
    pub device: String,
    pub sample_rate: u32,
    pub channels: u16,
    pub buffer_frames: Option<u32>,
    pub synth: String,
    pub error: Option<String>,
    /// Сообщение для пользователя, например «ASIO недоступен, включён WASAPI».
    pub notice: Option<String>,
    pub asio_supported: bool,
    /// GM-банк для аккомпанемента (барабаны, инструменты MIDI-дорожек), если загружен.
    pub gm: Option<String>,
}

/// Живые показатели, которые обновляет аудиопоток.
#[derive(Debug, Clone, Copy, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioMeters {
    /// Время от вызова аудиобуфера до выхода звука из устройства, мс.
    pub output_latency_ms: f32,
    /// Фактический размер последнего буфера, сэмплов.
    pub last_callback_frames: u32,
    /// Сколько раз звук прерывался (переполнение/опустошение буфера).
    pub xruns: u64,
}

/// Список устройств вывода для настроек.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioDevices {
    pub asio: Vec<String>,
    pub system: Vec<String>,
}

enum SynthEvent {
    Midi {
        channel: u8,
        msg: MidiMessage,
    },
    AllNotesOff,
    Click {
        accent: bool,
    },
    /// Нота/контроллер на GM-синтезаторе; `program` — инструмент канала.
    Gm {
        channel: u8,
        program: Option<u8>,
        msg: MidiMessage,
    },
}

/// Щелчок метронома: короткий затухающий тон, сильная доля выше и громче.
/// Генерируется прямо в аудиопотоке, поверх синтезатора.
struct ClickGen {
    sample_rate: f32,
    remaining: u32,
    phase: f32,
    step: f32,
    amp: f32,
    decay: f32,
}

impl ClickGen {
    const LENGTH_SEC: f32 = 0.045;

    fn new(sample_rate: u32) -> Self {
        Self {
            sample_rate: sample_rate as f32,
            remaining: 0,
            phase: 0.0,
            step: 0.0,
            amp: 0.0,
            decay: 1.0,
        }
    }

    fn trigger(&mut self, accent: bool) {
        let freq = if accent { 1760.0 } else { 1320.0 };
        self.step = std::f32::consts::TAU * freq / self.sample_rate;
        self.phase = 0.0;
        self.amp = if accent { 0.55 } else { 0.35 };
        self.remaining = (Self::LENGTH_SEC * self.sample_rate) as u32;
        self.decay = (-6.0 / (Self::LENGTH_SEC * self.sample_rate)).exp();
    }

    fn next(&mut self) -> f32 {
        if self.remaining == 0 {
            return 0.0;
        }
        self.remaining -= 1;
        let s = self.amp * self.phase.sin();
        self.phase += self.step;
        self.amp *= self.decay;
        s
    }
}

enum Control {
    Apply(AudioConfig),
    LoadSoundFont(PathBuf, Sender<Result<String, String>>),
    UseFallbackSynth,
    Suspend,
    Resume,
    StreamFailed(String),
    RefreshDevices(Sender<AudioDevices>),
    LoadGm(PathBuf, Sender<Result<String, String>>),
    /// Переоткрыть вход гитары (сменились устройство, канал, вкл/выкл).
    GuitarInput,
    InputFailed(String),
}

/// Ручка управления аудиодвижком. Дёшево клонируется.
#[derive(Clone)]
pub struct AudioEngine {
    ctl: Sender<Control>,
    events: Sender<SynthEvent>,
    status: Arc<RwLock<AudioStatus>>,
    meters: Arc<Meters>,
    volume: Arc<AtomicU32>,
    devices: Arc<RwLock<AudioDevices>>,
    guitar: Arc<GuitarShared>,
}

#[derive(Default)]
struct Meters {
    latency_us: AtomicU32,
    frames: AtomicU32,
    xruns: AtomicU64,
}

impl AudioEngine {
    /// Запускает управляющий поток и открывает вывод по конфигурации.
    pub fn start(config: AudioConfig, guitar: GuitarConfig) -> Self {
        let guitar = GuitarShared::start(guitar);
        let (ctl_tx, ctl_rx) = unbounded();
        // Ограниченный канал: при переполнении старые ноты не копятся бесконечно.
        let (ev_tx, ev_rx) = bounded(4096);
        let status = Arc::new(RwLock::new(AudioStatus {
            asio_supported: asio_supported(),
            ..Default::default()
        }));
        let meters = Arc::new(Meters::default());
        let volume = Arc::new(AtomicU32::new(config.volume.to_bits()));
        let devices = Arc::new(RwLock::new(AudioDevices::default()));

        let worker = Worker {
            config,
            ctl_tx: ctl_tx.clone(),
            events: ev_rx,
            status: status.clone(),
            meters: meters.clone(),
            volume: volume.clone(),
            devices: devices.clone(),
            guitar: guitar.clone(),
            gm: Arc::new(Mutex::new(None)),
            gm_font: None,
            out_device: None,
            in_stream: None,
            stream: None,
            synth: Arc::new(Mutex::new(Box::new(FallbackSynth::new(48_000)))),
            soundfont: None,
            sample_rate: 0,
            suspended: false,
        };
        thread::Builder::new()
            .name("mt-audio-control".into())
            .spawn(move || worker.run(ctl_rx))
            .expect("не удалось запустить аудиопоток");

        let engine = Self {
            ctl: ctl_tx,
            events: ev_tx,
            status,
            meters,
            volume,
            devices,
            guitar,
        };
        engine.ctl.send(Control::Resume).ok();
        engine
    }

    /// Сыграть MIDI-сообщение встроенным синтезатором. Вызывается из потока MIDI.
    pub fn send(&self, channel: u8, msg: MidiMessage) {
        let _ = self.events.try_send(SynthEvent::Midi { channel, msg });
    }

    pub fn all_notes_off(&self) {
        let _ = self.events.try_send(SynthEvent::AllNotesOff);
    }

    /// Нота аккомпанемента на GM-синтезаторе (инструмент `program` на канале `channel`).
    pub fn gm_send(&self, channel: u8, program: Option<u8>, msg: MidiMessage) {
        let _ = self.events.try_send(SynthEvent::Gm {
            channel,
            program,
            msg,
        });
    }

    /// Загрузить GM-банк (блокирует до конца загрузки).
    pub fn load_gm(&self, path: PathBuf) -> Result<String, String> {
        let (tx, rx) = bounded(1);
        self.ctl
            .send(Control::LoadGm(path, tx))
            .map_err(|_| "аудиодвижок остановлен".to_string())?;
        rx.recv()
            .map_err(|_| "аудиодвижок остановлен".to_string())?
    }

    /// Щелчок метронома (звучит через встроенный вывод, даже если ноты идут на пианино).
    pub fn click(&self, accent: bool) {
        let _ = self.events.try_send(SynthEvent::Click { accent });
    }

    pub fn apply(&self, config: AudioConfig) {
        self.set_volume(config.volume);
        self.ctl.send(Control::Apply(config)).ok();
    }

    pub fn set_volume(&self, volume: f32) {
        self.volume
            .store(volume.clamp(0.0, 1.5).to_bits(), Ordering::Relaxed);
    }

    /// Загружает SoundFont (блокирует вызывающий поток до конца загрузки).
    pub fn load_soundfont(&self, path: PathBuf) -> Result<String, String> {
        let (tx, rx) = bounded(1);
        self.ctl
            .send(Control::LoadSoundFont(path, tx))
            .map_err(|_| "аудиодвижок остановлен".to_string())?;
        rx.recv()
            .map_err(|_| "аудиодвижок остановлен".to_string())?
    }

    pub fn use_fallback_synth(&self) {
        self.ctl.send(Control::UseFallbackSynth).ok();
    }

    /// Закрыть устройство (освободить эксклюзивный ASIO-драйвер).
    pub fn suspend(&self) {
        self.ctl.send(Control::Suspend).ok();
    }

    pub fn resume(&self) {
        self.ctl.send(Control::Resume).ok();
    }

    /// Последний известный список устройств вывода (без обращения к драйверам).
    pub fn devices(&self) -> AudioDevices {
        self.devices.read().clone()
    }

    /// Обновляет список устройств в аудиопотоке и возвращает его.
    ///
    /// ASIO-драйверы при перечислении загружаются по очереди, а ASIO SDK держит
    /// только один загруженный драйвер. Поэтому перечисление делает только
    /// управляющий поток и только когда ASIO-поток не открыт; иначе список
    /// ASIO-драйверов остаётся прежним.
    pub fn refresh_devices(&self) -> AudioDevices {
        let (tx, rx) = bounded(1);
        if self.ctl.send(Control::RefreshDevices(tx)).is_ok() {
            if let Ok(d) = rx.recv_timeout(std::time::Duration::from_secs(3)) {
                return d;
            }
        }
        self.devices()
    }

    pub fn status(&self) -> AudioStatus {
        self.status.read().clone()
    }

    /// Вход гитары/баса: состояние, тюнер, начала нот.
    pub fn guitar(&self) -> &Arc<GuitarShared> {
        &self.guitar
    }

    /// Новые настройки гитарного входа.
    pub fn set_guitar(&self, config: GuitarConfig) {
        if self.guitar.set_config(config) {
            self.ctl.send(Control::GuitarInput).ok();
        }
    }

    pub fn meters(&self) -> AudioMeters {
        AudioMeters {
            output_latency_ms: self.meters.latency_us.load(Ordering::Relaxed) as f32 / 1000.0,
            last_callback_frames: self.meters.frames.load(Ordering::Relaxed),
            xruns: self.meters.xruns.load(Ordering::Relaxed),
        }
    }
}

/// Поддержан ли ASIO в этой сборке.
pub fn asio_supported() -> bool {
    cfg!(all(target_os = "windows", feature = "asio"))
}

fn output_names(host: &cpal::Host) -> Vec<String> {
    host.output_devices()
        .map(|devs| devs.filter_map(|d| device_name(&d)).collect())
        .unwrap_or_default()
}

fn device_name(device: &cpal::Device) -> Option<String> {
    device.description().ok().map(|d| d.name().to_string())
}

#[cfg(all(target_os = "windows", feature = "asio"))]
fn asio_host() -> Option<cpal::Host> {
    cpal::host_from_id(cpal::HostId::Asio).ok()
}

#[cfg(not(all(target_os = "windows", feature = "asio")))]
fn asio_host() -> Option<cpal::Host> {
    None
}

struct Worker {
    config: AudioConfig,
    ctl_tx: Sender<Control>,
    events: Receiver<SynthEvent>,
    status: Arc<RwLock<AudioStatus>>,
    meters: Arc<Meters>,
    volume: Arc<AtomicU32>,
    devices: Arc<RwLock<AudioDevices>>,
    guitar: Arc<GuitarShared>,
    /// GM-синтезатор аккомпанемента (живой) и загруженный банк (для смены частоты).
    gm: Arc<Mutex<Option<SoundFontSynth>>>,
    gm_font: Option<SoundFontSynth>,
    /// Устройство вывода: при ASIO вход гитары открывается на нём же.
    out_device: Option<cpal::Device>,
    in_stream: Option<cpal::Stream>,
    stream: Option<cpal::Stream>,
    synth: Arc<Mutex<Box<dyn Synth>>>,
    /// Загруженный SoundFont: нужен, чтобы пересоздать синтезатор при смене частоты.
    soundfont: Option<SoundFontSynth>,
    sample_rate: u32,
    suspended: bool,
}

impl Worker {
    fn run(mut self, ctl: Receiver<Control>) {
        while let Ok(cmd) = ctl.recv() {
            match cmd {
                Control::Apply(config) => {
                    self.config = config;
                    if !self.suspended {
                        self.open();
                    }
                }
                Control::Resume => {
                    self.suspended = false;
                    if self.stream.is_none() || self.status.read().error.is_some() {
                        self.open();
                    }
                    self.status.write().suspended = false;
                }
                Control::Suspend => {
                    self.suspended = true;
                    self.close_input();
                    self.stream = None;
                    let mut st = self.status.write();
                    st.running = false;
                    st.suspended = true;
                }
                Control::LoadSoundFont(path, reply) => {
                    let result = self.load_soundfont(path);
                    let _ = reply.send(result);
                }
                Control::UseFallbackSynth => {
                    self.soundfont = None;
                    self.install_synth(Box::new(FallbackSynth::new(self.sample_rate.max(1))));
                }
                Control::LoadGm(path, reply) => {
                    let rate = if self.sample_rate > 0 {
                        self.sample_rate
                    } else {
                        48_000
                    };
                    let result = SoundFontSynth::load(&path, rate)
                        .and_then(|sf| {
                            let live = sf.with_sample_rate(rate)?;
                            Ok((sf, live))
                        })
                        .map(|(sf, live)| {
                            let name = sf.name();
                            self.gm_font = Some(sf);
                            let old = self.gm.lock().replace(live);
                            drop(old);
                            self.status.write().gm = Some(name.clone());
                            name
                        })
                        .map_err(|e| format!("{e:#}"));
                    let _ = reply.send(result);
                }
                Control::RefreshDevices(reply) => {
                    self.refresh_devices();
                    let _ = reply.send(self.devices.read().clone());
                }
                Control::GuitarInput => {
                    if !self.suspended {
                        self.open_input();
                    }
                }
                Control::InputFailed(err) => {
                    log::warn!("вход гитары упал: {err}");
                    self.close_input();
                    self.guitar
                        .set_stream(false, String::new(), 0, 0, Some(err));
                }
                Control::StreamFailed(err) => {
                    log::warn!("аудиопоток упал: {err}");
                    self.stream = None;
                    if !self.suspended {
                        self.open();
                        let mut st = self.status.write();
                        if st.error.is_none() {
                            st.notice = Some(format!("Звук переподключён после ошибки: {err}"));
                        }
                    }
                }
            }
        }
    }

    /// Обновляет кэш устройств. ASIO-драйверы трогаем, только если ASIO-поток закрыт.
    fn refresh_devices(&mut self) {
        let asio_busy = self.stream.is_some() && self.status.read().backend == "ASIO";
        let system = output_names(&cpal::default_host());
        let mut devices = self.devices.write();
        devices.system = system;
        if !asio_busy {
            devices.asio = asio_host().map(|h| output_names(&h)).unwrap_or_default();
        }
        drop(devices);
        self.guitar.set_inputs(self.input_list());
    }

    /// Входы для гитары: системные устройства записи и, при ASIO, входы того же драйвера.
    fn input_list(&self) -> Vec<InputInfo> {
        let mut list = Vec::new();
        let asio = self.status.read().backend == "ASIO";
        if asio {
            if let Some(ch) = self
                .out_device
                .as_ref()
                .and_then(|d| d.default_input_config().ok())
                .map(|c| c.channels())
            {
                list.push(InputInfo {
                    name: ASIO_INPUT.to_string(),
                    channels: ch,
                });
            }
        }
        if let Ok(devs) = cpal::default_host().input_devices() {
            for d in devs {
                let Some(name) = device_name(&d) else {
                    continue;
                };
                let channels = d.default_input_config().map(|c| c.channels()).unwrap_or(1);
                list.push(InputInfo { name, channels });
            }
        }
        list
    }

    fn close_input(&mut self) {
        self.in_stream = None;
        self.guitar.connect(None);
    }

    /// Открыть вход гитары по её настройкам. При ASIO — каналы драйвера вывода
    /// (ASIO держит один драйвер на программу), иначе системное устройство записи.
    fn open_input(&mut self) {
        self.close_input();
        let cfg = self.guitar.config();
        if !cfg.enabled {
            self.guitar.set_stream(false, String::new(), 0, 0, None);
            return;
        }
        let asio = self.status.read().backend == "ASIO";
        let want_asio = cfg.device.as_deref() == Some(ASIO_INPUT);
        let result = if want_asio {
            if !asio {
                Err("вход ASIO доступен, когда вывод звука тоже через ASIO".to_string())
            } else {
                self.out_device
                    .clone()
                    .ok_or_else(|| "устройство ASIO не открыто".to_string())
                    .and_then(|d| {
                        self.start_input(
                            &d,
                            format!("ASIO: {}", self.status.read().device),
                            cfg.channel,
                            true,
                        )
                    })
            }
        } else {
            let host = cpal::default_host();
            cfg.device
                .as_ref()
                .and_then(|want| {
                    host.input_devices()
                        .ok()?
                        .find(|d| device_name(d).as_deref() == Some(want.as_str()))
                })
                .or_else(|| host.default_input_device())
                .ok_or_else(|| {
                    "нет устройств записи — подключи кабель или звуковую карту".to_string()
                })
                .and_then(|d| {
                    let name = device_name(&d).unwrap_or_else(|| "вход".into());
                    self.start_input(&d, name, cfg.channel, false)
                })
        };
        if let Err(e) = result {
            log::warn!("вход гитары: {e}");
            self.guitar.set_stream(false, String::new(), 0, 0, Some(e));
        }
    }

    /// Ошибка драйвера — с понятным пояснением.
    fn input_error(name: &str, err: String) -> String {
        format!(
            "Вход «{name}» не открылся ({err}). Проверь, что кабель или звуковая карта подключены, и нажми «Обновить»."
        )
    }

    fn start_input(
        &mut self,
        device: &cpal::Device,
        name: String,
        channel: u16,
        asio: bool,
    ) -> Result<(), String> {
        let supported = device
            .default_input_config()
            .map_err(|e| Self::input_error(&name, e.to_string()))?;
        let format = supported.sample_format();
        let mut config: StreamConfig = supported.config();
        if config.sample_rate == 0 {
            config.sample_rate = self.sample_rate.max(48_000);
        }
        if asio {
            // Вход и выход ASIO работают с одним буфером и частотой.
            if let Some(frames) = self.status.read().buffer_frames {
                config.buffer_size = BufferSize::Fixed(frames);
            }
            if self.sample_rate > 0 {
                config.sample_rate = self.sample_rate;
            }
        }
        let channel = (channel as usize).min(config.channels.max(1) as usize - 1);
        let link = InputLink::new(config.sample_rate);
        let stream = match format {
            SampleFormat::F32 => self.build_input::<f32>(device, &config, channel, &link),
            SampleFormat::F64 => self.build_input::<f64>(device, &config, channel, &link),
            SampleFormat::I16 => self.build_input::<i16>(device, &config, channel, &link),
            SampleFormat::I24 => self.build_input::<cpal::I24>(device, &config, channel, &link),
            SampleFormat::I32 => self.build_input::<i32>(device, &config, channel, &link),
            SampleFormat::U16 => self.build_input::<u16>(device, &config, channel, &link),
            other => Err(format!("формат {other} не поддерживается")),
        }
        .map_err(|e| Self::input_error(&name, e))?;
        stream
            .play()
            .map_err(|e| Self::input_error(&name, e.to_string()))?;
        self.in_stream = Some(stream);
        self.guitar.connect(Some(&link));
        self.guitar.set_stream(
            true,
            name.clone(),
            config.sample_rate,
            config.channels,
            None,
        );
        log::info!(
            "вход гитары: {name} / {} Гц / канал {}",
            config.sample_rate,
            channel + 1
        );
        Ok(())
    }

    fn build_input<T>(
        &self,
        device: &cpal::Device,
        config: &StreamConfig,
        channel: usize,
        link: &InputLink,
    ) -> Result<cpal::Stream, String>
    where
        T: SizedSample,
        f32: FromSample<T>,
    {
        let channels = config.channels.max(1) as usize;
        let guitar = self.guitar.clone();
        let analysis = link.analysis.clone();
        let monitor = link.monitor.clone();
        let timing = link.timing.clone();
        let chunk = link.chunk.clone();
        let rate = config.sample_rate as f32;
        let (kind, bass) = guitar.tone();
        let mut tone = Tone::new(rate, kind, bass);
        let mut tone_bass = bass;
        let mut pushed: u64 = 0;
        let ctl = self.ctl_tx.clone();

        let data_fn = move |data: &[T], _: &cpal::InputCallbackInfo| {
            let now = clock::now_us();
            let frames = data.len() / channels;
            chunk.store(frames, Ordering::Relaxed);
            guitar.note_frames(frames as u32);
            let gain = guitar.gain();
            let mon = guitar.monitor_on();
            let (k, b) = guitar.tone();
            if k != tone.kind() || b != tone_bass {
                tone = Tone::new(rate, k, b);
                tone_bass = b;
            }
            for frame in data.chunks(channels) {
                let x = f32::from_sample(frame[channel.min(frame.len() - 1)]) * gain;
                if analysis.push(x).is_ok() {
                    pushed += 1;
                }
                if mon {
                    let _ = monitor.push(tone.process(x));
                }
            }
            timing.mark(pushed, now);
        };
        let err_fn = move |err: cpal::Error| match err.kind() {
            cpal::ErrorKind::Xrun | cpal::ErrorKind::RealtimeDenied => {}
            _ => {
                let _ = ctl.send(Control::InputFailed(err.to_string()));
            }
        };
        device
            .build_input_stream(*config, data_fn, err_fn, None)
            .map_err(|e| e.to_string())
    }

    fn load_soundfont(&mut self, path: PathBuf) -> Result<String, String> {
        let rate = if self.sample_rate > 0 {
            self.sample_rate
        } else {
            48_000
        };
        let sf = SoundFontSynth::load(&path, rate).map_err(|e| format!("{e:#}"))?;
        let name = sf.name();
        let live = sf.with_sample_rate(rate).map_err(|e| format!("{e:#}"))?;
        self.soundfont = Some(sf);
        self.install_synth(Box::new(live));
        Ok(name)
    }

    fn install_synth(&mut self, synth: Box<dyn Synth>) {
        let name = synth.name();
        // Старый синтезатор освобождается здесь, а не в аудиопотоке.
        let old = std::mem::replace(&mut *self.synth.lock(), synth);
        drop(old);
        self.status.write().synth = name;
    }

    /// Синтезатор под текущую частоту дискретизации.
    fn synth_for_rate(&self, rate: u32) -> Box<dyn Synth> {
        if let Some(sf) = &self.soundfont {
            match sf.with_sample_rate(rate) {
                Ok(s) => return Box::new(s),
                Err(e) => log::warn!("SoundFont не пересоздан: {e:#}"),
            }
        }
        Box::new(FallbackSynth::new(rate))
    }

    /// Открывает вывод согласно конфигурации, с откатом ASIO → системный.
    fn open(&mut self) {
        // Вход ASIO живёт на устройстве вывода — закрываем его раньше вывода.
        self.close_input();
        self.stream = None;
        self.out_device = None;
        // Поток закрыт — можно безопасно перечислить и ASIO-драйверы.
        self.refresh_devices();
        let want_asio = match self.config.backend {
            AudioBackend::Asio => true,
            AudioBackend::Auto => !self.devices.read().asio.is_empty(),
            AudioBackend::System => false,
        };

        let mut notice = None;
        if want_asio {
            match asio_host().ok_or_else(|| "ASIO не поддерживается этой сборкой".to_string())
            {
                Ok(host) => match self.open_on(&host, "ASIO") {
                    Ok(()) => {
                        self.status.write().notice = None;
                        self.open_input();
                        return;
                    }
                    Err(e) => {
                        notice = Some(format!("ASIO недоступен ({e}). Включён системный вывод."))
                    }
                },
                Err(e) => notice = Some(format!("{e}. Включён системный вывод.")),
            }
        }

        let host = cpal::default_host();
        let label = if cfg!(target_os = "windows") {
            "WASAPI"
        } else {
            host.id().name()
        };
        let result = self.open_on(&host, label);
        {
            let mut st = self.status.write();
            st.notice = notice;
            if let Err(e) = result {
                st.running = false;
                st.error = Some(e);
            }
        }
        self.open_input();
    }

    fn open_on(&mut self, host: &cpal::Host, label: &str) -> Result<(), String> {
        let device = self
            .config
            .device
            .as_ref()
            .and_then(|want| {
                host.output_devices()
                    .ok()?
                    .find(|d| device_name(d).as_deref() == Some(want.as_str()))
            })
            .or_else(|| host.default_output_device())
            .or_else(|| host.output_devices().ok()?.next())
            .ok_or("нет устройств вывода")?;
        let name = device_name(&device).unwrap_or_else(|| "неизвестное устройство".into());

        let supported = device.default_output_config().map_err(|e| e.to_string())?;
        let format = supported.sample_format();
        let mut config: StreamConfig = supported.config();
        // Некоторые ASIO-драйверы (Realtek) сообщают 0 Гц, пока поток не запущен.
        if config.sample_rate == 0 {
            config.sample_rate = 48_000;
        }
        let requested = self
            .config
            .buffer_frames
            .map(|want| match supported.buffer_size() {
                SupportedBufferSize::Range { min, max } => want.clamp(*min, *max),
                SupportedBufferSize::Unknown => want,
            });

        // Сначала пробуем запрошенный размер буфера, затем размер по умолчанию.
        let mut attempts = vec![];
        if let Some(frames) = requested {
            attempts.push(BufferSize::Fixed(frames));
        }
        attempts.push(BufferSize::Default);

        let mut last_err = String::new();
        for buffer in attempts {
            config.buffer_size = buffer;
            // Синтезатор пересоздаётся под частоту устройства.
            if config.sample_rate != self.sample_rate {
                let synth = self.synth_for_rate(config.sample_rate);
                self.sample_rate = config.sample_rate;
                self.install_synth(synth);
                if let Some(gm) = self
                    .gm_font
                    .as_ref()
                    .and_then(|f| f.with_sample_rate(config.sample_rate).ok())
                {
                    let old = self.gm.lock().replace(gm);
                    drop(old);
                }
            }
            match self.build(&device, &config, format) {
                Ok(stream) => {
                    stream.play().map_err(|e| e.to_string())?;
                    self.stream = Some(stream);
                    self.out_device = Some(device.clone());
                    let mut st = self.status.write();
                    st.running = true;
                    st.suspended = false;
                    st.error = None;
                    st.backend = label.to_string();
                    st.device = name;
                    st.sample_rate = config.sample_rate;
                    st.channels = config.channels;
                    st.buffer_frames = match buffer {
                        BufferSize::Fixed(n) => Some(n),
                        BufferSize::Default => None,
                    };
                    log::info!(
                        "аудио: {label} / {} / {} Гц / буфер {:?}",
                        st.device,
                        st.sample_rate,
                        st.buffer_frames
                    );
                    return Ok(());
                }
                Err(e) => {
                    log::warn!("аудио: {label} {name} {buffer:?}: {e}");
                    last_err = e;
                }
            }
        }
        Err(last_err)
    }

    fn build(
        &self,
        device: &cpal::Device,
        config: &StreamConfig,
        format: SampleFormat,
    ) -> Result<cpal::Stream, String> {
        match format {
            SampleFormat::F32 => self.build_typed::<f32>(device, config),
            SampleFormat::F64 => self.build_typed::<f64>(device, config),
            SampleFormat::I16 => self.build_typed::<i16>(device, config),
            SampleFormat::I24 => self.build_typed::<cpal::I24>(device, config),
            SampleFormat::I32 => self.build_typed::<i32>(device, config),
            SampleFormat::U16 => self.build_typed::<u16>(device, config),
            other => Err(format!("формат {other} не поддерживается")),
        }
    }

    fn build_typed<T>(
        &self,
        device: &cpal::Device,
        config: &StreamConfig,
    ) -> Result<cpal::Stream, String>
    where
        T: SizedSample + FromSample<f32>,
    {
        let channels = config.channels as usize;
        let events = self.events.clone();
        let synth = self.synth.clone();
        let meters = self.meters.clone();
        let volume = self.volume.clone();
        let err_meters = self.meters.clone();
        let ctl = self.ctl_tx.clone();
        let guitar = self.guitar.clone();
        let out_rate = config.sample_rate as f32;
        let gm = self.gm.clone();
        let mut gm_programs = [u8::MAX; 16];
        let mut gm_left = vec![0.0f32; 1024];
        let mut gm_right = vec![0.0f32; 1024];

        // Буферы выделяются один раз; большие буферы драйвера обрабатываются частями.
        const CHUNK: usize = 1024;
        let mut left = vec![0.0f32; CHUNK];
        let mut right = vec![0.0f32; CHUNK];
        let mut mon = vec![0.0f32; CHUNK];
        let mut click = ClickGen::new(config.sample_rate);

        let data_fn = move |data: &mut [T], info: &cpal::OutputCallbackInfo| {
            let frames = data.len() / channels.max(1);
            meters.frames.store(frames as u32, Ordering::Relaxed);
            let ts = info.timestamp();
            if let Some(d) = ts.playback.checked_duration_since(ts.callback) {
                meters
                    .latency_us
                    .store(d.as_micros() as u32, Ordering::Relaxed);
            }

            let Some(mut synth) = synth.try_lock() else {
                // Идёт замена синтезатора: один буфер тишины, события подождут.
                data.fill(T::from_sample(0.0));
                return;
            };
            let mut gm_synth = gm.try_lock();
            while let Ok(ev) = events.try_recv() {
                match ev {
                    SynthEvent::Midi { channel, msg } => synth.handle(channel, msg),
                    SynthEvent::AllNotesOff => {
                        synth.all_notes_off();
                        if let Some(g) = gm_synth.as_mut().and_then(|g| g.as_mut()) {
                            g.all_notes_off();
                        }
                    }
                    SynthEvent::Click { accent } => click.trigger(accent),
                    SynthEvent::Gm {
                        channel,
                        program,
                        msg,
                    } => {
                        if let Some(g) = gm_synth.as_mut().and_then(|g| g.as_mut()) {
                            let ch = (channel & 0x0F) as usize;
                            if let Some(p) = program {
                                if gm_programs[ch] != p {
                                    g.program_change(channel, p);
                                    gm_programs[ch] = p;
                                }
                            }
                            g.handle(channel, msg);
                        }
                    }
                }
            }
            let gain = f32::from_bits(volume.load(Ordering::Relaxed));

            for block in data.chunks_mut(CHUNK * channels.max(1)) {
                let n = block.len() / channels.max(1);
                let (l, r) = (&mut left[..n], &mut right[..n]);
                synth.render(l, r);
                // Аккомпанемент GM подмешивается к роялю.
                if let Some(g) = gm_synth.as_mut().and_then(|g| g.as_mut()) {
                    let (gl, gr) = (&mut gm_left[..n], &mut gm_right[..n]);
                    g.render(gl, gr);
                    for i in 0..n {
                        l[i] += gl[i];
                        r[i] += gr[i];
                    }
                }
                // Прослушивание гитары (без блокировок: занято — этот буфер без него).
                let mon_gain = if guitar.monitor_on() {
                    match guitar.monitor.try_lock() {
                        Some(mut slot) => match slot.as_mut() {
                            Some(reader) => {
                                reader.fill(out_rate, &mut mon[..n]);
                                guitar.monitor_volume()
                            }
                            None => 0.0,
                        },
                        None => 0.0,
                    }
                } else {
                    0.0
                };
                for (i, frame) in block.chunks_mut(channels.max(1)).enumerate() {
                    let c = click.next() + mon[i] * mon_gain;
                    let (sl, sr) = (l[i] * gain + c, r[i] * gain + c);
                    match frame.len() {
                        1 => frame[0] = T::from_sample(0.5 * (sl + sr)),
                        _ => {
                            frame[0] = T::from_sample(sl);
                            frame[1] = T::from_sample(sr);
                            for s in &mut frame[2..] {
                                *s = T::from_sample(0.0);
                            }
                        }
                    }
                }
            }
        };

        let err_fn = move |err: cpal::Error| match err.kind() {
            cpal::ErrorKind::Xrun => {
                err_meters.xruns.fetch_add(1, Ordering::Relaxed);
            }
            cpal::ErrorKind::RealtimeDenied => log::warn!("аудио: {err}"),
            _ => {
                let _ = ctl.send(Control::StreamFailed(err.to_string()));
            }
        };

        device
            .build_output_stream(*config, data_fn, err_fn, None)
            .map_err(|e| e.to_string())
    }
}
