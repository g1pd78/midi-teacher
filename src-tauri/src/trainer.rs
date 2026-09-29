//! Тренажёр чтения нот: команды для интерфейса и подача MIDI в активную серию.
//!
//! Оценка нажатий идёт здесь, в Rust, по временным меткам из потока MIDI;
//! интерфейс только показывает результат.

use mt_core::clock;
use mt_core::store::{LevelStat, Store};
use mt_core::trainer::{
    self, Clef, ErrorMode, Feedback, Level, Rng, Session, Summary, Target, PASS_ACCURACY,
    PASS_REACTION_MS,
};
use parking_lot::Mutex;
use serde::Serialize;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};

pub struct TrainerHub {
    session: Mutex<Option<Session>>,
    store: Mutex<Option<Store>>,
}

impl TrainerHub {
    pub fn new(store: Option<Store>) -> Self {
        Self {
            session: Mutex::new(None),
            store: Mutex::new(store),
        }
    }

    /// Нажатие клавиши с любого инструмента.
    pub fn on_note_on(&self, app: &AppHandle, midi: u8, time_us: u64) {
        let mut guard = self.session.lock();
        let Some(session) = guard.as_mut() else {
            return;
        };
        let Some(feedback) = session.on_note(midi, time_us) else {
            return;
        };

        let mut finished = None;
        if session.is_finished() {
            let mut summary = session.summary();
            if let Some(store) = self.store.lock().as_mut() {
                let max = trainer::levels().len() as u32;
                let now = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_secs() as i64)
                    .unwrap_or(0);
                match store.record_session(session.mode, session.results(), &summary, max, now) {
                    Ok(unlocked) => summary.unlocked_level = unlocked,
                    Err(e) => log::warn!("прогресс не сохранён: {e:#}"),
                }
            }
            finished = Some(summary);
            *guard = None;
        }
        let _ = app.emit("trainer", TrainerEvent { feedback, finished });
    }
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct TrainerEvent {
    feedback: Feedback,
    finished: Option<Summary>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteStatView {
    clef: Clef,
    midi: u8,
    attempts: f64,
    accuracy: f64,
    avg_reaction_ms: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Overview {
    levels: Vec<Level>,
    unlocked: u32,
    level_stats: Vec<LevelStat>,
    note_stats: Vec<NoteStatView>,
    pass_accuracy: f64,
    pass_reaction_ms: u32,
    /// Прогресс не сохраняется (база недоступна).
    storage_error: bool,
}

#[tauri::command]
pub fn trainer_overview(hub: State<Arc<TrainerHub>>) -> Overview {
    let store = hub.store.lock();
    let (unlocked, level_stats, note_stats) = match store.as_ref() {
        Some(s) => (
            s.unlocked_level().unwrap_or(1),
            s.level_stats().unwrap_or_default(),
            s.note_stats().unwrap_or_default(),
        ),
        None => (1, vec![], Default::default()),
    };
    let mut notes: Vec<NoteStatView> = note_stats
        .into_iter()
        .map(|((clef, midi), st)| NoteStatView {
            clef,
            midi,
            attempts: st.attempts,
            accuracy: st.accuracy(),
            avg_reaction_ms: st.avg_reaction_ms(),
        })
        .collect();
    notes.sort_by_key(|n| (n.clef.as_str(), n.midi));
    Overview {
        levels: trainer::levels(),
        unlocked,
        level_stats,
        note_stats: notes,
        pass_accuracy: PASS_ACCURACY,
        pass_reaction_ms: PASS_REACTION_MS,
        storage_error: store.is_none(),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionView {
    level: u32,
    mode: ErrorMode,
    grand_staff: bool,
    targets: Vec<Target>,
}

#[tauri::command]
pub fn trainer_start(
    hub: State<Arc<TrainerHub>>,
    level: u32,
    mode: ErrorMode,
    count: Option<usize>,
) -> Result<SessionView, String> {
    let lvl = trainer::level(level).ok_or("нет такой ступени")?;
    let stats = hub
        .store
        .lock()
        .as_ref()
        .and_then(|s| s.note_stats().ok())
        .unwrap_or_default();
    let mut rng = Rng::new(clock::now_us() ^ 0x9E37_79B9_7F4A_7C15);
    let targets = trainer::pick_targets(&lvl, &stats, count.unwrap_or(20).clamp(1, 100), &mut rng);
    *hub.session.lock() = Some(Session::new(level, mode, targets.clone(), clock::now_us()));
    Ok(SessionView {
        level,
        mode,
        grand_staff: lvl.grand_staff,
        targets,
    })
}

/// Интерфейс показал первую ноту: отсчёт реакции начинается отсюда.
#[tauri::command]
pub fn trainer_ready(hub: State<Arc<TrainerHub>>) {
    if let Some(s) = hub.session.lock().as_mut() {
        if s.index() == 0 {
            s.restart_clock(clock::now_us());
        }
    }
}

#[tauri::command]
pub fn trainer_stop(hub: State<Arc<TrainerHub>>) {
    *hub.session.lock() = None;
}
