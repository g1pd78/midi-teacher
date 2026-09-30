//! Движок практики: как выучить пьесу наизусть.
//!
//! Пьеса делится на фрагменты по 2–4 такта. Фрагменты учатся по очереди и
//! сцепляются: 1 → 2 → 1+2 → 3 → 1–3 → … Каждый такой отрезок («единица»)
//! проходит уровни подсказок:
//!
//! | уровень | что происходит |
//! |---|---|
//! | 0 Знакомство | приложение играет отрезок, ученик слушает и смотрит |
//! | 1 Полные подсказки | руки отдельно, режим ожидания, названия нот, подсветка |
//! | 2 Ноты с курсором | обе руки, ожидание, без названий нот |
//! | 3 Только ноты | обе руки в темпе 60→100 %, без падающих нот и подсветки |
//! | 4 По памяти | ноты отрезка скрыты |
//!
//! После `STREAK_TO_ADVANCE` хороших проходов подряд приложение **предлагает**
//! перейти дальше, после `FAILS_TO_RETREAT` плохих — вернуться. Решает ученик.
//! Модуль чистый: состояние на входе, состояние и предложение на выходе.

use crate::piece::{HandMode, MeasureErrors};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

pub const MAX_LEVEL: u8 = 4;
/// Хороший проход: точность не ниже.
pub const GOOD_ACCURACY: f64 = 0.95;
/// Плохой проход: точность ниже.
pub const BAD_ACCURACY: f64 = 0.8;
pub const STREAK_TO_ADVANCE: u32 = 3;
pub const FAILS_TO_RETREAT: u32 = 3;
/// Темп на уровне 3: начинаем с 60 % и после каждого хорошего прохода +10 %.
pub const TEMPO_START: f64 = 0.6;
pub const TEMPO_STEP: f64 = 0.1;
pub const TEMPO_TARGET: f64 = 1.0;
/// Фрагмент — от 2 до 4 тактов.
pub const FRAGMENT_MIN: u32 = 2;
pub const FRAGMENT_MAX: u32 = 4;

/// Автоматическая разбивка на фрагменты. `phrase_ends` — такты, на которых
/// заканчивается фраза (двойная тактовая черта, долгая нота или пауза в конце).
/// Фрагмент режется на конце фразы, если в нём уже есть 2 такта, и в любом
/// случае на 4 тактах. Одинокий последний такт присоединяется к соседу.
pub fn split_fragments(measures: u32, phrase_ends: &[u32]) -> Vec<(u32, u32)> {
    let mut out: Vec<(u32, u32)> = Vec::new();
    let mut start = 1;
    for m in 1..=measures {
        let len = m - start + 1;
        if (len >= FRAGMENT_MIN && phrase_ends.contains(&m)) || len >= FRAGMENT_MAX {
            out.push((start, m));
            start = m + 1;
        }
    }
    if start <= measures {
        if measures - start + 1 == 1 {
            if let Some(last) = out.last_mut() {
                if last.1 - last.0 + 1 > FRAGMENT_MIN {
                    // 4 + 1 → 3 + 2
                    last.1 -= 1;
                    start -= 1;
                } else {
                    // 2 + 1 → 3
                    last.1 = measures;
                    start = measures + 1;
                }
            }
        }
        if start <= measures {
            out.push((start, measures));
        }
    }
    out
}

/// Фрагменты по номерам тактов, с которых они начинаются (ручная правка границ).
pub fn fragments_from_starts(measures: u32, starts: &[u32]) -> Vec<(u32, u32)> {
    if measures == 0 {
        return Vec::new();
    }
    let mut s: Vec<u32> = starts
        .iter()
        .copied()
        .filter(|&m| (1..=measures).contains(&m))
        .collect();
    s.push(1);
    s.sort_unstable();
    s.dedup();
    s.iter()
        .enumerate()
        .map(|(i, &a)| (a, s.get(i + 1).map_or(measures, |&b| b - 1)))
        .collect()
}

/// Порядок разучивания: 1 → 2 → 1+2 → 3 → 1–3 → … (индексы фрагментов с 0, включительно).
pub fn chain(fragments: usize) -> Vec<(usize, usize)> {
    let mut out = Vec::new();
    for i in 0..fragments {
        out.push((i, i));
        if i > 0 {
            out.push((0, i));
        }
    }
    out
}

/// Отдельный фрагмент начинается со знакомства, сцепка уже знакомых — с нот и курсора.
pub fn initial_level(frags: (usize, usize)) -> u8 {
    if frags.0 == frags.1 {
        0
    } else {
        2
    }
}

/// Какие руки есть в отрезке.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct Hands {
    pub right: bool,
    pub left: bool,
}

impl Hands {
    /// По маске тактов (бит 1 — правая, бит 2 — левая), такты с 1.
    pub fn of_range(mask: &[u8], from: u32, to: u32) -> Self {
        let mut h = Hands::default();
        for m in from..=to {
            let bits = mask.get(m as usize - 1).copied().unwrap_or(0);
            h.right |= bits & 1 != 0;
            h.left |= bits & 2 != 0;
        }
        h
    }

    fn both(self) -> bool {
        self.right && self.left
    }
}

/// Состояние отрезка (хранится в базе как JSON).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct UnitState {
    pub level: u8,
    /// Хороших проходов подряд на текущем уровне.
    pub streak: u32,
    /// Плохих проходов подряд.
    pub fails: u32,
    /// Уровень 1: хорошие проходы подряд для каждой руки.
    pub right_streak: u32,
    pub left_streak: u32,
    /// Темп уровня 3.
    pub tempo: f64,
    /// Отрезок сыгран по памяти `STREAK_TO_ADVANCE` раз подряд.
    pub learned: bool,
    pub passes: u32,
}

impl Default for UnitState {
    fn default() -> Self {
        Self::new(0)
    }
}

impl UnitState {
    pub fn new(level: u8) -> Self {
        Self {
            level: level.min(MAX_LEVEL),
            streak: 0,
            fails: 0,
            right_streak: 0,
            left_streak: 0,
            tempo: TEMPO_START,
            learned: false,
            passes: 0,
        }
    }

    /// Смена уровня (вручную или по предложению): счётчики с нуля.
    pub fn set_level(&mut self, level: u8) {
        let level = level.min(MAX_LEVEL);
        if level == 3 && self.level != 3 {
            self.tempo = TEMPO_START;
        }
        self.level = level;
        self.streak = 0;
        self.fails = 0;
        self.right_streak = 0;
        self.left_streak = 0;
    }

    /// Темп, в котором играется уровень (для ожидания — темп второй руки).
    pub fn play_tempo(&self) -> f64 {
        match self.level {
            3 => self.tempo,
            4 => TEMPO_TARGET,
            _ => 0.8,
        }
    }
}

/// Какой рукой играть на уровне `state.level`.
pub fn level_hand(state: &UnitState, hands: Hands) -> HandMode {
    let only = |h: Hands| {
        if h.right {
            HandMode::Right
        } else {
            HandMode::Left
        }
    };
    match state.level {
        0 => HandMode::None,
        1 if hands.both() => {
            let r_done = state.right_streak >= STREAK_TO_ADVANCE;
            let l_done = state.left_streak >= STREAK_TO_ADVANCE;
            match (r_done, l_done) {
                (false, _) => HandMode::Right,
                (true, false) => HandMode::Left,
                // Обе руки готовы, ученик остался на уровне: чередуем.
                _ if state.right_streak <= state.left_streak => HandMode::Right,
                _ => HandMode::Left,
            }
        }
        _ if hands.both() => HandMode::Both,
        _ => only(hands),
    }
}

/// Результат одного прохода отрезка.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Pass {
    pub level: u8,
    pub hands: HandMode,
    pub accuracy: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Suggestion {
    LevelUp {
        to: u8,
    },
    LevelDown {
        to: u8,
    },
    /// Отрезок выучен: можно переходить к следующему.
    Learned,
}

#[derive(Debug, Clone, Copy, PartialEq, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Outcome {
    pub good: bool,
    pub suggestion: Option<Suggestion>,
    /// Темп уровня 3 изменился (новое значение).
    pub tempo: Option<f64>,
    /// Отрезок стал выученным именно на этом проходе.
    pub learned_now: bool,
}

/// Учесть проход. Проход на другом уровне (например, запущенный до смены)
/// только увеличивает счётчик проходов.
pub fn record(state: &mut UnitState, pass: &Pass, hands: Hands) -> Outcome {
    state.passes += 1;
    let mut out = Outcome::default();
    if pass.level != state.level {
        return out;
    }
    let level = state.level;
    let good = level == 0 || pass.accuracy >= GOOD_ACCURACY;
    let bad = level > 0 && pass.accuracy < BAD_ACCURACY;
    out.good = good;
    if good {
        state.streak += 1;
        state.fails = 0;
    } else {
        state.streak = 0;
        if bad {
            state.fails += 1;
        }
    }
    let down = |to: u8| Some(Suggestion::LevelDown { to });

    match level {
        0 => out.suggestion = Some(Suggestion::LevelUp { to: 1 }),
        1 => {
            let streak = match pass.hands {
                HandMode::Right => Some(&mut state.right_streak),
                HandMode::Left => Some(&mut state.left_streak),
                _ => None,
            };
            if let Some(s) = streak {
                *s = if good { *s + 1 } else { 0 };
            } else if good {
                // Обе руки сразу засчитываются за каждую.
                state.right_streak += 1;
                state.left_streak += 1;
            } else {
                state.right_streak = 0;
                state.left_streak = 0;
            }
            let r = !hands.right || state.right_streak >= STREAK_TO_ADVANCE;
            let l = !hands.left || state.left_streak >= STREAK_TO_ADVANCE;
            if r && l {
                out.suggestion = Some(Suggestion::LevelUp { to: 2 });
            } else if state.fails >= FAILS_TO_RETREAT {
                out.suggestion = down(0);
            }
        }
        2 => {
            if state.streak >= STREAK_TO_ADVANCE {
                out.suggestion = Some(Suggestion::LevelUp { to: 3 });
            } else if state.fails >= FAILS_TO_RETREAT {
                out.suggestion = down(1);
            }
        }
        3 => {
            if good && state.tempo < TEMPO_TARGET - 1e-6 {
                // Темп растёт сам; серия считается только в полном темпе.
                state.tempo = round_tempo(state.tempo + TEMPO_STEP).min(TEMPO_TARGET);
                state.streak = 0;
                out.tempo = Some(state.tempo);
            } else if state.fails >= FAILS_TO_RETREAT {
                if state.tempo > TEMPO_START + 1e-6 {
                    state.tempo = round_tempo(state.tempo - TEMPO_STEP).max(TEMPO_START);
                    state.fails = 0;
                    out.tempo = Some(state.tempo);
                } else {
                    out.suggestion = down(2);
                }
            }
            if state.streak >= STREAK_TO_ADVANCE {
                out.suggestion = Some(Suggestion::LevelUp { to: 4 });
            }
        }
        _ => {
            if state.streak >= STREAK_TO_ADVANCE {
                out.learned_now = !state.learned;
                state.learned = true;
                out.suggestion = Some(Suggestion::Learned);
            } else if state.fails >= FAILS_TO_RETREAT {
                out.suggestion = down(3);
            }
        }
    }
    out
}

fn round_tempo(t: f64) -> f64 {
    (t * 100.0).round() / 100.0
}

/// Точность прохода в режиме ожидания: нужные ноты против лишних нажатий.
pub fn wait_accuracy(required: usize, errors: u32) -> f64 {
    if required == 0 {
        1.0
    } else {
        required as f64 / (required as f64 + errors as f64)
    }
}

/// Точность прохода в темпе: попадания против нужных нот и лишних нажатий.
pub fn rhythm_accuracy(required: usize, hits: usize, extras: usize) -> f64 {
    if required == 0 {
        1.0
    } else {
        hits as f64 / (required + extras) as f64
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnitView {
    /// Индексы фрагментов (с 0, включительно).
    pub frags: (usize, usize),
    /// Такты (с 1, включительно).
    pub from: u32,
    pub to: u32,
    pub state: UnitState,
    /// Рука для текущего уровня.
    pub hand: HandMode,
    pub hands: Hands,
    /// К отрезку уже приступали.
    pub started: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PracticeView {
    pub piece: String,
    pub measures: u32,
    pub fragments: Vec<(u32, u32)>,
    /// Границы фрагментов поправлены вручную.
    pub custom: bool,
    /// Отрезки в порядке разучивания.
    pub units: Vec<UnitView>,
    /// Какой отрезок учить сейчас (первый невыученный).
    pub current: usize,
    /// Ошибки по тактам за последние недели.
    pub heat: Vec<MeasureErrors>,
}

/// Отрезки в порядке разучивания и первый невыученный.
pub fn build_units(
    fragments: &[(u32, u32)],
    stored: &HashMap<(u32, u32), UnitState>,
    measure_hands: &[u8],
) -> (Vec<UnitView>, usize) {
    let units: Vec<UnitView> = chain(fragments.len())
        .into_iter()
        .map(|frags| {
            let (from, to) = (fragments[frags.0].0, fragments[frags.1].1);
            let saved = stored.get(&(from, to)).copied();
            let state = saved.unwrap_or_else(|| UnitState::new(initial_level(frags)));
            let hands = Hands::of_range(measure_hands, from, to);
            UnitView {
                frags,
                from,
                to,
                state,
                hand: level_hand(&state, hands),
                hands,
                started: saved.is_some(),
            }
        })
        .collect();
    let current = units
        .iter()
        .position(|u| !u.state.learned)
        .unwrap_or(units.len().saturating_sub(1));
    (units, current)
}

#[cfg(test)]
mod tests {
    use super::*;

    const BOTH: Hands = Hands {
        right: true,
        left: true,
    };
    const RIGHT: Hands = Hands {
        right: true,
        left: false,
    };

    fn pass(level: u8, hands: HandMode, accuracy: f64) -> Pass {
        Pass {
            level,
            hands,
            accuracy,
        }
    }

    #[test]
    fn fragments_follow_phrases_and_limits() {
        // «Ода к радости»: фразы по 4 такта.
        assert_eq!(
            split_fragments(16, &[4, 8, 12, 16]),
            vec![(1, 4), (5, 8), (9, 12), (13, 16)]
        );
        // Без подсказок — по 4 такта, остаток 2 остаётся отдельным.
        assert_eq!(split_fragments(10, &[]), vec![(1, 4), (5, 8), (9, 10)]);
        // Конец фразы после 2 тактов режет раньше, после 1 такта — нет.
        assert_eq!(split_fragments(6, &[1, 2]), vec![(1, 2), (3, 6)]);
        // Одинокий последний такт: 4 + 1 → 3 + 2, 2 + 1 → 3.
        assert_eq!(split_fragments(5, &[]), vec![(1, 3), (4, 5)]);
        assert_eq!(split_fragments(3, &[2]), vec![(1, 3)]);
        assert_eq!(split_fragments(1, &[]), vec![(1, 1)]);
        assert!(split_fragments(0, &[]).is_empty());
        // Все такты покрыты без пропусков.
        for n in 1..40 {
            let f = split_fragments(n, &[3, 7, 8, 15]);
            assert_eq!(f[0].0, 1);
            assert_eq!(f.last().unwrap().1, n);
            for w in f.windows(2) {
                assert_eq!(w[0].1 + 1, w[1].0);
            }
        }
    }

    #[test]
    fn custom_starts() {
        assert_eq!(
            fragments_from_starts(10, &[5, 3, 3, 12, 0]),
            vec![(1, 2), (3, 4), (5, 10)]
        );
        assert_eq!(fragments_from_starts(4, &[]), vec![(1, 4)]);
        assert!(fragments_from_starts(0, &[1]).is_empty());
    }

    #[test]
    fn chain_order() {
        assert_eq!(chain(1), vec![(0, 0)]);
        assert_eq!(
            chain(4),
            vec![(0, 0), (1, 1), (0, 1), (2, 2), (0, 2), (3, 3), (0, 3)]
        );
    }

    #[test]
    fn listening_suggests_level_one() {
        let mut s = UnitState::new(0);
        let o = record(&mut s, &pass(0, HandMode::None, 1.0), BOTH);
        assert_eq!(o.suggestion, Some(Suggestion::LevelUp { to: 1 }));
    }

    #[test]
    fn level_one_trains_each_hand() {
        let mut s = UnitState::new(1);
        assert_eq!(level_hand(&s, BOTH), HandMode::Right);
        for _ in 0..3 {
            assert_eq!(
                record(&mut s, &pass(1, HandMode::Right, 1.0), BOTH).suggestion,
                None
            );
        }
        assert_eq!(level_hand(&s, BOTH), HandMode::Left);
        record(&mut s, &pass(1, HandMode::Left, 1.0), BOTH);
        // Ошибка сбрасывает серию руки.
        record(&mut s, &pass(1, HandMode::Left, 0.9), BOTH);
        assert_eq!(s.left_streak, 0);
        record(&mut s, &pass(1, HandMode::Left, 1.0), BOTH);
        record(&mut s, &pass(1, HandMode::Left, 1.0), BOTH);
        let o = record(&mut s, &pass(1, HandMode::Left, 0.96), BOTH);
        assert_eq!(o.suggestion, Some(Suggestion::LevelUp { to: 2 }));

        // Одна рука в отрезке — хватает её серии.
        let mut s = UnitState::new(1);
        assert_eq!(level_hand(&s, RIGHT), HandMode::Right);
        for _ in 0..2 {
            record(&mut s, &pass(1, HandMode::Right, 1.0), RIGHT);
        }
        let o = record(&mut s, &pass(1, HandMode::Right, 1.0), RIGHT);
        assert_eq!(o.suggestion, Some(Suggestion::LevelUp { to: 2 }));
    }

    #[test]
    fn three_good_passes_suggest_next_level_and_failures_go_back() {
        let mut s = UnitState::new(2);
        assert_eq!(level_hand(&s, BOTH), HandMode::Both);
        record(&mut s, &pass(2, HandMode::Both, 1.0), BOTH);
        // Средний проход (между 80 и 95 %) обрывает серию, но не считается провалом.
        record(&mut s, &pass(2, HandMode::Both, 0.9), BOTH);
        assert_eq!((s.streak, s.fails), (0, 0));
        record(&mut s, &pass(2, HandMode::Both, 1.0), BOTH);
        record(&mut s, &pass(2, HandMode::Both, 1.0), BOTH);
        let o = record(&mut s, &pass(2, HandMode::Both, 1.0), BOTH);
        assert_eq!(o.suggestion, Some(Suggestion::LevelUp { to: 3 }));

        let mut s = UnitState::new(2);
        for _ in 0..2 {
            assert_eq!(
                record(&mut s, &pass(2, HandMode::Both, 0.5), BOTH).suggestion,
                None
            );
        }
        let o = record(&mut s, &pass(2, HandMode::Both, 0.5), BOTH);
        assert_eq!(o.suggestion, Some(Suggestion::LevelDown { to: 1 }));
    }

    #[test]
    fn level_three_ramps_tempo_then_needs_streak_at_full_tempo() {
        let mut s = UnitState::new(2);
        s.set_level(3);
        assert_eq!(s.tempo, TEMPO_START);
        let mut tempos = Vec::new();
        for _ in 0..4 {
            let o = record(&mut s, &pass(3, HandMode::Both, 1.0), BOTH);
            tempos.push(o.tempo.unwrap());
            assert_eq!(o.suggestion, None);
        }
        assert_eq!(tempos, vec![0.7, 0.8, 0.9, 1.0]);
        assert_eq!(s.play_tempo(), 1.0);
        record(&mut s, &pass(3, HandMode::Both, 1.0), BOTH);
        record(&mut s, &pass(3, HandMode::Both, 1.0), BOTH);
        let o = record(&mut s, &pass(3, HandMode::Both, 1.0), BOTH);
        assert_eq!(o.tempo, None);
        assert_eq!(o.suggestion, Some(Suggestion::LevelUp { to: 4 }));

        // Провалы сначала замедляют, на стартовом темпе — предлагают вернуться.
        let mut s = UnitState::new(3);
        s.tempo = 0.7;
        for _ in 0..2 {
            record(&mut s, &pass(3, HandMode::Both, 0.3), BOTH);
        }
        let o = record(&mut s, &pass(3, HandMode::Both, 0.3), BOTH);
        assert_eq!(o.tempo, Some(0.6));
        assert_eq!(o.suggestion, None);
        for _ in 0..2 {
            record(&mut s, &pass(3, HandMode::Both, 0.3), BOTH);
        }
        let o = record(&mut s, &pass(3, HandMode::Both, 0.3), BOTH);
        assert_eq!(o.suggestion, Some(Suggestion::LevelDown { to: 2 }));
    }

    #[test]
    fn memory_level_marks_learned_once() {
        let mut s = UnitState::new(4);
        record(&mut s, &pass(4, HandMode::Both, 1.0), BOTH);
        record(&mut s, &pass(4, HandMode::Both, 1.0), BOTH);
        let o = record(&mut s, &pass(4, HandMode::Both, 1.0), BOTH);
        assert!(o.learned_now && s.learned);
        assert_eq!(o.suggestion, Some(Suggestion::Learned));
        let o = record(&mut s, &pass(4, HandMode::Both, 1.0), BOTH);
        assert!(!o.learned_now);
        // Выученный остаётся выученным и после ошибок.
        record(&mut s, &pass(4, HandMode::Both, 0.1), BOTH);
        assert!(s.learned);
    }

    #[test]
    fn stale_pass_only_counts() {
        let mut s = UnitState::new(2);
        let o = record(&mut s, &pass(1, HandMode::Right, 1.0), BOTH);
        assert_eq!(o, Outcome::default());
        assert_eq!((s.passes, s.streak), (1, 0));
    }

    #[test]
    fn accuracy_formulas() {
        assert_eq!(wait_accuracy(0, 3), 1.0);
        assert!((wait_accuracy(19, 1) - 0.95).abs() < 1e-9);
        assert!((rhythm_accuracy(10, 9, 0) - 0.9).abs() < 1e-9);
        assert!((rhythm_accuracy(10, 10, 10) - 0.5).abs() < 1e-9);
    }

    #[test]
    fn units_start_where_learning_stopped() {
        let fragments = vec![(1, 4), (5, 8), (9, 10)];
        // Правая рука везде, левая — только в тактах 5–8.
        let mask = vec![1, 1, 1, 1, 3, 3, 3, 3, 1, 1];
        let mut stored = HashMap::new();
        let (units, current) = build_units(&fragments, &stored, &mask);
        assert_eq!(units.len(), 5);
        assert_eq!(current, 0);
        assert_eq!(units[0].state.level, 0);
        assert_eq!(units[0].hand, HandMode::None);
        assert_eq!(units[2].state.level, 2); // сцепка 1+2
        assert_eq!((units[2].from, units[2].to), (1, 8));
        assert!(units[2].hands.left && !units[0].hands.left);

        let mut learned = UnitState::new(4);
        learned.learned = true;
        stored.insert((1, 4), learned);
        let mut l1 = UnitState::new(1);
        l1.right_streak = 3;
        stored.insert((5, 8), l1);
        let (units, current) = build_units(&fragments, &stored, &mask);
        assert_eq!(current, 1);
        assert!(units[0].started && units[1].started && !units[2].started);
        assert_eq!(units[1].hand, HandMode::Left);
    }
}
