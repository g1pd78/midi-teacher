//! Настройки приложения в JSON-файле в каталоге конфигурации.

use mt_core::audio::AudioConfig;
use mt_core::devices::DeviceSettings;
use mt_core::guitar::GuitarConfig;
use mt_core::midifile::{HandOverride, TrackRole};
use mt_core::piece::HandMode;
use mt_core::trainer::ErrorMode;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

/// Настройки интерфейса.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct UiPrefs {
    /// `solfege` (до-ре-ми) или `latin` (C-D-E).
    pub note_names: String,
    /// Мастер первого запуска пройден.
    pub wizard_done: bool,
    pub trainer: TrainerPrefs,
    pub piece: PiecePrefs,
    /// Карточки теории, которые уже показаны («Понятно»).
    pub theory_seen: Vec<String>,
    /// Настройки отдельных пьес по id: транспонирование, дорожки MIDI, правка рук.
    pub piece_setup: BTreeMap<String, PieceSetup>,
    /// Свои песни по буквам аккордов (формат задаёт интерфейс, ядро хранит как есть).
    pub songs: Vec<serde_json::Value>,
}

/// Настройки одной пьесы.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PieceSetup {
    /// Сдвиг в полутонах (−12…+12).
    pub transpose: i8,
    /// Роли дорожек MIDI-файла; `None` — ещё не выбраны (показать окно дорожек).
    pub roles: Option<Vec<TrackRole>>,
    /// Ноты, переброшенные в другую руку вручную.
    pub hand_overrides: Vec<HandOverride>,
    /// На чём играем: `piano` (по умолчанию), `guitar`, `bass`.
    pub instrument: Option<String>,
    /// Какой стан играть на гитаре/басе (0 — выбрать самому).
    pub part: u8,
}

/// Настройки экрана пьесы.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PiecePrefs {
    /// `line` — одна строка, `pages` — страницы.
    pub layout: String,
    pub hands: HandMode,
    /// Вторая рука звучит (играет приложение).
    pub accompany: bool,
    pub names: bool,
    pub fingering: bool,
    /// Подсвечивать клавиши текущего шага.
    pub key_hints: bool,
    /// `wait` — режим ожидания, `rhythm` — игра в темпе.
    pub mode: String,
    /// Темп относительно пьесы (0,3–1,2).
    pub tempo: f32,
    /// Отсчёт такта перед началом (режим ритма).
    pub count_in: bool,
    pub metronome: bool,
    /// Показывать падающие ноты.
    pub waterfall: bool,
    /// Ведущий режим «Разучить» (иначе свободная игра).
    pub guided: bool,
    /// Тепловая карта трудных тактов на нотах.
    pub heat: bool,
}

impl Default for PiecePrefs {
    fn default() -> Self {
        Self {
            layout: "line".into(),
            hands: HandMode::Right,
            accompany: true,
            names: false,
            fingering: true,
            key_hints: true,
            mode: "wait".into(),
            tempo: 0.8,
            count_in: true,
            metronome: false,
            waterfall: true,
            guided: true,
            heat: false,
        }
    }
}

/// Настройки тренажёра чтения нот.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct TrainerPrefs {
    /// `single` — по одной ноте, `lane` — лентой.
    pub layout: String,
    pub error_mode: ErrorMode,
    /// Подписи нот: `always`, `struggle` (при затруднении), `never`.
    pub names: String,
}

impl Default for TrainerPrefs {
    fn default() -> Self {
        Self {
            layout: "single".into(),
            error_mode: ErrorMode::Wait,
            names: "struggle".into(),
        }
    }
}

impl Default for UiPrefs {
    fn default() -> Self {
        Self {
            note_names: "solfege".into(),
            wizard_done: false,
            trainer: TrainerPrefs::default(),
            piece: PiecePrefs::default(),
            theory_seen: Vec::new(),
            piece_setup: BTreeMap::new(),
            songs: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AppSettings {
    pub prefs: UiPrefs,
    pub devices: DeviceSettings,
    pub audio: AudioConfig,
    /// Свой SoundFont пользователя; `None` — встроенный.
    pub soundfont: Option<PathBuf>,
    /// Вход гитары/баса.
    pub guitar: GuitarConfig,
}

impl AppSettings {
    /// Читает настройки; при отсутствии или повреждении файла — умолчания.
    pub fn load(path: &Path) -> Self {
        match std::fs::read_to_string(path) {
            Ok(text) => serde_json::from_str(&text).unwrap_or_else(|e| {
                log::warn!("настройки повреждены ({e}), используются умолчания");
                Self::default()
            }),
            Err(_) => Self::default(),
        }
    }

    /// Пишет через временный файл, чтобы сбой не оставил полупустой JSON.
    pub fn save(&self, path: &Path) -> std::io::Result<()> {
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, serde_json::to_vec_pretty(self)?)?;
        std::fs::rename(tmp, path)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn save_and_load_roundtrip() {
        let dir = std::env::temp_dir().join(format!("mt-settings-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("settings.json");

        let mut s = AppSettings::default();
        s.prefs.note_names = "latin".into();
        s.prefs.wizard_done = true;
        s.audio.buffer_frames = Some(64);
        s.prefs.songs =
            vec![serde_json::json!({ "id": "my-1", "title": "Песня", "chords": "C | G" })];
        s.save(&path).unwrap();
        assert_eq!(AppSettings::load(&path), s);

        std::fs::write(&path, "{ broken").unwrap();
        assert_eq!(AppSettings::load(&path), AppSettings::default());
        std::fs::remove_dir_all(dir).ok();
    }
}
