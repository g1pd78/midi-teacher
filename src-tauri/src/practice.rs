//! Движок практики: фрагменты, уровни подсказок, история проходов и экран «Прогресс».
//!
//! Решения (какой уровень, что предложить) принимает чистый модуль
//! `mt_core::practice`; здесь — хранение и учёт времени игры.

use mt_core::clock;
use mt_core::fingering::{self, FingerNote, Fingering};
use mt_core::piece::{HandMode, MeasureErrors};
use mt_core::practice::{self, Hands, Outcome, Pass, PracticeView, UnitState};
use mt_core::store::{
    AttemptRecord, ExerciseResult, ExerciseStat, PieceActivity, PieceMeta, PieceRecord, Store,
    TodayStatus, PLAY_BUCKET_SECS,
};
use parking_lot::Mutex;
use serde::Serialize;
use std::collections::BTreeMap;
use std::sync::Arc;
use tauri::State;

pub type SharedStore = Arc<Mutex<Option<Store>>>;

/// Пауза между нажатиями дольше этой — перерыв, а не игра.
const IDLE_US: u64 = 30_000_000;
/// Копим время в памяти и пишем в базу порциями.
const FLUSH_SECS: f64 = 30.0;
/// Тепловая карта трудных тактов — за последние недели.
const HEAT_DAYS: i64 = 28;
const PLAY_DAYS: i64 = 120;

#[derive(Default)]
struct PlayClock {
    last_us: Option<u64>,
    pending: BTreeMap<i64, f64>,
    pending_secs: f64,
}

pub struct PracticeHub {
    store: SharedStore,
    play: Mutex<PlayClock>,
}

impl PracticeHub {
    pub fn new(store: SharedStore) -> Self {
        Self {
            store,
            play: Mutex::new(PlayClock::default()),
        }
    }

    /// Любое нажатие клавиши: копим время игры (паузы до 30 с считаются игрой).
    pub fn on_note_on(&self, time_us: u64) {
        let flush = {
            let mut p = self.play.lock();
            if let Some(last) = p.last_us {
                let gap = time_us.saturating_sub(last);
                if gap <= IDLE_US {
                    let secs = gap as f64 / 1e6;
                    let now = clock::unix_secs();
                    *p.pending
                        .entry(now - now.rem_euclid(PLAY_BUCKET_SECS))
                        .or_default() += secs;
                    p.pending_secs += secs;
                }
            }
            p.last_us = Some(time_us);
            p.pending_secs >= FLUSH_SECS
        };
        if flush {
            self.flush_play_time();
        }
    }

    fn flush_play_time(&self) {
        let buckets: Vec<(i64, f64)> = {
            let mut p = self.play.lock();
            p.pending_secs = 0.0;
            std::mem::take(&mut p.pending).into_iter().collect()
        };
        if buckets.is_empty() {
            return;
        }
        if let Some(store) = self.store.lock().as_mut() {
            if let Err(e) = store.add_play_time(&buckets) {
                log::warn!("время игры не сохранено: {e:#}");
            }
        }
    }

    fn with_store<T>(&self, f: impl FnOnce(&mut Store) -> anyhow::Result<T>) -> Result<T, String> {
        let mut guard = self.store.lock();
        let store = guard
            .as_mut()
            .ok_or("база прогресса недоступна — прогресс не сохраняется")?;
        f(store).map_err(|e| format!("{e:#}"))
    }
}

fn view(store: &Store, rec: &PieceRecord) -> anyhow::Result<PracticeView> {
    let fragments = rec.fragments();
    let stored = store.units(&rec.meta.id)?;
    let (units, current) = practice::build_units(&fragments, &stored, &rec.meta.measure_hands);
    Ok(PracticeView {
        piece: rec.meta.id.clone(),
        measures: rec.meta.measures,
        fragments,
        custom: rec.custom_starts.is_some(),
        units,
        current,
        heat: store.measure_heat(&rec.meta.id, clock::unix_secs() - HEAT_DAYS * 86_400)?,
    })
}

fn piece_record(store: &Store, piece: &str) -> anyhow::Result<PieceRecord> {
    store
        .piece(piece)?
        .ok_or_else(|| anyhow::anyhow!("пьеса {piece} ещё не открывалась"))
}

/// Состояние отрезка и руки в нём (для ещё не начатого — начальное).
fn unit_state(
    store: &Store,
    rec: &PieceRecord,
    range: (u32, u32),
) -> anyhow::Result<(UnitState, Hands)> {
    let fragments = rec.fragments();
    let stored = store.units(&rec.meta.id)?;
    let (units, _) = practice::build_units(&fragments, &stored, &rec.meta.measure_hands);
    Ok(match units.iter().find(|u| (u.from, u.to) == range) {
        Some(u) => (u.state, u.hands),
        // Отрезок вне цепочки (границы только что поменяли) — как отдельный фрагмент.
        None => (
            stored.get(&range).copied().unwrap_or_default(),
            Hands::of_range(&rec.meta.measure_hands, range.0, range.1),
        ),
    })
}

fn hand_mode(s: &str) -> HandMode {
    match s {
        "right" => HandMode::Right,
        "left" => HandMode::Left,
        "none" => HandMode::None,
        _ => HandMode::Both,
    }
}

#[tauri::command]
pub fn practice_open(
    hub: State<Arc<PracticeHub>>,
    meta: PieceMeta,
) -> Result<PracticeView, String> {
    hub.with_store(|s| {
        let rec = s.open_piece(&meta, clock::unix_secs())?;
        view(s, &rec)
    })
}

/// Ручные границы фрагментов: номера первых тактов; `None` — вернуть автоматические.
#[tauri::command]
pub fn practice_set_fragments(
    hub: State<Arc<PracticeHub>>,
    piece: String,
    starts: Option<Vec<u32>>,
) -> Result<PracticeView, String> {
    hub.with_store(|s| {
        s.set_custom_starts(&piece, starts.as_deref())?;
        view(s, &piece_record(s, &piece)?)
    })
}

#[tauri::command]
pub fn practice_set_level(
    hub: State<Arc<PracticeHub>>,
    piece: String,
    from: u32,
    to: u32,
    level: u8,
) -> Result<PracticeView, String> {
    hub.with_store(|s| {
        let rec = piece_record(s, &piece)?;
        let (mut state, _) = unit_state(s, &rec, (from, to))?;
        state.set_level(level);
        s.save_unit(&piece, (from, to), &state, clock::unix_secs())?;
        view(s, &rec)
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordResult {
    /// Итог для ведущего режима (в свободной игре — нет).
    outcome: Option<Outcome>,
    view: PracticeView,
}

#[tauri::command]
pub fn practice_record(
    hub: State<Arc<PracticeHub>>,
    piece: String,
    attempt: AttemptRecord,
) -> Result<RecordResult, String> {
    hub.flush_play_time();
    hub.with_store(|s| {
        let now = clock::unix_secs();
        let rec = piece_record(s, &piece)?;
        s.record_attempt(&piece, &attempt, now)?;
        let mut outcome = None;
        if let Some(level) = attempt.level {
            let range = (attempt.from, attempt.to);
            let (mut state, hands) = unit_state(s, &rec, range)?;
            let pass = Pass {
                level,
                hands: hand_mode(&attempt.hands),
                accuracy: attempt.accuracy,
            };
            outcome = Some(practice::record(&mut state, &pass, hands));
            s.save_unit(&piece, range, &state, now)?;
        }
        Ok(RecordResult {
            outcome,
            view: view(s, &rec)?,
        })
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FragmentProgress {
    from: u32,
    to: u32,
    level: u8,
    learned: bool,
    started: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PieceProgress {
    id: String,
    title: String,
    measures: u32,
    fragments: Vec<FragmentProgress>,
    /// Вся пьеса сыграна по памяти.
    learned: bool,
    heat: Vec<MeasureErrors>,
    activity: PieceActivity,
    opened_at: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    /// Время игры: (начало 15-минутной корзины, секунды Unix; секунды игры).
    play: Vec<(i64, f64)>,
    bucket_secs: i64,
    pieces: Vec<PieceProgress>,
}

#[tauri::command]
pub fn progress_overview(hub: State<Arc<PracticeHub>>) -> Result<Progress, String> {
    hub.flush_play_time();
    hub.with_store(|s| {
        let now = clock::unix_secs();
        let mut pieces = Vec::new();
        for rec in s.pieces()? {
            let v = view(s, &rec)?;
            let fragments = v
                .units
                .iter()
                .filter(|u| u.frags.0 == u.frags.1)
                .map(|u| FragmentProgress {
                    from: u.from,
                    to: u.to,
                    level: u.state.level,
                    learned: u.state.learned,
                    started: u.started,
                })
                .collect();
            pieces.push(PieceProgress {
                id: rec.meta.id.clone(),
                title: rec.meta.title.clone(),
                measures: rec.meta.measures,
                fragments,
                learned: v.units.last().is_some_and(|u| u.state.learned),
                heat: v.heat,
                activity: s.piece_activity(&rec.meta.id)?,
                opened_at: rec.opened_at,
            });
        }
        Ok(Progress {
            play: s.play_time(now - PLAY_DAYS * 86_400)?,
            bucket_secs: PLAY_BUCKET_SECS,
            pieces,
        })
    })
}

/// Аппликатура пьесы: ручные правки → файл → подбор. Правка, у которой
/// высота ноты не совпала (файл изменился), не применяется.
fn fingers_for(store: Option<&Store>, piece: &str, notes: &[FingerNote]) -> Vec<Fingering> {
    let manual: Vec<(String, u8)> = store
        .and_then(|s| s.manual_fingers(piece).ok())
        .unwrap_or_default()
        .into_iter()
        .filter(|(id, pitch, _)| notes.iter().any(|n| &n.id == id && n.pitch == *pitch))
        .map(|(id, _, f)| (id, f))
        .collect();
    fingering::assign(notes, &manual)
}

#[tauri::command]
pub fn fingering_get(
    hub: State<Arc<PracticeHub>>,
    piece: String,
    notes: Vec<FingerNote>,
) -> Vec<Fingering> {
    fingers_for(hub.store.lock().as_ref(), &piece, &notes)
}

/// Ручная правка пальца (`finger = None` — убрать правку).
#[tauri::command]
pub fn fingering_set(
    hub: State<Arc<PracticeHub>>,
    piece: String,
    notes: Vec<FingerNote>,
    note_id: String,
    finger: Option<u8>,
) -> Result<Vec<Fingering>, String> {
    let pitch = notes
        .iter()
        .find(|n| n.id == note_id)
        .map(|n| n.pitch)
        .ok_or("нет такой ноты")?;
    hub.with_store(|s| {
        s.set_manual_finger(
            &piece,
            &note_id,
            pitch,
            finger.filter(|f| (1..=5).contains(f)),
        )
    })?;
    Ok(fingers_for(hub.store.lock().as_ref(), &piece, &notes))
}

#[tauri::command]
pub fn exercise_stats(hub: State<Arc<PracticeHub>>) -> Result<Vec<ExerciseStat>, String> {
    hub.with_store(|s| s.exercise_stats())
}

#[tauri::command]
pub fn exercise_record(
    hub: State<Arc<PracticeHub>>,
    result: ExerciseResult,
) -> Result<Vec<ExerciseStat>, String> {
    hub.flush_play_time();
    hub.with_store(|s| {
        s.record_exercise(&result, clock::unix_secs())?;
        s.exercise_stats()
    })
}

#[tauri::command]
pub fn warmup_done(hub: State<Arc<PracticeHub>>) -> Result<(), String> {
    hub.with_store(|s| s.set_warmup_done(clock::unix_secs()))
}

/// Что сделано сегодня; `day_start` — начало местных суток (секунды Unix) от интерфейса.
#[tauri::command]
pub fn today_status(hub: State<Arc<PracticeHub>>, day_start: i64) -> Result<TodayStatus, String> {
    hub.with_store(|s| s.today(day_start))
}
