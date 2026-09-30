//! Аппликатура: какой палец на какую ноту.
//!
//! Источники по приоритету: ручная правка ученика → аппликатура из файла →
//! автоматический подбор. Подбор — динамическое программирование по шагам
//! (ноты с общим началом) отдельно для каждой руки: для каждого шага
//! перебираются все допустимые раскладки пальцев, и ищется путь с минимальной
//! «стоимостью» движений руки. Стоимость — упрощённая модель Parncutt и др.
//! (1997): удобные расстояния между парами пальцев, растяжки, подкладывание
//! первого пальца, слабые пальцы, первый палец на чёрной клавише.
//!
//! Левая рука считается как зеркальная правая: высоты берутся с обратным знаком.
//! Известные пальцы (правка, файл) фиксируют раскладку своего шага, и подбор
//! соседних нот подстраивается под них.

use crate::piece::Hand;
use serde::{Deserialize, Serialize};

/// Ноты с началом ближе этого — один шаг (аккорд).
const SAME_ONSET_MS: u32 = 15;
/// После паузы дольше этой рука свободно переставляется.
const FREE_MOVE_MS: u32 = 900;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FingerNote {
    pub id: String,
    pub pitch: u8,
    pub start_ms: u32,
    #[serde(default)]
    pub dur_ms: u32,
    pub hand: Hand,
    /// Палец из файла (1–5).
    #[serde(default)]
    pub file: Option<u8>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum FingerSource {
    Manual,
    File,
    Auto,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Fingering {
    pub id: String,
    pub finger: u8,
    pub source: FingerSource,
}

/// Удобные расстояния (полутоны) для пар пальцев правой руки, от меньшего
/// пальца к большему: MinPrac, MinComf, MinRel, MaxRel, MaxComf, MaxPrac.
/// Отрицательные — большой палец подкладывается под другой.
/// Рука «обычная»: секста между 1 и 5 без напряжения, октава — с растяжкой.
const SPANS: [((u8, u8), [i32; 6]); 10] = [
    ((1, 2), [-5, -3, 1, 5, 8, 10]),
    ((1, 3), [-4, -2, 3, 7, 10, 12]),
    ((1, 4), [-3, -1, 5, 9, 12, 14]),
    ((1, 5), [-1, 1, 7, 10, 13, 15]),
    ((2, 3), [1, 1, 1, 2, 3, 5]),
    ((2, 4), [1, 1, 3, 4, 5, 7]),
    ((2, 5), [2, 2, 5, 6, 8, 10]),
    ((3, 4), [1, 1, 1, 2, 2, 4]),
    ((3, 5), [1, 1, 3, 4, 5, 7]),
    ((4, 5), [1, 1, 1, 2, 3, 5]),
];

fn spans(a: u8, b: u8) -> [i32; 6] {
    SPANS
        .iter()
        .find(|(k, _)| *k == (a, b))
        .map(|(_, v)| *v)
        .unwrap_or([1, 1, 1, 2, 3, 5])
}

fn outside(x: i32, lo: i32, hi: i32) -> f64 {
    if x < lo {
        (lo - x) as f64
    } else if x > hi {
        (x - hi) as f64
    } else {
        0.0
    }
}

fn is_black(pitch: i32) -> bool {
    matches!(pitch.rem_euclid(12), 1 | 3 | 6 | 8 | 10)
}

/// Стоимость расстояния `d` (полутоны, от ноты пальца `f1` к ноте пальца `f2`)
/// в «зеркальной правой» системе координат.
fn pair_cost(f1: u8, f2: u8, d: i32) -> f64 {
    if f1 == f2 {
        // Тот же палец на другую клавишу — разрыв легато и перестановка руки.
        return if d == 0 {
            0.0
        } else {
            4.0 + d.abs() as f64 * 0.5
        };
    }
    let (a, b, span) = if f1 < f2 { (f1, f2, d) } else { (f2, f1, -d) };
    let [min_prac, min_comf, min_rel, max_rel, max_comf, max_prac] = spans(a, b);
    let mut cost = outside(span, min_rel, max_rel)
        + 2.0 * outside(span, min_comf, max_comf)
        + 10.0 * outside(span, min_prac, max_prac);
    if span < 0 {
        // Подкладывание первого пальца (или перекладывание пальца через первый).
        cost += if a == 1 { 1.0 } else { 20.0 };
    }
    cost
}

/// Раскладка шага: пальцы нот в порядке возрастания (зеркальной) высоты.
type Layout = Vec<u8>;

/// Все возрастающие наборы из `k` пальцев.
fn layouts(k: usize) -> Vec<Layout> {
    let mut out = Vec::new();
    for mask in 1u8..32 {
        if mask.count_ones() as usize != k {
            continue;
        }
        out.push((1..=5).filter(|f| mask & (1 << (f - 1)) != 0).collect());
    }
    out
}

struct Step {
    onset: u32,
    end: u32,
    /// Индексы нот, отсортированные по зеркальной высоте.
    notes: Vec<usize>,
    /// Зеркальные высоты в том же порядке.
    pitches: Vec<i32>,
    fixed: Vec<Option<u8>>,
}

/// Стоимость самой раскладки: растяжка внутри аккорда, чёрные клавиши, слабые пальцы.
fn layout_cost(step: &Step, lay: &Layout, mirror_black: &[bool]) -> f64 {
    let mut c = 0.0;
    for i in 1..lay.len() {
        c += pair_cost(lay[i - 1], lay[i], step.pitches[i] - step.pitches[i - 1]);
    }
    for (i, &f) in lay.iter().enumerate() {
        let black = mirror_black[i];
        if f == 1 && black {
            c += 2.0;
        }
        if f == 5 && black {
            c += 1.0;
        }
        if f == 4 {
            c += 0.3;
        }
    }
    c
}

fn transition_cost(prev: &Step, pl: &Layout, next: &Step, nl: &Layout) -> f64 {
    let mut total = 0.0;
    let mut n = 0.0;
    for (i, &f1) in pl.iter().enumerate() {
        for (j, &f2) in nl.iter().enumerate() {
            total += pair_cost(f1, f2, next.pitches[j] - prev.pitches[i]);
            n += 1.0;
        }
    }
    let mut c = if n > 0.0 { total / n } else { 0.0 };
    // После паузы рука переставляется свободно.
    if next.onset.saturating_sub(prev.end) > FREE_MOVE_MS {
        c *= 0.25;
    }
    c
}

/// Подобрать пальцы одной руки. `known` — зафиксированные пальцы по индексам нот.
fn solve_hand(
    notes: &[FingerNote],
    idx: &[usize],
    known: &[Option<u8>],
    hand: Hand,
) -> Vec<(usize, u8)> {
    let sign = if hand == Hand::Right { 1 } else { -1 };
    let mut order: Vec<usize> = idx.to_vec();
    order.sort_by_key(|&i| (notes[i].start_ms, notes[i].pitch as i32 * sign));
    let mut steps: Vec<Step> = Vec::new();
    for i in order {
        let n = &notes[i];
        let p = n.pitch as i32 * sign;
        match steps.last_mut() {
            Some(s) if n.start_ms - s.onset <= SAME_ONSET_MS => {
                s.notes.push(i);
                s.pitches.push(p);
                s.fixed.push(known[i]);
                s.end = s.end.max(n.start_ms + n.dur_ms);
            }
            _ => steps.push(Step {
                onset: n.start_ms,
                end: n.start_ms + n.dur_ms,
                notes: vec![i],
                pitches: vec![p],
                fixed: vec![known[i]],
            }),
        }
    }
    // Одновременно больше 5 нот одной руки не сыграть: лишние остаются без пальца.
    for s in &mut steps {
        let mut zipped: Vec<(usize, i32, Option<u8>)> = s
            .notes
            .iter()
            .zip(&s.pitches)
            .zip(&s.fixed)
            .map(|((&a, &b), &c)| (a, b, c))
            .collect();
        zipped.sort_by_key(|z| z.1);
        zipped.dedup_by_key(|z| z.1);
        zipped.truncate(5);
        s.notes = zipped.iter().map(|z| z.0).collect();
        s.pitches = zipped.iter().map(|z| z.1).collect();
        s.fixed = zipped.iter().map(|z| z.2).collect();
    }

    // Возможные раскладки каждого шага (с учётом известных пальцев).
    let options: Vec<Vec<(Layout, f64)>> = steps
        .iter()
        .map(|s| {
            let black: Vec<bool> = s.pitches.iter().map(|&p| is_black(p * sign)).collect();
            let all = layouts(s.notes.len());
            let fits = |l: &Layout| {
                s.fixed
                    .iter()
                    .zip(l)
                    .all(|(f, &x)| f.is_none_or(|f| f == x))
            };
            let mut ok: Vec<Layout> = all.iter().filter(|l| fits(l)).cloned().collect();
            if ok.is_empty() {
                // Известные пальцы противоречат друг другу — подбираем свободно.
                ok = all;
            }
            ok.into_iter()
                .map(|l| {
                    let c = layout_cost(s, &l, &black);
                    (l, c)
                })
                .collect()
        })
        .collect();

    if steps.is_empty() {
        return Vec::new();
    }
    // Прямой проход DP.
    let mut best: Vec<Vec<(f64, usize)>> = Vec::with_capacity(steps.len());
    best.push(options[0].iter().map(|(_, c)| (*c, usize::MAX)).collect());
    for t in 1..steps.len() {
        let row: Vec<(f64, usize)> = options[t]
            .iter()
            .map(|(nl, nc)| {
                options[t - 1]
                    .iter()
                    .enumerate()
                    .map(|(k, (pl, _))| {
                        (
                            best[t - 1][k].0
                                + transition_cost(&steps[t - 1], pl, &steps[t], nl)
                                + nc,
                            k,
                        )
                    })
                    .min_by(|a, b| a.0.total_cmp(&b.0))
                    .unwrap()
            })
            .collect();
        best.push(row);
    }
    // Обратный проход.
    let last = steps.len() - 1;
    let mut k = (0..best[last].len())
        .min_by(|&a, &b| best[last][a].0.total_cmp(&best[last][b].0))
        .unwrap();
    let mut out = Vec::new();
    for t in (0..=last).rev() {
        let lay = &options[t][k].0;
        for (j, &i) in steps[t].notes.iter().enumerate() {
            out.push((i, lay[j]));
        }
        k = best[t][k].1;
    }
    out
}

/// Аппликатура всех нот: ручные правки `manual` (id → палец) и пальцы из файла
/// фиксированы, остальное подбирается.
pub fn assign(notes: &[FingerNote], manual: &[(String, u8)]) -> Vec<Fingering> {
    let valid = |f: u8| (1..=5).contains(&f);
    let manual_of = |id: &str| {
        manual
            .iter()
            .find(|m| m.0 == id)
            .map(|m| m.1)
            .filter(|&f| valid(f))
    };
    let mut source = Vec::with_capacity(notes.len());
    let known: Vec<Option<u8>> = notes
        .iter()
        .map(|n| {
            if let Some(f) = manual_of(&n.id) {
                source.push(FingerSource::Manual);
                Some(f)
            } else if let Some(f) = n.file.filter(|&f| valid(f)) {
                source.push(FingerSource::File);
                Some(f)
            } else {
                source.push(FingerSource::Auto);
                None
            }
        })
        .collect();
    let mut finger: Vec<Option<u8>> = vec![None; notes.len()];
    for hand in [Hand::Right, Hand::Left] {
        let idx: Vec<usize> = (0..notes.len())
            .filter(|&i| notes[i].hand == hand)
            .collect();
        for (i, f) in solve_hand(notes, &idx, &known, hand) {
            finger[i] = Some(f);
        }
    }
    notes
        .iter()
        .enumerate()
        .filter_map(|(i, n)| {
            let f = finger[i]?;
            // Если известный палец пришлось нарушить (противоречие), это уже подбор.
            let src = if known[i] == Some(f) {
                source[i]
            } else {
                FingerSource::Auto
            };
            Some(Fingering {
                id: n.id.clone(),
                finger: f,
                source: src,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seq(hand: Hand, pitches: &[u8]) -> Vec<FingerNote> {
        pitches
            .iter()
            .enumerate()
            .map(|(i, &p)| FingerNote {
                id: format!("n{i}"),
                pitch: p,
                start_ms: i as u32 * 500,
                dur_ms: 500,
                hand,
                file: None,
            })
            .collect()
    }

    fn fingers(f: &[Fingering]) -> Vec<u8> {
        let mut v: Vec<(usize, u8)> = f
            .iter()
            .map(|x| (x.id[1..].parse().unwrap(), x.finger))
            .collect();
        v.sort();
        v.into_iter().map(|x| x.1).collect()
    }

    #[test]
    fn five_finger_position_right_hand() {
        // До ре ми фа соль вверх и вниз — 1 2 3 4 5 4 3 2 1.
        let notes = seq(Hand::Right, &[60, 62, 64, 65, 67, 65, 64, 62, 60]);
        assert_eq!(
            fingers(&assign(&notes, &[])),
            vec![1, 2, 3, 4, 5, 4, 3, 2, 1]
        );
    }

    #[test]
    fn five_finger_position_left_hand_is_mirrored() {
        // Левая рука: до малой … соль малой — 5 4 3 2 1.
        let notes = seq(Hand::Left, &[48, 50, 52, 53, 55]);
        assert_eq!(fingers(&assign(&notes, &[])), vec![5, 4, 3, 2, 1]);
    }

    #[test]
    fn c_major_scale_uses_thumb_under() {
        let notes = seq(Hand::Right, &[60, 62, 64, 65, 67, 69, 71, 72]);
        let f = fingers(&assign(&notes, &[]));
        // Стандарт: 1 2 3 1 2 3 4 5. Допускаем и 1 2 3 4 1 2 3 4 (тоже с подкладыванием).
        assert!(
            f == vec![1, 2, 3, 1, 2, 3, 4, 5] || f == vec![1, 2, 3, 4, 1, 2, 3, 4],
            "{f:?}"
        );
        assert!(
            f.windows(2).any(|w| w[1] == 1 && w[0] > 1),
            "подкладывание первого пальца: {f:?}"
        );
    }

    #[test]
    fn known_fingers_are_kept_and_neighbours_adapt() {
        // Ми ми фа соль, в файле у первой ноты 3 (как в «Оде к радости»).
        let mut notes = seq(Hand::Right, &[64, 64, 65, 67, 67, 65, 64, 62]);
        notes[0].file = Some(3);
        let f = assign(&notes, &[]);
        assert_eq!(fingers(&f), vec![3, 3, 4, 5, 5, 4, 3, 2]);
        assert_eq!(
            f.iter().find(|x| x.id == "n0").unwrap().source,
            FingerSource::File
        );
        assert_eq!(
            f.iter().find(|x| x.id == "n1").unwrap().source,
            FingerSource::Auto
        );

        // Ручная правка важнее файла.
        let f = assign(&notes, &[("n0".into(), 1)]);
        let first = f.iter().find(|x| x.id == "n0").unwrap();
        assert_eq!((first.finger, first.source), (1, FingerSource::Manual));
    }

    #[test]
    fn chords_get_increasing_fingers() {
        // Трезвучие до-ми-соль правой рукой — 1 3 5; левой — 5 3 1.
        let mk = |hand| {
            [48u8, 52, 55]
                .iter()
                .enumerate()
                .map(|(i, &p)| FingerNote {
                    id: format!("n{i}"),
                    pitch: p + if hand == Hand::Right { 12 } else { 0 },
                    start_ms: 0,
                    dur_ms: 1000,
                    hand,
                    file: None,
                })
                .collect::<Vec<_>>()
        };
        assert_eq!(fingers(&assign(&mk(Hand::Right), &[])), vec![1, 3, 5]);
        assert_eq!(fingers(&assign(&mk(Hand::Left), &[])), vec![5, 3, 1]);
    }

    #[test]
    fn contradictory_file_fingers_fall_back_to_auto() {
        // В файле у аккорда 5 снизу и 1 сверху — для правой руки так нельзя.
        let notes = vec![
            FingerNote {
                id: "n0".into(),
                pitch: 60,
                start_ms: 0,
                dur_ms: 500,
                hand: Hand::Right,
                file: Some(5),
            },
            FingerNote {
                id: "n1".into(),
                pitch: 67,
                start_ms: 0,
                dur_ms: 500,
                hand: Hand::Right,
                file: Some(1),
            },
        ];
        let f = fingers(&assign(&notes, &[]));
        assert!(f[0] < f[1], "снизу вверх пальцы растут: {f:?}");
        assert!(assign(&notes, &[])
            .iter()
            .all(|x| x.source == FingerSource::Auto));
    }

    #[test]
    fn every_note_gets_a_finger_and_large_leaps_are_possible() {
        let notes = seq(Hand::Right, &[60, 84, 61, 96, 60, 72, 73, 74, 75, 76, 77]);
        let f = assign(&notes, &[]);
        assert_eq!(f.len(), notes.len());
        assert!(f.iter().all(|x| (1..=5).contains(&x.finger)));
    }
}
