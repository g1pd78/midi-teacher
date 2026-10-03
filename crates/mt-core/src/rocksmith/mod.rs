//! Пользовательские песни Rocksmith 2014 (CDLC, файлы `.psarc` с CustomsForge):
//! партии гитары и баса с ладами, приёмами, долями, секциями и строем.
//!
//! Импортируются только CDLC — архивы, собранные Custom Song Toolkit или DLC Builder
//! (в них есть `toolkit.version`). Официальные DLC не открываются.

pub mod psarc;
pub mod sng;

use anyhow::{bail, Result};
use serde::Serialize;
use std::collections::BTreeMap;

pub use psarc::Psarc;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RsBeat {
    pub time: f32,
    /// Первая доля такта.
    pub downbeat: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RsNote {
    pub time: f32,
    /// Струна от низкой (0) к высокой.
    pub string: u8,
    /// Лад от порожка (с каподастром — абсолютный).
    pub fret: u8,
    pub sustain: f32,
    /// Приёмы — маска, см. [`sng::mask`].
    pub techniques: u32,
    /// Слайд к ладу.
    pub slide_to: Option<u8>,
    /// Бенд, в тонах.
    pub bend: f32,
    /// Нота аккорда: номер шаблона.
    pub chord: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RsSection {
    pub name: String,
    pub start: f32,
    pub end: f32,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RsChord {
    pub name: String,
    pub frets: [i8; 6],
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RsArrangement {
    /// Имя файла партии без расширения (постоянный id).
    pub id: String,
    /// «Lead», «Rhythm», «Bass», «Combo».
    pub name: String,
    pub bass: bool,
    /// Смещения струн от стандартного строя.
    pub tuning: Vec<i16>,
    pub capo: u8,
    pub cent_offset: f32,
    pub song_length: f32,
    pub beats: Vec<RsBeat>,
    pub notes: Vec<RsNote>,
    pub chords: Vec<RsChord>,
    pub sections: Vec<RsSection>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RsSong {
    pub title: String,
    pub artist: String,
    pub album: String,
    pub year: Option<i32>,
    pub arrangements: Vec<RsArrangement>,
}

fn stem(path: &str) -> &str {
    let file = path.rsplit('/').next().unwrap_or(path);
    file.rsplit_once('.').map(|(s, _)| s).unwrap_or(file)
}

/// Атрибуты партии из манифеста (JSON): первая запись `Entries.*.Attributes`.
fn attributes(json: &[u8]) -> Option<serde_json::Value> {
    let v: serde_json::Value = serde_json::from_slice(json).ok()?;
    v.get("Entries")?
        .as_object()?
        .values()
        .next()?
        .get("Attributes")
        .cloned()
}

/// Партия полной сложности: в каждом отрезке (повторе фразы) — ноты её самого сложного уровня;
/// ноты аккордов раскладываются по струнам.
pub fn full_arrangement(s: &sng::Sng) -> Vec<RsNote> {
    let mut out = Vec::new();
    for (pi_index, pi) in s.phrase_iterations.iter().enumerate() {
        let max = s
            .phrases
            .get(pi.phrase_id as usize)
            .map(|p| p.max_difficulty)
            .unwrap_or(0);
        // Уровня с такой сложностью может не быть — берём ближайший меньший.
        let level = s
            .levels
            .iter()
            .filter(|l| l.difficulty <= max)
            .max_by_key(|l| l.difficulty)
            .or_else(|| s.levels.first());
        let Some(level) = level else { continue };
        for n in level
            .notes
            .iter()
            .filter(|n| n.phrase_iteration_id == pi_index as i32)
        {
            if n.mask & sng::mask::IGNORE != 0 {
                continue;
            }
            let bend = n.max_bend;
            if n.chord_id >= 0 {
                let Some(ch) = s.chords.get(n.chord_id as usize) else {
                    continue;
                };
                let cn = (n.chord_notes_id >= 0)
                    .then(|| s.chord_notes.get(n.chord_notes_id as usize))
                    .flatten();
                for (string, &fret) in ch.frets.iter().enumerate() {
                    if fret < 0 {
                        continue;
                    }
                    let techniques = n.mask | cn.map(|c| c.mask[string]).unwrap_or(0);
                    let slide = cn
                        .map(|c| c.slide_to[string])
                        .filter(|&v| v >= 0)
                        .map(|v| v as u8);
                    out.push(RsNote {
                        time: n.time,
                        string: string as u8,
                        fret: fret as u8,
                        sustain: n.sustain,
                        techniques,
                        slide_to: slide,
                        bend,
                        chord: Some(n.chord_id as u32),
                    });
                }
            } else if n.string >= 0 && n.fret >= 0 {
                let slide = if n.slide_to >= 0 {
                    Some(n.slide_to as u8)
                } else if n.slide_unpitch_to >= 0 {
                    Some(n.slide_unpitch_to as u8)
                } else {
                    None
                };
                out.push(RsNote {
                    time: n.time,
                    string: n.string as u8,
                    fret: n.fret as u8,
                    sustain: n.sustain,
                    techniques: n.mask,
                    slide_to: slide,
                    bend,
                    chord: None,
                });
            }
        }
    }
    out.sort_by(|a, b| a.time.total_cmp(&b.time).then(a.string.cmp(&b.string)));
    out
}

/// Открыть пользовательскую песню (CDLC) из архива.
pub fn open_cdlc(data: Vec<u8>) -> Result<RsSong> {
    let archive = Psarc::parse(data)?;
    if !archive
        .names()
        .iter()
        .any(|n| n.ends_with("toolkit.version"))
    {
        bail!("это не пользовательская песня (CDLC): официальные DLC Rocksmith не импортируются");
    }
    // Манифесты партий: имя файла → атрибуты.
    let mut attrs: BTreeMap<String, serde_json::Value> = BTreeMap::new();
    for name in archive
        .names()
        .iter()
        .filter(|n| n.starts_with("manifests/") && n.ends_with(".json"))
    {
        if let Some(a) = archive.read(name).ok().as_deref().and_then(attributes) {
            attrs.insert(stem(name).to_lowercase(), a);
        }
    }
    let mut song = RsSong {
        title: String::new(),
        artist: String::new(),
        album: String::new(),
        year: None,
        arrangements: Vec::new(),
    };
    let text = |a: &serde_json::Value, k: &str| {
        a.get(k).and_then(|v| v.as_str()).unwrap_or("").to_string()
    };
    for name in archive.names().iter().filter(|n| n.ends_with(".sng")) {
        let platform = if name.contains("/macos/") {
            sng::Platform::Mac
        } else {
            sng::Platform::Pc
        };
        let raw = archive.read(name)?;
        let parsed = sng::parse(&sng::unpack(&raw, platform)?)?;
        if parsed.vocals > 0 || parsed.levels.is_empty() {
            continue; // слова песни
        }
        let id = stem(name).to_string();
        let a = attrs
            .get(&id.to_lowercase())
            .cloned()
            .unwrap_or(serde_json::Value::Null);
        if song.title.is_empty() {
            song.title = text(&a, "SongName");
            song.artist = text(&a, "ArtistName");
            song.album = text(&a, "AlbumName");
            song.year = a.get("SongYear").and_then(|v| v.as_i64()).map(|v| v as i32);
        }
        let arr_name = {
            let n = text(&a, "ArrangementName");
            if n.is_empty() {
                id.rsplit('_').next().unwrap_or("Lead").to_string()
            } else {
                n
            }
        };
        let props = a.get("ArrangementProperties");
        let bass = props
            .and_then(|p| p.get("pathBass"))
            .and_then(|v| v.as_i64())
            == Some(1)
            || arr_name.eq_ignore_ascii_case("bass");
        let tuning = a
            .get("Tuning")
            .and_then(|t| t.as_object())
            .map(|t| {
                (0..6)
                    .map(|i| {
                        t.get(&format!("string{i}"))
                            .and_then(|v| v.as_i64())
                            .unwrap_or(0) as i16
                    })
                    .collect()
            })
            .unwrap_or_else(|| parsed.tuning.clone());
        let capo = a
            .get("CapoFret")
            .and_then(|v| v.as_f64())
            .map(|v| v as i64)
            .unwrap_or(parsed.capo as i64)
            .clamp(0, 24) as u8;
        song.arrangements.push(RsArrangement {
            id,
            name: arr_name,
            bass,
            tuning,
            capo,
            cent_offset: a.get("CentOffset").and_then(|v| v.as_f64()).unwrap_or(0.0) as f32,
            song_length: parsed.song_length,
            beats: parsed
                .beats
                .iter()
                .map(|b| RsBeat {
                    time: b.time,
                    downbeat: b.first,
                })
                .collect(),
            notes: full_arrangement(&parsed),
            chords: parsed
                .chords
                .iter()
                .map(|c| RsChord {
                    name: c.name.clone(),
                    frets: c.frets,
                })
                .collect(),
            sections: parsed
                .sections
                .iter()
                .map(|s| RsSection {
                    name: s.name.clone(),
                    start: s.start,
                    end: s.end,
                })
                .collect(),
        });
    }
    if song.arrangements.is_empty() {
        bail!("в архиве нет партий гитары или баса");
    }
    // Порядок: соло-гитара, ритм, бас, остальное.
    let rank = |a: &RsArrangement| match a.name.to_lowercase().as_str() {
        "lead" => 0,
        "rhythm" => 1,
        "combo" => 2,
        "bass" => 3,
        _ => 4,
    };
    song.arrangements.sort_by_key(rank);
    Ok(song)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(name: &str) -> Vec<u8> {
        std::fs::read(
            concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/rocksmith/").to_string() + name,
        )
        .unwrap()
    }

    #[test]
    fn opens_cdlc_with_arrangements_tuning_and_sections() {
        let song = open_cdlc(fixture("test_p.psarc")).unwrap();
        assert_eq!(
            (song.title.as_str(), song.artist.as_str(), song.year),
            ("Test", "Test", Some(2020))
        );
        let names: Vec<&str> = song.arrangements.iter().map(|a| a.name.as_str()).collect();
        assert_eq!(names, ["Lead", "Rhythm"]);
        let lead = &song.arrangements[0];
        assert!(!lead.bass);
        assert_eq!(lead.tuning, vec![0; 6]);
        assert_eq!(lead.capo, 0);
        assert_eq!(lead.beats.len(), 234);
        assert!(lead.beats[0].downbeat);
        // Как в XML: такт — 4 доли.
        let downbeats: Vec<usize> = (0..12).filter(|&i| lead.beats[i].downbeat).collect();
        assert_eq!(downbeats, [0, 4, 8]);
        let sections: Vec<&str> = lead.sections.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(sections, ["intro", "solo", "noguitar"]);
        // Как в XML-версии партии: 7 аккордов (последний «игнорировать» не в счёт) — 19 нот по струнам.
        assert_eq!(lead.notes.len(), 19);
        let first: Vec<(u8, u8)> = lead
            .notes
            .iter()
            .take(3)
            .map(|n| (n.string, n.fret))
            .collect();
        assert_eq!(first, [(1, 5), (2, 4), (3, 2)]); // аккорд D
        assert_eq!(lead.chords[0].name, "D");
        assert!((lead.notes[0].time - 7.498).abs() < 0.01);
    }

    #[test]
    fn sng_of_pc_and_mac_unpack_to_the_same_chart() {
        let pc = sng::parse(&sng::unpack(&fixture("instrumental.sng"), sng::Platform::Pc).unwrap())
            .unwrap();
        assert_eq!(pc.levels.len(), 13);
        assert_eq!(pc.beats.len(), 294);
        let sections: Vec<&str> = pc.sections.iter().map(|s| s.name.as_str()).collect();
        assert_eq!(sections, ["riff", "interlude", "hook", "noguitar"]);
        assert_eq!(full_arrangement(&pc).len(), 82);
        let mac = sng::parse(&sng::unpack(&fixture("packed_mac.sng"), sng::Platform::Mac).unwrap())
            .unwrap();
        assert_eq!(mac.beats.len(), 294);
        assert_eq!(full_arrangement(&mac).len(), 76);
        // Неверный ключ — не SNG.
        assert!(sng::unpack(&fixture("packed_mac.sng"), sng::Platform::Pc).is_err());
    }

    /// Тестовая песня в JSON — для тестов интерфейса и имитации (`UPDATE_FIXTURES=1` — обновить).
    #[test]
    fn json_fixture_is_up_to_date() {
        let song = open_cdlc(fixture("test_p.psarc")).unwrap();
        let json = serde_json::to_string_pretty(&song).unwrap() + "\n";
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../src/lib/fixtures/rocksmith-test.json"
        );
        if std::env::var_os("UPDATE_FIXTURES").is_some() {
            std::fs::write(path, &json).unwrap();
        }
        let saved = std::fs::read_to_string(path).unwrap_or_default();
        assert!(
            saved == json,
            "{path} устарел: UPDATE_FIXTURES=1 cargo test -p mt-core rocksmith"
        );
    }

    #[test]
    fn rejects_non_psarc() {
        assert!(open_cdlc(b"not a psarc at all, definitely".to_vec()).is_err());
    }
}
