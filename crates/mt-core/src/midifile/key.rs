//! Тональность по нотам и написание нот в тональности.

use super::*;

// --- Тональность ---

pub(super) const MAJOR_PROFILE: [f64; 12] = [
    6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88,
];
pub(super) const MINOR_PROFILE: [f64; 12] = [
    6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17,
];

/// Знаки мажора с тоникой `pc`: до 6 диезов или 5 бемолей.
pub(super) fn major_fifths(pc: u8) -> i8 {
    [0, -5, 2, -3, 4, -1, 6, 1, -4, 3, -2, 5][pc as usize % 12]
}

/// Тональность по нотам (профили Крумхансла): (знаки, минор).
pub(super) fn detect_key<'a>(notes: impl Iterator<Item = &'a RawNote>) -> (i8, bool) {
    let mut hist = [0f64; 12];
    for n in notes {
        hist[n.pitch as usize % 12] += (n.end - n.tick) as f64;
    }
    if hist.iter().all(|&x| x == 0.0) {
        return (0, false);
    }
    let corr = |profile: &[f64; 12], tonic: usize| {
        let xm = hist.iter().sum::<f64>() / 12.0;
        let ym = profile.iter().sum::<f64>() / 12.0;
        let (mut num, mut dx, mut dy) = (0.0, 0.0, 0.0);
        for i in 0..12 {
            let x = hist[(i + tonic) % 12] - xm;
            let y = profile[i] - ym;
            num += x * y;
            dx += x * x;
            dy += y * y;
        }
        num / (dx * dy).sqrt().max(1e-9)
    };
    let mut best = (f64::MIN, 0i8, false);
    for tonic in 0..12 {
        let maj = corr(&MAJOR_PROFILE, tonic);
        if maj > best.0 {
            best = (maj, major_fifths(tonic as u8), false);
        }
        let min = corr(&MINOR_PROFILE, tonic);
        if min > best.0 {
            // Знаки минора — как у параллельного мажора (на малую терцию выше).
            best = (min, major_fifths(((tonic + 3) % 12) as u8), true);
        }
    }
    (best.1, best.2)
}

/// Знаки после транспонирования на `semitones` (не больше 6 знаков).
pub fn transpose_fifths(fifths: i8, semitones: i8) -> i8 {
    let mut f = (fifths as i32 + 7 * semitones as i32).rem_euclid(12);
    if f > 6 {
        f -= 12;
    }
    f as i8
}

pub(super) const STEPS: [char; 7] = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
pub(super) const STEP_PC: [i32; 7] = [0, 2, 4, 5, 7, 9, 11];

/// Написание высоты в тональности: (ступень, альтерация, октава).
pub(super) fn spell(pitch: u8, fifths: i8, minor: bool) -> (char, i8, i32) {
    let pc = pitch as i32 % 12;
    let oct = pitch as i32 / 12 - 1;
    // Ступени тональности: знаки при ключе.
    let mut key_alter = [0i8; 7];
    if fifths > 0 {
        for s in ["F", "C", "G", "D", "A", "E", "B"]
            .iter()
            .take(fifths as usize)
        {
            key_alter[STEPS.iter().position(|c| c.to_string() == *s).unwrap()] = 1;
        }
    } else {
        for s in ["B", "E", "A", "D", "G", "C", "F"]
            .iter()
            .take((-fifths) as usize)
        {
            key_alter[STEPS.iter().position(|c| c.to_string() == *s).unwrap()] = -1;
        }
    }
    // Нота из тональности — как в ключе.
    for i in 0..7 {
        if (STEP_PC[i] + key_alter[i] as i32).rem_euclid(12) == pc {
            let octave = oct - (STEP_PC[i] + key_alter[i] as i32).div_euclid(12);
            return (STEPS[i], key_alter[i], octave);
        }
    }
    // Вводный тон минора: повышенная VII ступень.
    if minor {
        let tonic_major = (major_fifths_to_pc(fifths) + 9) % 12; // тоника минора
        if (tonic_major + 11) % 12 == pc {
            for i in 0..7 {
                let raised = STEP_PC[i] + key_alter[i] as i32 + 1;
                if raised.rem_euclid(12) == pc {
                    return (STEPS[i], key_alter[i] + 1, oct - raised.div_euclid(12));
                }
            }
        }
    }
    // Остальное: диезы в диезных тональностях, бемоли — в бемольных.
    for i in 0..7 {
        let alter: i32 = if fifths >= 0 { 1 } else { -1 };
        let v = STEP_PC[i] + alter;
        if v.rem_euclid(12) == pc {
            return (STEPS[i], alter as i8, oct - v.div_euclid(12));
        }
    }
    (STEPS[0], 0, oct)
}

pub(super) fn major_fifths_to_pc(fifths: i8) -> i32 {
    (fifths as i32 * 7).rem_euclid(12)
}
