//! Режим ритма: пьеса идёт в темпе, нажатия оцениваются по времени.
//!
//! Как и [`crate::piece`], модуль чистый: получает текущее время и нажатия,
//! возвращает действия (звук второй руки, щелчки метронома, события для
//! интерфейса) и время, когда его нужно разбудить в следующий раз. Драйвер
//! с потоком и часами живёт в приложении.
//!
//! Время пьесы (`pos`, мс) связано с реальным временем (`t_us`, мкс) через темп:
//! `pos = pos0 + (t_us − origin_us) / 1000 · tempo`.

use crate::piece::{HandMode, KeyMap, MeasureErrors, PieceNote};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// Окна оценки (реальные миллисекунды): точно / нормально / неточно.
pub const PERFECT_MS: i32 = 50;
pub const GOOD_MS: i32 = 120;
/// Дальше этого нажатие не засчитывается как попадание в ноту.
pub const WINDOW_MS: i32 = 200;
/// Минимальная пауза перед первой нотой, чтобы успеть увидеть падающие ноты.
const LEAD_IN_MS: u64 = 1200;
const APP_VELOCITY: u8 = 70;

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Beat {
    /// Время доли в мс пьесы.
    pub ms: u32,
    /// Сильная доля (первая в такте).
    pub accent: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct RhythmConfig {
    pub hands: HandMode,
    pub accompany: bool,
    /// 1.0 — темп пьесы.
    pub tempo: f32,
    pub count_in: bool,
    pub metronome: bool,
    /// Играть только отрезок [начало, конец) в мс пьесы, по кругу.
    pub loop_range: Option<(u32, u32)>,
    /// Долей в такте и длительность доли (мс пьесы) — для отсчёта.
    pub beats_per_measure: u32,
    pub beat_ms: u32,
    pub key_map: KeyMap,
}

impl Default for RhythmConfig {
    fn default() -> Self {
        Self {
            hands: HandMode::Both,
            accompany: true,
            tempo: 0.8,
            count_in: true,
            metronome: false,
            loop_range: None,
            beats_per_measure: 4,
            beat_ms: 600,
            key_map: KeyMap::Exact,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Grade {
    Perfect,
    Good,
    Poor,
}

pub fn grade(delta_ms: i32) -> Grade {
    match delta_ms.abs() {
        d if d <= PERFECT_MS => Grade::Perfect,
        d if d <= GOOD_MS => Grade::Good,
        _ => Grade::Poor,
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RhythmSummary {
    pub required_notes: usize,
    pub hits: usize,
    pub misses: usize,
    pub extras: usize,
    pub perfect: usize,
    pub good: usize,
    pub poor: usize,
    /// Доля сыгранных нот (попаданий) от нужных.
    pub accuracy: f64,
    /// Среднее отклонение по модулю, мс.
    pub mean_abs_delta_ms: u32,
    /// Средний сдвиг со знаком: > 0 — опаздываешь, < 0 — спешишь.
    pub mean_delta_ms: i32,
    pub trouble_measures: Vec<MeasureErrors>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum RhythmEvent {
    /// Отсчёт времени: позиция `pos0` (мс пьесы) соответствует моменту `origin_us`.
    #[serde(rename_all = "camelCase")]
    Clock {
        origin_us: u64,
        pos0: u32,
        tempo: f32,
    },
    #[serde(rename_all = "camelCase")]
    Hit {
        id: String,
        delta_ms: i32,
        grade: Grade,
        /// Сила нажатия (1–127) — для ровности громкости в упражнениях.
        velocity: u8,
    },
    #[serde(rename_all = "camelCase")]
    Miss { id: String },
    #[serde(rename_all = "camelCase")]
    Extra { pitch: u8 },
    #[serde(rename_all = "camelCase")]
    LoopPass { pass: u32, summary: RhythmSummary },
    #[serde(rename_all = "camelCase")]
    Finished { summary: RhythmSummary },
}

#[derive(Debug, Clone, PartialEq)]
pub enum Action {
    Event(RhythmEvent),
    AppNoteOn {
        pitch: u8,
        velocity: u8,
    },
    AppNoteOff {
        pitch: u8,
    },
    /// Нота аккомпанемента на GM-синтезаторе (инструмент своей дорожки).
    GmNoteOn {
        channel: u8,
        program: Option<u8>,
        pitch: u8,
        velocity: u8,
    },
    GmNoteOff {
        channel: u8,
        pitch: u8,
    },
    Click {
        accent: bool,
    },
}

fn off_action(pitch: u8, channel: Option<u8>) -> Action {
    match channel {
        Some(channel) => Action::GmNoteOff { channel, pitch },
        None => Action::AppNoteOff { pitch },
    }
}

pub struct RhythmSession {
    notes: Vec<PieceNote>,
    /// Ноты ученика и второй руки, по времени начала.
    required: Vec<usize>,
    accomp: Vec<usize>,
    beats: Vec<Beat>,
    cfg: RhythmConfig,
    start_ms: u32,
    end_ms: u32,

    origin_us: u64,
    count_in: Vec<(u64, bool)>,
    matched: Vec<Option<i32>>,
    missed: Vec<bool>,
    next_beat: usize,
    next_accomp: usize,
    /// Звучащие ноты приложения: (высота, конец, канал GM).
    sounding: Vec<(u8, u32, Option<u8>)>,
    miss_cursor: usize,
    extras: usize,
    errors_by_measure: BTreeMap<u32, u32>,
    pass: u32,
    finished: bool,
    /// Нажатия на стыке кругов, которые относятся к началу следующего круга.
    pending_next: Vec<(usize, i32, u8)>,
}

impl RhythmSession {
    pub fn new(notes: Vec<PieceNote>, mut beats: Vec<Beat>, cfg: RhythmConfig) -> Self {
        let (start_ms, end_ms) = match cfg.loop_range {
            Some((a, b)) if b > a => (a, b),
            _ => (
                notes.iter().map(|n| n.start_ms).min().unwrap_or(0),
                notes
                    .iter()
                    .map(|n| n.start_ms + n.dur_ms)
                    .max()
                    .unwrap_or(0),
            ),
        };
        let in_range = |n: &PieceNote| n.start_ms >= start_ms && n.start_ms < end_ms;
        let mut required: Vec<usize> = (0..notes.len())
            .filter(|&i| in_range(&notes[i]) && cfg.hands.includes(notes[i].hand))
            .collect();
        let mut accomp: Vec<usize> = (0..notes.len())
            .filter(|&i| in_range(&notes[i]) && !cfg.hands.includes(notes[i].hand))
            .collect();
        required.sort_by_key(|&i| (notes[i].start_ms, notes[i].pitch));
        accomp.sort_by_key(|&i| (notes[i].start_ms, notes[i].pitch));
        beats.retain(|b| b.ms >= start_ms && b.ms < end_ms);
        beats.sort_by_key(|b| b.ms);
        let n = required.len();
        Self {
            notes,
            required,
            accomp,
            beats,
            cfg,
            start_ms,
            end_ms,
            origin_us: 0,
            count_in: Vec::new(),
            matched: vec![None; n],
            missed: vec![false; n],
            next_beat: 0,
            next_accomp: 0,
            sounding: Vec::new(),
            miss_cursor: 0,
            extras: 0,
            errors_by_measure: BTreeMap::new(),
            pass: 0,
            finished: false,
            pending_next: Vec::new(),
        }
    }

    pub fn is_finished(&self) -> bool {
        self.finished
    }

    pub fn key_map(&self) -> KeyMap {
        self.cfg.key_map
    }

    fn tempo(&self) -> f64 {
        (self.cfg.tempo as f64).clamp(0.1, 3.0)
    }

    /// Позиция в пьесе (мс) в момент `t_us`; до начала — меньше `start_ms`.
    pub fn pos(&self, t_us: u64) -> f64 {
        self.start_ms as f64 + (t_us as f64 - self.origin_us as f64) / 1000.0 * self.tempo()
    }

    /// Реальное время (мкс), когда позиция дойдёт до `ms`.
    fn real_us(&self, ms: f64) -> u64 {
        let dt = (ms - self.start_ms as f64) / self.tempo() * 1000.0;
        (self.origin_us as f64 + dt).max(0.0) as u64
    }

    pub fn start(&mut self, t_us: u64) -> Vec<Action> {
        let beat_real_us = (self.cfg.beat_ms as f64 / self.tempo() * 1000.0) as u64;
        let count_beats = if self.cfg.count_in {
            self.cfg.beats_per_measure.max(1) as u64
        } else {
            0
        };
        let count_in_us = count_beats * beat_real_us;
        self.origin_us = t_us + count_in_us.max(LEAD_IN_MS * 1000);
        self.count_in = (1..=count_beats)
            .map(|k| (self.origin_us - k * beat_real_us, k == count_beats))
            .rev()
            .collect();
        vec![Action::Event(RhythmEvent::Clock {
            origin_us: self.origin_us,
            pos0: self.start_ms,
            tempo: self.cfg.tempo,
        })]
    }

    /// Продвинуть время до `t_us`: звук, метроном, пропуски, конец/новый круг.
    pub fn advance(&mut self, t_us: u64) -> Vec<Action> {
        let mut out = Vec::new();
        if self.finished {
            return out;
        }
        while let Some(&(at, accent)) = self.count_in.first() {
            if at > t_us {
                break;
            }
            out.push(Action::Click { accent });
            self.count_in.remove(0);
        }
        let pos = self.pos(t_us);
        if pos < self.start_ms as f64 {
            return out;
        }

        while let Some(b) = self.beats.get(self.next_beat) {
            if b.ms as f64 > pos {
                break;
            }
            if self.cfg.metronome {
                out.push(Action::Click { accent: b.accent });
            }
            self.next_beat += 1;
        }

        self.release_until(pos, &mut out);
        while let Some(&i) = self.accomp.get(self.next_accomp) {
            let n = &self.notes[i];
            if n.start_ms as f64 > pos {
                break;
            }
            self.next_accomp += 1;
            if !self.cfg.accompany {
                continue;
            }
            let (pitch, end, channel, program) =
                (n.pitch, n.start_ms + n.dur_ms, n.channel, n.program);
            if self.sounding.iter().any(|s| s.0 == pitch && s.2 == channel) {
                out.push(off_action(pitch, channel));
                self.sounding.retain(|s| !(s.0 == pitch && s.2 == channel));
            }
            out.push(match channel {
                Some(channel) => Action::GmNoteOn {
                    channel,
                    program,
                    pitch,
                    velocity: APP_VELOCITY,
                },
                None => Action::AppNoteOn {
                    pitch,
                    velocity: APP_VELOCITY,
                },
            });
            self.sounding.push((pitch, end, channel));
        }

        // Нота пропущена, когда окно после неё закрылось без нажатия.
        let window_piece = WINDOW_MS as f64 * self.tempo();
        while let Some(&i) = self.required.get(self.miss_cursor) {
            let n = &self.notes[i];
            if n.start_ms as f64 + window_piece >= pos {
                break;
            }
            let k = self.miss_cursor;
            if self.matched[k].is_none() && !self.missed[k] {
                self.missed[k] = true;
                *self.errors_by_measure.entry(n.measure).or_default() += 1;
                out.push(Action::Event(RhythmEvent::Miss { id: n.id.clone() }));
            }
            self.miss_cursor += 1;
        }

        // Конец отрезка: новый круг или финиш (после окна последней ноты).
        let done_at = self.end_ms as f64
            + if self.cfg.loop_range.is_some() {
                0.0
            } else {
                window_piece
            };
        if pos >= done_at && self.miss_cursor >= self.required.len() {
            let summary = self.summary();
            if self.cfg.loop_range.is_some() {
                self.pass += 1;
                out.push(Action::Event(RhythmEvent::LoopPass {
                    pass: self.pass,
                    summary,
                }));
                self.wrap(&mut out);
            } else {
                self.release_until(f64::MAX, &mut out);
                self.finished = true;
                out.push(Action::Event(RhythmEvent::Finished { summary }));
            }
        }
        out
    }

    /// Начать отрезок заново без паузы: позиция снова `start_ms`.
    fn wrap(&mut self, out: &mut Vec<Action>) {
        let len_us = ((self.end_ms - self.start_ms) as f64 / self.tempo() * 1000.0) as u64;
        self.origin_us += len_us;
        self.release_until(f64::MAX, out);
        self.matched.iter_mut().for_each(|m| *m = None);
        self.missed.iter_mut().for_each(|m| *m = false);
        self.next_beat = 0;
        self.next_accomp = 0;
        self.miss_cursor = 0;
        self.extras = 0;
        self.errors_by_measure.clear();
        out.push(Action::Event(RhythmEvent::Clock {
            origin_us: self.origin_us,
            pos0: self.start_ms,
            tempo: self.cfg.tempo,
        }));
        for (k, delta, velocity) in std::mem::take(&mut self.pending_next) {
            self.record_hit(k, delta, velocity, out);
        }
    }

    fn record_hit(&mut self, k: usize, delta: i32, velocity: u8, out: &mut Vec<Action>) {
        self.matched[k] = Some(delta);
        let n = &self.notes[self.required[k]];
        let g = grade(delta);
        if g == Grade::Poor {
            *self.errors_by_measure.entry(n.measure).or_default() += 1;
        }
        out.push(Action::Event(RhythmEvent::Hit {
            id: n.id.clone(),
            delta_ms: delta,
            grade: g,
            velocity,
        }));
    }

    /// Лучшая нота высоты `pitch` для нажатия в позиции `pos` (мс пьесы).
    fn candidate(&self, pitch: u8, pos: f64, fresh: bool) -> Option<(usize, i32)> {
        let tempo = self.tempo();
        self.required
            .iter()
            .enumerate()
            .filter(|(k, &i)| {
                self.notes[i].pitch == pitch
                    && (fresh || (self.matched[*k].is_none() && !self.missed[*k]))
            })
            .map(|(k, &i)| {
                (
                    k,
                    ((pos - self.notes[i].start_ms as f64) / tempo).round() as i32,
                )
            })
            .filter(|(_, d)| d.abs() <= WINDOW_MS)
            .min_by_key(|(_, d)| d.abs())
    }

    fn release_until(&mut self, pos: f64, out: &mut Vec<Action>) {
        let mut keep = Vec::new();
        for (pitch, end, channel) in self.sounding.drain(..) {
            if end as f64 <= pos {
                out.push(off_action(pitch, channel));
            } else {
                keep.push((pitch, end, channel));
            }
        }
        self.sounding = keep;
    }

    pub fn on_note_on(&mut self, pitch: u8, velocity: u8, t_us: u64) -> Vec<Action> {
        let mut out = Vec::new();
        if self.finished {
            return out;
        }
        let pos = self.pos(t_us);
        let tempo = self.tempo();
        // Ближайшая по времени ещё не сыгранная нота той же высоты.
        let best = self.candidate(pitch, pos, false);
        // В цикле у конца отрезка нажатие может относиться к началу следующего круга.
        let next = match self.cfg.loop_range {
            Some(_) if pos > (self.end_ms as f64) - WINDOW_MS as f64 * tempo => self
                .candidate(pitch, pos - (self.end_ms - self.start_ms) as f64, true)
                .filter(|(k, _)| !self.pending_next.iter().any(|p| p.0 == *k)),
            _ => None,
        };
        let use_next = match (best, next) {
            (Some(b), Some(n)) => n.1.abs() < b.1.abs(),
            (None, Some(_)) => true,
            _ => false,
        };

        match (use_next, best, next) {
            (true, _, Some(n)) => self.pending_next.push((n.0, n.1, velocity)),
            (false, Some((k, delta)), _) => self.record_hit(k, delta, velocity, &mut out),
            _ => {
                if pos < self.start_ms as f64 - WINDOW_MS as f64 * tempo {
                    return out; // во время отсчёта нажатия не считаются
                }
                self.extras += 1;
                // Ошибка — к такту ближайшей по времени ноты.
                if let Some(&i) = self
                    .required
                    .iter()
                    .min_by_key(|&&i| (self.notes[i].start_ms as f64 - pos).abs() as u64)
                {
                    *self
                        .errors_by_measure
                        .entry(self.notes[i].measure)
                        .or_default() += 1;
                }
                out.push(Action::Event(RhythmEvent::Extra { pitch }));
            }
        }
        out
    }

    /// Когда разбудить сессию в следующий раз (реальное время, мкс).
    pub fn next_wakeup(&self, t_us: u64) -> Option<u64> {
        if self.finished {
            return None;
        }
        let mut next: Vec<u64> = Vec::new();
        if let Some(&(at, _)) = self.count_in.first() {
            next.push(at);
        }
        if self.cfg.metronome {
            if let Some(b) = self.beats.get(self.next_beat) {
                next.push(self.real_us(b.ms as f64));
            }
        }
        if let Some(&i) = self.accomp.get(self.next_accomp) {
            next.push(self.real_us(self.notes[i].start_ms as f64));
        }
        if let Some(end) = self.sounding.iter().map(|s| s.1).min() {
            next.push(self.real_us(end as f64));
        }
        let window_piece = WINDOW_MS as f64 * self.tempo();
        if let Some(&i) = self.required.get(self.miss_cursor) {
            next.push(self.real_us(self.notes[i].start_ms as f64 + window_piece) + 1000);
        }
        let done = self.end_ms as f64
            + if self.cfg.loop_range.is_some() {
                0.0
            } else {
                window_piece
            };
        next.push(self.real_us(done));
        next.push(self.origin_us);
        next.into_iter()
            .filter(|&t| t > t_us)
            .min()
            .or(Some(t_us + 1000))
    }

    /// Остановить: снять звучащие ноты.
    pub fn stop(&mut self) -> Vec<Action> {
        let mut out = Vec::new();
        self.release_until(f64::MAX, &mut out);
        self.finished = true;
        out
    }

    pub fn summary(&self) -> RhythmSummary {
        let deltas: Vec<i32> = self.matched.iter().flatten().copied().collect();
        let hits = deltas.len();
        let count = |g: Grade| deltas.iter().filter(|&&d| grade(d) == g).count();
        let mut trouble: Vec<MeasureErrors> = self
            .errors_by_measure
            .iter()
            .map(|(&measure, &errors)| MeasureErrors { measure, errors })
            .collect();
        trouble.sort_by(|a, b| b.errors.cmp(&a.errors).then(a.measure.cmp(&b.measure)));
        let required_notes = self.required.len();
        RhythmSummary {
            required_notes,
            hits,
            misses: self.missed.iter().filter(|&&m| m).count(),
            extras: self.extras,
            perfect: count(Grade::Perfect),
            good: count(Grade::Good),
            poor: count(Grade::Poor),
            accuracy: if required_notes > 0 {
                hits as f64 / required_notes as f64
            } else {
                0.0
            },
            mean_abs_delta_ms: if hits > 0 {
                (deltas.iter().map(|d| d.unsigned_abs() as u64).sum::<u64>() / hits as u64) as u32
            } else {
                0
            },
            mean_delta_ms: if hits > 0 {
                deltas.iter().sum::<i32>() / hits as i32
            } else {
                0
            },
            trouble_measures: trouble,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::piece::Hand;

    fn note(id: &str, pitch: u8, start: u32, dur: u32, hand: Hand, measure: u32) -> PieceNote {
        PieceNote {
            id: id.into(),
            pitch,
            start_ms: start,
            dur_ms: dur,
            hand,
            measure,
            channel: None,
            program: None,
        }
    }

    /// Такт 4/4 по 500 мс на долю: правая — до ре ми фа, левая — до малой на 1-й доле.
    fn notes() -> Vec<PieceNote> {
        vec![
            note("r1", 60, 0, 500, Hand::Right, 1),
            note("r2", 62, 500, 500, Hand::Right, 1),
            note("r3", 64, 1000, 500, Hand::Right, 1),
            note("r4", 65, 1500, 500, Hand::Right, 1),
            note("l1", 48, 0, 2000, Hand::Left, 1),
        ]
    }

    fn beats() -> Vec<Beat> {
        (0..4)
            .map(|k| Beat {
                ms: k * 500,
                accent: k == 0,
            })
            .collect()
    }

    fn cfg() -> RhythmConfig {
        RhythmConfig {
            hands: HandMode::Right,
            accompany: true,
            tempo: 1.0,
            count_in: false,
            metronome: false,
            loop_range: None,
            beats_per_measure: 4,
            beat_ms: 500,
            key_map: KeyMap::Exact,
        }
    }

    fn events(a: &[Action]) -> Vec<RhythmEvent> {
        a.iter()
            .filter_map(|x| match x {
                Action::Event(e) => Some(e.clone()),
                _ => None,
            })
            .collect()
    }

    /// Прогнать сессию по времени с шагом 5 мс, нажимая клавиши в заданные моменты (мкс).
    fn run(s: &mut RhythmSession, presses: &[(u64, u8)], until_us: u64) -> Vec<Action> {
        let mut out = Vec::new();
        let mut t = 0;
        let mut pi = 0;
        while t <= until_us && !s.is_finished() {
            while pi < presses.len() && presses[pi].0 <= t {
                out.extend(s.on_note_on(presses[pi].1, 64, presses[pi].0));
                pi += 1;
            }
            out.extend(s.advance(t));
            t += 5_000;
        }
        out
    }

    #[test]
    fn listening_plays_everything_and_loops() {
        // Уровень «Знакомство»: руки ученика — никакие, приложение играет всё по кругу.
        let mut s = RhythmSession::new(
            notes(),
            beats(),
            RhythmConfig {
                hands: HandMode::None,
                loop_range: Some((0, 2000)),
                ..cfg()
            },
        );
        s.start(0);
        let out = run(&mut s, &[], (LEAD_IN_MS + 4_100) * 1000);
        let played: Vec<u8> = out
            .iter()
            .filter_map(|a| match a {
                Action::AppNoteOn { pitch, .. } => Some(*pitch),
                _ => None,
            })
            .collect();
        // Два полных круга по 5 нот (третий начинается ровно на 4-й секунде).
        assert!(played.len() >= 10, "{played:?}");
        assert_eq!(played[..5], played[5..10]);
        assert_eq!(played[..5].len(), 5);
        let passes: Vec<RhythmSummary> = events(&out)
            .into_iter()
            .filter_map(|e| match e {
                RhythmEvent::LoopPass { summary, .. } => Some(summary),
                _ => None,
            })
            .collect();
        assert!(passes.len() >= 2);
        assert_eq!(passes[0].required_notes, 0);
        assert!(!events(&out)
            .iter()
            .any(|e| matches!(e, RhythmEvent::Miss { .. })));
    }

    #[test]
    fn grades_by_timing() {
        assert_eq!(grade(0), Grade::Perfect);
        assert_eq!(grade(-50), Grade::Perfect);
        assert_eq!(grade(90), Grade::Good);
        assert_eq!(grade(-150), Grade::Poor);
    }

    #[test]
    fn perfect_play_with_lead_in_and_accompaniment() {
        let mut s = RhythmSession::new(notes(), beats(), cfg());
        let a = s.start(0);
        let origin = match &events(&a)[0] {
            RhythmEvent::Clock {
                origin_us, pos0, ..
            } => {
                assert_eq!(*pos0, 0);
                *origin_us
            }
            e => panic!("{e:?}"),
        };
        assert_eq!(origin, LEAD_IN_MS * 1000, "пауза перед началом без отсчёта");
        let presses: Vec<(u64, u8)> = [(0, 60), (500, 62), (1000, 64), (1500, 65)]
            .iter()
            .map(|&(ms, p)| (origin + ms * 1000, p))
            .collect();
        let out = run(&mut s, &presses, origin + 3_000_000);
        assert!(s.is_finished());
        // Бас звучит на первой доле и снимается в конце.
        assert!(out.contains(&Action::AppNoteOn {
            pitch: 48,
            velocity: APP_VELOCITY
        }));
        assert!(out.contains(&Action::AppNoteOff { pitch: 48 }));
        let ev = events(&out);
        let fin = ev.iter().find_map(|e| match e {
            RhythmEvent::Finished { summary } => Some(summary.clone()),
            _ => None,
        });
        let sum = fin.unwrap();
        assert_eq!((sum.hits, sum.misses, sum.extras), (4, 0, 0));
        assert_eq!(sum.perfect, 4);
        assert!((sum.accuracy - 1.0).abs() < 1e-9);
    }

    #[test]
    fn late_early_missed_and_extra_notes() {
        let mut s = RhythmSession::new(notes(), beats(), cfg());
        s.start(0);
        let o = LEAD_IN_MS * 1000;
        let presses = vec![
            (o + 90_000, 60),  // опоздание 90 мс — «нормально»
            (o + 350_000, 61), // лишняя нота
            (o + 1_000_000 - 150_000, 64), // раньше на 150 мс — «неточно»
                               // ре (500) и фа (1500) пропущены
        ];
        let out = run(&mut s, &presses, o + 3_000_000);
        let ev = events(&out);
        assert!(ev.contains(&RhythmEvent::Hit {
            id: "r1".into(),
            delta_ms: 90,
            grade: Grade::Good,
            velocity: 64
        }));
        assert!(ev.contains(&RhythmEvent::Extra { pitch: 61 }));
        assert!(ev.contains(&RhythmEvent::Hit {
            id: "r3".into(),
            delta_ms: -150,
            grade: Grade::Poor,
            velocity: 64
        }));
        assert!(ev.contains(&RhythmEvent::Miss { id: "r2".into() }));
        assert!(ev.contains(&RhythmEvent::Miss { id: "r4".into() }));
        let sum = s.summary();
        assert_eq!((sum.hits, sum.misses, sum.extras), (2, 2, 1));
        assert_eq!(sum.mean_delta_ms, -30);
        assert_eq!(sum.mean_abs_delta_ms, 120);
        assert_eq!(
            sum.trouble_measures,
            vec![MeasureErrors {
                measure: 1,
                errors: 4
            }]
        );
    }

    #[test]
    fn count_in_clicks_one_measure_and_metronome_accents() {
        let mut c = cfg();
        c.count_in = true;
        c.metronome = true;
        c.tempo = 0.5; // вдвое медленнее: доля 1000 мс реального времени
        let mut s = RhythmSession::new(notes(), beats(), c);
        let a = s.start(0);
        let origin = match &events(&a)[0] {
            RhythmEvent::Clock { origin_us, .. } => *origin_us,
            _ => unreachable!(),
        };
        assert_eq!(origin, 4_000_000, "отсчёт — такт из 4 долей по 1 с");
        let mut clicks = Vec::new();
        let mut t = 0;
        while t < origin + 4_000_000 && !s.is_finished() {
            for x in s.advance(t) {
                if let Action::Click { accent } = x {
                    clicks.push((t / 100_000, accent));
                }
            }
            t += 5_000;
        }
        // Отсчёт: 0, 1, 2, 3 с (акцент на первом), затем доли пьесы 4, 5, 6, 7 с.
        let times: Vec<u64> = clicks.iter().map(|c| c.0).collect();
        assert_eq!(times, vec![0, 10, 20, 30, 40, 50, 60, 70]);
        assert!(clicks[0].1 && !clicks[1].1 && clicks[4].1 && !clicks[5].1);
    }

    #[test]
    fn slower_tempo_scales_timing_windows_to_real_time() {
        let mut c = cfg();
        c.tempo = 0.5;
        let mut s = RhythmSession::new(notes(), beats(), c);
        s.start(0);
        let o = LEAD_IN_MS * 1000;
        // Ре на 500 мс пьесы = 1000 мс реального времени; нажали на 40 мс позже.
        let out = run(&mut s, &[(o + 1_040_000, 62)], o + 1_200_000);
        assert!(events(&out).contains(&RhythmEvent::Hit {
            id: "r2".into(),
            delta_ms: 40,
            grade: Grade::Perfect,
            velocity: 64
        }));
    }

    #[test]
    fn loop_repeats_range_seamlessly() {
        let mut c = cfg();
        c.loop_range = Some((1000, 2000));
        let mut s = RhythmSession::new(notes(), beats(), c);
        let a = s.start(0);
        let o = match &events(&a)[0] {
            RhythmEvent::Clock {
                origin_us, pos0, ..
            } => {
                assert_eq!(*pos0, 1000, "цикл начинается с начала отрезка");
                *origin_us
            }
            _ => unreachable!(),
        };
        // Круг 1: ми (1000) и фа (1500) вовремя. Круг 2 начинается через 1 с: только ми.
        let presses = vec![(o, 64), (o + 500_000, 65), (o + 1_000_000, 64)];
        let out = run(&mut s, &presses, o + 2_300_000);
        let ev = events(&out);
        let passes: Vec<(u32, usize, usize)> = ev
            .iter()
            .filter_map(|e| match e {
                RhythmEvent::LoopPass { pass, summary } => {
                    Some((*pass, summary.hits, summary.misses))
                }
                _ => None,
            })
            .collect();
        assert_eq!(passes, vec![(1, 2, 0), (2, 1, 1)]);
        assert!(!s.is_finished());
        // Ноты вне отрезка (до, ре) не требуются, бас (с 0 мс) не звучит.
        assert!(!out.iter().any(|x| matches!(x, Action::AppNoteOn { .. })));
    }

    #[test]
    fn next_wakeup_points_to_upcoming_work() {
        let mut s = RhythmSession::new(notes(), beats(), cfg());
        s.start(0);
        let o = LEAD_IN_MS * 1000;
        // До начала будит к началу пьесы.
        assert_eq!(s.next_wakeup(0), Some(o));
        s.advance(o);
        // После начала: следующее — окно пропуска первой ноты (200 мс) или конец баса.
        let w = s.next_wakeup(o).unwrap();
        assert!(w > o && w <= o + 201_000 + 1_000, "{w}");
        assert!(s.stop().contains(&Action::AppNoteOff { pitch: 48 }));
        assert_eq!(s.next_wakeup(o), None);
    }
}
