// Не открывать консольное окно в release-сборке на Windows.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    midi_teacher_lib::run()
}
