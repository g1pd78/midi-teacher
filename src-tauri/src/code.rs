//! Вкладка «Код» (Strudel): треки-код в папке «Документы\MIDI Teacher\Код», свои сэмплы в «Сэмплы»,
//! и протокол `mtsound`, через который Strudel получает звуки:
//!
//! - `gm/<программа>/<нота>.wav` и `drum/<нота>.wav` — нота из встроенного GM-банка (GeneralUser GS),
//!   рендер по запросу и кэш в памяти;
//! - `piano/<нота>.wav` — встроенный рояль;
//! - `user/<папка>/<файл>` — свои сэмплы; `rec/<папка>/<файл>` — свои записи (Гитара, Треки);
//! - `net/<url в base64url>` — стандартные наборы Strudel из интернета (только если включено), с кэшем на диске.

use crate::library::{library_dir, safe_path, unique_name};
use crate::AppState;
use base64::Engine;
use mt_core::guitar::dsp::wav_bytes;
use mt_core::synth::SoundFontSynth;
use parking_lot::Mutex;
use serde::Serialize;
use std::collections::{BTreeMap, HashMap};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::UNIX_EPOCH;
use tauri::http::{Request, Response, StatusCode};
use tauri::{AppHandle, Manager, UriSchemeContext, UriSchemeResponder, Wry};

pub const SCHEME: &str = "mtsound";
const RATE: u32 = 32_000;
const AUDIO_EXT: [&str; 5] = ["wav", "ogg", "mp3", "flac", "m4a"];
/// Папки своих записей внутри библиотеки.
const REC_DIRS: [&str; 2] = ["Гитара", "Треки"];

#[derive(Default)]
pub struct CodeHub {
    gm: Mutex<Option<Arc<SoundFontSynth>>>,
    piano: Mutex<Option<Arc<SoundFontSynth>>>,
    cache: Mutex<HashMap<String, Arc<Vec<u8>>>>,
}

fn sub_dir(app: &AppHandle, name: &str) -> Result<PathBuf, String> {
    let dir = library_dir(app)?.join(name);
    std::fs::create_dir_all(&dir).map_err(|e| format!("не удалось создать папку {name}: {e}"))?;
    Ok(dir)
}

fn code_dir(app: &AppHandle) -> Result<PathBuf, String> {
    sub_dir(app, "Код")
}

fn samples_dir(app: &AppHandle) -> Result<PathBuf, String> {
    sub_dir(app, "Сэмплы")
}

/// Имя файла трека: без путей, `.js` или настройки панели `.mt.json`.
fn safe_name(name: &str) -> Result<&str, String> {
    let lower = name.to_lowercase();
    let ok_ext = lower.ends_with(".js") || lower.ends_with(".mt.json");
    if !ok_ext
        || name.starts_with('.')
        || name.contains(['/', '\\', ':', '*', '?', '"', '<', '>', '|'])
    {
        return Err(format!("недопустимое имя файла: {name}"));
    }
    Ok(name)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodeFile {
    name: String,
    modified: u64,
}

fn modified_ms(path: &Path) -> u64 {
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[tauri::command]
pub fn code_folder(app: AppHandle) -> Result<String, String> {
    Ok(code_dir(&app)?.display().to_string())
}

/// Треки-код (`*.js`), новые сверху.
#[tauri::command]
pub fn code_list(app: AppHandle) -> Result<Vec<CodeFile>, String> {
    let dir = code_dir(&app)?;
    let mut out: Vec<CodeFile> = std::fs::read_dir(&dir)
        .map_err(|e| e.to_string())?
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().is_some_and(|x| x.eq_ignore_ascii_case("js")))
        .map(|p| CodeFile {
            name: p.file_name().unwrap().to_string_lossy().into_owned(),
            modified: modified_ms(&p),
        })
        .collect();
    out.sort_by(|a, b| b.modified.cmp(&a.modified).then(a.name.cmp(&b.name)));
    Ok(out)
}

/// Текст и время изменения файла (`None`, если файла нет).
#[tauri::command]
pub fn code_read(app: AppHandle, name: String) -> Result<Option<(String, u64)>, String> {
    let path = code_dir(&app)?.join(safe_name(&name)?);
    match std::fs::read_to_string(&path) {
        Ok(t) => Ok(Some((t, modified_ms(&path)))),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("не удалось прочитать {name}: {e}")),
    }
}

/// Сохранить; возвращает новое время изменения.
#[tauri::command]
pub fn code_write(app: AppHandle, name: String, text: String) -> Result<u64, String> {
    let path = code_dir(&app)?.join(safe_name(&name)?);
    std::fs::write(&path, text).map_err(|e| format!("не удалось сохранить {name}: {e}"))?;
    Ok(modified_ms(&path))
}

/// Новый файл со свободным именем «<имя>.js», «<имя> (2).js»…; возвращает имя.
#[tauri::command]
pub fn code_create(app: AppHandle, name: String, text: String) -> Result<String, String> {
    let dir = code_dir(&app)?;
    let base = clean(&name);
    let file = unique_name(
        &dir,
        &format!("{}.js", if base.is_empty() { "трек" } else { &base }),
    );
    safe_name(&file)?;
    std::fs::write(dir.join(&file), text).map_err(|e| format!("не удалось создать {file}: {e}"))?;
    Ok(file)
}

#[tauri::command]
pub fn code_rename(app: AppHandle, from: String, to: String) -> Result<String, String> {
    let dir = code_dir(&app)?;
    let src = dir.join(safe_name(&from)?);
    let base = clean(to.trim_end_matches(".js"));
    if base.is_empty() {
        return Err("пустое имя".into());
    }
    let file = format!("{base}.js");
    if file == from {
        return Ok(file);
    }
    let file = unique_name(&dir, &file);
    std::fs::rename(&src, dir.join(&file)).map_err(|e| format!("не удалось переименовать: {e}"))?;
    let (old_cfg, new_cfg) = (settings_name(&from), settings_name(&file));
    let _ = std::fs::rename(dir.join(old_cfg), dir.join(new_cfg));
    Ok(file)
}

#[tauri::command]
pub fn code_delete(app: AppHandle, name: String) -> Result<(), String> {
    let dir = code_dir(&app)?;
    for f in [safe_name(&name)?.to_string(), settings_name(&name)] {
        match std::fs::remove_file(dir.join(&f)) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(format!("не удалось удалить {f}: {e}")),
        }
    }
    Ok(())
}

/// «трек.js» → «трек.mt.json» (настройки панели рядом с файлом).
fn settings_name(js: &str) -> String {
    format!("{}.mt.json", js.strip_suffix(".js").unwrap_or(js))
}

fn clean(name: &str) -> String {
    name.chars()
        .map(|c| if "/\\:*?\"<>|".contains(c) { '-' } else { c })
        .collect::<String>()
        .trim()
        .trim_start_matches('.')
        .to_string()
}

/// Открыть папку «Код» или «Сэмплы» в проводнике.
#[tauri::command]
pub fn code_open_folder(app: AppHandle, which: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    let dir = if which == "samples" {
        samples_dir(&app)?
    } else {
        code_dir(&app)?
    };
    app.opener()
        .open_path(dir.display().to_string(), None::<&str>)
        .map_err(|e| e.to_string())
}

/// Свои сэмплы и записи: `user` — подпапка «Сэмплы» → файлы (имя звука = подпапка; файлы прямо в «Сэмплы»
/// — каждый сам по себе звук по имени файла); `rec` — WAV из «Гитара» и «Треки» как `папка/файл`.
#[derive(Serialize, Default)]
pub struct SampleBanks {
    user: BTreeMap<String, Vec<String>>,
    rec: Vec<String>,
}

fn audio_files(dir: &Path) -> Vec<String> {
    let mut v: Vec<String> = std::fs::read_dir(dir)
        .map(|r| {
            r.filter_map(|e| e.ok().map(|e| e.path()))
                .filter(|p| p.is_file() && is_audio(p))
                .map(|p| p.file_name().unwrap().to_string_lossy().into_owned())
                .collect()
        })
        .unwrap_or_default();
    v.sort();
    v
}

fn is_audio(p: &Path) -> bool {
    p.extension()
        .and_then(|x| x.to_str())
        .is_some_and(|x| AUDIO_EXT.contains(&x.to_lowercase().as_str()))
}

/// Имя звука для Strudel: латиница, цифры, «_» и «-» как есть, остальное — «_».
pub fn sound_name(s: &str) -> String {
    s.chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '_' || c == '-' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

pub fn sample_banks(samples: &Path, library: &Path) -> SampleBanks {
    let mut banks = SampleBanks::default();
    if let Ok(rd) = std::fs::read_dir(samples) {
        for p in rd.filter_map(|e| e.ok().map(|e| e.path())) {
            let name = p.file_name().unwrap().to_string_lossy().into_owned();
            if p.is_dir() {
                let files: Vec<String> = audio_files(&p)
                    .into_iter()
                    .map(|f| format!("{name}/{f}"))
                    .collect();
                if !files.is_empty() {
                    banks.user.insert(sound_name(&name), files);
                }
            } else if is_audio(&p) {
                let stem = p.file_stem().unwrap().to_string_lossy().into_owned();
                banks.user.entry(sound_name(&stem)).or_default().push(name);
            }
        }
    }
    for d in REC_DIRS {
        banks.rec.extend(
            audio_files(&library.join(d))
                .into_iter()
                .map(|f| format!("{d}/{f}")),
        );
    }
    banks
}

#[tauri::command]
pub fn code_sample_banks(app: AppHandle) -> Result<SampleBanks, String> {
    Ok(sample_banks(&samples_dir(&app)?, &library_dir(&app)?))
}

/// Скопировать перетащенные файлы в «Сэмплы\<папка>»; возвращает имя звука.
#[tauri::command]
pub fn code_import_samples(
    app: AppHandle,
    paths: Vec<String>,
    folder: String,
) -> Result<String, String> {
    let name = clean(&folder);
    if name.is_empty() {
        return Err("пустое имя звука".into());
    }
    let dir = samples_dir(&app)?.join(&name);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    // Папку — по её звуковым файлам (без вложенных), по алфавиту.
    let mut files = Vec::new();
    for p in paths.iter().map(PathBuf::from) {
        if p.is_dir() {
            let mut inner: Vec<PathBuf> = std::fs::read_dir(&p)
                .map_err(|e| e.to_string())?
                .filter_map(|e| e.ok().map(|e| e.path()))
                .filter(|f| f.is_file() && is_audio(f))
                .collect();
            inner.sort();
            files.extend(inner);
        } else if is_audio(&p) {
            files.push(p);
        }
    }
    if files.is_empty() {
        return Err("нет звуковых файлов (wav, ogg, mp3, flac)".into());
    }
    for p in files {
        let file = p
            .file_name()
            .ok_or("неверный путь")?
            .to_string_lossy()
            .into_owned();
        let target = dir.join(unique_name(&dir, &file));
        std::fs::copy(&p, &target).map_err(|e| format!("не удалось скопировать {file}: {e}"))?;
    }
    Ok(sound_name(&name))
}

/// Сохранить звук трека (WAV в base64) в «Треки»; возвращает путь.
#[tauri::command]
pub fn code_save_wav(app: AppHandle, name: String, data: String) -> Result<String, String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data)
        .map_err(|e| format!("неверные данные WAV: {e}"))?;
    if bytes.len() < 44 || &bytes[0..4] != b"RIFF" {
        return Err("это не WAV".into());
    }
    let dir = sub_dir(&app, "Треки")?;
    let base = clean(&name);
    let file = unique_name(
        &dir,
        &format!("{}.wav", if base.is_empty() { "трек" } else { &base }),
    );
    let path = dir.join(file);
    std::fs::write(&path, bytes).map_err(|e| format!("WAV не сохранён: {e}"))?;
    Ok(path.display().to_string())
}

/// Текст по ссылке (карта стандартного набора Strudel) — с кэшем на диске, чтобы работало и без сети.
#[tauri::command]
pub async fn code_net_text(app: AppHandle, url: String) -> Result<String, String> {
    let bytes = tauri::async_runtime::spawn_blocking(move || net_cached(&app, &url))
        .await
        .map_err(|e| e.to_string())??;
    String::from_utf8(bytes).map_err(|e| e.to_string())
}

fn net_cache_path(app: &AppHandle, url: &str) -> Result<PathBuf, String> {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    url.hash(&mut h);
    let ext = Path::new(url.split(['?', '#']).next().unwrap_or(url))
        .extension()
        .and_then(|x| x.to_str())
        .filter(|x| x.len() <= 5)
        .unwrap_or("bin")
        .to_lowercase();
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join("strudel-samples");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join(format!("{:016x}.{ext}", h.finish())))
}

fn net_cached(app: &AppHandle, url: &str) -> Result<Vec<u8>, String> {
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("нужна ссылка http(s)".into());
    }
    let path = net_cache_path(app, url)?;
    if let Ok(b) = std::fs::read(&path) {
        return Ok(b);
    }
    let resp = ureq::get(url)
        .timeout(std::time::Duration::from_secs(30))
        .call()
        .map_err(|e| format!("не удалось скачать {url}: {e}"))?;
    let mut bytes = Vec::new();
    resp.into_reader()
        .take(64 << 20)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    let tmp = path.with_extension("part");
    if std::fs::write(&tmp, &bytes).is_ok() {
        let _ = std::fs::rename(&tmp, &path);
    }
    Ok(bytes)
}

// --- Протокол mtsound ---

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Что просит Strudel по пути протокола.
#[derive(Debug, PartialEq)]
pub enum SoundReq {
    Gm { program: u8, note: u8 },
    Drum { note: u8 },
    Piano { note: u8 },
    User(String),
    Rec(String),
    Net(String),
}

pub fn parse_sound_path(raw: &str) -> Option<SoundReq> {
    let path = percent_decode(raw.trim_start_matches('/'));
    let path = path.trim_start_matches('/');
    let num = |s: &str| {
        s.trim_end_matches(".wav")
            .parse::<u8>()
            .ok()
            .filter(|n| *n < 128)
    };
    let (kind, rest) = path.split_once('/')?;
    let clean_rel = |r: &str| -> Option<String> {
        let ok = !r.is_empty()
            && r.split('/').all(|c| !c.is_empty() && c != "." && c != "..")
            && !r.contains('\\');
        ok.then(|| r.to_string())
    };
    match kind {
        "gm" => {
            let (p, n) = rest.split_once('/')?;
            Some(SoundReq::Gm {
                program: num(p)?,
                note: num(n)?,
            })
        }
        "drum" => Some(SoundReq::Drum { note: num(rest)? }),
        "piano" => Some(SoundReq::Piano { note: num(rest)? }),
        "user" => clean_rel(rest).map(SoundReq::User),
        "rec" => clean_rel(rest)
            .filter(|r| REC_DIRS.iter().any(|d| r.starts_with(&format!("{d}/"))))
            .map(SoundReq::Rec),
        "net" => {
            let url = base64::engine::general_purpose::URL_SAFE_NO_PAD
                .decode(rest.trim_end_matches('='))
                .ok()?;
            String::from_utf8(url).ok().map(SoundReq::Net)
        }
        _ => None,
    }
}

impl CodeHub {
    fn synth(
        slot: &Mutex<Option<Arc<SoundFontSynth>>>,
        path: Option<PathBuf>,
    ) -> Result<Arc<SoundFontSynth>, String> {
        let mut g = slot.lock();
        if let Some(s) = g.as_ref() {
            return Ok(s.clone());
        }
        let path = path.ok_or("встроенный SoundFont не найден")?;
        let s = Arc::new(SoundFontSynth::load(&path, RATE).map_err(|e| e.to_string())?);
        *g = Some(s.clone());
        Ok(s)
    }

    fn render(&self, app: &AppHandle, req: &SoundReq) -> Result<Vec<u8>, String> {
        let state = app.state::<AppState>();
        let (synth, channel, program, note, hold) = match *req {
            SoundReq::Gm { program, note } => (
                Self::synth(&self.gm, state.bundled_gm())?,
                0,
                program,
                note,
                1500,
            ),
            SoundReq::Drum { note } => {
                (Self::synth(&self.gm, state.bundled_gm())?, 9, 0, note, 300)
            }
            SoundReq::Piano { note } => (
                Self::synth(&self.piano, state.bundled_soundfont())?,
                0,
                0,
                note,
                2500,
            ),
            _ => unreachable!(),
        };
        let pcm = synth
            .render_one_shot(channel, program, note, 100, hold, RATE)
            .map_err(|e| e.to_string())?;
        Ok(wav_bytes(&pcm, RATE))
    }

    fn serve(&self, app: &AppHandle, raw_path: &str) -> Result<Served, (StatusCode, String)> {
        let req = parse_sound_path(raw_path).ok_or((
            StatusCode::NOT_FOUND,
            format!("нет такого звука: {raw_path}"),
        ))?;
        let err = |e: String| (StatusCode::INTERNAL_SERVER_ERROR, e);
        match &req {
            SoundReq::Gm { .. } | SoundReq::Drum { .. } | SoundReq::Piano { .. } => {
                let key = format!("{req:?}");
                if let Some(b) = self.cache.lock().get(&key) {
                    return Ok((b.clone(), "audio/wav"));
                }
                let bytes = Arc::new(self.render(app, &req).map_err(err)?);
                self.cache.lock().insert(key, bytes.clone());
                Ok((bytes, "audio/wav"))
            }
            SoundReq::User(rel) | SoundReq::Rec(rel) => {
                let base = if matches!(req, SoundReq::User(_)) {
                    samples_dir(app)
                } else {
                    library_dir(app)
                }
                .map_err(err)?;
                let mut path = base;
                for c in rel.split('/') {
                    path = safe_path(&path, c).map_err(err)?;
                }
                let bytes =
                    std::fs::read(&path).map_err(|e| (StatusCode::NOT_FOUND, e.to_string()))?;
                Ok((Arc::new(bytes), mime(rel)))
            }
            SoundReq::Net(url) => {
                let bytes = net_cached(app, url).map_err(err)?;
                Ok((Arc::new(bytes), mime(url)))
            }
        }
    }
}

/// Ответ протокола: байты и MIME-тип.
type Served = (Arc<Vec<u8>>, &'static str);

fn mime(name: &str) -> &'static str {
    let lower = name.to_lowercase();
    match lower.rsplit('.').next().unwrap_or("") {
        "wav" => "audio/wav",
        "ogg" => "audio/ogg",
        "mp3" => "audio/mpeg",
        "flac" => "audio/flac",
        "m4a" => "audio/mp4",
        "json" => "application/json",
        _ => "application/octet-stream",
    }
}

/// Обработчик протокола: рендер и чтение файлов — в отдельном потоке, чтобы не держать окно.
pub fn protocol(
    ctx: UriSchemeContext<'_, Wry>,
    request: Request<Vec<u8>>,
    responder: UriSchemeResponder,
) {
    let app = ctx.app_handle().clone();
    let path = request.uri().path().to_string();
    std::thread::spawn(move || {
        let hub = app.state::<Arc<CodeHub>>();
        let resp = match hub.serve(&app, &path) {
            Ok((bytes, mime)) => Response::builder()
                .status(StatusCode::OK)
                .header("Content-Type", mime)
                .header("Access-Control-Allow-Origin", "*")
                .body(bytes.to_vec()),
            Err((status, msg)) => Response::builder()
                .status(status)
                .header("Access-Control-Allow-Origin", "*")
                .body(msg.into_bytes()),
        };
        responder.respond(resp.unwrap_or_else(|_| Response::new(Vec::new())));
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_and_paths() {
        assert!(safe_name("бит.js").is_ok());
        assert!(safe_name("бит.mt.json").is_ok());
        assert!(safe_name("../x.js").is_err());
        assert!(safe_name("x.exe").is_err());
        assert_eq!(settings_name("бит.js"), "бит.mt.json");
        assert_eq!(sound_name("whatUneed"), "whatUneed");
        assert_eq!(sound_name("мой бит"), "мой_бит");
    }

    #[test]
    fn sound_paths() {
        assert_eq!(
            parse_sound_path("/gm/33/40.wav"),
            Some(SoundReq::Gm {
                program: 33,
                note: 40
            })
        );
        assert_eq!(
            parse_sound_path("/gm%2F0%2F60.wav"),
            Some(SoundReq::Gm {
                program: 0,
                note: 60
            })
        );
        assert_eq!(
            parse_sound_path("/drum/36.wav"),
            Some(SoundReq::Drum { note: 36 })
        );
        assert_eq!(parse_sound_path("/piano/200.wav"), None);
        assert_eq!(
            parse_sound_path("/user/%D0%B1%D0%B8%D1%82/1.wav"),
            Some(SoundReq::User("бит/1.wav".into()))
        );
        assert_eq!(parse_sound_path("/user/../x.wav"), None);
        assert_eq!(
            parse_sound_path("/rec/Гитара/a.wav"),
            Some(SoundReq::Rec("Гитара/a.wav".into()))
        );
        assert_eq!(parse_sound_path("/rec/Код/a.wav"), None);
        let url = "https://raw.githubusercontent.com/x/y.wav";
        let enc = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(url);
        assert_eq!(
            parse_sound_path(&format!("/net/{enc}")),
            Some(SoundReq::Net(url.into()))
        );
    }

    #[test]
    fn banks_from_folders() {
        let root = std::env::temp_dir().join(format!("mt-code-banks-{}", std::process::id()));
        let samples = root.join("Сэмплы");
        std::fs::create_dir_all(samples.join("whatUneed")).unwrap();
        std::fs::write(samples.join("whatUneed/1.wav"), b"x").unwrap();
        std::fs::write(samples.join("whatUneed/2.wav"), b"x").unwrap();
        std::fs::write(samples.join("whatUneed/notes.txt"), b"x").unwrap();
        std::fs::write(samples.join("клап.wav"), b"x").unwrap();
        std::fs::create_dir_all(root.join("Гитара")).unwrap();
        std::fs::write(root.join("Гитара/рифф.wav"), b"x").unwrap();
        let b = sample_banks(&samples, &root);
        assert_eq!(
            b.user["whatUneed"],
            vec!["whatUneed/1.wav", "whatUneed/2.wav"]
        );
        assert_eq!(b.user["клап"], vec!["клап.wav"]);
        assert_eq!(b.rec, vec!["Гитара/рифф.wav"]);
        let _ = std::fs::remove_dir_all(&root);
    }
}
