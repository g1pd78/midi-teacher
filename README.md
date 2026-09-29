# MIDI Teacher

Десктопное приложение для обучения игре на фортепиано с цифровым пианино
и MIDI-клавиатурой: интерактивный нотный стан, тренажёр чтения нот,
разучивание пьес с постепенным отключением подсказок.

- План продукта и этапы: [docs/PLAN.md](docs/PLAN.md)
- Техническая архитектура: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- Чеклисты приёмки: [docs/checklists/](docs/checklists/)

**Текущий этап: 0 (каркас)**: подключение инструментов, маршруты звука,
встроенный рояль через ASIO/WASAPI, мастер первого запуска.

## Скачать сборку для Windows

1. Открой вкладку **Actions** репозитория → последний успешный запуск **CI**
   на нужной ветке.
2. Внизу страницы, в разделе **Artifacts**, скачай `MIDI-Teacher-windows-…`.
3. Распакуй архив и запусти `MIDI Teacher_…_x64-setup.exe`. Права
   администратора не нужны: установка идёт в профиль пользователя.

Windows может показать предупреждение SmartScreen: установщик не подписан.
Нажми «Подробнее» → «Выполнить в любом случае».

## Локальная разработка (Windows)

Нужно один раз:

1. [Rust](https://rustup.rs) (stable, MSVC) и Visual Studio Build Tools
   с компонентом «Разработка классических приложений на C++».
2. [Node.js 22](https://nodejs.org).
3. LLVM для ASIO: `winget install LLVM.LLVM`, затем
   `setx LIBCLANG_PATH "C:\Program Files\LLVM\bin"` и перезапуск терминала.
   ASIO SDK скачается автоматически при первой сборке.
4. WebView2 уже есть в Windows 10/11.

Дальше:

```bash
npm ci
npm run fetch-soundfont   # SoundFont рояля (~113 МБ), можно пропустить
npm run tauri dev         # приложение с горячей перезагрузкой интерфейса
```

Сборка установщика: `npx tauri build` (результат лежит в `target/release/bundle/nsis/`).

### Только интерфейс в браузере

`npm run dev` и открыть <http://localhost:1420>. Вместо ядра работает
имитация: клавиши компьютера изображают два MIDI-устройства
(`Z S X D C V…` — «Демо-клавиатура», `Q 2 W 3 E R…` — «Демо-пианино»).

## Проверки

```bash
npm run typecheck && npm test          # TypeScript и тесты интерфейса
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace                 # тесты ядра (MIDI, маршруты, синтез, настройки)
```

CI (GitHub Actions) запускает всё это на Linux и собирает установщик
для Windows на каждый push.

## Структура

```
crates/mt-core/   ядро на Rust без Tauri: MIDI, маршруты звука, аудио (ASIO/WASAPI), синтезатор
src-tauri/        приложение Tauri: команды, события, настройки
src/              интерфейс на React + TypeScript
scripts/          загрузка SoundFont для сборки
docs/             план, архитектура, чеклисты
```

## Лицензии звука

Встроенный рояль: YDP Grand Piano © Roberto Gordo Saez (проект FreePats),
[CC BY 3.0](https://creativecommons.org/licenses/by/3.0/).
