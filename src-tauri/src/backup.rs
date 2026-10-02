//! Резервная копия: настройки, прогресс (база SQLite) и треки студии — в один файл.
//! Восстановление кладёт файлы рядом с рабочими («….restore»), а подмена происходит при
//! следующем запуске — пока приложение работает, оно само перезаписывает настройки и базу.

use crate::library::library_dir;
use base64::Engine;
use mt_core::store::Store;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::{AppHandle, Manager, State};

const KIND: &str = "MIDI Teacher backup";
const RESTORE: &str = "restore";

/// База прогресса для команд резервной копии.
pub struct StoreHandle(pub Arc<Mutex<Option<Store>>>);

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BackupFile {
    kind: String,
    version: u32,
    created: u64,
    settings: Option<serde_json::Value>,
    /// Снимок базы прогресса, base64.
    progress: Option<String>,
    /// Треки студии: имя файла → содержимое JSON.
    songs: BTreeMap<String, serde_json::Value>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupInfo {
    settings: bool,
    progress: bool,
    songs: usize,
    created: u64,
}

fn paths(app: &AppHandle) -> Result<(PathBuf, PathBuf), String> {
    let config = app.path().app_config_dir().map_err(|e| e.to_string())?;
    let data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok((config.join("settings.json"), data.join("progress.db")))
}

fn restore_path(p: &Path) -> PathBuf {
    let mut s = p.as_os_str().to_owned();
    s.push(".");
    s.push(RESTORE);
    PathBuf::from(s)
}

/// При запуске: если ждёт восстановленный файл — подменить им рабочий.
pub fn apply_pending(path: &Path) {
    let pending = restore_path(path);
    if !pending.exists() {
        return;
    }
    // У базы SQLite могут остаться журналы — они от старой базы.
    for ext in ["-wal", "-shm"] {
        let mut j = path.as_os_str().to_owned();
        j.push(ext);
        let _ = std::fs::remove_file(PathBuf::from(j));
    }
    match std::fs::rename(&pending, path) {
        Ok(()) => log::info!("восстановлено из резервной копии: {}", path.display()),
        Err(e) => log::warn!("не удалось восстановить {}: {e}", path.display()),
    }
}

fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Сохранить резервную копию в файл `path` (выбран в диалоге «Сохранить как»).
#[tauri::command]
pub fn backup_export(
    app: AppHandle,
    store: State<StoreHandle>,
    path: String,
) -> Result<BackupInfo, String> {
    let (settings_path, db_path) = paths(&app)?;
    let settings = std::fs::read_to_string(&settings_path)
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok());
    let progress = match store.0.lock().as_ref() {
        Some(s) => {
            let tmp = db_path.with_extension("backup-tmp");
            s.snapshot_to(&tmp)
                .map_err(|e| format!("снимок прогресса не получился: {e}"))?;
            let bytes = std::fs::read(&tmp).map_err(|e| e.to_string())?;
            let _ = std::fs::remove_file(&tmp);
            Some(base64::engine::general_purpose::STANDARD.encode(bytes))
        }
        None => None,
    };
    let mut songs = BTreeMap::new();
    if let Ok(dir) = library_dir(&app).map(|d| d.join("Треки")) {
        for entry in std::fs::read_dir(dir).into_iter().flatten().flatten() {
            let p = entry.path();
            if p.extension().is_some_and(|x| x == "json") {
                if let Some(v) = std::fs::read_to_string(&p)
                    .ok()
                    .and_then(|t| serde_json::from_str(&t).ok())
                {
                    songs.insert(entry.file_name().to_string_lossy().into_owned(), v);
                }
            }
        }
    }
    let file = BackupFile {
        kind: KIND.into(),
        version: 1,
        created: now(),
        settings,
        progress,
        songs,
    };
    let info = BackupInfo {
        settings: file.settings.is_some(),
        progress: file.progress.is_some(),
        songs: file.songs.len(),
        created: file.created,
    };
    let text = serde_json::to_string(&file).map_err(|e| e.to_string())?;
    std::fs::write(&path, text).map_err(|e| format!("резервная копия не сохранена: {e}"))?;
    Ok(info)
}

/// Восстановить из файла: настройки и прогресс подменятся при перезапуске, треки студии —
/// сразу (одноимённые заменяются).
#[tauri::command]
pub fn backup_import(app: AppHandle, path: String) -> Result<BackupInfo, String> {
    let text =
        std::fs::read_to_string(&path).map_err(|e| format!("не удалось прочитать файл: {e}"))?;
    let file: BackupFile = serde_json::from_str(&text)
        .map_err(|_| "это не резервная копия MIDI Teacher".to_string())?;
    if file.kind != KIND {
        return Err("это не резервная копия MIDI Teacher".into());
    }
    let (settings_path, db_path) = paths(&app)?;
    if let Some(s) = &file.settings {
        let text = serde_json::to_string_pretty(s).map_err(|e| e.to_string())?;
        std::fs::write(restore_path(&settings_path), text).map_err(|e| e.to_string())?;
    }
    if let Some(b64) = &file.progress {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(b64)
            .map_err(|_| "резервная копия повреждена (прогресс)".to_string())?;
        std::fs::write(restore_path(&db_path), bytes).map_err(|e| e.to_string())?;
    }
    if !file.songs.is_empty() {
        let dir = library_dir(&app)?.join("Треки");
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        for (name, song) in &file.songs {
            if name.contains(['/', '\\']) || !name.ends_with(".json") {
                continue;
            }
            let text = serde_json::to_string(song).map_err(|e| e.to_string())?;
            std::fs::write(dir.join(name), text).map_err(|e| e.to_string())?;
        }
    }
    Ok(BackupInfo {
        settings: file.settings.is_some(),
        progress: file.progress.is_some(),
        songs: file.songs.len(),
        created: file.created,
    })
}

/// Перезапуск приложения (после восстановления).
#[tauri::command]
pub fn restart_app(app: AppHandle) {
    app.restart();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pending_restore_replaces_file_at_startup() {
        let dir = std::env::temp_dir().join(format!("mt-backup-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let target = dir.join("settings.json");
        std::fs::write(&target, "old").unwrap();
        apply_pending(&target);
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "old");
        std::fs::write(restore_path(&target), "new").unwrap();
        apply_pending(&target);
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "new");
        assert!(!restore_path(&target).exists());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
