//! Единые часы приложения.
//!
//! Все временные метки (нажатия клавиш, позиция воспроизведения) считаются
//! в микросекундах от одной точки отсчёта, чтобы события с разных устройств
//! можно было сравнивать между собой.

use std::sync::OnceLock;
use std::time::Instant;

static START: OnceLock<Instant> = OnceLock::new();

/// Микросекунды с момента первого обращения к часам.
pub fn now_us() -> u64 {
    START.get_or_init(Instant::now).elapsed().as_micros() as u64
}

/// Секунды Unix-времени (для записей в базе прогресса).
pub fn unix_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}
