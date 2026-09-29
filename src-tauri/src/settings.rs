//! Настройки приложения в JSON-файле в каталоге конфигурации.

use mt_core::audio::AudioConfig;
use mt_core::devices::DeviceSettings;
use mt_core::trainer::ErrorMode;
use serde::{Deserialize, Serialize};
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
        s.save(&path).unwrap();
        assert_eq!(AppSettings::load(&path), s);

        std::fs::write(&path, "{ broken").unwrap();
        assert_eq!(AppSettings::load(&path), AppSettings::default());
        std::fs::remove_dir_all(dir).ok();
    }
}
