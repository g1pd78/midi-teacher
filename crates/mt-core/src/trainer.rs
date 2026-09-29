//! Тренажёр чтения нот: ступени, адаптивный подбор нот и оценка серии.
//!
//! На стане показывается нота, нужно нажать ту же клавишу (октава строго).
//! Серия генерируется целиком заранее (для режима «лента» нужен просмотр
//! вперёд), а оценка идёт по мере нажатий с временными метками из потока MIDI.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Clef {
    Treble,
    Bass,
}

impl Clef {
    pub fn as_str(self) -> &'static str {
        match self {
            Clef::Treble => "treble",
            Clef::Bass => "bass",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "treble" => Some(Clef::Treble),
            "bass" => Some(Clef::Bass),
            _ => None,
        }
    }
}

/// Нота, которую нужно сыграть, с записью для нотного стана.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Target {
    pub id: String,
    pub midi: u8,
    pub clef: Clef,
    /// Ступень `c`…`b`.
    pub step: char,
    /// −1 бемоль, 0, +1 диез.
    pub alter: i8,
    /// Октава в научной нотации (C4 — до первой октавы).
    pub octave: i8,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Level {
    pub id: u32,
    pub title: &'static str,
    pub description: &'static str,
    /// Показывать оба ключа (фортепианная система).
    pub grand_staff: bool,
    pub pool: Vec<(u8, Clef)>,
}

const STEPS: [(char, bool); 12] = [
    ('c', true),
    ('c', false),
    ('d', true),
    ('d', false),
    ('e', true),
    ('f', true),
    ('f', false),
    ('g', true),
    ('g', false),
    ('a', true),
    ('a', false),
    ('b', true),
];

fn is_white(midi: u8) -> bool {
    STEPS[(midi % 12) as usize].1
}

fn whites(lo: u8, hi: u8, clef: Clef) -> Vec<(u8, Clef)> {
    (lo..=hi)
        .filter(|&m| is_white(m))
        .map(|m| (m, clef))
        .collect()
}

/// Ключ по высоте для фортепианной системы: от до первой октавы — скрипичный.
fn natural_clef(midi: u8) -> Clef {
    if midi >= 60 {
        Clef::Treble
    } else {
        Clef::Bass
    }
}

/// Все ступени тренажёра по возрастанию сложности.
pub fn levels() -> Vec<Level> {
    use Clef::*;
    let grand = |lo: u8, hi: u8, all_keys: bool| -> Vec<(u8, Clef)> {
        (lo..=hi)
            .filter(|&m| all_keys || is_white(m))
            .map(|m| (m, natural_clef(m)))
            .collect()
    };
    vec![
        Level {
            id: 1,
            title: "До–соль первой октавы",
            description: "Скрипичный ключ, пять нот под правую руку",
            grand_staff: false,
            pool: whites(60, 67, Treble),
        },
        Level {
            id: 2,
            title: "Первая октава",
            description: "Скрипичный ключ, от до до до",
            grand_staff: false,
            pool: whites(60, 72, Treble),
        },
        Level {
            id: 3,
            title: "Весь скрипичный ключ",
            description: "От до первой до соль второй октавы",
            grand_staff: false,
            pool: whites(60, 79, Treble),
        },
        Level {
            id: 4,
            title: "Фа малой – до первой",
            description: "Басовый ключ, пять нот под левую руку",
            grand_staff: false,
            pool: whites(53, 60, Bass),
        },
        Level {
            id: 5,
            title: "Малая октава",
            description: "Басовый ключ, от до до до",
            grand_staff: false,
            pool: whites(48, 60, Bass),
        },
        Level {
            id: 6,
            title: "Весь басовый ключ",
            description: "От соль большой до до первой октавы",
            grand_staff: false,
            pool: whites(43, 60, Bass),
        },
        Level {
            id: 7,
            title: "Оба ключа",
            description: "Фортепианная система: ноты в обоих ключах вперемешку",
            grand_staff: true,
            pool: grand(43, 79, false),
        },
        Level {
            id: 8,
            title: "Добавочные линейки",
            description: "Ноты над и под нотным станом",
            grand_staff: true,
            pool: [
                whites(36, 41, Bass),   // до–фа большой: под басовым станом
                whites(62, 64, Bass),   // ре–ми первой: над басовым станом
                whites(57, 59, Treble), // ля–си малой: под скрипичным станом
                whites(81, 84, Treble), // ля второй – до третьей: над скрипичным
            ]
            .concat(),
        },
        Level {
            id: 9,
            title: "Диезы и бемоли",
            description: "Чёрные клавиши: знаки альтерации в обоих ключах",
            grand_staff: true,
            pool: grand(48, 72, true),
        },
    ]
}

pub fn level(id: u32) -> Option<Level> {
    levels().into_iter().find(|l| l.id == id)
}

/// Простой генератор псевдослучайных чисел (xorshift64*): без зависимостей
/// и воспроизводимый в тестах.
#[derive(Debug, Clone)]
pub struct Rng(u64);

impl Rng {
    pub fn new(seed: u64) -> Self {
        Self(seed.max(1))
    }

    pub fn next_u64(&mut self) -> u64 {
        let mut x = self.0;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.0 = x;
        x.wrapping_mul(0x2545_F491_4F6C_DD1D)
    }

    /// Равномерно в [0, 1).
    pub fn next_f64(&mut self) -> f64 {
        (self.next_u64() >> 11) as f64 / (1u64 << 53) as f64
    }
}

/// Запись ноты для стана. Белые клавиши — без знаков; чёрные — случайно
/// диезом (от нижней белой) или бемолем (от верхней белой).
pub fn spell(midi: u8, rng: &mut Rng) -> (char, i8, i8) {
    let (base, alter) = if is_white(midi) {
        (midi, 0)
    } else if rng.next_u64().is_multiple_of(2) {
        (midi - 1, 1)
    } else {
        (midi + 1, -1)
    };
    let step = STEPS[(base % 12) as usize].0;
    (step, alter, (base / 12) as i8 - 1)
}

/// Накопленная статистика по ноте (в конкретном ключе).
#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteStat {
    pub attempts: f64,
    pub first_try: f64,
    pub reaction_ms_total: f64,
}

impl NoteStat {
    pub fn accuracy(&self) -> f64 {
        if self.attempts > 0.0 {
            self.first_try / self.attempts
        } else {
            0.0
        }
    }

    pub fn avg_reaction_ms(&self) -> f64 {
        if self.attempts > 0.0 {
            self.reaction_ms_total / self.attempts
        } else {
            0.0
        }
    }
}

pub type Stats = HashMap<(Clef, u8), NoteStat>;

/// Вес ноты при подборе: ошибки и медленная реакция — чаще, новые — тоже чаще.
fn weight(stat: Option<&NoteStat>) -> f64 {
    match stat {
        None => 2.5,
        Some(s) if s.attempts < 1.0 => 2.5,
        Some(s) => {
            let errors = 1.0 - s.accuracy();
            let slow = (s.avg_reaction_ms() / 1500.0).min(3.0);
            1.0 + 4.0 * errors + slow
        }
    }
}

/// Подбирает серию нот для ступени с учётом статистики.
pub fn pick_targets(level: &Level, stats: &Stats, count: usize, rng: &mut Rng) -> Vec<Target> {
    let mut out: Vec<Target> = Vec::with_capacity(count);
    let weights: Vec<f64> = level
        .pool
        .iter()
        .map(|k| weight(stats.get(&(k.1, k.0))))
        .collect();
    for i in 0..count {
        let prev = out.last().map(|t| t.midi);
        // Одна и та же нота два раза подряд не выпадает (если есть выбор).
        let total: f64 = level
            .pool
            .iter()
            .zip(&weights)
            .filter(|(k, _)| level.pool.len() == 1 || Some(k.0) != prev)
            .map(|(_, w)| w)
            .sum();
        let mut r = rng.next_f64() * total;
        let mut chosen = level.pool[0];
        for (k, w) in level.pool.iter().zip(&weights) {
            if level.pool.len() > 1 && Some(k.0) == prev {
                continue;
            }
            chosen = *k;
            if r < *w {
                break;
            }
            r -= w;
        }
        let (step, alter, octave) = spell(chosen.0, rng);
        out.push(Target {
            id: format!("t{i}"),
            midi: chosen.0,
            clef: chosen.1,
            step,
            alter,
            octave,
        });
    }
    out
}

/// Что делать при неверной клавише.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum ErrorMode {
    /// Ждать правильную клавишу; после двух ошибок показать подсказку.
    #[default]
    Wait,
    /// Засчитать ошибку и перейти к следующей ноте.
    Advance,
}

impl ErrorMode {
    pub fn as_str(self) -> &'static str {
        match self {
            ErrorMode::Wait => "wait",
            ErrorMode::Advance => "advance",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteResult {
    pub midi: u8,
    pub clef: Clef,
    pub errors: u32,
    pub reaction_ms: u32,
    pub first_try: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Trouble {
    pub midi: u8,
    pub clef: Clef,
    pub errors: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub level: u32,
    pub notes: usize,
    pub first_try: usize,
    /// Доля нот, сыгранных верно с первого раза.
    pub accuracy: f64,
    pub avg_reaction_ms: u32,
    pub trouble: Vec<Trouble>,
    /// Серия прошла условия открытия следующей ступени.
    pub passed: bool,
    /// Следующая ступень открыта этой серией (заполняет хранилище).
    pub unlocked_level: Option<u32>,
}

/// Условия открытия следующей ступени.
pub const PASS_ACCURACY: f64 = 0.9;
pub const PASS_REACTION_MS: u32 = 2000;
/// После скольких ошибок на ноте показывать подсказку (режим ожидания).
pub const HINT_AFTER_ERRORS: u32 = 2;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Feedback {
    #[serde(rename_all = "camelCase")]
    Correct { index: usize, reaction_ms: u32 },
    #[serde(rename_all = "camelCase")]
    Wrong {
        index: usize,
        played: u8,
        expected: u8,
        /// Показать правильную клавишу.
        hint: bool,
        /// Перешли к следующей ноте (режим «идти дальше»).
        advanced: bool,
    },
}

#[derive(Debug, Clone)]
pub struct Session {
    pub level: u32,
    pub mode: ErrorMode,
    pub targets: Vec<Target>,
    index: usize,
    current_since_us: u64,
    current_errors: u32,
    results: Vec<NoteResult>,
}

impl Session {
    pub fn new(level: u32, mode: ErrorMode, targets: Vec<Target>, now_us: u64) -> Self {
        Self {
            level,
            mode,
            targets,
            index: 0,
            current_since_us: now_us,
            current_errors: 0,
            results: Vec::new(),
        }
    }

    pub fn index(&self) -> usize {
        self.index
    }

    pub fn is_finished(&self) -> bool {
        self.index >= self.targets.len()
    }

    pub fn results(&self) -> &[NoteResult] {
        &self.results
    }

    /// Начать отсчёт реакции заново (например, интерфейс показал ноту позже).
    pub fn restart_clock(&mut self, now_us: u64) {
        self.current_since_us = now_us;
    }

    /// Обработать нажатие клавиши. `None` — серия уже закончена.
    pub fn on_note(&mut self, midi: u8, t_us: u64) -> Option<Feedback> {
        let target = self.targets.get(self.index)?.clone();
        let reaction_ms = (t_us.saturating_sub(self.current_since_us) / 1000) as u32;
        let index = self.index;

        if midi == target.midi {
            self.finish_note(&target, reaction_ms, t_us);
            return Some(Feedback::Correct { index, reaction_ms });
        }

        self.current_errors += 1;
        match self.mode {
            ErrorMode::Wait => Some(Feedback::Wrong {
                index,
                played: midi,
                expected: target.midi,
                hint: self.current_errors >= HINT_AFTER_ERRORS,
                advanced: false,
            }),
            ErrorMode::Advance => {
                self.finish_note(&target, reaction_ms, t_us);
                Some(Feedback::Wrong {
                    index,
                    played: midi,
                    expected: target.midi,
                    hint: true,
                    advanced: true,
                })
            }
        }
    }

    fn finish_note(&mut self, target: &Target, reaction_ms: u32, t_us: u64) {
        self.results.push(NoteResult {
            midi: target.midi,
            clef: target.clef,
            errors: self.current_errors,
            reaction_ms,
            first_try: self.current_errors == 0,
        });
        self.index += 1;
        self.current_errors = 0;
        self.current_since_us = t_us;
    }

    pub fn summary(&self) -> Summary {
        let notes = self.results.len();
        let first_try = self.results.iter().filter(|r| r.first_try).count();
        let accuracy = if notes > 0 {
            first_try as f64 / notes as f64
        } else {
            0.0
        };
        let avg_reaction_ms = if notes > 0 {
            (self
                .results
                .iter()
                .map(|r| r.reaction_ms as u64)
                .sum::<u64>()
                / notes as u64) as u32
        } else {
            0
        };

        let mut by_note: HashMap<(Clef, u8), u32> = HashMap::new();
        for r in self.results.iter().filter(|r| r.errors > 0) {
            *by_note.entry((r.clef, r.midi)).or_default() += r.errors;
        }
        let mut trouble: Vec<Trouble> = by_note
            .into_iter()
            .map(|((clef, midi), errors)| Trouble { midi, clef, errors })
            .collect();
        trouble.sort_by(|a, b| b.errors.cmp(&a.errors).then(a.midi.cmp(&b.midi)));
        trouble.truncate(5);

        Summary {
            level: self.level,
            notes,
            first_try,
            accuracy,
            avg_reaction_ms,
            trouble,
            passed: self.is_finished()
                && accuracy >= PASS_ACCURACY
                && avg_reaction_ms <= PASS_REACTION_MS,
            unlocked_level: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn levels_are_ordered_and_pools_valid() {
        let ls = levels();
        for (i, l) in ls.iter().enumerate() {
            assert_eq!(l.id as usize, i + 1);
            assert!(!l.pool.is_empty(), "ступень {} пуста", l.id);
            for &(m, clef) in &l.pool {
                assert!((21..=108).contains(&m));
                if !l.grand_staff {
                    assert_eq!(clef, l.pool[0].1, "в одноключевой ступени один ключ");
                }
            }
        }
        // Первая ступень: до, ре, ми, фа, соль первой октавы.
        assert_eq!(
            ls[0].pool.iter().map(|p| p.0).collect::<Vec<_>>(),
            vec![60, 62, 64, 65, 67]
        );
        // Чёрные клавиши только в ступени со знаками.
        for l in &ls[..8] {
            assert!(l.pool.iter().all(|p| is_white(p.0)));
        }
        assert!(ls[8].pool.iter().any(|p| !is_white(p.0)));
    }

    #[test]
    fn spelling_matches_pitch() {
        let mut rng = Rng::new(7);
        assert_eq!(spell(60, &mut rng), ('c', 0, 4));
        assert_eq!(spell(59, &mut rng), ('b', 0, 3));
        assert_eq!(spell(21, &mut rng), ('a', 0, 0));
        let mut seen_sharp = false;
        let mut seen_flat = false;
        for _ in 0..50 {
            match spell(61, &mut rng) {
                ('c', 1, 4) => seen_sharp = true,
                ('d', -1, 4) => seen_flat = true,
                other => panic!("неверная запись 61: {other:?}"),
            }
        }
        assert!(seen_sharp && seen_flat);
        // Си-бемоль малой / ля-диез малой.
        let s = spell(58, &mut rng);
        assert!(s == ('a', 1, 3) || s == ('b', -1, 3));
    }

    #[test]
    fn picker_prefers_weak_notes_and_avoids_repeats() {
        let level = level(1).unwrap();
        let mut stats = Stats::new();
        for &(m, c) in &level.pool {
            let good = NoteStat {
                attempts: 20.0,
                first_try: 20.0,
                reaction_ms_total: 20.0 * 600.0,
            };
            stats.insert((c, m), good);
        }
        // Фа (65) часто путают и долго думают.
        stats.insert(
            (Clef::Treble, 65),
            NoteStat {
                attempts: 20.0,
                first_try: 8.0,
                reaction_ms_total: 20.0 * 3000.0,
            },
        );
        let mut rng = Rng::new(42);
        let targets = pick_targets(&level, &stats, 2000, &mut rng);
        let fa = targets.iter().filter(|t| t.midi == 65).count();
        let do_ = targets.iter().filter(|t| t.midi == 60).count();
        assert!(fa > do_ * 2, "фа {fa}, до {do_}");
        assert!(targets.windows(2).all(|w| w[0].midi != w[1].midi));
        assert!(targets
            .iter()
            .all(|t| level.pool.contains(&(t.midi, t.clef))));
        assert_eq!(targets[0].id, "t0");
    }

    fn session(mode: ErrorMode) -> Session {
        let mut rng = Rng::new(1);
        let targets = pick_targets(&level(2).unwrap(), &Stats::new(), 4, &mut rng);
        Session::new(2, mode, targets, 1_000_000)
    }

    #[test]
    fn wait_mode_waits_for_correct_key_and_hints_after_two_errors() {
        let mut s = session(ErrorMode::Wait);
        let first = s.targets[0].midi;
        let wrong = if first == 60 { 62 } else { 60 };

        let fb = s.on_note(wrong, 1_500_000).unwrap();
        assert!(matches!(
            fb,
            Feedback::Wrong {
                hint: false,
                advanced: false,
                ..
            }
        ));
        let fb = s.on_note(wrong, 1_700_000).unwrap();
        assert!(matches!(
            fb,
            Feedback::Wrong {
                hint: true,
                advanced: false,
                ..
            }
        ));
        assert_eq!(s.index(), 0);

        let fb = s.on_note(first, 2_200_000).unwrap();
        assert_eq!(
            fb,
            Feedback::Correct {
                index: 0,
                reaction_ms: 1200
            }
        );
        assert_eq!(s.index(), 1);
        assert_eq!(s.results()[0].errors, 2);
        assert!(!s.results()[0].first_try);
    }

    #[test]
    fn octave_is_strict() {
        let mut s = session(ErrorMode::Wait);
        let first = s.targets[0].midi;
        let fb = s.on_note(first + 12, 1_100_000).unwrap();
        assert!(matches!(fb, Feedback::Wrong { .. }));
    }

    #[test]
    fn advance_mode_moves_on_after_error() {
        let mut s = session(ErrorMode::Advance);
        let first = s.targets[0].midi;
        let fb = s.on_note(first + 1, 1_400_000).unwrap();
        assert!(matches!(
            fb,
            Feedback::Wrong {
                index: 0,
                advanced: true,
                hint: true,
                ..
            }
        ));
        assert_eq!(s.index(), 1);
    }

    #[test]
    fn perfect_series_passes_and_slow_series_does_not() {
        let mut s = session(ErrorMode::Wait);
        let mut t = 1_000_000;
        for i in 0..4 {
            t += 800_000;
            let m = s.targets[i].midi;
            s.on_note(m, t);
        }
        assert!(s.is_finished());
        assert_eq!(s.on_note(60, t + 1), None);
        let sum = s.summary();
        assert_eq!(sum.first_try, 4);
        assert_eq!(sum.avg_reaction_ms, 800);
        assert!(sum.passed);
        assert!(sum.trouble.is_empty());

        let mut slow = session(ErrorMode::Wait);
        let mut t = 1_000_000;
        for i in 0..4 {
            t += 2_500_000;
            let m = slow.targets[i].midi;
            slow.on_note(m, t);
        }
        assert!(!slow.summary().passed);
    }

    #[test]
    fn trouble_lists_notes_with_most_errors() {
        let mut s = session(ErrorMode::Wait);
        let mut t = 1_000_000;
        for i in 0..4 {
            let m = s.targets[i].midi;
            if i == 1 {
                for _ in 0..3 {
                    t += 100_000;
                    s.on_note(if m == 60 { 62 } else { 60 }, t);
                }
            }
            t += 500_000;
            s.on_note(m, t);
        }
        let sum = s.summary();
        assert_eq!(sum.first_try, 3);
        assert_eq!(sum.trouble.len(), 1);
        assert_eq!(sum.trouble[0].midi, s.targets[1].midi);
        assert_eq!(sum.trouble[0].errors, 3);
        assert!(!sum.passed, "точность 75% < 90%");
    }
}
