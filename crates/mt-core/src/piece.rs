//! Разучивание пьесы в режиме ожидания.
//!
//! Ноты пьесы группируются в шаги — по одновременному началу. Курсор стоит на
//! шаге, пока не нажаты все его ноты (порядок внутри аккорда любой). Ноты руки,
//! которую ученик сейчас не учит, играет приложение. Шаги, где нужны только
//! ноты другой руки, проходятся сами в темпе пьесы.
//!
//! Модуль не знает ни про MIDI-устройства, ни про таймеры: он получает события
//! с временем и возвращает список действий (сыграть ноту, запланировать таймер,
//! сообщить интерфейсу). Поэтому вся логика проверяется unit-тестами.

use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashSet};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Hand {
    Right,
    Left,
}

/// Какую руку учим.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum HandMode {
    Right,
    Left,
    #[default]
    Both,
}

impl HandMode {
    pub fn includes(self, hand: Hand) -> bool {
        match self {
            HandMode::Both => true,
            HandMode::Right => hand == Hand::Right,
            HandMode::Left => hand == Hand::Left,
        }
    }
}

/// Нота пьесы. `id` совпадает с id элемента в SVG Verovio.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PieceNote {
    pub id: String,
    pub pitch: u8,
    /// Начало и длительность в миллисекундах при исходном темпе пьесы.
    pub start_ms: u32,
    pub dur_ms: u32,
    pub hand: Hand,
    pub measure: u32,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Step {
    pub onset_ms: u32,
    /// Индексы нот в `notes`.
    pub notes: Vec<usize>,
}

/// Ноты с началом ближе этого считаются одновременными.
const SAME_ONSET_MS: u32 = 15;

/// Группирует ноты в шаги по времени начала.
pub fn build_steps(notes: &[PieceNote]) -> Vec<Step> {
    let mut order: Vec<usize> = (0..notes.len()).collect();
    order.sort_by_key(|&i| (notes[i].start_ms, notes[i].pitch));
    let mut steps: Vec<Step> = Vec::new();
    for i in order {
        let t = notes[i].start_ms;
        match steps.last_mut() {
            Some(s) if t - s.onset_ms <= SAME_ONSET_MS => s.notes.push(i),
            _ => steps.push(Step {
                onset_ms: t,
                notes: vec![i],
            }),
        }
    }
    steps
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PieceConfig {
    pub hands: HandMode,
    /// Играть ноты второй руки.
    pub accompany: bool,
    /// Темп для шагов, которые проходятся сами (1.0 — темп пьесы).
    pub tempo: f32,
}

impl Default for PieceConfig {
    fn default() -> Self {
        Self {
            hands: HandMode::Both,
            accompany: true,
            tempo: 0.8,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MeasureErrors {
    pub measure: u32,
    pub errors: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PieceSummary {
    /// Шагов, которые играл ученик.
    pub played_steps: usize,
    pub required_notes: usize,
    pub errors: u32,
    pub duration_ms: u32,
    /// Такты с ошибками, по убыванию числа ошибок.
    pub trouble_measures: Vec<MeasureErrors>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum PieceEvent {
    /// Курсор перешёл на шаг. `auto` — шаг пройдёт сам (нот ученика в нём нет).
    #[serde(rename_all = "camelCase")]
    Step {
        index: usize,
        note_ids: Vec<String>,
        required: Vec<u8>,
        auto: bool,
    },
    /// Нажата нужная нота текущего шага.
    #[serde(rename_all = "camelCase")]
    Hit {
        index: usize,
        note_ids: Vec<String>,
    },
    /// Нажата лишняя нота.
    #[serde(rename_all = "camelCase")]
    Wrong {
        index: usize,
        pitch: u8,
    },
    Finished {
        summary: PieceSummary,
    },
}

#[derive(Debug, Clone, PartialEq)]
pub enum Action {
    Event(PieceEvent),
    AppNoteOn {
        pitch: u8,
        velocity: u8,
    },
    AppNoteOff {
        pitch: u8,
    },
    /// Вызвать `on_timer(token)` через `delay_ms`.
    Schedule {
        token: u64,
        delay_ms: u32,
    },
}

const APP_VELOCITY: u8 = 70;
const MIN_AUTO_DELAY_MS: u32 = 60;

pub struct PieceSession {
    notes: Vec<PieceNote>,
    steps: Vec<Step>,
    cfg: PieceConfig,
    index: usize,
    pressed: HashSet<u8>,
    accompanied: bool,
    /// Ноты приложения, которые сейчас звучат: (высота, конец в мс пьесы).
    sounding: Vec<(u8, u32)>,
    token: u64,
    errors: u32,
    errors_by_measure: BTreeMap<u32, u32>,
    started_us: u64,
    finished: bool,
}

impl PieceSession {
    pub fn new(notes: Vec<PieceNote>, cfg: PieceConfig) -> Self {
        let steps = build_steps(&notes);
        Self {
            notes,
            steps,
            cfg,
            index: 0,
            pressed: HashSet::new(),
            accompanied: false,
            sounding: Vec::new(),
            token: 0,
            errors: 0,
            errors_by_measure: BTreeMap::new(),
            started_us: 0,
            finished: false,
        }
    }

    pub fn steps(&self) -> &[Step] {
        &self.steps
    }

    pub fn index(&self) -> usize {
        self.index
    }

    pub fn is_finished(&self) -> bool {
        self.finished
    }

    pub fn start(&mut self, t_us: u64) -> Vec<Action> {
        self.started_us = t_us;
        let mut out = Vec::new();
        self.activate(0, t_us, &mut out);
        out
    }

    fn required(&self, step: usize) -> impl Iterator<Item = &PieceNote> {
        self.steps[step]
            .notes
            .iter()
            .map(|&i| &self.notes[i])
            .filter(|n| self.cfg.hands.includes(n.hand))
    }

    fn others(&self, step: usize) -> impl Iterator<Item = &PieceNote> {
        self.steps[step]
            .notes
            .iter()
            .map(|&i| &self.notes[i])
            .filter(|n| !self.cfg.hands.includes(n.hand))
    }

    fn activate(&mut self, i: usize, t_us: u64, out: &mut Vec<Action>) {
        self.index = i;
        self.pressed.clear();
        self.accompanied = false;
        self.token += 1;

        if i >= self.steps.len() {
            self.finish(t_us, out);
            return;
        }
        let onset = self.steps[i].onset_ms;
        self.release_until(onset, out);

        let required: Vec<u8> = self.required(i).map(|n| n.pitch).collect();
        let note_ids = self.steps[i]
            .notes
            .iter()
            .map(|&n| self.notes[n].id.clone())
            .collect();
        let auto = required.is_empty();
        out.push(Action::Event(PieceEvent::Step {
            index: i,
            note_ids,
            required,
            auto,
        }));

        if auto {
            self.accompany(out);
            let next = self.steps.get(i + 1).map(|s| s.onset_ms);
            let span = match next {
                Some(n) => n - onset,
                None => self.others(i).map(|n| n.dur_ms).max().unwrap_or(0),
            };
            let delay = ((span as f32) / self.cfg.tempo.max(0.1)) as u32;
            out.push(Action::Schedule {
                token: self.token,
                delay_ms: delay.max(MIN_AUTO_DELAY_MS),
            });
        }
    }

    /// Сыграть ноты второй руки текущего шага (один раз на шаг).
    fn accompany(&mut self, out: &mut Vec<Action>) {
        if self.accompanied || !self.cfg.accompany {
            return;
        }
        self.accompanied = true;
        let notes: Vec<(u8, u32)> = self
            .others(self.index)
            .map(|n| (n.pitch, n.start_ms + n.dur_ms))
            .collect();
        for (pitch, end) in notes {
            // Та же высота уже звучит — сначала снять, чтобы нота прозвучала заново.
            if self.sounding.iter().any(|s| s.0 == pitch) {
                out.push(Action::AppNoteOff { pitch });
                self.sounding.retain(|s| s.0 != pitch);
            }
            out.push(Action::AppNoteOn {
                pitch,
                velocity: APP_VELOCITY,
            });
            self.sounding.push((pitch, end));
        }
    }

    fn release_until(&mut self, t_ms: u32, out: &mut Vec<Action>) {
        let mut keep = Vec::new();
        for (pitch, end) in self.sounding.drain(..) {
            if end <= t_ms {
                out.push(Action::AppNoteOff { pitch });
            } else {
                keep.push((pitch, end));
            }
        }
        self.sounding = keep;
    }

    fn finish(&mut self, t_us: u64, out: &mut Vec<Action>) {
        self.release_until(u32::MAX, out);
        self.finished = true;
        let played_steps = (0..self.steps.len())
            .filter(|&s| self.required(s).next().is_some())
            .count();
        let required_notes = (0..self.steps.len())
            .map(|s| self.required(s).count())
            .sum();
        let mut trouble: Vec<MeasureErrors> = self
            .errors_by_measure
            .iter()
            .map(|(&measure, &errors)| MeasureErrors { measure, errors })
            .collect();
        trouble.sort_by(|a, b| b.errors.cmp(&a.errors).then(a.measure.cmp(&b.measure)));
        out.push(Action::Event(PieceEvent::Finished {
            summary: PieceSummary {
                played_steps,
                required_notes,
                errors: self.errors,
                duration_ms: (t_us.saturating_sub(self.started_us) / 1000) as u32,
                trouble_measures: trouble,
            },
        }));
    }

    pub fn on_note_on(&mut self, pitch: u8, t_us: u64) -> Vec<Action> {
        let mut out = Vec::new();
        if self.finished || self.index >= self.steps.len() {
            return out;
        }
        let i = self.index;
        let hit_ids: Vec<String> = self
            .required(i)
            .filter(|n| n.pitch == pitch)
            .map(|n| n.id.clone())
            .collect();

        if !hit_ids.is_empty() {
            if !self.pressed.insert(pitch) {
                return out; // повторное нажатие той же ноты аккорда
            }
            out.push(Action::Event(PieceEvent::Hit {
                index: i,
                note_ids: hit_ids,
            }));
            // Вторая рука вступает вместе с первой нажатой нотой ученика.
            self.accompany(&mut out);
            let done = self.required(i).all(|n| self.pressed.contains(&n.pitch));
            if done {
                self.activate(i + 1, t_us, &mut out);
            }
            return out;
        }

        // Нота второй руки на этом шаге — не ошибка (ученик играет вместе с приложением).
        if self.others(i).any(|n| n.pitch == pitch) || self.required(i).next().is_none() {
            return out;
        }

        self.errors += 1;
        let measure = self.required(i).map(|n| n.measure).next().unwrap_or(0);
        *self.errors_by_measure.entry(measure).or_default() += 1;
        out.push(Action::Event(PieceEvent::Wrong { index: i, pitch }));
        out
    }

    pub fn on_timer(&mut self, token: u64, t_us: u64) -> Vec<Action> {
        let mut out = Vec::new();
        if self.finished || token != self.token {
            return out;
        }
        let i = self.index;
        if i < self.steps.len() && self.required(i).next().is_none() {
            self.activate(i + 1, t_us, &mut out);
        }
        out
    }

    /// Остановить: снять все ноты приложения.
    pub fn stop(&mut self) -> Vec<Action> {
        let mut out = Vec::new();
        self.release_until(u32::MAX, &mut out);
        self.finished = true;
        self.token += 1;
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn note(id: &str, pitch: u8, start: u32, dur: u32, hand: Hand, measure: u32) -> PieceNote {
        PieceNote {
            id: id.into(),
            pitch,
            start_ms: start,
            dur_ms: dur,
            hand,
            measure,
        }
    }

    /// Правая: до, ре, (ми+соль). Левая: до малой на первой доле и соль малой отдельно.
    fn piece() -> Vec<PieceNote> {
        vec![
            note("r1", 60, 0, 500, Hand::Right, 1),
            note("l1", 48, 0, 1000, Hand::Left, 1),
            note("r2", 62, 500, 500, Hand::Right, 1),
            note("l2", 55, 1000, 500, Hand::Left, 2),
            note("r3", 64, 1500, 500, Hand::Right, 2),
            note("r4", 67, 1505, 500, Hand::Right, 2),
        ]
    }

    fn events(actions: &[Action]) -> Vec<&PieceEvent> {
        actions
            .iter()
            .filter_map(|a| match a {
                Action::Event(e) => Some(e),
                _ => None,
            })
            .collect()
    }

    #[test]
    fn steps_group_simultaneous_notes() {
        let steps = build_steps(&piece());
        let onsets: Vec<u32> = steps.iter().map(|s| s.onset_ms).collect();
        assert_eq!(onsets, vec![0, 500, 1000, 1500]);
        assert_eq!(steps[0].notes.len(), 2);
        assert_eq!(
            steps[3].notes.len(),
            2,
            "ми и соль с разницей 5 мс — один аккорд"
        );
    }

    #[test]
    fn both_hands_waits_for_whole_chord_in_any_order() {
        let mut s = PieceSession::new(
            piece(),
            PieceConfig {
                hands: HandMode::Both,
                ..Default::default()
            },
        );
        s.start(0);
        assert!(events(&s.on_note_on(48, 10))
            .iter()
            .any(|e| matches!(e, PieceEvent::Hit { .. })));
        assert_eq!(s.index(), 0, "аккорд ещё не взят");
        let a = s.on_note_on(60, 20);
        assert!(events(&a)
            .iter()
            .any(|e| matches!(e, PieceEvent::Step { index: 1, .. })));
        s.on_note_on(62, 30);
        s.on_note_on(55, 40);
        assert_eq!(s.index(), 3);
        s.on_note_on(67, 50);
        let a = s.on_note_on(64, 60);
        assert!(s.is_finished());
        let fin = events(&a).into_iter().find_map(|e| match e {
            PieceEvent::Finished { summary } => Some(summary.clone()),
            _ => None,
        });
        let sum = fin.unwrap();
        assert_eq!(sum.errors, 0);
        assert_eq!(sum.required_notes, 6);
        assert_eq!(sum.played_steps, 4);
    }

    #[test]
    fn wrong_note_is_counted_and_does_not_advance() {
        let mut s = PieceSession::new(
            piece(),
            PieceConfig {
                hands: HandMode::Right,
                ..Default::default()
            },
        );
        s.start(0);
        let a = s.on_note_on(61, 10);
        assert_eq!(
            events(&a),
            vec![&PieceEvent::Wrong {
                index: 0,
                pitch: 61
            }]
        );
        assert_eq!(s.index(), 0);
        // Нота левой руки на этом шаге — не ошибка.
        assert!(s.on_note_on(48, 20).is_empty());
        s.on_note_on(60, 30);
        s.on_note_on(62, 40);
        // Шаг 2 — только левая рука: проходит сам.
        assert_eq!(s.index(), 2);
        s.on_note_on(59, 50); // во время автошага нажатия не считаются
        let mut sess = s;
        let token = sess.token;
        sess.on_timer(token, 60);
        sess.on_note_on(64, 70);
        let a = sess.on_note_on(67, 80);
        let sum = events(&a).into_iter().find_map(|e| match e {
            PieceEvent::Finished { summary } => Some(summary.clone()),
            _ => None,
        });
        let sum = sum.unwrap();
        assert_eq!(sum.errors, 1);
        assert_eq!(
            sum.trouble_measures,
            vec![MeasureErrors {
                measure: 1,
                errors: 1
            }]
        );
        assert_eq!(sum.required_notes, 4);
    }

    #[test]
    fn right_hand_mode_accompanies_with_left_hand() {
        let mut s = PieceSession::new(
            piece(),
            PieceConfig {
                hands: HandMode::Right,
                accompany: true,
                tempo: 1.0,
            },
        );
        let a = s.start(0);
        // Левая ещё не звучит: вступает вместе с первой нотой ученика.
        assert!(!a.iter().any(|x| matches!(x, Action::AppNoteOn { .. })));
        let a = s.on_note_on(60, 10);
        assert!(a.contains(&Action::AppNoteOn {
            pitch: 48,
            velocity: APP_VELOCITY
        }));
        // Шаг 1 (ре): левая (до малой, до 1000 мс) ещё звучит.
        let a = s.on_note_on(62, 20);
        // Переход на шаг 2 (1000 мс): до малой снимается, соль малой звучит сразу (автошаг).
        assert!(a.contains(&Action::AppNoteOff { pitch: 48 }));
        assert!(a.contains(&Action::AppNoteOn {
            pitch: 55,
            velocity: APP_VELOCITY
        }));
        let sched = a.iter().find_map(|x| match x {
            Action::Schedule { token, delay_ms } => Some((*token, *delay_ms)),
            _ => None,
        });
        let (token, delay) = sched.unwrap();
        assert_eq!(delay, 500, "до следующего шага 500 мс при темпе 1.0");
        // Устаревший таймер игнорируется.
        assert!(s.on_timer(token - 1, 30).is_empty());
        let a = s.on_timer(token, 40);
        assert!(events(&a).iter().any(|e| matches!(
            e,
            PieceEvent::Step {
                index: 3,
                auto: false,
                ..
            }
        )));
        assert!(a.contains(&Action::AppNoteOff { pitch: 55 }));
    }

    #[test]
    fn no_accompaniment_when_disabled_and_slow_tempo_stretches_auto_steps() {
        let mut s = PieceSession::new(
            piece(),
            PieceConfig {
                hands: HandMode::Right,
                accompany: false,
                tempo: 0.5,
            },
        );
        s.start(0);
        let a = s.on_note_on(60, 10);
        assert!(!a.iter().any(|x| matches!(x, Action::AppNoteOn { .. })));
        let a = s.on_note_on(62, 20);
        let delay = a.iter().find_map(|x| match x {
            Action::Schedule { delay_ms, .. } => Some(*delay_ms),
            _ => None,
        });
        assert_eq!(delay, Some(1000));
    }

    #[test]
    fn left_hand_only_piece_part_plays_itself_for_right_mode() {
        let notes = vec![
            note("l1", 48, 0, 400, Hand::Left, 1),
            note("l2", 50, 400, 400, Hand::Left, 1),
        ];
        let mut s = PieceSession::new(
            notes,
            PieceConfig {
                hands: HandMode::Right,
                accompany: true,
                tempo: 1.0,
            },
        );
        let a = s.start(0);
        assert!(events(&a).iter().any(|e| matches!(
            e,
            PieceEvent::Step {
                index: 0,
                auto: true,
                ..
            }
        )));
        let t = s.token;
        s.on_timer(t, 1);
        let t = s.token;
        let a = s.on_timer(t, 2);
        assert!(s.is_finished());
        assert!(a.contains(&Action::AppNoteOff { pitch: 50 }));
    }

    #[test]
    fn repeated_chord_note_is_ignored_and_stop_releases_sound() {
        let mut s = PieceSession::new(
            piece(),
            PieceConfig {
                hands: HandMode::Right,
                accompany: true,
                tempo: 1.0,
            },
        );
        s.start(0);
        s.on_note_on(60, 1);
        s.on_note_on(62, 2);
        let t = s.token;
        s.on_timer(t, 3);
        s.on_note_on(64, 4);
        assert!(
            s.on_note_on(64, 5).is_empty(),
            "повтор ми не ошибка и не продвигает"
        );
        let a = s.stop();
        assert!(s.is_finished());
        assert!(a.iter().all(|x| matches!(x, Action::AppNoteOff { .. })));
    }
}
