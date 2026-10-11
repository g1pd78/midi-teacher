# MIDI Teacher

Десктопное приложение (Windows) для занятий музыкой с цифровым пианино, MIDI-клавиатурой, гитарой, басом и
барабанными пэдами.

**Что умеет — коротко** (подробно — [docs/FEATURES.md](docs/FEATURES.md)):

- **Пьесы:** нотный стан и падающие ноты, режим ожидания, разучивание фрагментами до игры по памяти,
  аппликатура, MIDI, MusicXML, Guitar Pro, текстовые табы и песни Rocksmith.
- **Тренажёры:** чтение нот и с листа, ритм, аккорды, слух, гриф гитары, бас, барабаны.
- **Упражнения:** ступенями с оценкой ровности, разминка дня, «Занятие на сегодня».
- **Курс:** уроки по порядку для фортепиано, гитары, баса и барабанов.
- **Гитара и бас:** вход звука, тюнер, строи, табы, распознавание нот и аккордов по звуку.
- **Джем и импровизация:** аккомпанемент по кругу, уроки, запись и разбор соло.
- **Студия:** свой трек из дорожек, дубли, микшер, экспорт в MIDI и WAV.
- **Код:** лайвкодинг Strudel, игра поверх кода, курс «Музыка кодом».
- **Дневник:** история занятий, планы из YAML и повторение выученного.
- **Подсветка клавиш:** лента над клавишами — железо и прошивка в
  [midi-teacher-lights](https://github.com/g1pd78/midi-teacher-lights).

**Документы:**

- Возможности целиком: [docs/FEATURES.md](docs/FEATURES.md)
- План и этапы: [docs/PLAN.md](docs/PLAN.md)
- Архитектура: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- Чеклисты приёмки: [docs/checklists/](docs/checklists/)

## Скачать сборку для Windows

1. Открой вкладку **Actions** репозитория → последний успешный запуск **CI**
   на нужной ветке.
2. Внизу страницы, в разделе **Artifacts**, скачай `MIDI-Teacher-windows-…`.
3. Распакуй архив и запусти `MIDI Teacher_…_x64-setup.exe`. Права
   администратора не нужны: установка идёт в профиль пользователя.

Windows может показать предупреждение SmartScreen: установщик не подписан.
Нажми «Подробнее» → «Выполнить в любом случае».

Если Chrome блокирует архив («Это опасный файл»), скачай сборку без браузера
через GitHub CLI (PowerShell):

```powershell
winget install --id GitHub.cli   # один раз
gh auth login                    # один раз
$id = gh run list -R g1pd78/midi-teacher -b claude/piano-learning-app-mmhm6f -s success -L 1 --json databaseId -q ".[0].databaseId"
gh run download $id -R g1pd78/midi-teacher -p "MIDI-Teacher-windows-*" -D "$env:USERPROFILE\Downloads\MIDI-Teacher"
```

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

Сквозной тест «бот играет»: настоящее приложение проходит серию тренажёра,
пьесу, цикл, режим ритма, уровни режима «Разучить», упражнения, запись игры в MIDI и её
открытие как пьесы через имитацию MIDI-входа (Linux: нужны `webkit2gtk-driver` и
`cargo install tauri-driver`):

```bash
npx tauri build --debug --no-bundle
xvfb-run -a node e2e/run.mjs
```

CI (GitHub Actions) запускает всё это на Linux и собирает установщик
для Windows на каждый push.

## Структура

```
crates/mt-core/   ядро на Rust без Tauri: MIDI, маршруты звука, аудио (ASIO/WASAPI), синтезатор,
                  тренажёр, пьесы (ожидание, ритм), движок практики, аппликатура, импорт MIDI
                  (дорожки, руки, выравнивание, MusicXML, запись), гитара и бас (вход звука,
                  тюнер, прослушивание), хранилище (SQLite)
src-tauri/        приложение Tauri: команды, события, настройки
src/              интерфейс на React + TypeScript
scripts/          загрузка SoundFont для сборки, генератор встроенных пьес (gen_pieces.py)
e2e/              сквозной тест через WebDriver (tauri-driver)
docs/             план, архитектура, чеклисты
```

## Лицензия

MIDI Teacher — свободная программа: её можно использовать, изучать, менять и распространять на условиях
[GNU General Public License версии 3](LICENSE) или (по вашему выбору) любой более поздней версии
(SPDX: `GPL-3.0-or-later`). Программа распространяется без каких-либо гарантий.

© 2026 mtanzella и участники проекта.

Сторонние библиотеки, звуки и тестовые файлы — под своими лицензиями, список — в
[THIRD_PARTY.md](THIRD_PARTY.md). Сборка для Windows включает ASIO SDK © Steinberg Media Technologies,
который используется по GPLv3.

### Звуки и встроенные пьесы

Встроенный рояль: YDP Grand Piano © Roberto Gordo Saez (проект FreePats),
[CC BY 3.0](https://creativecommons.org/licenses/by/3.0/).

Встроенные пьесы (`src/pieces/`, генерируются `scripts/gen_pieces.py`, там же источник
каждой мелодии) — общественное достояние: народные песни по записям Musica Viva, нотным
вставкам Википедии и сборнику abc Джона Чемберса; Менуэты BWV Anh. 114 и 115 — по изданиям
Mutopia Project №75 и №76 (Bach-Gesellschaft), «Старинная французская песенка» — по
Mutopia №2080 (Schirmer, 1904); партии левой руки в песнях — простой бас, MIDI Teacher.
«К Элизе» (тема), Прелюдия до мажор BWV 846 (тт. 1–19), «Гимнопедия №1» (начало), «Гринсливз» — по
общеизвестным текстам; «Канон» Пахельбеля и «Утро» Грига — упрощённые переложения MIDI Teacher. Песни по
буквам и пьесы для классической гитары (`src/lib/guitarPieces.ts`) — общеизвестные народные мелодии и
переложения MIDI Teacher; арпеджио — этюды в духе op. 1 М. Джулиани.
