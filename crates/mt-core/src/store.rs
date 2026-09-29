//! Хранилище прогресса (SQLite в каталоге данных приложения).

use crate::trainer::{Clef, ErrorMode, NoteResult, NoteStat, Stats, Summary};
use anyhow::Result;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use std::path::Path;

/// После скольких попыток статистика ноты начинает «забывать» старое:
/// вес ~20 последних попыток, чтобы прогресс быстро отражался в подборе.
const STAT_WINDOW: f64 = 20.0;

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS trainer_note_stats (
    clef TEXT NOT NULL,
    midi INTEGER NOT NULL,
    attempts REAL NOT NULL,
    first_try REAL NOT NULL,
    reaction_ms_total REAL NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (clef, midi)
);
CREATE TABLE IF NOT EXISTS trainer_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    level INTEGER NOT NULL,
    mode TEXT NOT NULL,
    finished_at INTEGER NOT NULL,
    notes INTEGER NOT NULL,
    first_try INTEGER NOT NULL,
    avg_reaction_ms INTEGER NOT NULL,
    passed INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS kv (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
";

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LevelStat {
    pub level: u32,
    pub sessions: u32,
    pub best_accuracy: f64,
    pub last_accuracy: f64,
    pub last_reaction_ms: u32,
    pub passed: bool,
}

pub struct Store {
    conn: Connection,
}

impl Store {
    pub fn open(path: &Path) -> Result<Self> {
        Self::init(Connection::open(path)?)
    }

    pub fn open_in_memory() -> Result<Self> {
        Self::init(Connection::open_in_memory()?)
    }

    fn init(conn: Connection) -> Result<Self> {
        conn.execute_batch(SCHEMA)?;
        Ok(Self { conn })
    }

    pub fn note_stats(&self) -> Result<Stats> {
        let mut stmt = self.conn.prepare(
            "SELECT clef, midi, attempts, first_try, reaction_ms_total FROM trainer_note_stats",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, u8>(1)?,
                NoteStat {
                    attempts: r.get(2)?,
                    first_try: r.get(3)?,
                    reaction_ms_total: r.get(4)?,
                },
            ))
        })?;
        let mut out = Stats::new();
        for row in rows {
            let (clef, midi, stat) = row?;
            if let Some(clef) = Clef::parse(&clef) {
                out.insert((clef, midi), stat);
            }
        }
        Ok(out)
    }

    /// Самая высокая открытая ступень (первая открыта всегда).
    pub fn unlocked_level(&self) -> Result<u32> {
        let v: Option<String> = self
            .conn
            .query_row(
                "SELECT value FROM kv WHERE key = 'trainer_unlocked'",
                [],
                |r| r.get(0),
            )
            .optional()?;
        Ok(v.and_then(|s| s.parse().ok()).unwrap_or(1).max(1))
    }

    /// Сохраняет серию. Если серия пройдена на самой высокой открытой ступени,
    /// открывает следующую (не выше `max_level`) и возвращает её номер.
    pub fn record_session(
        &mut self,
        mode: ErrorMode,
        results: &[NoteResult],
        summary: &Summary,
        max_level: u32,
        now_secs: i64,
    ) -> Result<Option<u32>> {
        let tx = self.conn.transaction()?;
        for r in results {
            let (a, f, rt): (f64, f64, f64) = tx
                .query_row(
                    "SELECT attempts, first_try, reaction_ms_total FROM trainer_note_stats
                     WHERE clef = ?1 AND midi = ?2",
                    params![r.clef.as_str(), r.midi],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .optional()?
                .unwrap_or((0.0, 0.0, 0.0));
            // Скользящее окно: старые попытки постепенно теряют вес.
            let keep = if a >= STAT_WINDOW {
                (STAT_WINDOW - 1.0) / a
            } else {
                1.0
            };
            tx.execute(
                "INSERT INTO trainer_note_stats (clef, midi, attempts, first_try, reaction_ms_total, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                 ON CONFLICT(clef, midi) DO UPDATE SET
                   attempts = excluded.attempts, first_try = excluded.first_try,
                   reaction_ms_total = excluded.reaction_ms_total, updated_at = excluded.updated_at",
                params![
                    r.clef.as_str(),
                    r.midi,
                    a * keep + 1.0,
                    f * keep + if r.first_try { 1.0 } else { 0.0 },
                    rt * keep + r.reaction_ms as f64,
                    now_secs
                ],
            )?;
        }
        tx.execute(
            "INSERT INTO trainer_sessions (level, mode, finished_at, notes, first_try, avg_reaction_ms, passed)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                summary.level,
                mode.as_str(),
                now_secs,
                summary.notes as i64,
                summary.first_try as i64,
                summary.avg_reaction_ms,
                summary.passed
            ],
        )?;

        let unlocked: u32 = tx
            .query_row(
                "SELECT value FROM kv WHERE key = 'trainer_unlocked'",
                [],
                |r| r.get::<_, String>(0),
            )
            .optional()?
            .and_then(|s| s.parse().ok())
            .unwrap_or(1);
        let mut newly = None;
        if summary.passed && summary.level >= unlocked && summary.level < max_level {
            let next = summary.level + 1;
            tx.execute(
                "INSERT INTO kv (key, value) VALUES ('trainer_unlocked', ?1)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                params![next.to_string()],
            )?;
            newly = Some(next);
        }
        tx.commit()?;
        Ok(newly)
    }

    pub fn level_stats(&self) -> Result<Vec<LevelStat>> {
        let mut stmt = self.conn.prepare(
            "SELECT level, COUNT(*),
                    MAX(CAST(first_try AS REAL) / MAX(notes, 1)),
                    MAX(passed)
             FROM trainer_sessions GROUP BY level ORDER BY level",
        )?;
        let base: Vec<(u32, u32, f64, bool)> = stmt
            .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?
            .collect::<rusqlite::Result<_>>()?;
        let mut out = Vec::new();
        for (level, sessions, best, passed) in base {
            let (last_acc, last_rt): (f64, u32) = self.conn.query_row(
                "SELECT CAST(first_try AS REAL) / MAX(notes, 1), avg_reaction_ms
                 FROM trainer_sessions WHERE level = ?1 ORDER BY id DESC LIMIT 1",
                params![level],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )?;
            out.push(LevelStat {
                level,
                sessions,
                best_accuracy: best,
                last_accuracy: last_acc,
                last_reaction_ms: last_rt,
                passed,
            });
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::trainer::{Session, Target};

    fn target(midi: u8) -> Target {
        Target {
            id: format!("n{midi}"),
            midi,
            clef: Clef::Treble,
            step: 'c',
            alter: 0,
            octave: 4,
        }
    }

    /// Серия на ступени `level`: `wrong` нот с одной ошибкой, реакция `ms`.
    fn play(level: u32, notes: &[u8], wrong: usize, ms: u64) -> Session {
        let targets = notes.iter().map(|&m| target(m)).collect();
        let mut s = Session::new(level, ErrorMode::Wait, targets, 0);
        let mut t = 0;
        for (i, &m) in notes.iter().enumerate() {
            if i < wrong {
                s.on_note(m + 1, t + 1);
            }
            t += ms * 1000;
            s.on_note(m, t);
        }
        s
    }

    #[test]
    fn stats_accumulate_and_unlock_progresses() {
        let mut store = Store::open_in_memory().unwrap();
        assert_eq!(store.unlocked_level().unwrap(), 1);

        // Неудачная серия: ничего не открывается, статистика копится.
        let s = play(1, &[60, 62, 64, 65, 67, 60, 62, 64, 65, 67], 3, 900);
        let unlocked = store
            .record_session(ErrorMode::Wait, s.results(), &s.summary(), 9, 100)
            .unwrap();
        assert_eq!(unlocked, None);
        let stats = store.note_stats().unwrap();
        let c = stats[&(Clef::Treble, 60)];
        assert_eq!(c.attempts, 2.0);
        assert_eq!(c.first_try, 1.0);

        // Хорошая серия открывает ступень 2.
        let s = play(1, &[60, 62, 64, 65, 67, 60, 62, 64, 65, 67], 0, 700);
        let unlocked = store
            .record_session(ErrorMode::Wait, s.results(), &s.summary(), 9, 200)
            .unwrap();
        assert_eq!(unlocked, Some(2));
        assert_eq!(store.unlocked_level().unwrap(), 2);

        // Повторное прохождение уже пройденной ступени ничего не меняет.
        let s = play(1, &[60, 62, 64, 65, 67], 0, 700);
        let unlocked = store
            .record_session(ErrorMode::Wait, s.results(), &s.summary(), 9, 300)
            .unwrap();
        assert_eq!(unlocked, None);
        assert_eq!(store.unlocked_level().unwrap(), 2);

        let levels = store.level_stats().unwrap();
        assert_eq!(levels.len(), 1);
        assert_eq!(levels[0].sessions, 3);
        assert!(levels[0].passed);
        assert!((levels[0].best_accuracy - 1.0).abs() < 1e-9);
        assert_eq!(levels[0].last_reaction_ms, 700);
    }

    #[test]
    fn last_level_does_not_unlock_beyond_max() {
        let mut store = Store::open_in_memory().unwrap();
        let s = play(9, &[60, 62, 64, 65, 67], 0, 500);
        store
            .conn
            .execute("INSERT INTO kv VALUES ('trainer_unlocked', '9')", [])
            .unwrap();
        let unlocked = store
            .record_session(ErrorMode::Wait, s.results(), &s.summary(), 9, 1)
            .unwrap();
        assert_eq!(unlocked, None);
        assert_eq!(store.unlocked_level().unwrap(), 9);
    }

    #[test]
    fn note_stats_use_sliding_window() {
        let mut store = Store::open_in_memory().unwrap();
        // 30 серий по одной ноте: попыток не больше окна.
        for i in 0..30 {
            let s = play(1, &[60], 0, 500);
            store
                .record_session(ErrorMode::Wait, s.results(), &s.summary(), 9, i)
                .unwrap();
        }
        let st = store.note_stats().unwrap()[&(Clef::Treble, 60)];
        assert!(st.attempts <= STAT_WINDOW + 1e-9, "{}", st.attempts);
        assert!((st.accuracy() - 1.0).abs() < 1e-9);
        assert!((st.avg_reaction_ms() - 500.0).abs() < 1e-6);
    }

    #[test]
    fn reopens_existing_database() {
        let dir = std::env::temp_dir().join(format!("mt-store-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("progress.db");
        {
            let mut store = Store::open(&path).unwrap();
            let s = play(1, &[60, 62, 64, 65, 67], 0, 500);
            store
                .record_session(ErrorMode::Wait, s.results(), &s.summary(), 9, 1)
                .unwrap();
        }
        let store = Store::open(&path).unwrap();
        assert_eq!(store.unlocked_level().unwrap(), 2);
        assert_eq!(store.note_stats().unwrap().len(), 5);
        std::fs::remove_dir_all(dir).ok();
    }
}
