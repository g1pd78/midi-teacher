//! Дневник занятий: файлы YAML/JSON в папке «Документы\MIDI Teacher\Дневник» — недельные записи,
//! свои уроки и план. Интерфейс сам собирает и разбирает текст; здесь — только чтение и запись.

use crate::library::library_dir;
use std::path::PathBuf;
use tauri::AppHandle;

fn journal_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = library_dir(app)?.join("Дневник");
    std::fs::create_dir_all(&dir).map_err(|e| format!("не удалось создать папку дневника: {e}"))?;
    Ok(dir)
}

/// Имя файла без путей: буквы, цифры, «-», «_», «.», пробел; расширение yaml, yml, json или md.
fn safe_name(name: &str) -> Result<&str, String> {
    let ok_chars = name
        .chars()
        .all(|c| c.is_alphanumeric() || "-_. ".contains(c));
    let ext_ok = [".yaml", ".yml", ".json", ".md"]
        .iter()
        .any(|e| name.to_lowercase().ends_with(e));
    if name.is_empty() || name.starts_with('.') || !ok_chars || !ext_ok {
        return Err(format!("недопустимое имя файла дневника: {name}"));
    }
    Ok(name)
}

#[tauri::command]
pub fn journal_folder(app: AppHandle) -> Result<String, String> {
    Ok(journal_dir(&app)?.display().to_string())
}

/// Текст файла дневника или `None`, если его нет.
#[tauri::command]
pub fn journal_read(app: AppHandle, name: String) -> Result<Option<String>, String> {
    let path = journal_dir(&app)?.join(safe_name(&name)?);
    match std::fs::read_to_string(&path) {
        Ok(t) => Ok(Some(t)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("не удалось прочитать {name}: {e}")),
    }
}

#[tauri::command]
pub fn journal_write(app: AppHandle, name: String, text: String) -> Result<(), String> {
    let path = journal_dir(&app)?.join(safe_name(&name)?);
    std::fs::write(&path, text).map_err(|e| format!("не удалось сохранить {name}: {e}"))
}

#[tauri::command]
pub fn journal_delete(app: AppHandle, name: String) -> Result<(), String> {
    let path = journal_dir(&app)?.join(safe_name(&name)?);
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("не удалось удалить {name}: {e}")),
    }
}

#[tauri::command]
pub fn journal_open_folder(app: AppHandle) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let dir = journal_dir(&app)?;
    app.opener()
        .open_path(dir.display().to_string(), None::<&str>)
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::safe_name;

    #[test]
    fn only_plain_names() {
        assert!(safe_name("план.yaml").is_ok());
        assert!(safe_name("2026-W41.yaml").is_ok());
        assert!(safe_name("цель.json").is_ok());
        assert!(safe_name("../x.yaml").is_err());
        assert!(safe_name("a/b.yaml").is_err());
        assert!(safe_name("x.exe").is_err());
        assert!(safe_name(".yaml").is_err());
    }
}
