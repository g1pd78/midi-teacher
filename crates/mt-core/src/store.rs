//! Хранилище прогресса (SQLite в каталоге данных приложения).

use crate::piece::MeasureErrors;
use crate::practice::{self, UnitState};
use crate::trainer::{Clef, ErrorMode, NoteResult, NoteStat, Stats, Summary};
use anyhow::Result;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
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
CREATE TABLE IF NOT EXISTS pieces (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    measures INTEGER NOT NULL,
    phrase_ends TEXT NOT NULL,
    hands TEXT NOT NULL,
    custom_starts TEXT,
    opened_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS practice_units (
    piece TEXT NOT NULL,
    from_m INTEGER NOT NULL,
    to_m INTEGER NOT NULL,
    state TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (piece, from_m, to_m)
);
CREATE TABLE IF NOT EXISTS practice_attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    piece TEXT NOT NULL,
    from_m INTEGER NOT NULL,
    to_m INTEGER NOT NULL,
    level INTEGER,
    mode TEXT NOT NULL,
    hands TEXT NOT NULL,
    tempo REAL NOT NULL,
    accuracy REAL NOT NULL,
    duration_ms INTEGER NOT NULL,
    finished_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS practice_attempts_piece ON practice_attempts (piece, finished_at);
CREATE TABLE IF NOT EXISTS attempt_measures (
    attempt INTEGER NOT NULL,
    measure INTEGER NOT NULL,
    errors INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS attempt_measures_attempt ON attempt_measures (attempt);
CREATE TABLE IF NOT EXISTS play_time (
    bucket INTEGER PRIMARY KEY,
    seconds REAL NOT NULL
);
";

/// Корзина учёта времени игры — 15 минут: так интерфейс может разложить
/// время по дням в любом часовом поясе (смещения кратны 15 минутам).
pub const PLAY_BUCKET_SECS: i64 = 900;

/// Описание пьесы от интерфейса: сколько тактов, где кончаются фразы, какие руки в каждом такте.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PieceMeta {
    pub id: String,
    pub title: String,
    pub measures: u32,
    pub phrase_ends: Vec<u32>,
    /// Маска рук по тактам: бит 1 — правая, бит 2 — левая.
    pub measure_hands: Vec<u8>,
}

/// Пьеса в базе.
#[derive(Debug, Clone, PartialEq)]
pub struct PieceRecord {
    pub meta: PieceMeta,
    pub custom_starts: Option<Vec<u32>>,
    pub opened_at: i64,
}

impl PieceRecord {
    pub fn fragments(&self) -> Vec<(u32, u32)> {
        match &self.custom_starts {
            Some(starts) => practice::fragments_from_starts(self.meta.measures, starts),
            None => practice::split_fragments(self.meta.measures, &self.meta.phrase_ends),
        }
    }
}

/// Проход, записанный в историю.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttemptRecord {
    pub from: u32,
    pub to: u32,
    /// Уровень ведущего режима; `None` — свободная игра.
    pub level: Option<u8>,
    /// `wait` или `rhythm`.
    pub mode: String,
    pub hands: String,
    pub tempo: f64,
    pub accuracy: f64,
    pub duration_ms: u32,
    #[serde(default)]
    pub trouble: Vec<MeasureErrorsIn>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MeasureErrorsIn {
    pub measure: u32,
    pub errors: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PieceActivity {
    pub attempts: u32,
    pub last_at: Option<i64>,
    pub minutes: f64,
}

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

    // --- Пьесы и практика ---

    /// Отметить открытие пьесы и обновить её описание (файл мог измениться).
    /// Ручные границы фрагментов сбрасываются, если число тактов изменилось.
    pub fn open_piece(&mut self, meta: &PieceMeta, now_secs: i64) -> Result<PieceRecord> {
        let old = self.piece(&meta.id)?;
        let custom = old
            .filter(|o| o.meta.measures == meta.measures)
            .and_then(|o| o.custom_starts);
        self.conn.execute(
            "INSERT INTO pieces (id, title, measures, phrase_ends, hands, custom_starts, opened_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(id) DO UPDATE SET title = excluded.title, measures = excluded.measures,
               phrase_ends = excluded.phrase_ends, hands = excluded.hands,
               custom_starts = excluded.custom_starts, opened_at = excluded.opened_at",
            params![
                meta.id,
                meta.title,
                meta.measures,
                serde_json::to_string(&meta.phrase_ends)?,
                serde_json::to_string(&meta.measure_hands)?,
                custom.as_ref().map(serde_json::to_string).transpose()?,
                now_secs
            ],
        )?;
        Ok(PieceRecord {
            meta: meta.clone(),
            custom_starts: custom,
            opened_at: now_secs,
        })
    }

    pub fn piece(&self, id: &str) -> Result<Option<PieceRecord>> {
        self.conn
            .query_row(
                "SELECT id, title, measures, phrase_ends, hands, custom_starts, opened_at
                 FROM pieces WHERE id = ?1",
                params![id],
                row_to_piece,
            )
            .optional()?
            .transpose()
    }

    /// Пьесы, которые открывали, — последние сверху.
    pub fn pieces(&self) -> Result<Vec<PieceRecord>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, title, measures, phrase_ends, hands, custom_starts, opened_at
             FROM pieces ORDER BY opened_at DESC",
        )?;
        let rows = stmt.query_map([], row_to_piece)?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r??);
        }
        Ok(out)
    }

    /// Ручные границы (номера первых тактов фрагментов) или `None` — автоматически.
    pub fn set_custom_starts(&mut self, piece: &str, starts: Option<&[u32]>) -> Result<()> {
        self.conn.execute(
            "UPDATE pieces SET custom_starts = ?2 WHERE id = ?1",
            params![piece, starts.map(serde_json::to_string).transpose()?],
        )?;
        Ok(())
    }

    pub fn units(&self, piece: &str) -> Result<HashMap<(u32, u32), UnitState>> {
        let mut stmt = self
            .conn
            .prepare("SELECT from_m, to_m, state FROM practice_units WHERE piece = ?1")?;
        let rows = stmt.query_map(params![piece], |r| {
            Ok((
                r.get::<_, u32>(0)?,
                r.get::<_, u32>(1)?,
                r.get::<_, String>(2)?,
            ))
        })?;
        let mut out = HashMap::new();
        for r in rows {
            let (a, b, json) = r?;
            if let Ok(st) = serde_json::from_str(&json) {
                out.insert((a, b), st);
            }
        }
        Ok(out)
    }

    pub fn save_unit(
        &mut self,
        piece: &str,
        range: (u32, u32),
        state: &UnitState,
        now_secs: i64,
    ) -> Result<()> {
        self.conn.execute(
            "INSERT INTO practice_units (piece, from_m, to_m, state, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(piece, from_m, to_m) DO UPDATE SET
               state = excluded.state, updated_at = excluded.updated_at",
            params![
                piece,
                range.0,
                range.1,
                serde_json::to_string(state)?,
                now_secs
            ],
        )?;
        Ok(())
    }

    pub fn record_attempt(&mut self, piece: &str, a: &AttemptRecord, now_secs: i64) -> Result<i64> {
        let tx = self.conn.transaction()?;
        tx.execute(
            "INSERT INTO practice_attempts
               (piece, from_m, to_m, level, mode, hands, tempo, accuracy, duration_ms, finished_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                piece,
                a.from,
                a.to,
                a.level,
                a.mode,
                a.hands,
                a.tempo,
                a.accuracy,
                a.duration_ms,
                now_secs
            ],
        )?;
        let id = tx.last_insert_rowid();
        for m in a.trouble.iter().filter(|m| m.errors > 0) {
            tx.execute(
                "INSERT INTO attempt_measures (attempt, measure, errors) VALUES (?1, ?2, ?3)",
                params![id, m.measure, m.errors],
            )?;
        }
        tx.commit()?;
        Ok(id)
    }

    /// Ошибки по тактам пьесы с момента `since_secs`, по номеру такта.
    pub fn measure_heat(&self, piece: &str, since_secs: i64) -> Result<Vec<MeasureErrors>> {
        let mut stmt = self.conn.prepare(
            "SELECT m.measure, SUM(m.errors) FROM attempt_measures m
             JOIN practice_attempts a ON a.id = m.attempt
             WHERE a.piece = ?1 AND a.finished_at >= ?2
             GROUP BY m.measure ORDER BY m.measure",
        )?;
        let rows = stmt.query_map(params![piece, since_secs], |r| {
            Ok(MeasureErrors {
                measure: r.get(0)?,
                errors: r.get(1)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// Сколько проходов, когда последний и сколько минут в проходах.
    pub fn piece_activity(&self, piece: &str) -> Result<PieceActivity> {
        Ok(self.conn.query_row(
            "SELECT COUNT(*), MAX(finished_at), COALESCE(SUM(duration_ms), 0)
             FROM practice_attempts WHERE piece = ?1",
            params![piece],
            |r| {
                Ok(PieceActivity {
                    attempts: r.get(0)?,
                    last_at: r.get(1)?,
                    minutes: r.get::<_, f64>(2)? / 60_000.0,
                })
            },
        )?)
    }

    /// Добавить время игры: (начало корзины в секундах Unix, секунды).
    pub fn add_play_time(&mut self, buckets: &[(i64, f64)]) -> Result<()> {
        let tx = self.conn.transaction()?;
        for &(bucket, secs) in buckets {
            tx.execute(
                "INSERT INTO play_time (bucket, seconds) VALUES (?1, ?2)
                 ON CONFLICT(bucket) DO UPDATE SET seconds = seconds + excluded.seconds",
                params![bucket, secs],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    /// Время игры по 15-минутным корзинам начиная с `since_secs`.
    pub fn play_time(&self, since_secs: i64) -> Result<Vec<(i64, f64)>> {
        let mut stmt = self
            .conn
            .prepare("SELECT bucket, seconds FROM play_time WHERE bucket >= ?1 ORDER BY bucket")?;
        let rows = stmt.query_map(params![since_secs], |r| Ok((r.get(0)?, r.get(1)?)))?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
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

type PieceRow = Result<PieceRecord>;

fn row_to_piece(r: &rusqlite::Row) -> rusqlite::Result<PieceRow> {
    let phrase: String = r.get(3)?;
    let hands: String = r.get(4)?;
    let custom: Option<String> = r.get(5)?;
    let build = || -> Result<PieceRecord> {
        Ok(PieceRecord {
            meta: PieceMeta {
                id: r.get(0)?,
                title: r.get(1)?,
                measures: r.get(2)?,
                phrase_ends: serde_json::from_str(&phrase)?,
                measure_hands: serde_json::from_str(&hands)?,
            },
            custom_starts: custom.map(|c| serde_json::from_str(&c)).transpose()?,
            opened_at: r.get(6)?,
        })
    };
    Ok(build())
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

    fn meta(measures: u32) -> PieceMeta {
        PieceMeta {
            id: "builtin:ode".into(),
            title: "Ода".into(),
            measures,
            phrase_ends: vec![4, 8],
            measure_hands: vec![1; measures as usize],
        }
    }

    #[test]
    fn pieces_fragments_and_units() {
        let mut store = Store::open_in_memory().unwrap();
        let rec = store.open_piece(&meta(8), 10).unwrap();
        assert_eq!(rec.fragments(), vec![(1, 4), (5, 8)]);
        store
            .set_custom_starts("builtin:ode", Some(&[3, 6]))
            .unwrap();
        let rec = store.piece("builtin:ode").unwrap().unwrap();
        assert_eq!(rec.fragments(), vec![(1, 2), (3, 5), (6, 8)]);
        // Повторное открытие сохраняет ручные границы…
        let rec = store.open_piece(&meta(8), 20).unwrap();
        assert_eq!(rec.custom_starts, Some(vec![3, 6]));
        // …но не если в пьесе стало другое число тактов.
        let rec = store.open_piece(&meta(12), 30).unwrap();
        assert_eq!(rec.custom_starts, None);
        assert_eq!(store.pieces().unwrap().len(), 1);

        let mut st = UnitState::new(2);
        st.streak = 2;
        store.save_unit("builtin:ode", (1, 4), &st, 40).unwrap();
        st.streak = 3;
        store.save_unit("builtin:ode", (1, 4), &st, 41).unwrap();
        let units = store.units("builtin:ode").unwrap();
        assert_eq!(units.len(), 1);
        assert_eq!(units[&(1, 4)].streak, 3);
    }

    #[test]
    fn attempts_heat_and_play_time() {
        let mut store = Store::open_in_memory().unwrap();
        store.open_piece(&meta(8), 1).unwrap();
        let attempt = |trouble: Vec<(u32, u32)>| AttemptRecord {
            from: 1,
            to: 4,
            level: Some(2),
            mode: "wait".into(),
            hands: "both".into(),
            tempo: 0.8,
            accuracy: 0.9,
            duration_ms: 30_000,
            trouble: trouble
                .into_iter()
                .map(|(measure, errors)| MeasureErrorsIn { measure, errors })
                .collect(),
        };
        store
            .record_attempt("builtin:ode", &attempt(vec![(2, 1), (3, 2)]), 100)
            .unwrap();
        store
            .record_attempt("builtin:ode", &attempt(vec![(3, 1), (4, 0)]), 200)
            .unwrap();
        let heat = store.measure_heat("builtin:ode", 0).unwrap();
        assert_eq!(
            heat,
            vec![
                MeasureErrors {
                    measure: 2,
                    errors: 1
                },
                MeasureErrors {
                    measure: 3,
                    errors: 3
                }
            ]
        );
        // Старые проходы не учитываются.
        assert_eq!(store.measure_heat("builtin:ode", 150).unwrap().len(), 1);
        let act = store.piece_activity("builtin:ode").unwrap();
        assert_eq!((act.attempts, act.last_at), (2, Some(200)));
        assert!((act.minutes - 1.0).abs() < 1e-9);

        store.add_play_time(&[(900, 30.0), (1800, 10.0)]).unwrap();
        store.add_play_time(&[(900, 15.0)]).unwrap();
        assert_eq!(store.play_time(0).unwrap(), vec![(900, 45.0), (1800, 10.0)]);
        assert_eq!(store.play_time(1000).unwrap(), vec![(1800, 10.0)]);
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
