//! MIDI-устройства: автоподключение, горячее переподключение, маршруты звука.
//!
//! Все входы подключаются одновременно, чтобы можно было играть на любом
//! инструменте без настройки. Для каждого входа задаётся, откуда брать звук:
//! встроенный синтезатор, «звучит само» (цифровое пианино) или пересылка на
//! MIDI-выход (MIDI-клавиатура звучит через цифровое пианино).

use crate::audio::AudioEngine;
use crate::clock;
use crate::midi::{self, MidiMessage};
use crossbeam_channel::Sender;
use midir::{Ignore, MidiInput, MidiInputConnection, MidiOutput, MidiOutputConnection};
use parking_lot::{Mutex, RwLock};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, Weak};
use std::thread;
use std::time::{Duration, Instant};

const CLIENT_NAME: &str = "MIDI Teacher";
/// Имя USB-MIDI устройства подсветки клавиш (прошивка в `hardware/key-lights`).
pub const LIGHTS_NAME: &str = "MIDI Teacher Lights";
/// Кадр подсветки — SysEx `F0 7D 4D 54 10 <яркость 0–127> (<клавиша> <цвет>)… F7`: полный список горящих
/// клавиш. Одни и те же байты годятся для USB-MIDI и (потом) для радио: потерянный кадр исправит следующий.
const LIGHTS_FRAME: [u8; 5] = [0xF0, 0x7D, 0x4D, 0x54, 0x10];

/// Статус радио от платы: `F0 7D 4D 54 20 <версия> <связь> <связка> <−дБм> <потери %> F7`
/// (прошивка — `radio_core.h`). Плата шлёт его раз в секунду; старше этого — статуса нет.
const LIGHTS_STATUS: [u8; 5] = [0xF0, 0x7D, 0x4D, 0x54, 0x20];
const LIGHTS_STATUS_TTL: Duration = Duration::from_secs(3);
/// Запросить статус у платы (SysEx `05`).
const LIGHTS_STATUS_REQUEST: [u8; 6] = [0xF0, 0x7D, 0x4D, 0x54, 0x05, 0xF7];

/// Как лента связана с компьютером.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum LightsLinkState {
    /// Ленты по радио нет: лента на этой же плате, по проводу.
    Wired,
    /// Лента по радио на связи.
    Online,
    /// Лента связана, но не отвечает.
    Lost,
}

/// Связка свистка с лентой.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum LightsPairing {
    Idle,
    Searching,
    Done,
    NotFound,
}

/// Статус радио платы подсветки.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LightsLink {
    pub link: LightsLinkState,
    pub pairing: LightsPairing,
    /// Сила сигнала, дБм; `None` — неизвестно.
    pub rssi: Option<i16>,
    /// Потери кадров за 10 секунд, %.
    pub loss: u8,
}

/// Разбор статуса радио от платы; `None` — это не статус.
pub fn parse_lights_status(bytes: &[u8]) -> Option<LightsLink> {
    if bytes.len() < 11 || bytes[..5] != LIGHTS_STATUS || bytes[bytes.len() - 1] != 0xF7 {
        return None;
    }
    let link = match bytes[6] {
        0 => LightsLinkState::Wired,
        1 => LightsLinkState::Online,
        2 => LightsLinkState::Lost,
        _ => return None,
    };
    let pairing = match bytes[7] {
        1 => LightsPairing::Searching,
        2 => LightsPairing::Done,
        3 => LightsPairing::NotFound,
        _ => LightsPairing::Idle,
    };
    Some(LightsLink {
        link,
        pairing,
        rssi: (bytes[8] > 0).then(|| -i16::from(bytes[8])),
        loss: bytes[9].min(100),
    })
}

/// Порт — плата подсветки, а не инструмент.
pub fn is_lights_port(name: &str) -> bool {
    name.contains(LIGHTS_NAME)
}
const SCAN_INTERVAL: Duration = Duration::from_millis(1000);

/// Откуда берётся звук.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SoundRoute {
    /// Встроенный синтезатор приложения.
    #[default]
    Internal,
    /// Инструмент звучит сам, приложение только слушает.
    Silent,
    /// Переслать на MIDI-выход (например, на цифровое пианино).
    Output { port: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct InputSettings {
    pub enabled: bool,
    pub route: SoundRoute,
    /// Диапазон клавиатуры (самая низкая и самая высокая нота), из калибровки.
    pub range: Option<(u8, u8)>,
}

impl Default for InputSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            route: SoundRoute::Internal,
            range: None,
        }
    }
}

/// Пэд MIDI-клавиатуры, назначенный барабаном: удар по нему звучит барабаном установки GM
/// и приходит в приложение нотой GM-ударных `drum` (36 — бочка, 38 — малый…) от устройства «Пэды».
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PadBinding {
    pub device: String,
    pub channel: u8,
    pub note: u8,
    pub drum: u8,
}

/// Имя «устройства», от которого приходят удары по пэдам.
pub const PADS_DEVICE: &str = "Пэды";
/// Канал ударных General MIDI (10-й).
pub const DRUM_CHANNEL: u8 = 9;

/// Барабан, назначенный сообщению с входа (только нажатия и отпускания клавиш).
pub fn pad_drum(
    settings: &DeviceSettings,
    device: &str,
    channel: u8,
    msg: MidiMessage,
) -> Option<u8> {
    let note = match msg {
        MidiMessage::NoteOn { note, .. } | MidiMessage::NoteOff { note } => note,
        _ => return None,
    };
    settings
        .pads
        .iter()
        .find(|p| p.device == device && p.channel == channel && p.note == note)
        .map(|p| p.drum)
}

/// Сохраняемые настройки устройств.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct DeviceSettings {
    pub inputs: BTreeMap<String, InputSettings>,
    /// Звук самого приложения: экранная клавиатура, вторая рука, метроном.
    pub app_route: SoundRoute,
    /// MIDI-канал (0–15) для звука приложения при выводе на внешний инструмент.
    pub app_channel: u8,
    /// Пэды, назначенные барабанами.
    pub pads: Vec<PadBinding>,
    /// Подсветка клавиш (светодиодная лента над клавиатурой).
    pub lights: LightsSettings,
}

impl Default for DeviceSettings {
    fn default() -> Self {
        Self {
            inputs: BTreeMap::new(),
            app_route: SoundRoute::Internal,
            app_channel: 0,
            pads: Vec::new(),
            lights: LightsSettings::default(),
        }
    }
}

/// Настройки подсветки клавиш.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct LightsSettings {
    pub enabled: bool,
    /// Выход подсветки; `None` — найти по имени «MIDI Teacher Lights».
    pub port: Option<String>,
    /// Яркость, проценты (на плате — не больше 60%).
    pub brightness: u8,
    /// Показывать мои нажатия (огонёк над нажатой клавишей).
    pub show_presses: bool,
}

impl Default for LightsSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            port: None,
            brightness: 25,
            show_presses: true,
        }
    }
}

/// Выход подсветки: выбранный, если он есть, иначе первый с именем платы.
pub fn lights_port(settings: &LightsSettings, outputs: &[String]) -> Option<String> {
    if !settings.enabled {
        return None;
    }
    match &settings.port {
        Some(p) => outputs.iter().find(|o| *o == p).cloned(),
        None => outputs.iter().find(|o| is_lights_port(o)).cloned(),
    }
}

/// Кадр подсветки: яркость (проценты) и все горящие клавиши (клавиша → цвет 1–127).
pub fn lights_frame(brightness: u8, lit: &BTreeMap<u8, u8>) -> Vec<u8> {
    let mut out = LIGHTS_FRAME.to_vec();
    out.push(brightness_cc(brightness));
    for (note, color) in lit {
        out.push(note & 0x7F);
        out.push(color & 0x7F);
    }
    out.push(0xF7);
    out
}

/// Событие с MIDI-входа.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MidiEvent {
    pub device: String,
    pub channel: u8,
    #[serde(flatten)]
    pub msg: MidiMessage,
    /// Время получения по часам приложения, мкс.
    pub time_us: u64,
}

#[derive(Debug, Clone)]
pub enum DeviceEvent {
    Midi(MidiEvent),
    /// Изменился список устройств или их состояние.
    Changed,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InputInfo {
    pub name: String,
    pub available: bool,
    pub connected: bool,
    pub error: Option<String>,
    pub settings: InputSettings,
    /// MIDI-выход того же устройства (есть у цифровых пианино), если нашёлся.
    pub matching_output: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DevicesSnapshot {
    pub inputs: Vec<InputInfo>,
    pub outputs: Vec<String>,
    pub app_route: SoundRoute,
    pub app_channel: u8,
    /// Нужен ли сейчас встроенный синтезатор (иначе аудиоустройство освобождается).
    pub internal_sound_needed: bool,
    pub pads: Vec<PadBinding>,
    pub lights: LightsSettings,
    /// Выход, на который сейчас идёт подсветка (подключён).
    pub lights_port: Option<String>,
    /// Статус радио от платы; `None` — плата его не шлёт (прошивка без радио) или не подключена.
    pub lights_link: Option<LightsLink>,
}

/// Куда отправить звук для события с входа.
#[derive(Debug, PartialEq, Eq)]
pub enum Target<'a> {
    Synth,
    Output(&'a str),
    None,
}

/// Решает, куда пойдёт звук от входа `device`.
pub fn route_target<'a>(settings: &'a DeviceSettings, device: &str) -> Target<'a> {
    match settings.inputs.get(device).map(|s| &s.route) {
        None | Some(SoundRoute::Internal) => Target::Synth,
        Some(SoundRoute::Silent) => Target::None,
        Some(SoundRoute::Output { port }) => Target::Output(port),
    }
}

/// Делает имена портов уникальными: два одинаковых устройства получают « #2».
/// Системный порт Linux «Midi Through» пропускается.
pub fn unique_port_names(raw: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut seen: HashMap<String, usize> = HashMap::new();
    raw.into_iter()
        .filter(|n| !n.contains("Midi Through"))
        .map(|n| {
            let count = seen.entry(n.clone()).or_insert(0);
            *count += 1;
            if *count == 1 {
                n
            } else {
                format!("{n} #{count}")
            }
        })
        .collect()
}

/// Приводит имя порта к сути: без «MIDIIN2 (…)»/«MIDIOUT2 (…)», номеров портов
/// ALSA и регистра. `MIDIIN2 (Digital Piano)` → `digital piano`.
fn port_base_name(name: &str) -> String {
    let mut s = name.trim().to_lowercase();
    // Windows: «MIDIIN2 (Digital Piano)» / «MIDIOUT2 (Digital Piano)».
    for prefix in ["midiin", "midiout"] {
        if let Some(rest) = s.strip_prefix(prefix) {
            let rest = rest.trim_start_matches(|c: char| c.is_ascii_digit()).trim();
            if let Some(inner) = rest.strip_prefix('(').and_then(|r| r.strip_suffix(')')) {
                s = inner.trim().to_string();
            }
        }
    }
    // Linux ALSA: «Digital Piano:Digital Piano MIDI 1 24:0» → до двоеточия.
    if let Some((head, _)) = s.split_once(':') {
        s = head.trim().to_string();
    }
    // Суффикс уникальности « #2» и хвосты вроде « midi», « midi 1».
    let s = s.split(" #").next().unwrap_or(&s).to_string();
    s.trim_end_matches(|c: char| c.is_ascii_digit() || c == ' ')
        .trim_end_matches(" midi")
        .trim()
        .to_string()
}

/// Ищет выход, принадлежащий тому же устройству, что и вход.
pub fn matching_output(input: &str, outputs: &[String]) -> Option<String> {
    let base = port_base_name(input);
    if base.is_empty() {
        return None;
    }
    outputs
        .iter()
        .find(|o| o.as_str() == input)
        .or_else(|| outputs.iter().find(|o| port_base_name(o) == base))
        .cloned()
}

/// Нужен ли встроенный синтезатор при таких настройках и подключённых входах.
pub fn internal_sound_needed(settings: &DeviceSettings, connected: &[String]) -> bool {
    settings.app_route == SoundRoute::Internal
        || connected
            .iter()
            .any(|name| route_target(settings, name) == Target::Synth)
        // Барабаны пэдов звучат из компьютера.
        || settings.pads.iter().any(|p| connected.contains(&p.device))
}

/// Что горит на ленте и куда её слать.
#[derive(Default)]
struct LightsState {
    lit: BTreeMap<u8, u8>,
    port: Option<String>,
    last_frame: Vec<u8>,
}

struct Shared {
    settings: RwLock<DeviceSettings>,
    outputs: Mutex<HashMap<String, MidiOutputConnection>>,
    lights: Mutex<LightsState>,
    /// Последний статус радио от платы и когда пришёл.
    lights_link: Mutex<Option<(LightsLink, Instant)>>,
    audio: AudioEngine,
    events: Sender<DeviceEvent>,
}

impl Shared {
    /// Сообщение от платы подсветки (её вход): статус радио.
    fn on_lights_input(&self, bytes: &[u8]) {
        if let Some(link) = parse_lights_status(bytes) {
            *self.lights_link.lock() = Some((link, Instant::now()));
        }
    }

    /// Статус радио, если он свежий.
    fn lights_link(&self) -> Option<LightsLink> {
        self.lights_link
            .lock()
            .filter(|(_, at)| at.elapsed() <= LIGHTS_STATUS_TTL)
            .map(|(l, _)| l)
    }

    /// Вызывается из потока MIDI-драйвера на каждое входящее сообщение.
    fn on_midi(&self, device: &str, bytes: &[u8]) {
        let time_us = clock::now_us();
        let Some((channel, msg)) = midi::parse(bytes) else {
            return;
        };
        let drum = pad_drum(&self.settings.read(), device, channel, msg);
        if let Some(drum) = drum {
            self.play_drum(drum, msg);
            let msg = match msg {
                MidiMessage::NoteOn { velocity, .. } => MidiMessage::NoteOn {
                    note: drum,
                    velocity,
                },
                _ => MidiMessage::NoteOff { note: drum },
            };
            let _ = self.events.try_send(DeviceEvent::Midi(MidiEvent {
                device: PADS_DEVICE.to_string(),
                channel: DRUM_CHANNEL,
                msg,
                time_us,
            }));
            return;
        }
        {
            let settings = self.settings.read();
            match route_target(&settings, device) {
                Target::Synth => self.audio.send(channel, msg),
                Target::Output(port) => self.send_out(port, channel, msg),
                Target::None => {}
            }
        }
        let _ = self.events.try_send(DeviceEvent::Midi(MidiEvent {
            device: device.to_string(),
            channel,
            msg,
            time_us,
        }));
    }

    /// Барабан установки GM; без GM-банка — щелчок метронома, чтобы удар был хотя бы слышен.
    fn play_drum(&self, drum: u8, msg: MidiMessage) {
        let MidiMessage::NoteOn { velocity, .. } = msg else {
            return;
        };
        if self.audio.has_gm() {
            self.audio.gm_send(
                DRUM_CHANNEL,
                None,
                MidiMessage::NoteOn {
                    note: drum,
                    velocity,
                },
            );
        } else {
            self.audio.click(velocity >= 90);
        }
    }

    fn send_out(&self, port: &str, channel: u8, msg: MidiMessage) {
        if let Some(conn) = self.outputs.lock().get_mut(port) {
            if let Err(e) = conn.send(&midi::encode(channel, msg)) {
                log::warn!("MIDI Out {port}: {e}");
            }
        }
    }
}

struct InputState {
    conn: Option<MidiInputConnection<()>>,
    available: bool,
    error: Option<String>,
}

pub struct DeviceManager {
    shared: Arc<Shared>,
    inputs: Mutex<BTreeMap<String, InputState>>,
    /// Вход платы подсветки (статус радио). Отдельно от `Shared`: закрытие ждёт колбэк, а он берёт `Shared`.
    lights_input: Mutex<Option<(String, MidiInputConnection<()>)>>,
    available_outputs: Mutex<Vec<String>>,
    last_snapshot: Mutex<DevicesSnapshot>,
    sound_needed: Mutex<Option<bool>>,
    /// Встроенный вывод нужен помимо маршрутов (метроном).
    extra_demand: std::sync::atomic::AtomicBool,
    /// Вход гитары включён: прослушивание и ASIO-вход требуют открытого вывода.
    guitar_demand: std::sync::atomic::AtomicBool,
}

impl DeviceManager {
    /// Создаёт менеджер и запускает фоновое отслеживание устройств.
    pub fn start(
        audio: AudioEngine,
        events: Sender<DeviceEvent>,
        settings: DeviceSettings,
    ) -> Arc<Self> {
        let manager = Arc::new(Self {
            shared: Arc::new(Shared {
                settings: RwLock::new(settings),
                outputs: Mutex::new(HashMap::new()),
                lights: Mutex::new(LightsState::default()),
                lights_link: Mutex::new(None),
                audio,
                events,
            }),
            inputs: Mutex::new(BTreeMap::new()),
            lights_input: Mutex::new(None),
            available_outputs: Mutex::new(Vec::new()),
            last_snapshot: Mutex::new(DevicesSnapshot::default()),
            sound_needed: Mutex::new(None),
            extra_demand: std::sync::atomic::AtomicBool::new(false),
            guitar_demand: std::sync::atomic::AtomicBool::new(false),
        });
        manager.rescan();

        let weak: Weak<Self> = Arc::downgrade(&manager);
        thread::Builder::new()
            .name("mt-midi-watch".into())
            .spawn(move || loop {
                thread::sleep(SCAN_INTERVAL);
                match weak.upgrade() {
                    Some(m) => {
                        m.rescan();
                        // Повтор кадра подсветки: плата гаснет сама, если кадров нет 3 секунды.
                        m.send_lights_frame();
                    }
                    None => break,
                }
            })
            .expect("не удалось запустить отслеживание MIDI");
        manager
    }

    pub fn settings(&self) -> DeviceSettings {
        self.shared.settings.read().clone()
    }

    pub fn snapshot(&self) -> DevicesSnapshot {
        self.last_snapshot.lock().clone()
    }

    pub fn set_input(&self, name: &str, input: InputSettings) {
        self.shared
            .settings
            .write()
            .inputs
            .insert(name.to_string(), input);
        self.rescan();
    }

    pub fn set_app_route(&self, route: SoundRoute, channel: u8) {
        {
            let mut s = self.shared.settings.write();
            s.app_route = route;
            s.app_channel = channel & 0x0F;
        }
        self.rescan();
    }

    /// Назначить пэды барабанами (пустой список — пэды снова звучат как клавиши).
    pub fn set_pads(&self, pads: Vec<PadBinding>) {
        self.shared.settings.write().pads = pads;
        self.rescan();
    }

    /// Настройки подсветки: выход, вкл/выкл, яркость (сразу уходит на плату).
    pub fn set_lights_settings(&self, lights: LightsSettings) {
        let off = !lights.enabled;
        self.shared.settings.write().lights = lights;
        if off {
            self.set_lights(&[]);
        }
        self.rescan();
        self.send_lights_frame();
    }

    /// Что должно гореть: (клавиша, цвет 1–127). Изменение сразу уходит на плату кадром.
    pub fn set_lights(&self, keys: &[(u8, u8)]) {
        let new: BTreeMap<u8, u8> = keys
            .iter()
            .copied()
            .filter(|(n, c)| *n < 128 && (1..128).contains(c))
            .collect();
        let changed = {
            let mut l = self.shared.lights.lock();
            let changed = l.lit != new;
            l.lit = new;
            changed
        };
        if changed {
            self.send_lights_frame();
        }
    }

    /// Кадр с тем, что должно гореть, — на плату (при изменении и раз в секунду: плата гаснет без кадров).
    fn send_lights_frame(&self) {
        let brightness = self.shared.settings.read().lights.brightness;
        let (frame, port) = {
            let mut l = self.shared.lights.lock();
            let frame = lights_frame(brightness, &l.lit);
            l.last_frame = frame.clone();
            (frame, l.port.clone())
        };
        if let Some(port) = port {
            if let Some(conn) = self.shared.outputs.lock().get_mut(&port) {
                let _ = conn.send(&frame);
            }
        }
    }

    /// Последний кадр подсветки (для сквозных тестов и предпросмотра без платы).
    pub fn lights_last_frame(&self) -> Vec<u8> {
        self.shared.lights.lock().last_frame.clone()
    }

    /// Горящие клавиши (для проверки и предпросмотра).
    pub fn lights(&self) -> Vec<(u8, u8)> {
        self.shared
            .lights
            .lock()
            .lit
            .iter()
            .map(|(n, c)| (*n, *c))
            .collect()
    }

    /// Сырые байты на плату подсветки (SysEx настройки и проверки).
    pub fn lights_send(&self, bytes: &[u8]) -> bool {
        let Some(port) = self.shared.lights.lock().port.clone() else {
            return false;
        };
        match self.shared.outputs.lock().get_mut(&port) {
            Some(conn) => conn.send(bytes).is_ok(),
            None => false,
        }
    }

    /// Имитация сообщения от платы подсветки (статус радио) — для сквозных тестов без платы.
    pub fn lights_inject(&self, bytes: &[u8]) {
        self.shared.on_lights_input(bytes);
        self.rescan();
    }

    /// Удар по барабану без пэда (экранные пэды, тесты): звучит и приходит как с «Пэдов»;
    /// через 150 мс — отпускание, чтобы пэд на экране погас.
    pub fn hit_drum(&self, drum: u8, velocity: u8) {
        let msg = MidiMessage::NoteOn {
            note: drum,
            velocity: velocity.max(1),
        };
        self.shared.play_drum(drum, msg);
        let send = |msg| {
            let _ = self.shared.events.try_send(DeviceEvent::Midi(MidiEvent {
                device: PADS_DEVICE.to_string(),
                channel: DRUM_CHANNEL,
                msg,
                time_us: clock::now_us(),
            }));
        };
        send(msg);
        let events = self.shared.events.clone();
        thread::spawn(move || {
            thread::sleep(Duration::from_millis(150));
            let _ = events.try_send(DeviceEvent::Midi(MidiEvent {
                device: PADS_DEVICE.to_string(),
                channel: DRUM_CHANNEL,
                msg: MidiMessage::NoteOff { note: drum },
                time_us: clock::now_us(),
            }));
        });
    }

    /// Держать встроенный вывод открытым независимо от маршрутов (для метронома).
    /// Звук нужен гитаре (отдельно от метронома, чтобы конец игры его не выключал).
    pub fn set_guitar_sound_demand(&self, on: bool) {
        let prev = self
            .guitar_demand
            .swap(on, std::sync::atomic::Ordering::Relaxed);
        if prev != on {
            self.rescan();
        }
    }

    pub fn set_extra_sound_demand(&self, on: bool) {
        let prev = self
            .extra_demand
            .swap(on, std::sync::atomic::Ordering::Relaxed);
        if prev != on {
            self.rescan();
        }
    }

    /// Снять все ноты и педаль звука приложения (после прослушивания записи).
    pub fn all_app_notes_off(&self) {
        let settings = self.shared.settings.read();
        let channel = settings.app_channel;
        match &settings.app_route {
            SoundRoute::Internal => self.shared.audio.all_notes_off(),
            SoundRoute::Output { port } => {
                for controller in [midi::CC_SUSTAIN, 123] {
                    self.shared.send_out(
                        port,
                        channel,
                        MidiMessage::ControlChange {
                            controller,
                            value: 0,
                        },
                    );
                }
            }
            SoundRoute::Silent => {}
        }
    }

    /// Звук приложения (экранная клавиатура, вторая рука, метроном).
    pub fn play_app(&self, msg: MidiMessage) {
        let settings = self.shared.settings.read();
        let channel = settings.app_channel;
        match &settings.app_route {
            SoundRoute::Internal => self.shared.audio.send(channel, msg),
            SoundRoute::Output { port } => self.shared.send_out(port, channel, msg),
            SoundRoute::Silent => {}
        }
    }

    /// Имитация входящего сообщения (для тестов и режима разработчика).
    pub fn inject(&self, device: &str, bytes: &[u8]) {
        self.shared.on_midi(device, bytes);
    }

    /// Событие «устройства» без звука и маршрутов (ноты, распознанные по звуку гитары:
    /// гитара звучит сама). Время задаёт источник.
    pub fn inject_event(&self, device: &str, channel: u8, msg: MidiMessage, time_us: u64) {
        let _ = self.shared.events.try_send(DeviceEvent::Midi(MidiEvent {
            device: device.to_string(),
            channel,
            msg,
            time_us,
        }));
    }

    /// Сверяет список портов с подключениями и настройками.
    pub fn rescan(&self) {
        let (mut in_names, out_names) = scan_ports();
        // Плата подсветки видна и как вход — это не инструмент: с него приходит только статус радио.
        let lights_in: Vec<String> = in_names
            .iter()
            .filter(|n| is_lights_port(n))
            .cloned()
            .collect();
        in_names.retain(|n| !is_lights_port(n));

        // Новые устройства получают настройки по умолчанию.
        {
            let mut s = self.shared.settings.write();
            for name in &in_names {
                s.inputs.entry(name.clone()).or_default();
            }
        }
        let settings = self.settings();

        self.sync_outputs(&settings, &out_names);
        *self.available_outputs.lock() = out_names.clone();
        self.sync_lights_input(&lights_in);

        let mut inputs = self.inputs.lock();
        for name in settings.inputs.keys() {
            let state = inputs.entry(name.clone()).or_insert(InputState {
                conn: None,
                available: false,
                error: None,
            });
            state.available = in_names.contains(name);
            let want = state.available && settings.inputs[name].enabled;
            if !want {
                state.conn = None;
                if !state.available {
                    state.error = None;
                }
            } else if state.conn.is_none() {
                match self.connect_input(name) {
                    Ok(conn) => {
                        log::info!("MIDI-вход подключён: {name}");
                        state.conn = Some(conn);
                        state.error = None;
                    }
                    Err(e) => state.error = Some(e),
                }
            }
        }

        let connected: Vec<String> = inputs
            .iter()
            .filter(|(_, s)| s.conn.is_some())
            .map(|(n, _)| n.clone())
            .collect();
        let needed = internal_sound_needed(&settings, &connected)
            || self.extra_demand.load(std::sync::atomic::Ordering::Relaxed)
            || self
                .guitar_demand
                .load(std::sync::atomic::Ordering::Relaxed);
        let snapshot = DevicesSnapshot {
            inputs: settings
                .inputs
                .iter()
                .map(|(name, cfg)| {
                    let st = &inputs[name];
                    InputInfo {
                        name: name.clone(),
                        available: st.available,
                        connected: st.conn.is_some(),
                        error: st.error.clone(),
                        settings: cfg.clone(),
                        matching_output: matching_output(name, &out_names),
                    }
                })
                .collect(),
            outputs: out_names,
            app_route: settings.app_route.clone(),
            app_channel: settings.app_channel,
            internal_sound_needed: needed,
            pads: settings.pads.clone(),
            lights: settings.lights.clone(),
            lights_port: self.shared.lights.lock().port.clone(),
            lights_link: self.shared.lights_link(),
        };
        drop(inputs);

        self.update_audio_demand(needed);
        let mut last = self.last_snapshot.lock();
        if *last != snapshot {
            *last = snapshot;
            let _ = self.shared.events.try_send(DeviceEvent::Changed);
        }
    }

    /// Встроенный синтезатор не нужен — освобождаем аудиоустройство (важно для
    /// эксклюзивного ASIO), нужен снова — открываем.
    fn update_audio_demand(&self, needed: bool) {
        let mut prev = self.sound_needed.lock();
        if *prev == Some(needed) {
            return;
        }
        *prev = Some(needed);
        if needed {
            self.shared.audio.resume();
        } else {
            self.shared.audio.suspend();
        }
    }

    /// Держит открытыми выходы, на которые ссылаются маршруты.
    fn sync_outputs(&self, settings: &DeviceSettings, available: &[String]) {
        let mut wanted: Vec<&str> = settings
            .inputs
            .values()
            .filter_map(|s| match &s.route {
                SoundRoute::Output { port } => Some(port.as_str()),
                _ => None,
            })
            .collect();
        if let SoundRoute::Output { port } = &settings.app_route {
            wanted.push(port);
        }
        let lights = lights_port(&settings.lights, available);
        if let Some(p) = &lights {
            wanted.push(p);
        }
        let lights_changed = {
            let mut l = self.shared.lights.lock();
            let changed = l.port != lights;
            l.port = lights.clone();
            changed
        };

        let mut outputs = self.shared.outputs.lock();
        outputs.retain(|name, _| wanted.contains(&name.as_str()) && available.contains(name));
        for port in wanted {
            if outputs.contains_key(port) || !available.iter().any(|a| a == port) {
                continue;
            }
            match connect_output(port) {
                Ok(conn) => {
                    log::info!("MIDI-выход подключён: {port}");
                    outputs.insert(port.to_string(), conn);
                }
                Err(e) => log::warn!("MIDI-выход {port}: {e}"),
            }
        }
        // Плата подсветки появилась (или сменилась): сразу кадр с тем, что должно гореть.
        if lights_changed {
            if let Some(conn) = lights.as_ref().and_then(|p| outputs.get_mut(p)) {
                let lit = self.shared.lights.lock().lit.clone();
                let _ = conn.send(&lights_frame(settings.lights.brightness, &lit));
            }
        }
    }

    /// Держит открытым вход платы подсветки, пока подсветка идёт на плату (её выход подключён).
    fn sync_lights_input(&self, lights_in: &[String]) {
        let out = self.shared.lights.lock().port.clone();
        // Вход с тем же именем, что выход; иначе — первый с именем платы.
        let want = out.and_then(|o| {
            lights_in
                .iter()
                .find(|n| **n == o)
                .or_else(|| lights_in.first())
                .cloned()
        });
        let mut cur = self.lights_input.lock();
        if cur.as_ref().map(|(n, _)| n) == want.as_ref() {
            return;
        }
        *cur = None;
        let Some(name) = want else {
            return;
        };
        match self.connect_lights_input(&name) {
            Ok(conn) => {
                log::info!("Вход платы подсветки подключён: {name}");
                *cur = Some((name, conn));
                drop(cur);
                // Статус сразу, не дожидаясь секундного.
                self.lights_send(&LIGHTS_STATUS_REQUEST);
            }
            Err(e) => log::warn!("Вход платы подсветки {name}: {e}"),
        }
    }

    fn connect_lights_input(&self, name: &str) -> Result<MidiInputConnection<()>, String> {
        let mut input = MidiInput::new(CLIENT_NAME).map_err(|e| e.to_string())?;
        input.ignore(Ignore::None);
        let port = find_port(&input.ports(), |p| input.port_name(p).ok(), name)
            .ok_or("устройство не найдено")?;
        let shared = self.shared.clone();
        input
            .connect(
                &port,
                "mt-lights-in",
                move |_, bytes, _| shared.on_lights_input(bytes),
                (),
            )
            .map_err(|e| e.to_string())
    }

    fn connect_input(&self, name: &str) -> Result<MidiInputConnection<()>, String> {
        let mut input = MidiInput::new(CLIENT_NAME).map_err(|e| e.to_string())?;
        input.ignore(Ignore::All);
        let port = find_port(&input.ports(), |p| input.port_name(p).ok(), name)
            .ok_or("устройство не найдено")?;
        let shared = self.shared.clone();
        let device: Arc<str> = Arc::from(name);
        input
            .connect(
                &port,
                "mt-in",
                move |_, bytes, _| shared.on_midi(&device, bytes),
                (),
            )
            .map_err(|e| {
                format!("не удалось открыть ({e}). Возможно, устройство занято другой программой.")
            })
    }
}

fn scan_ports() -> (Vec<String>, Vec<String>) {
    let inputs = MidiInput::new(CLIENT_NAME)
        .map(|m| unique_port_names(m.ports().iter().filter_map(|p| m.port_name(p).ok())))
        .unwrap_or_default();
    let outputs = MidiOutput::new(CLIENT_NAME)
        .map(|m| unique_port_names(m.ports().iter().filter_map(|p| m.port_name(p).ok())))
        .unwrap_or_default();
    (inputs, outputs)
}

/// Находит порт по уникальному имени (с учётом суффикса « #N»).
fn find_port<P: Clone>(
    ports: &[P],
    name_of: impl Fn(&P) -> Option<String>,
    want: &str,
) -> Option<P> {
    let names = unique_port_names(ports.iter().map(|p| name_of(p).unwrap_or_default()));
    // unique_port_names мог выкинуть «Midi Through», поэтому сопоставляем заново.
    let kept: Vec<&P> = ports
        .iter()
        .filter(|p| !name_of(p).unwrap_or_default().contains("Midi Through"))
        .collect();
    names
        .iter()
        .position(|n| n == want)
        .map(|i| kept[i].clone())
}

/// Яркость в процентах → значение контроллера 0–127.
fn brightness_cc(percent: u8) -> u8 {
    ((percent.min(100) as u32 * 127 + 50) / 100) as u8
}

fn connect_output(name: &str) -> Result<MidiOutputConnection, String> {
    let output = MidiOutput::new(CLIENT_NAME).map_err(|e| e.to_string())?;
    let port = find_port(&output.ports(), |p| output.port_name(p).ok(), name)
        .ok_or("устройство не найдено")?;
    output.connect(&port, "mt-out").map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn settings_with(routes: &[(&str, SoundRoute)]) -> DeviceSettings {
        let mut s = DeviceSettings::default();
        for (name, route) in routes {
            s.inputs.insert(
                name.to_string(),
                InputSettings {
                    route: route.clone(),
                    ..Default::default()
                },
            );
        }
        s
    }

    #[test]
    fn pads_map_to_drums_only_for_their_device_channel_and_note() {
        let s = DeviceSettings {
            pads: vec![
                PadBinding {
                    device: "Keystation".into(),
                    channel: 9,
                    note: 36,
                    drum: 36,
                },
                PadBinding {
                    device: "Keystation".into(),
                    channel: 9,
                    note: 37,
                    drum: 38,
                },
            ],
            ..Default::default()
        };
        let hit = |device: &str, channel, note| {
            pad_drum(
                &s,
                device,
                channel,
                MidiMessage::NoteOn {
                    note,
                    velocity: 100,
                },
            )
        };
        assert_eq!(hit("Keystation", 9, 37), Some(38));
        assert_eq!(hit("Keystation", 9, 36), Some(36));
        // Клавиша с тем же номером на канале клавиш — не пэд.
        assert_eq!(hit("Keystation", 0, 37), None);
        assert_eq!(hit("Digital Piano", 9, 37), None);
        assert_eq!(
            pad_drum(&s, "Keystation", 9, MidiMessage::NoteOff { note: 37 }),
            Some(38)
        );
        assert_eq!(
            pad_drum(
                &s,
                "Keystation",
                9,
                MidiMessage::ControlChange {
                    controller: 1,
                    value: 3
                }
            ),
            None
        );
    }

    #[test]
    fn connected_pads_need_internal_sound() {
        let mut s = settings_with(&[("Keystation", SoundRoute::Silent)]);
        s.app_route = SoundRoute::Silent;
        assert!(!internal_sound_needed(&s, &["Keystation".into()]));
        s.pads = vec![PadBinding {
            device: "Keystation".into(),
            channel: 9,
            note: 36,
            drum: 36,
        }];
        assert!(internal_sound_needed(&s, &["Keystation".into()]));
        assert!(!internal_sound_needed(&s, &[]));
    }

    #[test]
    fn routes_resolve_per_device() {
        let s = settings_with(&[
            ("Digital Piano", SoundRoute::Silent),
            (
                "Keystation",
                SoundRoute::Output {
                    port: "Digital Piano".into(),
                },
            ),
        ]);
        assert_eq!(route_target(&s, "Digital Piano"), Target::None);
        assert_eq!(
            route_target(&s, "Keystation"),
            Target::Output("Digital Piano")
        );
        // Неизвестное устройство звучит через встроенный синтезатор.
        assert_eq!(route_target(&s, "Other"), Target::Synth);
    }

    #[test]
    fn internal_sound_only_when_someone_needs_it() {
        let mut s = settings_with(&[
            ("Digital Piano", SoundRoute::Silent),
            (
                "Keystation",
                SoundRoute::Output {
                    port: "Digital Piano".into(),
                },
            ),
        ]);
        s.app_route = SoundRoute::Output {
            port: "Digital Piano".into(),
        };
        let connected = vec!["Digital Piano".to_string(), "Keystation".to_string()];
        assert!(!internal_sound_needed(&s, &connected));

        s.inputs.get_mut("Keystation").unwrap().route = SoundRoute::Internal;
        assert!(internal_sound_needed(&s, &connected));
        // Не подключённый вход с Internal синтезатор не держит.
        assert!(!internal_sound_needed(&s, &connected[..1]));

        s.app_route = SoundRoute::Internal;
        assert!(internal_sound_needed(&s, &[]));
    }

    #[test]
    fn finds_output_of_the_same_device() {
        let outs: Vec<String> = [
            "Microsoft GS Wavetable Synth",
            "MIDIOUT2 (Digital Piano)",
            "Keystation 49",
        ]
        .map(String::from)
        .to_vec();
        assert_eq!(
            matching_output("MIDIIN2 (Digital Piano)", &outs).as_deref(),
            Some("MIDIOUT2 (Digital Piano)")
        );
        assert_eq!(
            matching_output("Keystation 49", &outs).as_deref(),
            Some("Keystation 49")
        );
        assert_eq!(matching_output("Other Keys", &outs), None);

        let alsa = vec!["P-125:P-125 MIDI 1 20:0".to_string()];
        assert_eq!(
            matching_output("P-125:P-125 MIDI 1 20:0", &alsa).as_deref(),
            Some("P-125:P-125 MIDI 1 20:0")
        );
        assert_eq!(port_base_name("Digital Piano #2"), "digital piano");
        assert_eq!(port_base_name("USB MIDI 1"), "usb");
    }

    #[test]
    fn duplicate_port_names_become_unique() {
        let names = unique_port_names(
            ["Piano", "Midi Through Port-0", "Piano", "Keys", "Piano"].map(String::from),
        );
        assert_eq!(names, vec!["Piano", "Piano #2", "Keys", "Piano #3"]);
    }

    #[test]
    fn find_port_matches_unique_names_skipping_midi_through() {
        // (идентификатор порта, имя порта)
        let ports = [
            (0, "Midi Through Port-0"),
            (1, "Piano"),
            (2, "Keys"),
            (3, "Piano"),
        ];
        let name_of = |p: &(i32, &str)| Some(p.1.to_string());
        assert_eq!(find_port(&ports, name_of, "Piano").map(|p| p.0), Some(1));
        assert_eq!(find_port(&ports, name_of, "Keys").map(|p| p.0), Some(2));
        assert_eq!(find_port(&ports, name_of, "Piano #2").map(|p| p.0), Some(3));
        assert_eq!(find_port(&ports, name_of, "Nope"), None);
    }

    #[test]
    fn settings_json_roundtrip() {
        let mut s = settings_with(&[(
            "Keys",
            SoundRoute::Output {
                port: "Piano".into(),
            },
        )]);
        s.inputs.get_mut("Keys").unwrap().range = Some((36, 96));
        let json = serde_json::to_string(&s).unwrap();
        assert!(
            json.contains(r#""route":{"kind":"output","port":"Piano"}"#),
            "{json}"
        );
        assert_eq!(serde_json::from_str::<DeviceSettings>(&json).unwrap(), s);
        // Старый/неполный файл настроек читается с умолчаниями.
        let partial: DeviceSettings = serde_json::from_str(r#"{"inputs":{"X":{}}}"#).unwrap();
        assert_eq!(partial.inputs["X"], InputSettings::default());
        assert_eq!(partial.app_route, SoundRoute::Internal);
    }

    #[test]
    fn lights_port_and_diff() {
        let outs = vec!["NPK Piano".to_string(), "MIDI Teacher Lights".to_string()];
        let mut l = LightsSettings::default();
        assert_eq!(
            lights_port(&l, &outs).as_deref(),
            Some("MIDI Teacher Lights")
        );
        l.port = Some("NPK Piano".into());
        assert_eq!(lights_port(&l, &outs).as_deref(), Some("NPK Piano"));
        l.port = Some("Нет такого".into());
        assert_eq!(lights_port(&l, &outs), None);
        l.enabled = false;
        l.port = None;
        assert_eq!(lights_port(&l, &outs), None);
        assert!(is_lights_port("MIDI Teacher Lights #2"));

        let lit: BTreeMap<u8, u8> = [(67, 2), (60, 1)].into_iter().collect();
        assert_eq!(
            lights_frame(25, &lit),
            vec![0xF0, 0x7D, 0x4D, 0x54, 0x10, 32, 60, 1, 67, 2, 0xF7]
        );
        // Пустой кадр — всё погасить.
        assert_eq!(
            lights_frame(25, &BTreeMap::new()),
            vec![0xF0, 0x7D, 0x4D, 0x54, 0x10, 32, 0xF7]
        );
        assert_eq!(brightness_cc(30), 38);
        assert_eq!(brightness_cc(100), 127);
    }

    #[test]
    fn lights_status() {
        let st = [0xF0, 0x7D, 0x4D, 0x54, 0x20, 1, 1, 2, 58, 3, 0xF7];
        assert_eq!(
            parse_lights_status(&st),
            Some(LightsLink {
                link: LightsLinkState::Online,
                pairing: LightsPairing::Done,
                rssi: Some(-58),
                loss: 3,
            })
        );
        let wired = [0xF0, 0x7D, 0x4D, 0x54, 0x20, 1, 0, 0, 0, 0, 0xF7];
        let l = parse_lights_status(&wired).unwrap();
        assert_eq!(
            (l.link, l.pairing, l.rssi),
            (LightsLinkState::Wired, LightsPairing::Idle, None)
        );
        let lost = [0xF0, 0x7D, 0x4D, 0x54, 0x20, 1, 2, 3, 0, 0, 0xF7];
        let l = parse_lights_status(&lost).unwrap();
        assert_eq!(
            (l.link, l.pairing),
            (LightsLinkState::Lost, LightsPairing::NotFound)
        );
        // Не статус: кадр, чужой SysEx, обрезанное сообщение, неизвестная связь.
        assert_eq!(
            parse_lights_status(&[0xF0, 0x7D, 0x4D, 0x54, 0x10, 32, 0xF7]),
            None
        );
        assert_eq!(parse_lights_status(&[0xF0, 0x41, 0x10, 0x42, 0xF7]), None);
        assert_eq!(parse_lights_status(&st[..10]), None);
        let mut bad = st;
        bad[6] = 9;
        assert_eq!(parse_lights_status(&bad), None);
        // Статус хранится 3 секунды.
        let link = Mutex::new(Some((
            parse_lights_status(&st).unwrap(),
            Instant::now() - LIGHTS_STATUS_TTL - Duration::from_millis(10),
        )));
        assert!(link
            .lock()
            .filter(|(_, at)| at.elapsed() <= LIGHTS_STATUS_TTL)
            .is_none());
    }
}
