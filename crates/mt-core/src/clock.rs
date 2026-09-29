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
