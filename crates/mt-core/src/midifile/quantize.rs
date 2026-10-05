//! Выравнивание по сетке (прямые доли и триоли) и деление на руки.

use super::*;

// --- Выравнивание ---

#[derive(Debug, Clone, Copy, PartialEq)]
pub(super) struct QNote {
    /// Начало и конец в делениях (DIV на четверть).
    pub(super) start: i64,
    pub(super) end: i64,
    pub(super) pitch: u8,
    pub(super) velocity: u8,
}

/// Для каждой четверти — сетка: шестнадцатые (3) или триоли (4).
pub(super) fn choose_grids(onsets: &[f64], quarters: usize) -> Vec<i64> {
    let mut grid = vec![STRAIGHT; quarters + 2];
    let mut per_q: Vec<Vec<f64>> = vec![Vec::new(); quarters + 2];
    for &t in onsets {
        let q = (t + 1.0 / 24.0).floor().max(0.0) as usize;
        if q < per_q.len() {
            per_q[q].push(t - q as f64);
        }
    }
    for (q, xs) in per_q.iter().enumerate() {
        let off_beat = xs
            .iter()
            .filter(|&&x| x.abs() > 0.06 && (1.0 - x).abs() > 0.06)
            .count();
        if off_beat < 2 {
            continue;
        }
        let err = |g: f64| {
            xs.iter()
                .map(|&x| (x * g - (x * g).round()).abs() / g)
                .sum::<f64>()
        };
        if err(3.0) < err(4.0) * 0.6 {
            grid[q] = TRIPLET;
        }
    }
    grid
}

pub(super) fn snap(t: f64, grids: &[i64]) -> i64 {
    let q = (t + 1.0 / 24.0).floor().max(0.0);
    let g = grids.get(q as usize).copied().unwrap_or(STRAIGHT) as f64;
    let local = ((t - q) * DIV as f64 / g).round() * g;
    q as i64 * DIV + local as i64
}

pub(super) fn quantize(notes: &[RawNote], ppq: u64, grids: &[i64]) -> Vec<QNote> {
    notes
        .iter()
        .map(|n| {
            let start = snap(n.tick as f64 / ppq as f64, grids);
            let min = grids
                .get((start / DIV) as usize)
                .copied()
                .unwrap_or(STRAIGHT);
            let end = snap(n.end as f64 / ppq as f64, grids).max(start + min);
            QNote {
                start,
                end,
                pitch: n.pitch,
                velocity: n.velocity,
            }
        })
        .collect()
}

/// Ноту, отпущенную чуть раньше следующей (зазор не больше шестнадцатой или четверти
/// промежутка между началами), дотягиваем до следующей ноты этой руки: живая игра
/// почти всегда чуть короче записанной, а «восьмая с точкой и пауза» вместо
/// четверти только мешает читать.
pub(super) fn fill_gaps(notes: &mut [QNote]) {
    let mut onsets: Vec<i64> = notes.iter().map(|n| n.start).collect();
    onsets.sort_unstable();
    onsets.dedup();
    for n in notes.iter_mut() {
        // После последней ноты — до ближайшей доли.
        let next = match onsets.iter().find(|&&t| t > n.start) {
            Some(&t) => t,
            None => (n.end + DIV - 1).div_euclid(DIV) * DIV,
        };
        if next > n.end && next - n.end <= STRAIGHT.max((next - n.start) / 4) {
            n.end = next;
        }
    }
}

// --- Руки ---

/// Деление на руки: для каждого аккорда (одновременных нот) выбирается граница,
/// при которой ноты ближе к текущему положению своей руки, рука не растянута шире
/// децимы и в ней не больше пяти нот. Положения рук плавно следуют за музыкой.
pub(super) fn split_hands(notes: &[QNote]) -> Vec<HandSide> {
    let mut order: Vec<usize> = (0..notes.len()).collect();
    order.sort_by_key(|&i| (notes[i].start, notes[i].pitch));
    let median = |xs: Vec<f64>, dflt: f64| {
        if xs.is_empty() {
            return dflt;
        }
        let mut v = xs;
        v.sort_by(|a, b| a.total_cmp(b));
        v[v.len() / 2]
    };
    let mut c_right = median(
        notes
            .iter()
            .filter(|n| n.pitch >= 60)
            .map(|n| n.pitch as f64)
            .collect(),
        72.0,
    );
    let mut c_left = median(
        notes
            .iter()
            .filter(|n| n.pitch < 60)
            .map(|n| n.pitch as f64)
            .collect(),
        48.0,
    );
    let mut out = vec![HandSide::Right; notes.len()];
    let mut i = 0;
    while i < order.len() {
        let mut j = i;
        while j < order.len() && notes[order[j]].start == notes[order[i]].start {
            j += 1;
        }
        let chord: Vec<usize> = order[i..j].to_vec();
        let pitches: Vec<f64> = chord.iter().map(|&k| notes[k].pitch as f64).collect();
        let part_cost = |ps: &[f64], c: f64| -> f64 {
            if ps.is_empty() {
                return 0.0;
            }
            let span = ps.last().unwrap() - ps.first().unwrap();
            ps.iter().map(|p| (p - c).abs()).sum::<f64>()
                + 8.0 * (span - 16.0).max(0.0)
                + if ps.len() > 5 { 100.0 } else { 0.0 }
        };
        let mut best = (f64::MAX, 0);
        for k in 0..=pitches.len() {
            let cost = part_cost(&pitches[..k], c_left) + part_cost(&pitches[k..], c_right);
            if cost < best.0 {
                best = (cost, k);
            }
        }
        let k = best.1;
        for (idx, &n) in chord.iter().enumerate() {
            out[n] = if idx < k {
                HandSide::Left
            } else {
                HandSide::Right
            };
        }
        let avg = |ps: &[f64]| ps.iter().sum::<f64>() / ps.len() as f64;
        if k > 0 {
            c_left = 0.7 * c_left + 0.3 * avg(&pitches[..k]);
        }
        if k < pitches.len() {
            c_right = 0.7 * c_right + 0.3 * avg(&pitches[k..]);
        }
        // Руки не должны меняться местами.
        if c_left > c_right - 5.0 {
            let mid = (c_left + c_right) / 2.0;
            c_left = mid - 2.5;
            c_right = mid + 2.5;
        }
        i = j;
    }
    out
}
