//! Плагины: папка `plugins` в данных приложения, по подпапке на плагин с `plugin.json`.
//!
//! Нет папки — нет плагинов, и интерфейс ничего о них не показывает. Файлы плагина (ES-модуль, WASM, модели)
//! отдаёт протокол `mtplugin://<id>/<путь>`; свои настройки плагин хранит в `storage.json` своей папки.
//! API для плагинов — `src/plugins/host.ts`, описание — `docs/plugins.md`.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::http::{Request, Response, StatusCode};
use tauri::{AppHandle, Manager, Runtime, UriSchemeContext, UriSchemeResponder};

pub const SCHEME: &str = "mtplugin";
/// Версия API хоста: плагин с другой версией не загружается.
pub const API_VERSION: u32 = 1;
const MANIFEST: &str = "plugin.json";
const STORAGE: &str = "storage.json";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginManifest {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub version: String,
    /// Версия API хоста, под которую написан плагин.
    pub api: u32,
    /// ES-модуль с функцией `activate(host)`, путь внутри папки плагина.
    pub entry: String,
}

/// Имя без путей: буквы, цифры, «-», «_», «.» (не «..»).
fn safe_id(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 64
        && s != "."
        && s != ".."
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

/// Относительный путь внутри папки плагина без выхода наружу.
fn safe_rel(s: &str) -> bool {
    !s.is_empty()
        && !s.contains('\\')
        && s.split('/').all(|c| !c.is_empty() && c != "." && c != "..")
}

/// Плагины в папке `dir`: только корректные манифесты, у которых `id` совпадает с именем папки.
pub fn scan(dir: &Path) -> Vec<PluginManifest> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut out: Vec<PluginManifest> = entries
        .flatten()
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            let text = std::fs::read_to_string(e.path().join(MANIFEST)).ok()?;
            match serde_json::from_str::<PluginManifest>(&text) {
                Ok(m) if m.api != API_VERSION => {
                    log::warn!(
                        "плагин {name}: API {} не поддерживается (нужен {API_VERSION})",
                        m.api
                    );
                    None
                }
                Ok(m) if m.id == name && safe_id(&m.id) && safe_rel(&m.entry) => Some(m),
                Ok(_) => {
                    log::warn!("плагин {name}: id не совпадает с папкой или неверный путь entry");
                    None
                }
                Err(err) => {
                    log::warn!("плагин {name}: {MANIFEST}: {err}");
                    None
                }
            }
        })
        .collect();
    out.sort_by(|a, b| a.id.cmp(&b.id));
    out
}

pub fn plugins_dir<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join("plugins"))
}

/// Тип файла по расширению (WASM должен отдаваться как application/wasm).
pub fn mime(path: &str) -> &'static str {
    match path
        .rsplit('.')
        .next()
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "js" | "mjs" => "text/javascript",
        "wasm" => "application/wasm",
        "json" => "application/json",
        "css" => "text/css",
        "html" => "text/html",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        _ => "application/octet-stream",
    }
}

/// `%D0%AD` → байты UTF-8; неверная запись — `None`.
fn percent_decode(s: &str) -> Option<String> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' {
            let hex = std::str::from_utf8(b.get(i + 1..i + 3)?).ok()?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// Путь `/<id>/<файл>` протокола → файл в папке плагина.
pub fn resolve(dir: &Path, uri_path: &str) -> Option<PathBuf> {
    let path = percent_decode(uri_path)?;
    let path = path.trim_start_matches('/');
    let (id, rel) = path.split_once('/')?;
    (safe_id(id) && safe_rel(rel)).then(|| dir.join(id).join(rel))
}

pub fn protocol<R: Runtime>(
    ctx: UriSchemeContext<'_, R>,
    request: Request<Vec<u8>>,
    responder: UriSchemeResponder,
) {
    let dir = plugins_dir(ctx.app_handle());
    let path = request.uri().path().to_string();
    std::thread::spawn(move || {
        let file = dir.as_deref().and_then(|d| resolve(d, &path));
        let resp = match file.and_then(|f| std::fs::read(&f).ok()) {
            Some(bytes) => Response::builder()
                .status(StatusCode::OK)
                .header("Content-Type", mime(&path))
                .header("Access-Control-Allow-Origin", "*")
                .body(bytes),
            None => Response::builder()
                .status(StatusCode::NOT_FOUND)
                .header("Access-Control-Allow-Origin", "*")
                .body(Vec::new()),
        };
        responder.respond(resp.unwrap_or_else(|_| Response::new(Vec::new())));
    });
}

/// Установленные плагины (папка читается при каждом вызове: перезагрузка окна подхватывает новые).
#[tauri::command]
pub fn plugin_list(app: AppHandle) -> Vec<PluginManifest> {
    plugins_dir(&app).map(|d| scan(&d)).unwrap_or_default()
}

/// Настройки плагина (JSON-текст) или `None`, если их ещё нет.
#[tauri::command]
pub fn plugin_storage_get(app: AppHandle, id: String) -> Result<Option<String>, String> {
    let dir = plugins_dir(&app).ok_or("нет папки данных")?;
    if !safe_id(&id) {
        return Err("неверный id плагина".into());
    }
    Ok(std::fs::read_to_string(dir.join(&id).join(STORAGE)).ok())
}

#[tauri::command]
pub fn plugin_storage_set(app: AppHandle, id: String, value: String) -> Result<(), String> {
    let dir = plugins_dir(&app).ok_or("нет папки данных")?;
    if !safe_id(&id) || !dir.join(&id).is_dir() {
        return Err("неверный id плагина".into());
    }
    serde_json::from_str::<serde_json::Value>(&value).map_err(|e| format!("не JSON: {e}"))?;
    std::fs::write(dir.join(&id).join(STORAGE), value).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scans_only_valid_plugins() {
        let tmp = std::env::temp_dir().join(format!("mt-plugins-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        assert!(scan(&tmp).is_empty(), "нет папки — нет плагинов");
        let mk = |dir: &str, json: &str| {
            std::fs::create_dir_all(tmp.join(dir)).unwrap();
            std::fs::write(tmp.join(dir).join(MANIFEST), json).unwrap();
        };
        mk(
            "echo",
            r#"{"id":"echo","name":"Эхо","version":"1.0","api":1,"entry":"plugin.js"}"#,
        );
        mk(
            "other",
            r#"{"id":"wrong","name":"x","api":1,"entry":"plugin.js"}"#,
        );
        mk(
            "bad",
            r#"{"id":"bad","name":"x","api":1,"entry":"../evil.js"}"#,
        );
        mk("broken", "{");
        mk(
            "future",
            r#"{"id":"future","name":"x","api":99,"entry":"plugin.js"}"#,
        );
        std::fs::create_dir_all(tmp.join("empty")).unwrap();
        let found = scan(&tmp);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].name, "Эхо");
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn protocol_paths_stay_inside() {
        let d = Path::new("/p");
        assert_eq!(
            resolve(d, "/echo/plugin.js"),
            Some(PathBuf::from("/p/echo/plugin.js"))
        );
        assert_eq!(
            resolve(d, "/echo/wasm/a.wasm"),
            Some(PathBuf::from("/p/echo/wasm/a.wasm"))
        );
        assert_eq!(resolve(d, "/echo/../x"), None);
        assert_eq!(resolve(d, "/../echo/x"), None);
        assert_eq!(resolve(d, "/echo"), None);
        assert_eq!(
            resolve(d, "/echo/%D0%BC%D0%BE%D0%B4%D0%B5%D0%BB%D1%8C.task"),
            Some(PathBuf::from("/p/echo/модель.task"))
        );
        assert_eq!(resolve(d, "/echo/%2E%2E/x"), None);
        assert_eq!(resolve(d, "/echo/%zz"), None);
        assert_eq!(mime("a.wasm"), "application/wasm");
        assert_eq!(mime("plugin.js"), "text/javascript");
        assert_eq!(mime("model.task"), "application/octet-stream");
    }
}
