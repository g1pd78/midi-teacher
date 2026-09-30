//! Библиотека пьес пользователя: папка «Документы\MIDI Teacher».
//!
//! Встроенные пьесы лежат в интерфейсе; здесь — только файлы пользователя.

use serde::Serialize;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;
use tauri::{AppHandle, Manager};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryItem {
    /// Имя файла внутри папки библиотеки.
    id: String,
    title: String,
    /// `musicxml`, `mxl` или `midi`.
    format: String,
    size: u64,
    modified: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryListing {
    dir: String,
    items: Vec<LibraryItem>,
}

pub fn library_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .document_dir()
        .or_else(|_| app.path().home_dir())
        .map_err(|e| e.to_string())?;
    let dir = base.join("MIDI Teacher");
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("не удалось создать {}: {e}", dir.display()))?;
    Ok(dir)
}

fn format_of(path: &Path) -> Option<&'static str> {
    let ext = path.extension()?.to_str()?.to_lowercase();
    match ext.as_str() {
        "musicxml" | "xml" => Some("musicxml"),
        "mxl" => Some("mxl"),
        "mid" | "midi" => Some("midi"),
        _ => None,
    }
}

/// Название из MusicXML (`work-title`, затем `movement-title`), иначе имя файла.
pub fn title_of(path: &Path, format: &str) -> String {
    let stem = path
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    if format != "musicxml" {
        return stem;
    }
    let Ok(text) = std::fs::read_to_string(path) else {
        return stem;
    };
    for tag in ["work-title", "movement-title"] {
        if let Some(t) = extract_tag(&text, tag) {
            if !t.trim().is_empty() {
                return t.trim().to_string();
            }
        }
    }
    stem
}

fn extract_tag(text: &str, tag: &str) -> Option<String> {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let start = text.find(&open)? + open.len();
    let end = text[start..].find(&close)? + start;
    Some(
        text[start..end]
            .replace("&amp;", "&")
            .replace("&lt;", "<")
            .replace("&gt;", ">")
            .replace("&quot;", "\"")
            .replace("&apos;", "'"),
    )
}

/// Проверяет, что `id` — простое имя файла внутри папки (без путей).
pub fn safe_path(dir: &Path, id: &str) -> Result<PathBuf, String> {
    if id.is_empty() || id.contains(['/', '\\']) || id == "." || id == ".." {
        return Err("неверное имя файла".into());
    }
    Ok(dir.join(id))
}

/// Свободное имя: «Пьеса.musicxml», «Пьеса (2).musicxml», …
pub fn unique_name(dir: &Path, name: &str) -> String {
    if !dir.join(name).exists() {
        return name.to_string();
    }
    let p = Path::new(name);
    let stem = p
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    let ext = p
        .extension()
        .map(|s| format!(".{}", s.to_string_lossy()))
        .unwrap_or_default();
    (2..)
        .map(|i| format!("{stem} ({i}){ext}"))
        .find(|n| !dir.join(n).exists())
        .unwrap_or_else(|| name.to_string())
}

#[tauri::command]
pub fn library_list(app: AppHandle) -> Result<LibraryListing, String> {
    let dir = library_dir(&app)?;
    let mut items = Vec::new();
    for entry in std::fs::read_dir(&dir)
        .map_err(|e| e.to_string())?
        .flatten()
    {
        let path = entry.path();
        let Some(format) = format_of(&path) else {
            continue;
        };
        let meta = entry.metadata().ok();
        items.push(LibraryItem {
            id: entry.file_name().to_string_lossy().into_owned(),
            title: title_of(&path, format),
            format: format.into(),
            size: meta.as_ref().map(|m| m.len()).unwrap_or(0),
            modified: meta
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0),
        });
    }
    items.sort_by_key(|i| i.title.to_lowercase());
    Ok(LibraryListing {
        dir: dir.display().to_string(),
        items,
    })
}

/// Содержимое файла библиотеки (как есть, в байтах).
#[tauri::command]
pub fn library_read(app: AppHandle, id: String) -> Result<tauri::ipc::Response, String> {
    let path = safe_path(&library_dir(&app)?, &id)?;
    let bytes = std::fs::read(&path).map_err(|e| format!("не удалось прочитать {id}: {e}"))?;
    Ok(tauri::ipc::Response::new(bytes))
}

/// Копирует файлы в папку библиотеки. Возвращает имена добавленных файлов.
#[tauri::command]
pub fn library_import(app: AppHandle, paths: Vec<String>) -> Result<Vec<String>, String> {
    let dir = library_dir(&app)?;
    let mut added = Vec::new();
    for p in paths {
        let src = PathBuf::from(&p);
        if format_of(&src).is_none() {
            continue;
        }
        // Файл уже в библиотеке — не копируем сам в себя.
        if src.parent().map(|d| d == dir).unwrap_or(false) {
            continue;
        }
        let Some(name) = src.file_name().map(|n| n.to_string_lossy().into_owned()) else {
            continue;
        };
        let name = unique_name(&dir, &name);
        std::fs::copy(&src, dir.join(&name))
            .map_err(|e| format!("не удалось скопировать {p}: {e}"))?;
        added.push(name);
    }
    Ok(added)
}

#[tauri::command]
pub fn library_open_folder(app: AppHandle) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let dir = library_dir(&app)?;
    app.opener()
        .open_path(dir.display().to_string(), None::<&str>)
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn titles_and_safe_names() {
        let dir = std::env::temp_dir().join(format!("mt-lib-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("a.musicxml");
        std::fs::write(
            &f,
            "<score-partwise><work><work-title>Ода к радости &amp; бас</work-title></work></score-partwise>",
        )
        .unwrap();
        assert_eq!(title_of(&f, "musicxml"), "Ода к радости & бас");
        let g = dir.join("Менуэт.musicxml");
        std::fs::write(
            &g,
            "<score-partwise><movement-title>Menuet</movement-title></score-partwise>",
        )
        .unwrap();
        assert_eq!(title_of(&g, "musicxml"), "Menuet");
        assert_eq!(title_of(&dir.join("x.mid"), "midi"), "x");

        assert_eq!(unique_name(&dir, "a.musicxml"), "a (2).musicxml");
        assert_eq!(unique_name(&dir, "new.musicxml"), "new.musicxml");
        assert!(safe_path(&dir, "../etc").is_err());
        assert!(safe_path(&dir, "a\\b").is_err());
        assert!(safe_path(&dir, "a.musicxml").is_ok());
        assert_eq!(format_of(Path::new("X.MXL")), Some("mxl"));
        assert_eq!(format_of(Path::new("x.txt")), None);
        std::fs::remove_dir_all(dir).ok();
    }
}
