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
use std::time::Duration;

const CLIENT_NAME: &str = "MIDI Teacher";
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

/// Сохраняемые настройки устройств.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct DeviceSettings {
    pub inputs: BTreeMap<String, InputSettings>,
    /// Звук самого приложения: экранная клавиатура, вторая рука, метроном.
    pub app_route: SoundRoute,
    /// MIDI-канал (0–15) для звука приложения при выводе на внешний инструмент.
    pub app_channel: u8,
}

impl Default for DeviceSettings {
    fn default() -> Self {
        Self {
            inputs: BTreeMap::new(),
            app_route: SoundRoute::Internal,
            app_channel: 0,
        }
    }
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
}

struct Shared {
    settings: RwLock<DeviceSettings>,
    outputs: Mutex<HashMap<String, MidiOutputConnection>>,
    audio: AudioEngine,
    events: Sender<DeviceEvent>,
}

impl Shared {
    /// Вызывается из потока MIDI-драйвера на каждое входящее сообщение.
    fn on_midi(&self, device: &str, bytes: &[u8]) {
        let time_us = clock::now_us();
        let Some((channel, msg)) = midi::parse(bytes) else {
            return;
        };
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
    available_outputs: Mutex<Vec<String>>,
    last_snapshot: Mutex<DevicesSnapshot>,
    sound_needed: Mutex<Option<bool>>,
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
                audio,
                events,
            }),
            inputs: Mutex::new(BTreeMap::new()),
            available_outputs: Mutex::new(Vec::new()),
            last_snapshot: Mutex::new(DevicesSnapshot::default()),
            sound_needed: Mutex::new(None),
        });
        manager.rescan();

        let weak: Weak<Self> = Arc::downgrade(&manager);
        thread::Builder::new()
            .name("mt-midi-watch".into())
            .spawn(move || loop {
                thread::sleep(SCAN_INTERVAL);
                match weak.upgrade() {
                    Some(m) => m.rescan(),
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

    /// Сверяет список портов с подключениями и настройками.
    pub fn rescan(&self) {
        let (in_names, out_names) = scan_ports();

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
        let needed = internal_sound_needed(&settings, &connected);
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
}
