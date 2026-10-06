# Сторонние компоненты

MIDI Teacher распространяется по [GPL-3.0-or-later](LICENSE). Компоненты ниже сохраняют свои лицензии; все они
совместимы с GPLv3. Полные тексты лицензий библиотек лежат в их пакетах (`node_modules/…`, реестр crates.io).

## Библиотеки интерфейса (npm)

| Компонент | Лицензия | Для чего |
|---|---|---|
| [Verovio](https://www.verovio.org) | LGPL-3.0-or-later | Нотный стан и табулатура (WASM в Web Worker) |
| [alphaTab](https://github.com/CoderLine/alphaTab) © Daniel Kuschny и соавторы | MPL-2.0 | Чтение файлов Guitar Pro 3–8 |
| [React](https://react.dev), React DOM | MIT | Интерфейс |
| [Zustand](https://github.com/pmndrs/zustand) | MIT | Состояние интерфейса |
| [yaml](https://github.com/eemeli/yaml) | ISC | Дневник и планы в YAML |
| [@tauri-apps/api](https://tauri.app) и плагины dialog, opener | MIT OR Apache-2.0 | Связь с ядром |

## Ядро и приложение (crates.io)

| Компонент | Лицензия | Для чего |
|---|---|---|
| [Tauri](https://tauri.app) и плагины | Apache-2.0 OR MIT | Оболочка приложения |
| [cpal](https://github.com/RustAudio/cpal) | Apache-2.0 | Вывод и ввод звука (WASAPI, ASIO) |
| [midir](https://github.com/Boddlnagg/midir) | MIT | MIDI-устройства |
| [midly](https://github.com/kovaxis/midly) | Unlicense | Чтение MIDI-файлов |
| [rustysynth](https://github.com/sinshu/rustysynth) | MIT | Синтезатор SoundFont |
| [rusqlite](https://github.com/rusqlite/rusqlite) (+ SQLite, общественное достояние) | MIT | База прогресса |
| serde, crossbeam, parking_lot, flate2, aes, ctr, cfb-mode, base64, anyhow, log | MIT OR Apache-2.0 | Служебные |

Остальные зависимости (транзитивные) — под MIT, Apache-2.0, BSD, ISC, Zlib, Unicode-3.0, Unlicense, MPL-2.0;
проверить список: `cargo metadata` и `npx license-checker --production`.

## ASIO

Сборка для Windows включает **ASIO SDK © Steinberg Media Technologies GmbH**. SDK скачивается при сборке и в
репозитории не хранится; используется по лицензии **GPLv3** (Steinberg предлагает ASIO SDK по двойной лицензии —
коммерческой и GPLv3). ASIO — торговая марка Steinberg Media Technologies GmbH.

## Звуки

| Компонент | Лицензия |
|---|---|
| [YDP Grand Piano](https://freepats.zenvoid.org/Piano/acoustic-grand-piano.html) © Roberto Gordo Saez (FreePats) — встроенный рояль | [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/) |
| [GeneralUser GS](https://github.com/mrbumpy409/GeneralUser-GS) © S. Christian Collins — инструменты GM и барабаны | GeneralUser GS License v2.0: свободное использование, в том числе в программах, с правом изменять и распространять (`documentation/LICENSE.txt` в репозитории автора) |

SoundFont в репозитории не хранятся: их скачивает `scripts/fetch-soundfont.mjs` при сборке.

## Ноты и тестовые файлы

- Встроенные пьесы (`src/pieces/`) — общественное достояние; источники каждой мелодии — в `scripts/gen_pieces.py`
  и в разделе «Звуки и встроенные пьесы» в README.
- Тестовые файлы Guitar Pro (`src/lib/fixtures/gp/`) — из проекта alphaTab, MPL-2.0, без изменений
  (см. `src/lib/fixtures/gp/LICENSE.txt`).
- Тестовые данные Rocksmith (`src/lib/fixtures/rocksmith-test.json`) — синтетические, сделаны для тестов.
