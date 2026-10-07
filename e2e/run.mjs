#!/usr/bin/env node
// Сквозной тест «бот играет»: настоящее приложение (Rust + WebView) проходит
// серию тренажёра, пьесу, цикл, режим ритма и ведущий режим «Разучить»
// через имитацию MIDI-входа.
//
// Нужны: собранное приложение (`npx tauri build --debug --no-bundle`),
// tauri-driver (`cargo install tauri-driver`) и WebKitWebDriver (Linux).
// Запуск: `xvfb-run node e2e/run.mjs` (на Linux без дисплея).
//
// Используется голый протокол W3C WebDriver поверх fetch — без WebdriverIO.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const exe = process.platform === "win32" ? "midi-teacher.exe" : "midi-teacher";
const app = process.env.MT_APP ?? join(root, "target", "debug", exe);
const DRIVER = "http://127.0.0.1:4444";

if (!existsSync(app)) {
  console.error(`Нет приложения: ${app}. Собери: npx tauri build --debug --no-bundle`);
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function wd(method, path, body) {
  const res = await fetch(DRIVER + path, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${JSON.stringify(json)}`);
  return json.value;
}

async function waitFor(what, fn, timeoutMs = 20000) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeoutMs) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) {
      last = e;
    }
    await sleep(200);
  }
  throw new Error(`Не дождались: ${what} (последнее: ${last})`);
}

// Порт драйвера должен быть свободен: иначе тест пошёл бы в чужое приложение.
if (await fetch(DRIVER + "/status").then((r) => r.ok).catch(() => false)) {
  console.error("Порт 4444 занят другим tauri-driver — останови его и запусти тест снова.");
  process.exit(1);
}

// Чистый профиль: настройки и база прогресса во временном каталоге (Linux).
const profile = mkdtempSync(join(tmpdir(), "mt-e2e-"));
// Папка библиотеки («Документы») — тоже во временном каталоге.
const docs = join(profile, "docs");
mkdirSync(join(profile, "config"), { recursive: true });
mkdirSync(docs, { recursive: true });
writeFileSync(join(profile, "config", "user-dirs.dirs"), `XDG_DOCUMENTS_DIR="${docs}"\n`);
const driver = spawn("tauri-driver", [], {
  stdio: ["ignore", "inherit", "inherit"],
  env: { ...process.env, XDG_CONFIG_HOME: join(profile, "config"), XDG_DATA_HOME: join(profile, "data") },
});
let sid;
const ok = (msg) => console.log(`  ✓ ${msg}`);

try {
  await waitFor("tauri-driver", () => fetch(DRIVER + "/status").then((r) => r.ok), 15000);
  sid = (await wd("POST", "/session", {
    capabilities: { alwaysMatch: { "tauri:options": { application: app } } },
  })).sessionId;
  const js = (script, args = []) => wd("POST", `/session/${sid}/execute/sync`, { script, args });
  const jsAsync = (script, args = []) => wd("POST", `/session/${sid}/execute/async`, { script, args });
  const invoke = (cmd, payload = {}) =>
    jsAsync(
      "const [cmd, payload, done] = arguments;" +
        "window.__TAURI_INTERNALS__.invoke(cmd, payload).then((v) => done({ v }), (e) => done({ e: String(e) }));",
      [cmd, payload],
    ).then((r) => {
      if (r && r.e) throw new Error(`${cmd}: ${r.e}`);
      return r?.v;
    });
  const click = (text) =>
    js(
      "const t = arguments[0]; const b = [...document.querySelectorAll('button')].find((b) => b.textContent.trim().startsWith(t) && !b.disabled);" +
        "if (!b) return false; b.click(); return true;",
      [text],
    );
  const press = async (note) => {
    await invoke("simulate_midi", { device: "E2E", bytes: [0x90, note, 100] });
    await invoke("simulate_midi", { device: "E2E", bytes: [0x80, note, 0] });
  };

  console.log("Сквозной тест: тренажёр нот");
  await waitFor("интерфейс загрузился", () => js("return !!document.querySelector('.wizard, .home');"));
  ok("приложение запустилось");

  // Пропускаем мастер первого запуска.
  const state = await invoke("get_state");
  await invoke("set_prefs", { prefs: { ...state.prefs, wizardDone: true } });
  await js("location.reload();");
  await waitFor("главный экран", () => js("return !!document.querySelector('.home');"));
  ok("мастер пропущен, главный экран");

  // Имитация MIDI доходит до интерфейса.
  // Сразу после перезагрузки экран может ещё не подписаться на события MIDI — нажимаем, пока не увидим.
  await waitFor("название ноты на главном экране", async () => {
    await press(60);
    await sleep(300);
    return js("return (document.querySelector('.now-name')?.textContent ?? '').includes('До первой октавы');");
  });
  ok("нажатие через имитацию MIDI показано на главном экране");

  await waitFor("вкладка тренажёров", () => click("Тренажёры"));
  await waitFor("список ступеней", () => js("return document.querySelectorAll('.level').length;")).then((n) => {
    if (n !== 9) throw new Error(`ступеней ${n}, ожидалось 9`);
  });
  ok("9 ступеней");

  await waitFor("кнопка первой ступени", () =>
    js("const b = document.querySelector('.level button'); if (!b || b.disabled) return false; b.click(); return true;"),
  );
  await waitFor("нотный стан", () => js("return !!document.querySelector('.staff-svg svg g.note');"), 30000);
  ok("серия началась, ноты нарисованы (Verovio)");

  const expected = () => js("return document.querySelector('[data-current-midi]')?.dataset.currentMidi ?? '';");

  // Одна ошибка: нажимаем не ту клавишу.
  const first = Number(await waitFor("ожидаемая нота", expected));
  await press(first === 60 ? 62 : 60);
  await waitFor("красная нота", () => js("return !!document.querySelector('g.note.mark-wrong');"));
  ok("ошибка подсвечена, серия ждёт правильную клавишу");

  let played = 0;
  for (let i = 0; i < 40; i++) {
    const m = await expected();
    if (!m) break;
    await press(Number(m));
    played++;
    // Ждём, пока интерфейс перейдёт к следующей ноте (или к итогу).
    await waitFor("следующая нота", async () => (await expected()) !== m || (await js("return !!document.querySelector('.summary');")), 5000);
  }
  if (played !== 20) throw new Error(`сыграно ${played} нот, ожидалось 20`);
  const summary = await waitFor("итог серии", () => js("return document.querySelector('.summary')?.innerText;"));
  if (!summary.includes("95%")) throw new Error(`в итоге нет 95%:\n${summary}`);
  if (!summary.includes("Открыта ступень 2")) throw new Error(`ступень 2 не открылась:\n${summary}`);
  ok("итог: 95% (19 из 20), открыта ступень 2");

  const overview = await invoke("trainer_overview");
  if (overview.unlocked !== 2) throw new Error(`unlocked = ${overview.unlocked}`);
  if (!overview.levelStats.some((s) => s.level === 1 && s.sessions >= 1)) throw new Error("серия не сохранена");
  if (overview.noteStats.length === 0) throw new Error("статистика нот пуста");
  ok("прогресс сохранён в базе (ступень 2 открыта, статистика нот есть)");

  // --- Пьеса: «Ода к радости» правой рукой в режиме ожидания ---
  console.log("Сквозной тест: пьеса");
  await waitFor("вкладка пьес", () => click("Пьесы"));
  await waitFor("карточка «Оды к радости»", () =>
    js("const b = [...document.querySelectorAll('.piece-card')].find((b) => b.textContent.includes('Ода к радости')); if (!b) return false; b.click(); return true;"),
  );
  await waitFor("ноты пьесы", () => js("return !!document.querySelector('.score-page svg g.note');"), 30000);
  // По умолчанию открывается ведущий режим «Разучить»; этапы 2–3 проверяем в свободной игре.
  await waitFor("режим «Разучить» по умолчанию", () => js("return !!document.querySelector('.guide');"), 10000);
  await waitFor("режим «Свободно»", () => click("Свободно"));
  await waitFor("кнопка «Правая»", () => click("Правая"));
  ok("пьеса открыта, ноты нарисованы");

  const pitches = () => js("return document.querySelector('.score-scroll')?.dataset.currentPitches ?? '';");
  const stepNo = () => js("return document.querySelector('.score-scroll')?.dataset.currentStep ?? '';");
  const finished = () => js("return document.querySelector('.score-scroll')?.dataset.finished === '1';");
  const firstStep = await waitFor("первый шаг", pitches);
  if (firstStep !== "64") throw new Error(`первая нота правой руки: ${firstStep}, ожидалась ми (64)`);

  await press(61); // лишняя нота
  await waitFor("красная клавиша", () => js("return document.querySelector('.key.active') !== null;"));
  let steps = 0;
  for (let i = 0; i < 200 && !(await finished()); i++) {
    const step = await stepNo();
    const cur = await pitches();
    if (!cur) {
      await sleep(100); // шаг другой руки проходит сам
      continue;
    }
    for (const p of cur.split(",")) await press(Number(p));
    steps++;
    await waitFor(`переход с шага ${step}`, async () => (await finished()) || (await stepNo()) !== step, 5000);
  }
  const pieceSummary = await waitFor("итог пьесы", () => js("return document.querySelector('.summary')?.innerText;"), 10000);
  if (!/Пьеса сыграна/.test(pieceSummary) || !/\b1\b/.test(pieceSummary)) throw new Error(`итог пьесы:\n${pieceSummary}`);
  if (steps !== 62) throw new Error(`сыграно шагов ${steps}, ожидалось 62`);
  ok("«Ода к радости» правой рукой: 62 шага, 1 ошибка в итоге");

  // --- Этап 3: цикл в режиме ожидания и режим ритма ---
  console.log("Сквозной тест: цикл и ритм");
  await waitFor("к списку пьес", () => click("К списку пьес"));
  await waitFor("снова «Ода к радости»", () =>
    js("const b = [...document.querySelectorAll('.piece-card')].find((b) => b.textContent.includes('Ода к радости')); if (!b) return false; b.click(); return true;"),
  );
  await waitFor("ноты пьесы", () => js("return !!document.querySelector('.score-page svg g.note');"), 30000);
  const setInput = (selector, index, value) =>
    js(
      "const [sel, i, v] = arguments; const el = document.querySelectorAll(sel)[i]; if (!el) return false;" +
        "Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, String(v));" +
        "el.dispatchEvent(new Event('input', { bubbles: true })); return true;",
      [selector, index, value],
    );
  // Такт 2 по кругу: соль фа ми ре.
  await waitFor("поле «с такта»", () => setInput(".loop-fields input", 0, 2));
  await waitFor("поле «по такт»", () => setInput(".loop-fields input", 1, 2));
  await waitFor("выделение такта", () => js("return document.querySelectorAll('.loop-rect').length === 1;"));
  await waitFor("шаг цикла", async () => (await pitches()) === "67");
  for (let pass = 0; pass < 2; pass++) {
    for (const note of [67, 65, 64, 62]) {
      const step = await stepNo();
      await waitFor(`нота ${note}`, async () => (await pitches()) === String(note), 5000);
      await press(note);
      await waitFor("следующий шаг", async () => (await stepNo()) !== step, 5000);
    }
  }
  const toast = await waitFor("сообщение о круге", () => js("return document.querySelector('.toast')?.textContent;"), 5000);
  if (!/Круг \d: без ошибок/.test(toast)) throw new Error(`сообщение о круге: ${toast}`);
  ok("цикл такта 2 в режиме ожидания: круг пройден без ошибок, курсор вернулся в начало");

  // Режим ритма: один такт по кругу в темпе 100%, ничего не играем — все ноты пропущены.
  await waitFor("режим «Ритм»", () => click("Ритм"));
  await waitFor("темп 100%", () => setInput(".tempo input", 0, 1));
  await waitFor("кнопка «Старт»", () => click("▶ Старт"));
  await waitFor("идёт игра", () => js("return document.querySelector('.score-scroll')?.dataset.playing === '1';"));
  await press(61); // лишняя нота во время игры
  // Пропуски видны на стане до конца круга (с новым кругом отметки сбрасываются).
  await waitFor("пропущенные ноты на стане", () => js("return document.querySelectorAll('g.note.mark-miss').length >= 2;"), 10000);
  const rhythmToast = await waitFor(
    "итог круга в ритме",
    () => js("const t = document.querySelector('.toast')?.textContent ?? ''; return t.includes('нот') ? t : false;"),
    15000,
  );
  if (!/Круг 1: 0% нот/.test(rhythmToast)) throw new Error(`круг в ритме: ${rhythmToast}`);
  await waitFor("кнопка «Стоп»", () => click("■ Стоп"));
  await waitFor("остановлено", () => js("return document.querySelector('.score-scroll')?.dataset.playing === '0';"));
  ok("режим ритма: транспорт идёт, пропуски отмечены, цикл повторяется, остановка работает");

  // --- Этап 4: ведущий режим «Разучить» ---
  console.log("Сквозной тест: движок практики");
  const data = (key) => js("return document.querySelector('.score-scroll')?.dataset[arguments[0]] ?? '';", [key]);
  await waitFor("режим «Разучить»", () => click("Разучить"));
  await waitFor("первый фрагмент, знакомство", async () => (await data("unit")) === "1-4" && (await data("level")) === "0", 10000);
  ok("«Ода к радости» разбита на фрагменты, первый — такты 1–4, уровень «Знакомство»");

  // --- Этап 4а: аппликатура ---
  const fings = () =>
    js(
      "const all = [...document.querySelectorAll('.score-page g.fing')];" +
        "return { all: all.length, auto: all.filter((g) => g.classList.contains('auto')).length," +
        "manual: all.filter((g) => g.classList.contains('manual')).map((g) => g.textContent.trim()) };",
    );
  const fingState = await waitFor("цифры пальцев у всех нот", async () => {
    const f = await fings();
    return f.all === 81 && f.auto > 0 ? f : false;
  }, 20000);
  const firstFing = await js(
    "const n = document.querySelector('.score-page g.note'); const f = [...document.querySelectorAll('.score-page g.fing')]" +
      ".find((g) => !g.classList.contains('auto') && !g.classList.contains('manual')); return f ? f.textContent.trim() : '';",
  );
  if (firstFing !== "3") throw new Error(`палец из файла у первой ноты: ${firstFing}`);
  ok(`аппликатура у всех 81 ноты: из файла и подобранная (серых ${fingState.auto})`);

  await waitFor("режим «Пальцы…»", () => click("Пальцы…"));
  await waitFor("выбрать вторую ноту", () =>
    js(
      "const g = document.querySelectorAll('.score-page g.note')[1]; const el = g && g.querySelector('use, path, ellipse');" +
        "if (!el) return false; el.dispatchEvent(new MouseEvent('click', { bubbles: true }));" +
        "return !!document.querySelector('g.note.mark-select');",
    ),
  );
  await js("window.dispatchEvent(new KeyboardEvent('keydown', { key: '2', bubbles: true }));");
  await waitFor("ручной палец 2 на стане", async () => (await fings()).manual.join() === "2", 10000);
  await js("window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));");
  await waitFor("режим правки закрыт", () => js("return !document.querySelector('.score-scroll.edit-fing');"));
  ok("ручная правка: вторая нота — палец 2 (синяя цифра)");

  const clickLevel = (l) =>
    js("const b = document.querySelector(`.guide button[data-level='${arguments[0]}']`); if (!b) return false; b.click(); return true;", [l]);
  const suggestion = () => js("return document.querySelector('[data-suggestion]')?.dataset.suggestion ?? '';");
  // Бот играет всё, что ждёт курсор, пока не выполнится условие.
  const playUntil = async (what, cond, timeoutMs) => {
    const start = Date.now();
    while (!(await cond())) {
      if (Date.now() - start > timeoutMs) throw new Error(`Не дождались: ${what}`);
      const step = await stepNo();
      const cur = await pitches();
      if (!cur) {
        await sleep(100); // шаг другой руки проходит сам
        continue;
      }
      for (const p of cur.split(",")) await press(Number(p));
      await waitFor(`переход с шага ${step}`, async () => (await stepNo()) !== step || (await cond()), 8000);
    }
  };

  await waitFor("уровень 1", () => clickLevel(1));
  await waitFor("правая рука на уровне 1", async () => (await data("level")) === "1" && (await data("hands")) === "right", 10000);
  await playUntil("переход к левой руке", async () => (await data("hands")) === "left", 60000);
  ok("уровень 1: три прохода правой рукой — дальше левая");
  await playUntil("предложение перейти дальше", async () => (await suggestion()) === "levelUp", 120000);
  ok("три прохода левой рукой — приложение предлагает уровень 2");
  await waitFor("принять предложение", () =>
    js("const b = document.querySelector('[data-suggestion] button.primary'); if (!b) return false; b.click(); return true;"),
  );
  await waitFor("уровень 2, обе руки", async () => (await data("level")) === "2" && (await data("hands")) === "both", 10000);
  ok("предложение принято: уровень 2, обе руки");

  await waitFor("уровень 3", () => clickLevel(3));
  await waitFor("аппликатура скрыта на уровне 3", () => js("return !!document.querySelector('.score-scroll.hide-fing');"), 10000);
  ok("на уровне «В темпе» цифры пальцев скрыты");

  await waitFor("уровень 4", () => clickLevel(4));
  await waitFor("ноты фрагмента скрыты", () => js("return document.querySelectorAll('.memory-cover').length === 4;"), 10000);
  ok("уровень «По памяти»: такты 1–4 закрыты");

  const progress = await invoke("progress_overview");
  const ode = progress.pieces.find((p) => p.title.includes("Ода"));
  if (!ode) throw new Error(`нет «Оды» в прогрессе: ${JSON.stringify(progress.pieces)}`);
  if (ode.fragments.length !== 4 || ode.fragments[0].level !== 4) throw new Error(`фрагменты: ${JSON.stringify(ode.fragments)}`);
  if (ode.activity.attempts < 6) throw new Error(`проходов: ${ode.activity.attempts}`);
  const playedSecs = progress.play.reduce((s, [, secs]) => s + secs, 0);
  if (playedSecs < 5) throw new Error(`время игры: ${playedSecs} с`);
  ok(`прогресс сохранён: 4 фрагмента, проходов ${ode.activity.attempts}, игры ${Math.round(playedSecs)} с`);

  await waitFor("к списку пьес", () => click("← Пьесы"));
  await waitFor("вкладка «Прогресс»", () => click("Прогресс"));
  await waitFor("пьеса на экране прогресса", () =>
    js("return [...document.querySelectorAll('.progress-piece')].some((e) => e.textContent.includes('Ода к радости'));"),
  );
  ok("экран «Прогресс» показывает пьесу и её фрагменты");

  // --- Этап 5: теория, упражнения, разминка, «Занятие на сегодня», справочник ---
  console.log("Сквозной тест: упражнения и теория");
  // Плашка «Новое» в пьесе: «Понятно» отмечает карточку показанной.
  await waitFor("к пьесам", () => click("Пьесы"));
  await waitFor("«Менуэт соль минор»", () =>
    js("const b = [...document.querySelectorAll('.piece-card')].find((b) => b.textContent.includes('Менуэт соль минор')); if (!b) return false; b.click(); return true;"),
  );
  const plaque = await waitFor("плашка теории", () => js("return document.querySelector('.theory-plaque')?.dataset.theory ?? '';"), 30000);
  await js("[...document.querySelectorAll('.theory-plaque button')].find((b) => b.textContent.includes('Понятно')).click();");
  await waitFor("следующая плашка", async () => (await js("return document.querySelector('.theory-plaque')?.dataset.theory ?? '';")) !== plaque);
  const seen = (await invoke("get_state")).prefs.theorySeen;
  if (!seen.includes(plaque)) throw new Error(`карточка ${plaque} не отмечена: ${seen}`);
  ok(`плашка «Новое» в пьесе: карточка «${plaque}» отмечена показанной`);
  // «Подробнее» → Esc закрывает только окно карточки, пьеса остаётся открытой.
  await js("[...document.querySelectorAll('.theory-plaque button')].find((b) => b.textContent.includes('Подробнее')).click();");
  await waitFor("окно карточки", () => js("return !!document.querySelector('.theory-modal');"));
  await js("document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));");
  await waitFor("окно закрыто", () => js("return !document.querySelector('.theory-modal');"));
  await sleep(300);
  if (!(await js("return !!document.querySelector('.score-scroll');"))) throw new Error("Esc в окне карточки закрыл пьесу");
  ok("Esc в окне «Подробнее» закрывает только окно");
  await waitFor("к списку пьес", () => click("← Пьесы"));

  await waitFor("вкладка «Упражнения»", () => click("Упражнения"));
  await waitFor("первое упражнение открыто", () =>
    js("const b = document.querySelector('[data-exercise=\"five-C-updown-right\"]'); if (!b || b.disabled) return false; b.click(); return true;"),
  );
  await waitFor("ноты упражнения", () => js("return !!document.querySelector('.score-page svg g.note');"), 30000);
  const exFings = await js("return document.querySelectorAll('.score-page g.fing').length;");
  if (exFings !== 9) throw new Error(`пальцев на стане упражнения: ${exFings}, ожидалось 9`);
  // В темпе, ничего не играем: результат «не засчитано» записывается.
  await waitFor("кнопка «Старт»", () => click("▶ Старт"));
  await waitFor("итог упражнения", () => js("return document.querySelector('.score-scroll')?.dataset.exResult === 'failed';"), 30000);
  const exStats = await invoke("exercise_stats");
  const st = exStats.find((x) => x.exercise === "five-C-updown-right");
  if (!st || st.attempts < 1 || st.passed) throw new Error(`результат упражнения: ${JSON.stringify(exStats)}`);
  ok("упражнение: 9 нот с пальцами, сыграно в темпе, результат записан (не засчитано)");
  await waitFor("к упражнениям", () => click("К упражнениям"));

  await waitFor("главная", () => click("Главная"));
  await waitFor("«Занятие на сегодня»", () => js("return !!document.querySelector('[data-today]');"));
  const todayText = await js("return document.querySelector('[data-today]').innerText;");
  if (!/Разминка/.test(todayText) || !/Тренажёр нот/.test(todayText) || !/Ода к радости|Менуэт/.test(todayText))
    throw new Error(`«Занятие на сегодня»: ${todayText}`);
  await waitFor("шаг «Разминка»", () =>
    js("const b = [...document.querySelectorAll('.today-step')].find((b) => b.textContent.includes('Разминка')); if (!b) return false; b.click(); return true;"),
  );
  await waitFor("разминка началась", () => js("return /Разминка: 1 из \\d/.test(document.body.innerText);"), 15000);
  ok("главная: «Занятие на сегодня», разминка дня открывается с главной");
  await waitFor("из разминки", () => click("← Упражнения"));

  await waitFor("вкладка «Справочник»", () => click("Справочник"));
  await waitFor("карточка «Знаки при ключе»", () =>
    js("const b = document.querySelector('[data-card=\"key-signature\"]'); if (!b) return false; b.click(); return true;"),
  );
  await waitFor("нотный пример карточки", () => js("return !!document.querySelector('.theory-example svg');"), 15000);
  ok("справочник: карточка с нотным примером");

  // --- Этап 6: запись своей игры → MIDI-пьеса с нотами ---
  console.log("Сквозной тест: запись и импорт MIDI");
  await waitFor("вкладка пьес", () => click("Пьесы"));
  await waitFor("кнопка записи", () => js("const b = document.querySelector('[data-record-open]'); if (!b) return false; b.click(); return true;"));
  // Без отсчёта и метронома — сразу запись.
  await waitFor("настройки записи", () =>
    js("const boxes = [...document.querySelectorAll('.record-panel input[type=checkbox]')]; if (boxes.length !== 2) return false; boxes.forEach((b) => b.checked && b.click()); return boxes.every((b) => !b.checked);"),
  );
  await waitFor("начать запись", () => js("const b = document.querySelector('[data-record-start]'); if (!b) return false; b.click(); return true;"));
  await waitFor("идёт запись", () => js("return document.querySelector('.record-panel')?.dataset.recording === '1';"));
  // Восемь четвертей до–до при 80 уд/мин (750 мс), каждая звучит ~690 мс.
  // Время считается от начала, чтобы задержки вызовов не накапливались.
  const melody = [60, 62, 64, 65, 67, 69, 71, 72];
  const t0 = Date.now();
  const until = (ms) => sleep(Math.max(0, t0 + ms - Date.now()));
  for (const [k, note] of melody.entries()) {
    await until(k * 750);
    await invoke("simulate_midi", { device: "E2E", bytes: [0x90, note, 90] });
    await until(k * 750 + 690);
    await invoke("simulate_midi", { device: "E2E", bytes: [0x80, note, 0] });
  }
  await waitFor("остановить запись", () => js("const b = document.querySelector('[data-record-stop]'); if (!b) return false; b.click(); return true;"));
  const recFile = await waitFor("запись в библиотеке", () =>
    js("const c = [...document.querySelectorAll('[data-file]')].find((c) => c.dataset.file.startsWith('Запись')); return c ? c.dataset.file : '';"),
  );
  if (!existsSync(join(docs, "MIDI Teacher", recFile))) throw new Error(`файла ${recFile} нет в папке библиотеки`);
  ok(`запись сохранена в библиотеку: ${recFile}`);

  await js("[...document.querySelectorAll('[data-file]')].find((c) => c.dataset.file === arguments[0]).click();", [recFile]);
  await waitFor("окно дорожек", () => js("return !!document.querySelector('[data-track-dialog]');"), 15000);
  const trackRows = await js("return document.querySelectorAll('[data-track]').length;");
  if (trackRows !== 1) throw new Error(`дорожек в записи: ${trackRows}`);
  await js("document.querySelector('[data-apply]').click();");
  await waitFor("ноты из MIDI", () => js("return document.querySelectorAll('.score-page svg g.note').length === 8;"), 30000);
  ok("окно дорожек → ноты построены: 8 нот на стане");
  const pieceId = `user:${recFile}`;
  const setupOf = async () => (await invoke("get_state")).prefs.pieceSetup[pieceId];
  const setup = await setupOf();
  if (!setup?.roles || setup.roles.length !== 1) throw new Error(`выбор дорожек не сохранён: ${JSON.stringify(setup)}`);
  const conv = await invoke("midi_convert", { id: recFile, options: { roles: setup.roles } });
  const quarters = (conv.musicxml.match(/<type>quarter<\/type>/g) ?? []).length;
  if (conv.measures !== 2 || quarters !== 8) throw new Error(`выравнивание: тактов ${conv.measures}, четвертей ${quarters}`);
  ok("выравнивание по сетке: 2 такта по 4 четверти");

  const svgNow = () => js("return document.querySelector('.score-page svg')?.innerHTML ?? '';");
  const svgBefore = await svgNow();
  await waitFor("тон +1", () => js("const b = document.querySelector('[data-transpose-up]'); if (!b) return false; b.click(); return true;"));
  await waitFor("тон сохранён", async () => (await setupOf())?.transpose === 1);
  // Ждём, пока ноты действительно перерисуются (знаки при ключе другие), а не только сохранится тон.
  await waitFor("ноты после транспонирования", async () => (await svgNow()) !== svgBefore && (await js("return document.querySelectorAll('.score-page svg g.note').length === 8;")), 20000);
  ok("транспонирование на полутон: настройка сохранена, ноты перестроены");

  await waitFor("режим «Руки…»", () => click("Руки…"));
  await waitFor("клик по ноте", () =>
    js("const n = document.querySelector('.score-page svg g.note'); if (!n) return false; n.dispatchEvent(new MouseEvent('click', { bubbles: true })); return true;"),
  );
  await waitFor("правка руки сохранена", async () => (await setupOf())?.handOverrides?.length === 1);
  await waitFor("нота в левой руке", () =>
    js("return [...document.querySelectorAll('.score-page svg g.staff')].some((s, i) => i % 2 === 1 && s.querySelector('g.note'));"),
    20000,
  );
  ok("«Руки…»: нота перенесена в левую руку");
  await waitFor("выйти из «Руки…»", () => click("Готово"));

  const xmlPath = join(profile, "export.musicxml");
  await invoke("save_text_file", { path: xmlPath, content: conv.musicxml });
  if (!existsSync(xmlPath)) throw new Error("MusicXML не сохранён");
  ok("сохранение MusicXML в файл");

  // --- Гитара и бас (этап Г0): тюнер по тестовому сигналу вместо кабеля ---
  console.log("Сквозной тест: гитара и бас");
  await waitFor("вкладка «Гитара»", () => click("Гитара"));
  await waitFor("экран гитары", () => js("return !!document.querySelector('[data-guitar]');"));
  const tuner = () => js("const t = document.querySelector('.tuner'); return t ? [t.dataset.midi, t.dataset.cents] : null;");
  await invoke("guitar_test_signal", { hz: 110, secs: 1.0, kind: "pluck" });
  await waitFor("тюнер: ля (щипок 110 Гц)", async () => (await tuner())?.[0] === "45");
  await invoke("guitar_test_signal", { hz: 82.407 * 2 ** (22 / 1200), secs: 0.6, kind: "sine" });
  const [eMidi, eCents] = await waitFor("тюнер: ми +22 цента", async () => {
    const t = await tuner();
    return t && t[0] === "40" ? t : null;
  });
  if (Math.abs(Number(eCents) - 22) > 3) throw new Error(`центы: ${eCents}`);
  await waitFor("подсвечена струна ми", () => js("return !!document.querySelector('[data-string=\"0\"].active');"));
  ok(`тюнер гитары: ля по щипку, ми ${eMidi} на +${eCents} центов, подсказка у нужной струны`);

  await js("document.querySelector('[data-instrument=\"bass\"]').click();");
  await waitFor("бас в настройках", async () => (await invoke("guitar_state")).config.instrument === "bass");
  await waitFor("четыре струны баса", () => js("return document.querySelectorAll('.tuner-string').length === 4;"));
  await invoke("guitar_test_signal", { hz: 41.2, secs: 1.0, kind: "pluck" });
  await waitFor("тюнер: ми контроктавы", async () => (await tuner())?.[0] === "28");
  ok("тюнер баса: низкая ми (41 Гц) определена");

  // Включение входа без устройства (в CI звуковых карт нет) — понятное сообщение, не падение.
  await js("document.querySelector('[data-enable]').click();");
  const gst = await waitFor("вход открылся или ошибка", async () => {
    const s = (await invoke("guitar_state")).status;
    return s.running || s.error ? s : null;
  });
  ok(gst.running ? `вход открыт: ${gst.device}` : `без устройства записи — сообщение: «${gst.error}»`);
  await js("document.querySelector('[data-enable]').click();");
  await waitFor("вход выключен", async () => !(await invoke("guitar_state")).config.enabled);

  // «Бот играет на гитаре»: «Ода к радости» в табах, каждая нужная нота — синтезированный
  // щипок, который проходит весь путь распознавания звука (начало, высота) → режим ожидания.
  await waitFor("вкладка пьес", () => click("Пьесы"));
  await waitFor("«Ода к радости»", () =>
    js("const b = [...document.querySelectorAll('.piece-card')].find((b) => b.textContent.includes('Ода к радости')); if (!b) return false; b.click(); return true;"),
  );
  await waitFor("ноты пьесы", () => js("return !!document.querySelector('.score-page svg g.note');"), 30000);
  await waitFor("гитара", () => js("const b = document.querySelector('[data-piece-instrument=\"guitar\"]'); if (!b) return false; b.click(); return true;"));
  await waitFor("табулатура и гриф", () => js("return !!document.querySelector('.tab-score g.note') && !!document.querySelector('[data-fretboard]');"), 30000);
  await waitFor("режим «Свободно»", () => click("Свободно"));
  await waitFor("режим ожидания", () => click("Ожидание"));
  // Сессия один раз перезапускается, когда догрузится аккомпанемент (вторая партия пьесы) —
  // ждём, пока первый шаг устойчиво покажет ми.
  await waitFor("первая нота мелодии на гитаре — ми (64)", async () => {
    if ((await pitches()) !== "64") return false;
    await sleep(700);
    return (await pitches()) === "64";
  }, 20000);
  const hzOf = (m) => 440 * 2 ** ((m - 69) / 12);
  const gDone = () => js("return document.querySelector('.score-scroll')?.dataset.finished === '1';");
  let plucks = 0;
  for (let i = 0; i < 120 && !(await gDone()); i++) {
    const cur = await pitches();
    if (!cur) {
      await sleep(100);
      continue;
    }
    const step = await stepNo();
    for (const p of cur.split(",")) await invoke("guitar_test_signal", { hz: hzOf(Number(p)), secs: 0.3, kind: "pluck" });
    plucks++;
    await waitFor(`гитара: переход с шага ${step}`, async () => (await stepNo()) !== step || (await gDone()), 8000);
  }
  const gSum = await waitFor("итог пьесы на гитаре", () => js("return document.querySelector('.summary')?.innerText;"), 10000);
  const gErrors = await js("return document.querySelector('.summary .big')?.textContent;");
  if (gErrors !== "0") throw new Error(`ошибок на гитаре: ${gErrors}\n${gSum}`);
  const heard = (await invoke("guitar_state")).status.recentNotes;
  if (!heard.length) throw new Error("распознанные ноты не показаны");
  ok(`гитара: «Ода к радости» в табах сыграна щипками через распознавание звука — ${plucks} нот, 0 ошибок`);

  // --- Этап «Б»: барабаны на пэдах ---
  console.log("Сквозной тест: барабаны");
  await waitFor("вкладка «Барабаны»", () => click("Барабаны"));
  await waitFor("мастер пэдов", () => js("const b = document.querySelector('[data-pad-wizard]'); if (!b) return false; b.click(); return true;"));
  const padStep = () => js("return document.querySelector('[data-pad-step]')?.dataset.padStep ?? '';");
  await waitFor("шаг «Бочка»", async () => (await padStep()) === "kick");
  // Пэды имитированной клавиатуры — ноты 36–39 на 10-м канале.
  const padHit = async (note, velocity = 100) => {
    await invoke("simulate_midi", { device: "E2E", bytes: [0x99, note, velocity] });
    await invoke("simulate_midi", { device: "E2E", bytes: [0x89, note, 0] });
  };
  for (const [note, next] of [[36, "snare"], [37, "hhClosed"], [38, "hhOpen"], [39, "tom"]]) {
    await padHit(note);
    await waitFor(`мастер: шаг «${next}»`, async () => (await padStep()) === next);
  }
  await padHit(36);
  await waitFor("повтор пэда отклонён", () => js("return (document.querySelector('.pad-wizard .notice')?.textContent ?? '').includes('уже назначен');"));
  await js("document.querySelector('[data-pad-save]').click();");
  await waitFor("пэды сохранены", async () => (await invoke("get_state")).devices.pads.length === 4);
  ok("мастер пэдов: 4 пэда назначены, повторный пэд отклонён");

  // Экранный пэд: удар звучит и приходит от «Пэдов».
  // Вспышка длится 150 мс — ловим её наблюдателем за классом, а не опросом.
  await waitFor("экранный пэд", () =>
    js(
      "const b = document.querySelector(\".drums [data-drum='snare']\"); if (!b) return false;" +
        "window.__padFlash = false; new MutationObserver(() => { if (b.classList.contains('held')) window.__padFlash = true; }).observe(b, { attributes: true, attributeFilter: ['class'] });" +
        "b.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); return true;",
    ),
  );
  await waitFor("экранный пэд вспыхнул", () => js("return window.__padFlash === true;"), 3000);
  ok("удар по экранному пэду приходит от устройства «Пэды»");

  // Бот играет грув на пэдах в режиме ожидания: каждый нужный барабан — удар по назначенному пэду.
  const padOf = { 36: 36, 38: 37, 42: 38, 46: 39 };
  const done = () => js("return document.querySelector('.score-scroll')?.dataset.finished === '1';");
  const playWait = async (label, hit) => {
    let count = 0;
    for (let i = 0; i < 200 && !(await done()); i++) {
      const cur = await pitches();
      if (!cur) {
        await sleep(100);
        continue;
      }
      const step = await stepNo();
      for (const p of cur.split(",")) await hit(Number(p));
      count++;
      await waitFor(`${label}: переход с шага ${step}`, async () => (await stepNo()) !== step || (await done()), 8000);
    }
    const sum = await waitFor(`${label}: итог`, () => js("return document.querySelector('.summary')?.innerText;"), 10000);
    const errors = await js("return document.querySelector('.summary .big')?.textContent;");
    if (errors !== "0") throw new Error(`${label}: ошибок ${errors}\n${sum}`);
    return count;
  };
  await waitFor("грув «Бочка и малый четвертями»", () =>
    js("const b = document.querySelector(\"[data-exercise='drum-groove-quarters']\"); if (!b || b.disabled) return false; b.click(); return true;"),
  );
  await waitFor("ударный стан, дорожка и пэды", () =>
    js("return !!document.querySelector('.score-page svg g.note') && !!document.querySelector('[data-drum-pads]') && !!document.querySelector('[data-drum-highway]');"),
    30000,
  );
  await waitFor("режим ожидания", () => click("Ожидание"));
  await waitFor("первый шаг — бочка (36)", async () => (await pitches()) === "36", 10000);
  const grooveSteps = await playWait("грув", (p) => padHit(padOf[p]));
  ok(`барабаны: грув сыгран на пэдах через назначение — ${grooveSteps} шагов, 0 ошибок`);

  // Рудимент в темпе: ничего не играем — результат всё равно записан (не засчитан).
  await waitFor("к барабанам", () => click("← Барабаны"));
  await waitFor("рудимент «Одиночные восьмыми»", () =>
    js("const b = document.querySelector(\"[data-exercise='drum-rud-singles8']\"); if (!b || b.disabled) return false; b.click(); return true;"),
  );
  await waitFor("ноты рудимента", () => js("return !!document.querySelector('.score-page svg g.note');"), 30000);
  await waitFor("старт", () => click("▶ Старт"));
  await waitFor("итог рудимента", () => js("return !!document.querySelector('.exercise-summary');"), 40000);
  const drumStats = await invoke("exercise_stats");
  if (!drumStats.some((st) => st.exercise === "drum-rud-singles8")) throw new Error("результат рудимента не записан");
  ok("рудимент в темпе: итог показан, результат записан");
  await waitFor("закрыть итог", () => js("const b = [...document.querySelectorAll('.exercise-summary button')].find((b) => b.textContent.includes('Закрыть') || b.textContent.includes('К упражнениям') || b.textContent.includes('←')); if (!b) return false; b.click(); return true;")).catch(() => {});

  // Барабаны из MIDI: файл с фортепиано и ударными, ударные — «мои».
  const smf0 = (events, ppq = 480) => {
    const vlq = (v) => {
      const out = [v & 0x7f];
      while ((v >>= 7)) out.unshift((v & 0x7f) | 0x80);
      return out;
    };
    const body = [0, 0xff, 0x51, 3, 0x07, 0xa1, 0x20, 0, 0xff, 0x58, 4, 4, 2, 24, 8];
    let last = 0;
    for (const [t, bytes] of [...events].sort((a, b) => a[0] - b[0] || (a[1][0] & 0xf0) - (b[1][0] & 0xf0))) {
      body.push(...vlq(t - last), ...bytes);
      last = t;
    }
    body.push(0, 0xff, 0x2f, 0);
    const len = body.length;
    return Buffer.from([
      ...Buffer.from("MThd"), 0, 0, 0, 6, 0, 0, 0, 1, ppq >> 8, ppq & 0xff,
      ...Buffer.from("MTrk"), (len >>> 24) & 0xff, (len >>> 16) & 0xff, (len >>> 8) & 0xff, len & 0xff,
      ...body,
    ]);
  };
  const ev = [];
  const note = (t, ch, n, len = 100, v = 90) => ev.push([t, [0x90 | ch, n, v]], [t + len, [0x80 | ch, n, 0]]);
  for (let bar = 0; bar < 2; bar++) {
    const o = bar * 1920;
    for (let i = 0; i < 8; i++) note(o + i * 240, 9, 42);
    note(o, 9, 36);
    note(o + 960, 9, 36);
    note(o + 480, 9, 38);
    note(o + 1440, 9, 38);
    [60, 64, 67, 64].forEach((n, i) => note(o + i * 480, 0, n, 460, 70));
  }
  writeFileSync(join(docs, "MIDI Teacher", "Барабаны тест.mid"), smf0(ev));
  await waitFor("вкладка пьес", () => click("Пьесы"));
  await waitFor("MIDI с барабанами", () =>
    js("const b = [...document.querySelectorAll('.piece-card')].find((b) => b.textContent.includes('Барабаны тест')); if (!b) return false; b.click(); return true;"),
    20000,
  );
  await waitFor("окно дорожек", () => js("return !!document.querySelector('[data-track-dialog]');"), 20000);
  await waitFor("ударные — «Барабаны»", () =>
    js("const row = [...document.querySelectorAll('[data-track]')].find((r) => r.textContent.includes('Ударные')); const b = row && row.querySelector(\"[data-role='drums']\"); if (!b) return false; b.click(); return b.classList.contains('on') || true;"),
  );
  await js("document.querySelector('[data-apply]').click();");
  await waitFor("инструмент «Барабаны»", () => js("const b = document.querySelector(\"[data-piece-instrument='drums']\"); if (!b) return false; b.click(); return true;"), 20000);
  await waitFor("барабанная партия из MIDI", () => js("return !!document.querySelector('[data-drum-pads]') && !!document.querySelector('.score-page svg g.note');"), 30000);
  await waitFor("режим «Свободно»", () => click("Свободно"));
  await waitFor("режим ожидания", () => click("Ожидание"));
  await waitFor("первый шаг — бочка и хэт", async () => (await pitches()).split(",").sort().join(",") === "36,42", 10000);
  const midiSteps = await playWait("барабаны из MIDI", (p) => invoke("hit_drum", { drum: p, velocity: 100 }));
  ok(`барабаны из MIDI: партия ударных сыграна на экранных пэдах — ${midiSteps} шагов, 0 ошибок`);

  // Запись своей игры в пьесе: ● → удары → ■ → дубль → «Сохранить».
  await js("document.querySelector('.summary-overlay button')?.click();");
  await waitFor("кнопка записи", () => js("const b = document.querySelector(\"[data-record-take='off']\"); if (!b) return false; b.click(); return true;"));
  await waitFor("запись идёт", () => js("return !!document.querySelector(\"[data-record-take='on']\");"));
  for (const d of [36, 42, 38, 42]) {
    await invoke("hit_drum", { drum: d, velocity: 100 });
    await sleep(150);
  }
  await js("document.querySelector(\"[data-record-take='on']\").click();");
  const takeNotes = await waitFor("дубль", () => js("return document.querySelector('[data-take]')?.dataset.take ?? '';"));
  if (Number(takeNotes) !== 4) throw new Error(`в дубле ${takeNotes} нот вместо 4`);
  await js("document.querySelector('[data-take-save]').click();");
  const saved = await waitFor("запись сохранена", () => js("const t = document.querySelector('.toast')?.textContent ?? ''; return t.includes('сохранена') ? t : false;"));
  const takeFile = saved.split(": ").pop().trim();
  if (!existsSync(join(docs, "MIDI Teacher", takeFile))) throw new Error(`файла ${takeFile} нет в библиотеке`);
  ok(`запись в пьесе: дубль из 4 ударов сохранён — ${takeFile}`);

  // --- Студия: свой трек из дорожек ---
  console.log("Сквозной тест: студия");
  const setValue = (selector, value, event = "input") =>
    js(
      "const [sel, v, ev] = arguments; const el = document.querySelector(sel); if (!el) return false;" +
        "const proto = el.tagName === 'SELECT' ? HTMLSelectElement.prototype : el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;" +
        "Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, String(v));" +
        "el.dispatchEvent(new Event(ev, { bubbles: true })); return true;",
      [selector, value, event],
    );
  const studioMode = () => js("return document.querySelector('[data-studio-mode]')?.dataset.studioMode ?? '';");
  const studioToast = (text) => waitFor(`сообщение «${text}»`, () => js("const t = document.querySelector('.studio-toast')?.textContent ?? ''; return t.includes(arguments[0]) ? t : false;", [text]), 15000);
  // Запись: ждём конца отсчёта, играем, останавливаем.
  const recordTake = async (label, playFn) => {
    await js("document.querySelector('[data-studio-record]').click();");
    await waitFor(`${label}: идёт запись`, async () => (await studioMode()) === "record");
    await waitFor(`${label}: отсчёт идёт`, () => js("return document.querySelector('[data-studio-pos]')?.dataset.counting === '1';"), 10000);
    await waitFor(`${label}: отсчёт закончился`, () => js("return document.querySelector('[data-studio-pos]')?.dataset.counting === '0';"), 10000);
    await playFn();
    await js("document.querySelector('[data-studio-stop]').click();");
    await waitFor(`${label}: запись остановлена`, async () => (await studioMode()) === "idle");
  };
  await waitFor("вкладка «Студия»", () => click("Студия"));
  await waitFor("новый трек", () => js("const b = document.querySelector('[data-studio-new]'); if (!b) return false; b.click(); return true;"));
  await waitFor("название трека", () => setValue("[data-song-name]", "E2E трек"));
  // Короткий трек: 2 такта, темп 120 — отсчёт 2 с.
  await setValue(".studio-form input[type='number']", 120);
  await js("const n = document.querySelectorAll('.studio-form input[type=number]'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(n[1], '2'); n[1].dispatchEvent(new Event('input', { bubbles: true }));");
  await js("document.querySelector('[data-studio-create]').click();");
  await waitFor("редактор трека", async () => (await studioMode()) === "idle");
  // Дорожка 1 — клавишные: до–ре–ми–фа четвертями.
  await recordTake("клавишные", async () => {
    for (const note of [60, 62, 64, 65]) {
      await invoke("simulate_midi", { device: "E2E", bytes: [0x90, note, 90] });
      await sleep(400);
      await invoke("simulate_midi", { device: "E2E", bytes: [0x80, note, 0] });
      await sleep(100);
    }
  });
  await studioToast("нот 4");
  // Дорожка 2 — барабаны на пэдах (экранные пэды).
  await js("document.querySelector(\"[data-add-track='drums']\").click();");
  await waitFor("дорожка барабанов выбрана", () => js("return document.querySelectorAll('[data-studio-track]').length === 2 && document.querySelectorAll('[data-studio-track] input[type=radio]')[1].checked;"));
  await recordTake("барабаны", async () => {
    for (const d of [36, 42, 38, 42, 36, 42]) {
      await invoke("hit_drum", { drum: d, velocity: 100 });
      await sleep(250);
    }
  });
  await studioToast("нот 6");
  // Перезапись такта 2 на клавишных: новый дубль, склеенный с прежним.
  await js("document.querySelectorAll('[data-studio-track] input[type=radio]')[0].click();");
  await js("document.querySelector('[data-punch]').click();");
  await waitFor("поля куска", () => setValue("[data-punch-from]", 2));
  await setValue("[data-punch-to]", 2);
  await recordTake("кусок", async () => {
    // Такт 1 звучит (вход), запись — со второго такта.
    await waitFor("такт 2", () => js("return (document.querySelector('[data-studio-pos]')?.dataset.studioPos ?? '').startsWith('2:');"), 10000);
    await invoke("simulate_midi", { device: "E2E", bytes: [0x90, 72, 90] });
    await sleep(300);
    await invoke("simulate_midi", { device: "E2E", bytes: [0x80, 72, 0] });
    await sleep(200);
  });
  const takeNames = await waitFor("дубль куска", () =>
    js("const o = [...document.querySelectorAll('[data-studio-track]')[0].querySelectorAll('[data-takes] option')].map((o) => o.textContent); return o.some((t) => t.includes('такты 2–2')) ? o : false;"),
  );
  await js("document.querySelector('[data-punch]').click();");
  // Сетка на клавишных и воспроизведение до конца.
  await setValue("[data-studio-track='0'] [data-grid]", 8, "change");
  await js("document.querySelector('[data-studio-play]').click();");
  await waitFor("играет", async () => (await studioMode()) === "play");
  await waitFor("доиграл до конца", async () => (await studioMode()) === "idle", 20000);
  // Экспорт.
  await js("document.querySelector('[data-export-midi]').click();");
  const midiMsg = await studioToast("MIDI сохранён");
  const midiFile = midiMsg.split(": ").pop().trim();
  const midiInfo = await invoke("midi_inspect", { id: midiFile });
  if (midiInfo.tracks.length !== 2 || !midiInfo.tracks.some((t) => t.drums)) throw new Error(`дорожки MIDI: ${JSON.stringify(midiInfo.tracks)}`);
  await js("document.querySelector('[data-export-wav]').click();");
  const wavMsg = await studioToast("WAV сохранён");
  const wavPath = wavMsg.replace(/^.*WAV сохранён: /, "").trim();
  if (!existsSync(wavPath)) throw new Error(`нет файла ${wavPath}`);
  await sleep(800);
  const songs = await invoke("studio_list");
  const mine = songs.find((x) => x.name === "E2E трек");
  if (!mine || mine.tracks !== 2) throw new Error(`трек не сохранён: ${JSON.stringify(songs)}`);
  ok(`студия: трек с нуля — клавишные и барабаны, кусок (${takeNames.length} дубля), сетка, MIDI (${midiInfo.tracks.length} дорожки) и WAV`);

  // Трек из MIDI-песни: дорожки с «Оригиналом», своя партия поверх — с оценкой.
  await js("[...document.querySelectorAll('button')].find((b) => b.textContent.includes('← Треки')).click();");
  await waitFor("из MIDI-песни", () => js("const b = document.querySelector('[data-studio-from-midi]'); if (!b) return false; b.click(); return true;"));
  await waitFor("песня в списке", () => js("const b = document.querySelector(\"[data-studio-midi='Барабаны тест']\"); if (!b) return false; b.click(); return true;"), 10000);
  await waitFor("дорожки песни", () => js("return document.querySelectorAll('[data-studio-track]').length === 2;"), 10000);
  const drumIdx = await js("return [...document.querySelectorAll('[data-studio-track]')].findIndex((r) => r.textContent.includes('Барабаны'));");
  await js("document.querySelectorAll('[data-studio-track] input[type=radio]')[arguments[0]].click();", [drumIdx]);
  await recordTake("барабаны поверх песни", async () => {
    for (let i = 0; i < 4; i++) {
      await invoke("hit_drum", { drum: 36, velocity: 100 });
      await sleep(500);
    }
  });
  const graded = await waitFor("оценка дубля", () =>
    js("const o = [...document.querySelectorAll('[data-studio-track]')[arguments[0]].querySelectorAll('[data-takes] option')].map((o) => o.textContent); return o.find((t) => t.includes('к оригиналу')) ?? false;", [drumIdx]),
  );
  ok(`студия: трек из MIDI-песни, своя партия барабанов поверх — «${graded.trim()}»`);

  console.log("Сквозной тест: чтение с листа и ритм");
  const scroll = (attr) => js(`return document.querySelector('.score-scroll')?.dataset.${attr} ?? '';`, []);
  // Бот в темпе: по часам транспорта нажимает каждую ноту в её момент (имитация MIDI-входа).
  const playInTempo = async (pitchOf = (p) => p) => {
    const transportAttr = await waitFor("часы транспорта", () => scroll("transport"), 10000);
    const [originUs, pos0, tempo] = transportAttr.split(",").map(Number);
    const notes = (await scroll("onsets")).split(",").map((x) => x.split(":").map(Number)).sort((a, b) => a[0] - b[0]);
    // Сдвиг часов приложения относительно часов теста.
    const t0 = Date.now();
    const appUs = await invoke("clock_now");
    const rtt = Date.now() - t0;
    const localOf = (us) => t0 + rtt / 2 + (us - appUs) / 1000;
    // Ноты одного момента (аккорд, удар по струнам) — одним вызовом, почти одновременно.
    const groups = [];
    for (const [ms, pitch] of notes) {
      const last = groups[groups.length - 1];
      if (last && last.ms === ms) last.pitches.push(pitch);
      else groups.push({ ms, pitches: [pitch] });
    }
    for (const { ms, pitches } of groups) {
      const at = localOf(originUs + ((ms - pos0) / tempo) * 1000);
      const wait = at - Date.now() - 4;
      if (wait > 0) await sleep(wait);
      const ps = pitches.map(pitchOf);
      if (ps.length === 1) {
        await invoke("simulate_midi", { device: "E2E", bytes: [0x90, ps[0], 100] });
        await invoke("simulate_midi", { device: "E2E", bytes: [0x80, ps[0], 0] });
        continue;
      }
      await jsAsync(
        "const [ps, done] = arguments; const inv = (b) => window.__TAURI_INTERNALS__.invoke('simulate_midi', { device: 'E2E', bytes: b });" +
          "Promise.all(ps.map((p) => inv([0x90, p, 100]))).then(() => Promise.all(ps.map((p) => inv([0x80, p, 0])))).then(() => done(1), () => done(0));",
        [ps],
      );
    }
  };
  await waitFor("вкладка тренажёров", () => click("Тренажёры"));
  await waitFor("раздел «Чтение с листа»", () => js("const b = document.querySelector(\"[data-trainer-section='reading']\"); if (!b) return false; b.click(); return true;"));
  await waitFor("ступень 1", () => js("const b = document.querySelector(\"[data-read-level='1']\"); if (!b || b.disabled) return false; b.click(); return true;"));
  await waitFor("мелодия на стане", () => js("return !!document.querySelector('.score-page svg g.note');"), 30000);
  if ((await js("return document.querySelector('[data-ex-mode]')?.dataset.exMode;")) !== "wait") throw new Error("чтение с листа открывается не в режиме ожидания");
  // «▶ Послушать»: играет само, «■ Стоп» — обратно в ожидание.
  await js("document.querySelector('[data-listen]').click();");
  await waitFor("прослушивание идёт", async () => (await scroll("listening")) === "1" && (await scroll("playing")) === "1", 10000);
  await sleep(1500);
  await js("document.querySelector('[data-listen]').click();");
  await waitFor("снова ожидание", async () => (await scroll("listening")) === "0" && (await js("return document.querySelector('[data-ex-mode]')?.dataset.exMode;")) === "wait", 10000);
  // Ожидание: бот играет по курсору.
  for (let i = 0; i < 100 && !(await scroll("exResult")); i++) {
    const cur = await pitches();
    if (!cur) {
      await sleep(100);
      continue;
    }
    const step = await stepNo();
    for (const p of cur.split(",")) await press(Number(p));
    await waitFor(`чтение: шаг ${step}`, async () => (await stepNo()) !== step || !!(await scroll("exResult")), 8000);
  }
  if ((await waitFor("итог мелодии", () => scroll("exResult"), 10000)) !== "passed") throw new Error("мелодия в ожидании не засчитана");
  // Та же мелодия в темпе.
  await js("[...document.querySelectorAll('[data-wait-result] button')].find((b) => b.textContent === 'В темпе').click();");
  await waitFor("режим «в темпе»", () => js("return document.querySelector('[data-ex-mode]')?.dataset.exMode === 'rhythm';"));
  await js("document.querySelector('.score-scroll')?.removeAttribute('data-transport');");
  await waitFor("старт", () => click("▶ Старт"));
  await playInTempo();
  const readTempo = await waitFor("итог в темпе", () => js("return document.querySelector('.exercise-summary')?.innerText ?? '';"), 20000);
  const readStats = await invoke("exercise_stats");
  const passesOf = (id) => readStats.find((x) => x.exercise === id)?.passes ?? 0;
  if (passesOf("read-1-wait") !== 1 || passesOf("read-1") !== 1) throw new Error(`чтение: зачёты ${JSON.stringify(readStats.filter((x) => x.exercise.startsWith("read-")))}\n${readTempo}`);
  ok("чтение с листа: мелодия ступени 1 — «Послушать», засчитана в ожидании и в темпе");
  // «Новая мелодия» — другая мелодия той же ступени.
  const onsets1 = await scroll("onsets");
  await js("[...document.querySelectorAll('.exercise-summary button')].find((b) => b.textContent === 'Новая мелодия').click();");
  await waitFor("новая мелодия", async () => (await scroll("onsets")) && (await scroll("onsets")) !== onsets1, 20000);
  await waitFor("к тренажёрам", () => click("← Тренажёры"));

  // Ритм одной строкой: любая клавиша.
  await waitFor("раздел «Ритм»", () => js("const b = document.querySelector(\"[data-trainer-section='rhythm']\"); if (!b) return false; b.click(); return true;"));
  if (!(await js("return document.querySelector(\"[data-category='rhythm-hands']\")?.classList.contains('locked');"))) throw new Error("«Две руки» открыты сразу");
  await waitFor("ритм, ступень 1", () => js("const b = document.querySelector(\"[data-rhythm-level='rhythm-line-1']\"); if (!b || b.disabled) return false; b.click(); return true;"));
  await waitFor("ритм на стане и пэды ритма", () => js("return !!document.querySelector('.score-page svg g.note') && !!document.querySelector('[data-rhythm-pad]');"), 30000);
  await js("document.querySelector('.score-scroll')?.removeAttribute('data-transport');");
  await waitFor("старт", () => click("▶ Старт"));
  await playInTempo(() => 55 + Math.floor(Math.random() * 20)); // любые клавиши
  await waitFor("итог ритма", () => js("return !!document.querySelector('.exercise-summary');"), 20000);
  const lineRes = await scroll("exResult");
  const lineText = await js("return document.querySelector('.exercise-summary').innerText;");
  if (lineRes !== "passed") throw new Error(`ритм одной строкой не засчитан:\n${lineText}`);
  ok("ритм одной строкой: простучан случайными клавишами, засчитан");
  await waitFor("к тренажёрам", () => click("← Тренажёры"));

  // Две руки: открыть (три ступени одной строки засчитаны), стучать по рукам.
  for (let l = 1; l <= 3; l++)
    for (let k = 0; k < 3; k++)
      await invoke("exercise_record", { result: { exercise: `rhythm-line-${l}`, tempo: 1, accuracy: 1, timingSdMs: 10, loudness: 1, passed: true } });
  await waitFor("в главную и обратно", () => click("Главная"));
  await waitFor("тренажёры", () => click("Тренажёры"));
  await waitFor("две руки открыты", () => js("const b = document.querySelector(\"[data-rhythm-level='rhythm-hands-1']\"); if (!b || b.disabled) return false; b.click(); return true;"), 10000);
  await waitFor("две строки и два пэда", () => js("return document.querySelectorAll('[data-rhythm-pad]').length === 2 && !!document.querySelector('.score-page svg g.note');"), 30000);
  await waitFor("старт", () => click("▶ Старт"));
  // Правая строка — клавиши от до первой октавы и выше, левая — ниже.
  await playInTempo((p) => (p === 72 ? 64 + Math.floor(Math.random() * 12) : 40 + Math.floor(Math.random() * 12)));
  await waitFor("итог двух рук", () => js("return !!document.querySelector('.exercise-summary');"), 20000);
  if ((await scroll("exResult")) !== "passed") throw new Error(`две руки не засчитаны:\n${await js("return document.querySelector('.exercise-summary').innerText;")}`);
  ok("ритм двумя руками: правая и левая по разным клавишам, засчитан");
  await waitFor("к тренажёрам", () => click("← Тренажёры"));
  await waitFor("главная", () => click("Главная"));
  const doneSteps = () => js("return [...document.querySelectorAll('.today-step.done b')].map((b) => b.textContent).join('|');");
  await waitFor("шаги «Чтение с листа» и «Ритм» сделаны", async () => {
    const d = await doneSteps();
    return d.includes("Чтение с листа") && d.includes("Ритм");
  }, 10000).catch(async () => {
    throw new Error(`«Занятие на сегодня», сделано: ${await doneSteps()}`);
  });
  ok("главная: шаги «Чтение с листа» и «Ритм» отмечены сделанными");

  console.log("Сквозной тест: аккорды");
  const noteOn = (n) => invoke("simulate_midi", { device: "E2E", bytes: [0x90, n, 100] });
  const noteOff = (n) => invoke("simulate_midi", { device: "E2E", bytes: [0x80, n, 0] });
  await waitFor("вкладка тренажёров", () => click("Тренажёры"));
  await waitFor("раздел «Аккорды»", () => js("const b = document.querySelector(\"[data-trainer-section='chords']\"); if (!b) return false; b.click(); return true;"));
  await waitFor("ступень 1", () => js("const b = document.querySelector(\"[data-chord-level='1']\"); if (!b || b.disabled) return false; b.click(); return true;"));
  // Бот берёт каждый аккорд в обращении (основной тон сверху) — тоже верно.
  for (let i = 0; i < 12; i++) {
    const done = await js("return document.querySelector('[data-chord-done]')?.dataset.chordDone ?? '';");
    if (done) break;
    const idx = await js("return document.querySelector('[data-chord-index]')?.dataset.chordIndex;");
    const pcs = await waitFor("аккорд", () => js("return document.querySelector('[data-chord-pcs]')?.dataset.chordPcs ?? '';"), 5000);
    const [root, ...rest] = pcs.split(",").map(Number);
    const keys = [...rest.map((pc) => 48 + pc), 60 + root];
    for (const k of keys) await noteOn(k);
    try {
      await waitFor(`аккорд ${i + 1} принят`, async () => (await js("return document.querySelector('[data-chord-index]')?.dataset.chordIndex;")) !== idx, 5000);
    } catch (e) {
      const m = await js("const m = document.querySelector('.chord-drill'); return JSON.stringify({ held: m?.dataset.held, stale: m?.dataset.stale, pcs: document.querySelector('[data-chord-pcs]')?.dataset.chordPcs });");
      throw new Error(`${e.message}; нажато ${keys}; экран ${m}`);
    }
    for (const k of keys) await noteOff(k);
    await sleep(100);
  }
  const chordDone = await waitFor("итог серии", () => js("return document.querySelector('[data-chord-done]')?.dataset.chordDone ?? '';"), 10000);
  if (chordDone !== "passed") throw new Error(`серия аккордов: ${chordDone}`);
  await waitFor("зачёт записан", async () => ((await invoke("exercise_stats")).find((x) => x.exercise === "chord-1")?.passes ?? 0) === 1, 5000);
  ok("тренажёр аккордов: серия из 10 аккордов взята в обращениях, засчитана");
  await waitFor("к списку", () => click("К списку"));

  // Песня по буквам: правая — мелодия, левая — аккорды октавой ниже записанного (любая октава).
  const playSong = async (label, shift) => {
    for (let i = 0; i < 300; i++) {
      if ((await js("return document.querySelector('.score-scroll')?.dataset.finished;")) === "1") break;
      const cur = await pitches();
      if (!cur) {
        await sleep(100);
        continue;
      }
      const step = await stepNo();
      for (const p of cur.split(",").map(Number)) await press(shift(p));
      await waitFor(`${label}: шаг ${step}`, async () => (await stepNo()) !== step || (await js("return document.querySelector('.score-scroll')?.dataset.finished;")) === "1", 8000);
    }
    await waitFor(`${label}: итог`, () => js("return !!document.querySelector('.summary');"), 10000).catch(async (e) => {
      const st = await js("const s = document.querySelector('.score-scroll'); return JSON.stringify({ step: s?.dataset.currentStep, pitches: s?.dataset.currentPitches, finished: s?.dataset.finished, mode: [...document.querySelectorAll('.piece-bar button.on, .piece-bar .primary')].map((b) => b.textContent).join('|'), toast: document.querySelector('.toast')?.textContent });");
      throw new Error(`${e.message}; экран ${st}`);
    });
    const errors = await js("return document.querySelector('.summary .big')?.textContent;");
    if (errors !== "0") throw new Error(`${label}: ошибок ${errors}`);
  };
  await waitFor("песня «У Мэри был барашек»", () => js("const b = document.querySelector(\"[data-song='builtin-mary'] [data-song-style='block']\"); if (!b) return false; b.click(); return true;"));
  await waitFor("ноты песни", () => js("return !!document.querySelector('.score-page svg g.note');"), 30000);
  const harms = await js("return document.querySelectorAll('.score-page g.harm').length;");
  if (harms < 8) throw new Error(`букв аккордов на нотах: ${harms}`);
  await waitFor("«Свободно»", () => click("Свободно"));
  await waitFor("обе руки", () => click("Обе"));
  await waitFor("ожидание", () => click("Ожидание"));
  await playSong("песня по буквам", (p) => (p < 60 ? p - 12 : p));
  ok(`песня по буквам: ${harms} аккордов над нотами, левая рука сыграна октавой ниже — без ошибок`);
  await js("document.querySelector('.summary-overlay button')?.click();");
  await waitFor("к аккордам", () => click("← Аккорды"));

  // Своя песня текстом, без мелодии: обе руки в любой октаве.
  await waitFor("«+ Своя песня»", () => js("const b = document.querySelector('[data-song-new]'); if (!b) return false; b.click(); return true;"));
  await waitFor("поле аккордов", () =>
    js(
      "const el = document.querySelector('[data-song-chords]'); if (!el) return false;" +
        "Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(el, 'C | G7 | Am | F C');" +
        "el.dispatchEvent(new Event('input', { bubbles: true })); return true;",
    ),
  );
  await waitFor("аккорды разобраны", () => js("return document.querySelector('[data-song-parse]')?.dataset.songParse === 'ok';"));
  await js("document.querySelector('[data-song-play]').click();");
  await waitFor("ноты своей песни", () => js("return !!document.querySelector('.score-page svg g.note');"), 30000);
  await waitFor("ожидание", () => click("Ожидание"));
  await playSong("своя песня", (p) => p - 12);
  const songsSaved = (await invoke("get_state")).prefs.songs ?? [];
  if (songsSaved.length !== 1 || songsSaved[0].chords !== "C | G7 | Am | F C") throw new Error(`свои песни: ${JSON.stringify(songsSaved)}`);
  ok("своя песня: аккорды текстом сохранены, сыграны обеими руками октавой ниже — без ошибок");
  await js("document.querySelector('.summary-overlay button')?.click();");
  await waitFor("к аккордам", () => click("← Аккорды"));

  // Песня из пьесы: «⋯» → «Аккорды по буквам…».
  await waitFor("вкладка пьес", () => click("Пьесы"));
  await waitFor("«Ода к радости»", () =>
    js("const b = [...document.querySelectorAll('.piece-card')].find((b) => b.textContent.includes('Ода к радости')); if (!b) return false; b.click(); return true;"),
  );
  await waitFor("ноты пьесы", () => js("return !!document.querySelector('.score-page svg g.note');"), 30000);
  // В разделе «Гитара» «Оду» переключали на гитару — аккорды по буквам делаются из фортепианной партии.
  await waitFor("фортепиано", () => js("const b = document.querySelector(\"[data-piece-instrument='piano']\"); if (!b) return false; b.click(); return true;"));
  await waitFor("фортепианный стан", () => js("return !document.querySelector('.tab-score') && !!document.querySelector('.session-piano .piano');"), 30000);
  await sleep(2000); // ноты фортепианной партии перерисовываются после переключения
  await js("document.querySelector('[data-more]').click();");
  await waitFor("«Аккорды по буквам…»", () => js("const b = document.querySelector('[data-make-song]'); if (!b) return false; b.click(); return true;"));
  await waitFor("песня добавлена", () => js("return (document.querySelector('.toast')?.textContent ?? '').includes('добавлена');"));
  const fromPiece = ((await invoke("get_state")).prefs.songs ?? []).find((x) => x.source && x.source.includes("Ода"));
  if (!fromPiece || fromPiece.melody.length < 20 || !/^C\b/.test(fromPiece.chords)) throw new Error(`песня из пьесы: ${JSON.stringify(fromPiece)?.slice(0, 300)}`);
  ok(`песня из пьесы: мелодия ${fromPiece.melody.length} нот, аккорды «${fromPiece.chords.slice(0, 40)}…»`);
  await js("document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));");
  await sleep(300);
  await waitFor("к списку пьес", () => click("← Пьесы")).catch(() => {});

  console.log("Сквозной тест: строи и Rocksmith");
  // Пользовательская песня Rocksmith (CDLC) в папке библиотеки — как будто скачана с CustomsForge.
  const rsFile = "Test_Test_v1_p.psarc";
  writeFileSync(join(docs, "MIDI Teacher", rsFile), readFileSync(join(root, "crates/mt-core/tests/fixtures/rocksmith/test_p.psarc")));
  const select = (sel, value) =>
    js(
      "const s = document.querySelector(arguments[0]); if (!s) return false; s.value = arguments[1]; s.dispatchEvent(new Event('change', { bubbles: true })); return true;",
      [sel, value],
    );
  const openRs = async () => {
    // Список файлов читается при открытии вкладки — заходим на неё заново.
    await waitFor("главная", () => click("Главная"));
    await waitFor("вкладка пьес", () => click("Пьесы"));
    await waitFor("карточка песни Rocksmith", () =>
      js("const c = document.querySelector('[data-file=\"' + arguments[0] + '\"]'); if (!c || !c.textContent.includes('Rocksmith')) return false; c.click(); return true;", [rsFile]),
    );
    await waitFor("табулатура песни", () => js("return !!document.querySelector('.tab-score g.note') && !!document.querySelector('[data-arrangement-select]');"), 30000);
  };
  await openRs();
  const rsName = await js("return document.querySelector('.piece-name')?.textContent ?? '';");
  const parts = await js("return [...document.querySelectorAll('[data-arrangement]')].map((b) => b.dataset.arrangement + (b.classList.contains('on') ? '*' : '')).join(',');");
  const meta = await js("return document.querySelector('[data-tuning-meta]')?.dataset.tuningMeta;");
  if (!rsName.startsWith("Test — Test") || parts !== "lead*,rhythm" || meta !== "40,45,50,55,59,64")
    throw new Error(`песня: «${rsName}», партии ${parts}, строй ${meta}`);
  if (!(await js("return document.querySelector('.score-page svg')?.textContent.includes('Вступление');"))) throw new Error("нет подписи секции");
  ok("песня Rocksmith из библиотеки: соло и ритм-гитара, стандартный строй, секция «Вступление»");

  // Соло-гитара в режиме ожидания: 7 аккордов (19 нот) по нотам из табов.
  await waitFor("режим «Свободно»", () => click("Свободно"));
  await waitFor("режим ожидания", () => click("Ожидание"));
  const chordNow = async () => (await pitches()).split(",").filter(Boolean).map(Number).sort((a, b) => a - b).join(",");
  await waitFor("первый аккорд D (ре-фа#-ля)", async () => {
    if ((await chordNow()) !== "50,54,57") return false;
    await sleep(700);
    return (await chordNow()) === "50,54,57";
  }, 20000);
  let rsChords = 0;
  for (let i = 0; i < 40 && !(await gDone()); i++) {
    const cur = await pitches();
    if (!cur) {
      await sleep(100);
      continue;
    }
    const step = await stepNo();
    for (const p of cur.split(",")) await invoke("simulate_midi", { device: "E2E", bytes: [0x90, Number(p), 100] });
    for (const p of cur.split(",")) await invoke("simulate_midi", { device: "E2E", bytes: [0x80, Number(p), 0] });
    rsChords++;
    await waitFor(`Rocksmith: переход с шага ${step}`, async () => (await stepNo()) !== step || (await gDone()), 8000);
  }
  const rsErrors = await waitFor("итог соло-гитары", () => js("return document.querySelector('.summary .big')?.textContent;"), 10000);
  if (rsErrors !== "0" || rsChords !== 7) throw new Error(`соло: шагов ${rsChords}, ошибок ${rsErrors}`);
  ok("соло-гитара сыграна по табам: 7 аккордов, 0 ошибок");

  await js("document.querySelector('[data-arrangement=\"rhythm\"]').click();");
  await waitFor("ритм-гитара выбрана и сохранена", async () => (await invoke("get_state")).prefs.pieceSetup[`user:${rsFile}`]?.arrangement === 1);
  await waitFor("табы ритм-гитары", () => js("return document.querySelector('[data-arrangement=\"rhythm\"]').classList.contains('on') && document.querySelectorAll('.tab-score g.note').length > 10;"), 20000);
  ok("переключение на ритм-гитару: другая партия, выбор запомнен");

  // Ноты над табами: обычный стан с копиями нот, таб на месте.
  await js("document.querySelector('[data-more]').click();");
  await waitFor("«Ноты над табами»", () => js("const t = document.querySelector('[data-staff-with-tab] input'); if (!t) return false; t.click(); return true;"));
  await waitFor("стан над табом", () => js("return document.querySelectorAll('.score-page svg g.note[id$=\"~s\"]').length > 10 && !!document.querySelector('.score-page svg g.note:not([id$=\"~s\"])');"), 20000);
  if (!(await invoke("get_state")).prefs.piece.staffWithTab) throw new Error("«Ноты над табами» не сохранилось");
  await js("document.querySelector('[data-staff-with-tab] input').click(); document.querySelector('[data-more]').click();");
  ok("«Ноты над табами»: обычный стан над табулатурой");

  // Мой строй — Drop D: песня в стандартном строе предлагает перестроиться или переложить табы.
  const gcfg = (await invoke("guitar_state")).config;
  await invoke("guitar_set", { config: { ...gcfg, instrument: "guitar", tuning: [38, 45, 50, 55, 59, 64], capo: 0 } });
  await js("document.querySelector('[data-arrangement=\"lead\"]').click();");
  await waitFor("назад к списку", () => click("← Пьесы"));
  await openRs();
  await waitFor("плашка «строй пьесы другой»", () => js("return !!document.querySelector('[data-tuning-mismatch]');"), 15000);
  await js("document.querySelector('[data-relayout]').click();");
  await waitFor("табы переложены под Drop D", () =>
    js("return !!document.querySelector('[data-relayout-on]') && document.querySelector('[data-tuning-meta]')?.dataset.tuningMeta === '38,45,50,55,59,64';"),
  );
  if (!(await invoke("get_state")).prefs.pieceSetup[`user:${rsFile}`]?.relayout) throw new Error("переложение не сохранилось");
  // Звучат те же ноты: первый аккорд — снова D.
  await waitFor("первый аккорд после переложения", async () => (await chordNow()) === "50,54,57", 15000);
  ok("строй Drop D: плашка о строе, «Переложить табы» — табы под мой строй, ноты те же");

  await waitFor("вернуть строй пьесы", () => click("Вернуть строй пьесы"));
  await waitFor("перестроить гитару", () => js("const b = document.querySelector('[data-retune-open]'); if (!b) return false; b.click(); return true;"));
  await waitFor("тюнер на строй пьесы", () => js("return document.querySelector('[data-retune] [data-tuner-target]')?.dataset.tunerTarget === '40,45,50,55,59,64';"));
  await invoke("guitar_test_signal", { hz: 110, secs: 1.0, kind: "pluck" });
  await waitFor("струна ля настроена ✓", () => js("return (document.querySelector('[data-retune] [data-tuned]')?.dataset.tuned ?? '').split(',').includes('1');"));
  await js("document.querySelector('[data-retune-save]').click();");
  await waitFor("строй сохранён — стандартный", async () => {
    const c = (await invoke("guitar_state")).config;
    return c.tuning === null && c.capo === 0;
  });
  await waitFor("плашка о строе ушла", () => js("return !document.querySelector('[data-tuning-mismatch]') && !document.querySelector('[data-retune]');"));
  ok("«Перестроить гитару»: тюнер со струнами строя пьесы, ✓ у настроенной, строй сохранён");

  // Экран «Гитара»: Drop C — тюнер слышит до большой октавы (ниже стандартной ми).
  await waitFor("вкладка «Гитара»", () => click("Гитара"));
  await waitFor("выбор строя", () => select("[data-tuning-select]", "dropc"));
  await waitFor("Drop C в настройках", async () => (await invoke("guitar_state")).config.tuning?.join(",") === "36,43,48,53,57,62");
  await waitFor("струны тюнера — Drop C", () => js("return document.querySelector('[data-tuner-target]')?.dataset.tunerTarget === '36,43,48,53,57,62';"));
  await invoke("guitar_test_signal", { hz: 65.406, secs: 1.0, kind: "pluck" });
  await waitFor("тюнер: до (36)", async () => (await tuner())?.[0] === "36");
  await waitFor("каподастр", () => select("[data-capo-select]", "3"));
  await waitFor("каподастр в настройках", async () => (await invoke("guitar_state")).config.capo === 3);
  await waitFor("стандартный строй", () => select("[data-tuning-select]", "std"));
  await waitFor("без каподастра", () => select("[data-capo-select]", "0"));
  await waitFor("стандарт в настройках", async () => {
    const c = (await invoke("guitar_state")).config;
    return c.tuning === null && c.capo === 0;
  });
  ok("экран «Гитара»: Drop C — тюнер слышит низкое до, каподастр сохраняется");

  console.log("Сквозной тест: Guitar Pro и текстовые табы");
  // Файлы Guitar Pro и текстовые табы в папке библиотеки (тестовые примеры alphaTab, MPL-2.0).
  const lib = join(docs, "MIDI Teacher");
  mkdirSync(lib, { recursive: true });
  writeFileSync(join(lib, "Хаммеры.gp5"), readFileSync(join(root, "src/lib/fixtures/gp/5-hammer.gp5")));
  writeFileSync(join(lib, "Бит.gp"), readFileSync(join(root, "src/lib/fixtures/gp/7-drum-tabs.gp")));
  writeFileSync(join(lib, "заметки.txt"), "просто заметки\nбез табов\n");
  const openFile = async (file, ready) => {
    await waitFor("главная", () => click("Главная"));
    await waitFor("вкладка пьес", () => click("Пьесы"));
    await waitFor(`карточка ${file}`, () => js("const c = document.querySelector('[data-file=\"' + arguments[0] + '\"]'); if (!c) return false; c.click(); return true;", [file]));
    await waitFor(`${file}: ноты`, () => js(ready), 30000);
  };
  await waitFor("главная", () => click("Главная"));
  await waitFor("вкладка пьес", () => click("Пьесы"));
  await waitFor("карточки Guitar Pro", () =>
    js("const c = (f) => document.querySelector('[data-file=\"' + f + '\"]')?.textContent ?? ''; return c('Хаммеры.gp5').includes('Guitar Pro') && c('Бит.gp').includes('Guitar Pro');"),
  );
  if (await js("return !!document.querySelector('[data-file=\"заметки.txt\"]');")) throw new Error("текст без таба попал в библиотеку");
  ok("библиотека: файлы Guitar Pro с пометкой, текст без таба не показывается");

  await openFile("Хаммеры.gp5", "return !!document.querySelector('.tab-score g.note');");
  await waitFor("режим «Свободно»", () => click("Свободно"));
  await waitFor("режим ожидания", () => click("Ожидание"));
  const sortedNow = async () => (await pitches()).split(",").filter(Boolean).map(Number).sort((a, b) => a - b).join(",");
  await waitFor("первый аккорд (си-ре-ля♯-до)", async () => (await sortedNow()) === "47,50,58,60", 15000);
  const gpSteps = await playWait("Guitar Pro", async (p) => {
    await invoke("simulate_midi", { device: "E2E", bytes: [0x90, p, 100] });
    await invoke("simulate_midi", { device: "E2E", bytes: [0x80, p, 0] });
  });
  if (!(await js("return document.querySelector('.score-page svg')?.textContent.includes('H');"))) throw new Error("нет подписей хаммеров");
  ok(`Guitar Pro: табы с хаммерами сыграны в ожидании — ${gpSteps} шагов, 0 ошибок`);

  await openFile("Бит.gp", "return !!document.querySelector('[data-drum-pads]') && !!document.querySelector('.score-page svg g.note');");
  await waitFor("режим ожидания", () => click("Ожидание"));
  await waitFor("первый шаг барабанов", async () => !!(await pitches()), 15000);
  const beatSteps = await playWait("барабаны из Guitar Pro", (p) => invoke("hit_drum", { drum: p, velocity: 100 }));
  ok(`барабаны из Guitar Pro: партия на экранных пэдах — ${beatSteps} шагов, 0 ошибок`);

  // Вставка текстового таба: текст → предпросмотр → сохранить → открыть и сыграть.
  await waitFor("главная", () => click("Главная"));
  await waitFor("вкладка пьес", () => click("Пьесы"));
  await waitFor("«Вставить таб…»", () => js("const b = document.querySelector('[data-tab-paste-open]'); if (!b) return false; b.click(); return true;"));
  const riff = "Бас-рифф · Темп: 100\n\nG|----------------|----------------|\nD|----------------|----------------|\nA|-----------0--2-|-3--2--0--------|\nE|-0--3--5--------|-----------3--0-|\n";
  await waitFor("поле таба", () => setValue("[data-tab-text]", riff));
  await setValue("[data-tab-name]", "Бас-рифф");
  await setValue("[data-tab-rhythm]", "8", "change");
  await waitFor("разбор таба", async () => (await js("return document.querySelector('[data-tab-summary]')?.dataset.tabSummary;")) === "4:2:10");
  await waitFor("предпросмотр", () => js("return !!document.querySelector('.tab-preview svg');"), 15000);
  await js("document.querySelector('[data-tab-save]').click();");
  await waitFor("таб в библиотеке", () => js("return !!document.querySelector('[data-file=\"Бас-рифф.txt\"]');"));
  const tabText = readFileSync(join(lib, "Бас-рифф.txt"), "utf8");
  if (!tabText.startsWith("Темп: 100 · Размер: 4/4 · Ритм: восьмыми")) throw new Error(`заголовок таба: ${tabText.split("\n")[0]}`);
  await openFile("Бас-рифф.txt", "return !!document.querySelector('.tab-score g.note') && !!document.querySelector('[data-fretboard]');");
  await waitFor("режим ожидания", () => click("Ожидание"));
  await waitFor("первая нота баса — ми (28)", async () => (await pitches()) === "28", 15000);
  const tabSteps = await playWait("текстовый таб", async (p) => {
    await invoke("simulate_midi", { device: "E2E", bytes: [0x90, p, 100] });
    await invoke("simulate_midi", { device: "E2E", bytes: [0x80, p, 0] });
  });
  if (tabSteps !== 10) throw new Error(`нот в табе: ${tabSteps}`);
  ok("текстовый таб: вставлен, сохранён в библиотеку (темп и ритм — в первой строке), сыгран на басу — 10 нот, 0 ошибок");
  await js("document.querySelector('.summary-overlay button')?.click();");
  await waitFor("назад к списку пьес", () => click("← Пьесы"));
  await waitFor("список пьес", () => js("return !!document.querySelector('.piece-card');"));

  console.log("Сквозной тест: гитарные упражнения и гриф");
  const clickSel = (sel) => js("const b = document.querySelector(arguments[0]); if (!b || b.disabled) return false; b.click(); return true;", [sel]);
  await waitFor("вкладка «Упражнения»", () => click("Упражнения"));
  await waitFor("переключатель «Гитара»", () => clickSel("[data-ex-instrument-btn='guitar']"));
  await waitFor("гитарные упражнения", () => js("return !!document.querySelector(\"[data-gtr-exercises='guitar'] [data-exercise='gtr-spider-1234-5-60']\");"));
  if (await js("return !document.querySelector(\"[data-category='pentatonic']\")?.classList.contains('locked');")) throw new Error("пентатоника открыта сразу");
  await waitFor("паучок 1-2-3-4", () => clickSel("[data-exercise='gtr-spider-1234-5-60']"));
  await waitFor("табы паучка", () => js("return document.querySelectorAll('.tab-score g.note').length === 48 && !!document.querySelector('[data-ex-hint]');"), 30000);
  if (!(await js("return document.querySelector('.score-page svg')?.textContent.includes('4');"))) throw new Error("нет пальцев над табами");
  // Ожидание: разобрать узор по нотам.
  await waitFor("режим ожидания", () => click("Ожидание"));
  await waitFor("первая нота — ля (45)", async () => (await pitches()) === "45", 15000);
  const spiderSteps = await playWait("паучок", press);
  if (spiderSteps !== 48) throw new Error(`нот в паучке: ${spiderSteps}`);
  // В темпе: бот играет по часам — засчитано.
  await js("document.querySelector('.summary-overlay button')?.click();");
  await waitFor("режим «в темпе»", () => click("В темпе"));
  await js("document.querySelector('.score-scroll')?.removeAttribute('data-transport');");
  await waitFor("старт", () => click("▶ Старт"));
  await playInTempo();
  await waitFor("итог паучка", () => js("return !!document.querySelector('.exercise-summary');"), 30000);
  if ((await scroll("exResult")) !== "passed") throw new Error(`паучок не засчитан:\n${await js("return document.querySelector('.exercise-summary').innerText;")}`);
  ok(`паучок 1-2-3-4: табы с пальцами, ${spiderSteps} нот в ожидании, в темпе — засчитан`);
  await waitFor("к упражнениям", () => click("К упражнениям"));
  await waitFor("пентатоника и грувы открылись", () =>
    js("return !document.querySelector(\"[data-category='pentatonic']\")?.classList.contains('locked') && !document.querySelector(\"[data-exercise='gtr-groove-rock-90']\")?.disabled;"),
  10000);
  // Отметка «сегодня», «▶ Все подряд», ★ каждый день, сворачивание раздела.
  if (!(await js("return document.querySelector(\"[data-exercise='gtr-spider-1234-5-60']\")?.dataset.today === '1';")))
    throw new Error("нет отметки «сыграно сегодня»");
  if (!(await js("return !!document.querySelector(\"[data-group-all='1-2-3-4']\");"))) throw new Error("нет «Все подряд» у паучка 1-2-3-4");
  await waitFor("★ каждый день", () => clickSel("[data-daily-toggle='gtr-spider-1324-5-60']"));
  await waitFor("★ сохранено в настройках", async () => ((await invoke("get_state")).prefs.daily ?? []).includes("gtr-spider-1324-5-60"));
  await waitFor("★ в «На сегодня»", () => js("return (document.querySelector('.warmup-list')?.innerText ?? '').includes('★ Паучок 1-3-2-4');"));
  await js("document.querySelector(\"[data-category-toggle='pentatonic']\").click();");
  await waitFor("раздел свёрнут", () => js("return document.querySelector(\"[data-category='pentatonic']\")?.dataset.folded === '1' && !document.querySelector(\"[data-category='pentatonic'] [data-exercise]\");"));
  await js("document.querySelector(\"[data-category-toggle='pentatonic']\").click();");
  ok("список упражнений: отметка «сегодня», «Все подряд», ★ каждый день в «На сегодня», раздел сворачивается");
  // Игра под барабаны: своя партия — гитара, барабаны звучат аккомпанементом.
  await waitFor("грув «Рок»", () => clickSel("[data-exercise='gtr-groove-rock-90']"));
  await waitFor("табы грува", () => js("return document.querySelectorAll('.tab-score g.note').length > 8;"), 30000);
  ok("после паучка открылись пентатоника и игра под барабаны");
  await waitFor("к упражнениям", () => click("← Упражнения"));
  await waitFor("переключатель «Фортепиано»", () => clickSel("[data-ex-instrument-btn='piano']"));

  // Тренажёр грифа: открытые струны, одна ошибка — всё равно зачёт (от 85%).
  await waitFor("вкладка тренажёров", () => click("Тренажёры"));
  await waitFor("раздел «Гриф»", () => clickSel("[data-trainer-section='fretboard']"));
  await waitFor("ступень 1", () => clickSel("[data-fret-level='1']"));
  const fretPitch = () => js("return document.querySelector('[data-fret-index]')?.dataset.fretPitch ?? '';");
  await waitFor("первое задание", fretPitch);
  await press(Number(await fretPitch()) + 1);
  await waitFor("ошибка отмечена", () => js("return !!document.querySelector('.fret-drill .flash-wrong');"), 3000).catch(() => {});
  for (let i = 0; i < 20; i++) {
    const p = await fretPitch();
    if (!p) break;
    const idx = await js("return document.querySelector('[data-fret-index]').dataset.fretIndex;");
    await press(Number(p));
    await waitFor(`гриф: задание ${idx}`, async () => (await js("return document.querySelector('[data-fret-index]').dataset.fretIndex;")) !== idx || !(await fretPitch()), 5000);
  }
  const fretDone = await waitFor("итог серии грифа", () => js("return document.querySelector('[data-fret-index]')?.dataset.fretDone;"), 10000);
  if (fretDone !== "passed") throw new Error(`гриф: ${await js("return document.querySelector('.fret-drill').innerText;")}`);
  await waitFor("зачёт ступени записан", async () => (await invoke("exercise_stats")).some((x) => x.exercise === "fret-guitar-1" && x.passed), 5000);
  ok("тренажёр грифа: открытые струны — серия из 12 заданий засчитана, ступень 2 открыта");
  await waitFor("к списку ступеней", () => click("К списку"));
  await waitFor("ступень 2 открыта", () => js("return !document.querySelector(\"[data-fret-level='2']\")?.disabled;"));

  await waitFor("главная", () => click("Главная"));
  await waitFor("шаг «Гитара» сделан", () =>
    js("return [...document.querySelectorAll('.today-step.done b')].some((b) => b.textContent === 'Гитара');"),
  10000);
  ok("главная: шаг «Гитара» в «Занятии на сегодня» отмечен сделанным");

  console.log("Сквозной тест: гитарные аккорды и бой");
  const chordOn = async (ps) => {
    for (const p of ps) await invoke("simulate_midi", { device: "E2E", bytes: [0x90, p, 100] });
    for (const p of ps) await invoke("simulate_midi", { device: "E2E", bytes: [0x80, p, 0] });
  };
  await waitFor("вкладка тренажёров", () => click("Тренажёры"));
  await waitFor("раздел «Аккорды»", () => clickSel("[data-trainer-section='chords']"));
  await waitFor("режим «Гитара»", () => clickSel("[data-chords-instrument='guitar']"));
  await waitFor("ступень 1 гитарных аккордов", () => clickSel("[data-gchord-level='1']"));
  const gExpected = () => js("return document.querySelector('[data-gchord-index]')?.dataset.gchordExpected ?? '';");
  const gIndex = () => js("return document.querySelector('[data-gchord-index]')?.dataset.gchordIndex ?? '';");
  await waitFor("первый аккорд и схема", async () => (await gExpected()) && (await js("return !!document.querySelector('.gchord-card [data-chord-diagram]');")));
  // Первый аккорд — звуком: удар по струнам проходит распознавание по спектру.
  const firstChord = (await gExpected()).split(",").map(Number);
  await invoke("guitar_test_chord", { pitches: firstChord, secs: 0.6 });
  await waitFor("аккорд по звуку засчитан", async () => (await gIndex()) === "1", 10000);
  // Второй — сначала с лишней нотой (на полтона выше верхней): подсказка «Лишнее».
  const second = (await gExpected()).split(",").map(Number);
  await chordOn([...second.slice(0, -1), second[second.length - 1] + 1]);
  await waitFor("подсказка о лишнем звуке", () => js("return (document.querySelector('[data-gchord-verdict]')?.innerText ?? '').includes('Лишнее');"), 5000);
  for (let i = 0; i < 15; i++) {
    const e = await gExpected();
    if (!e) break;
    const idx = await gIndex();
    await chordOn(e.split(",").map(Number));
    await waitFor(`аккорд ${idx}`, async () => (await gIndex()) !== idx, 5000);
  }
  const gChordsDone = await waitFor("итог серии аккордов", () => js("return document.querySelector('[data-gchord-index]')?.dataset.gchordDone;"), 10000);
  if (gChordsDone !== "passed") throw new Error(`гитарные аккорды: ${await js("return document.querySelector('.gchord-drill').innerText;")}`);
  await waitFor("зачёт ступени аккордов", async () => (await invoke("exercise_stats")).some((x) => x.exercise === "gchord-1" && x.passed), 5000);
  ok("тренажёр гитарных аккордов: аккорд по звуку (спектр) засчитан, лишний звук подсказан, серия засчитана");
  await waitFor("к списку", () => click("К списку"));

  // Минута смен: разминка переключает аккорды, в минуте считаются смены.
  await waitFor("пара Am ↔ C", () => clickSel("[data-change-pair='gchange-Am-C']"));
  const chExpected = () => js("return document.querySelector('[data-changes-phase]')?.dataset.changesExpected ?? '';");
  const chAttr = (a) => js(`return document.querySelector('[data-changes-phase]')?.dataset.${a} ?? '';`);
  await waitFor("схема Am", chExpected);
  await chordOn((await chExpected()).split(",").map(Number));
  await waitFor("переключение на C", async () => (await chAttr("changesSide")) === "1", 3000);
  await js("document.querySelector('[data-changes-start]').click();");
  await waitFor("минута пошла", async () => (await chAttr("changesPhase")) === "run", 6000);
  for (let k = 0; k < 4; k++) {
    const side = await chAttr("changesSide");
    await chordOn((await chExpected()).split(",").map(Number));
    await waitFor(`смена ${k + 1}`, async () => (await chAttr("changesSide")) !== side, 3000);
  }
  if ((await chAttr("changesCount")) !== "4") throw new Error(`смен: ${await chAttr("changesCount")}`);
  await js("document.querySelector('[data-changes-stop]').click();");
  ok("минута смен: Am ↔ C, 4 чистые смены посчитаны");
  await waitFor("к аккордам", () => click("← Аккорды"));

  // Песня боем: схемы аккордов над табами со стрелками.
  await waitFor("песня боем", () => clickSel("[data-song-strum-play]"));
  await waitFor("табы песни, схемы и бой", () =>
    js("return !!document.querySelector('.tab-score g.note') && document.querySelectorAll('[data-song-banner] [data-chord-diagram]').length >= 2 && document.querySelector('.score-page svg').textContent.includes('↓');"),
  30000);
  ok("песня по буквам боем: табы с аккордами и стрелками ↓↑, схемы аккордов над нотами");
  await waitFor("к аккордам", () => click("← Аккорды"));
  await waitFor("режим «Фортепиано»", () => clickSel("[data-chords-instrument='piano']"));

  // Бой в упражнениях: четверти по Em–Am — в ожидании и в темпе.
  await waitFor("вкладка «Упражнения»", () => click("Упражнения"));
  await waitFor("переключатель «Гитара»", () => clickSel("[data-ex-instrument-btn='guitar']"));
  await waitFor("бой «Четверти вниз»", () => clickSel("[data-exercise='gtr-strum-quarters-emam-70']"));
  await waitFor("табы боя", () => js("return document.querySelectorAll('.tab-score g.note').length > 40;"), 30000);
  await waitFor("режим ожидания", () => click("Ожидание"));
  await waitFor("первый удар — ми минор", async () => (await pitches()).split(",").length === 6, 15000);
  const strumSteps = await playWait("бой", press);
  if (strumSteps !== 32) throw new Error(`ударов: ${strumSteps}`);
  await js("document.querySelector('.summary-overlay button')?.click();");
  await waitFor("режим «в темпе»", () => click("В темпе"));
  await js("document.querySelector('.score-scroll')?.removeAttribute('data-transport');");
  await waitFor("старт", () => click("▶ Старт"));
  await playInTempo();
  await waitFor("итог боя", () => js("return !!document.querySelector('.exercise-summary');"), 40000);
  if ((await scroll("exResult")) !== "passed") throw new Error(`бой не засчитан:\n${await js("return document.querySelector('.exercise-summary').innerText;")}`);
  ok(`бой «Четверти вниз» Em–Am: ${strumSteps} ударов в ожидании, в темпе — засчитан`);
  await waitFor("к упражнениям", () => click("К упражнениям"));
  await waitFor("переключатель «Фортепиано»", () => clickSel("[data-ex-instrument-btn='piano']"));

  console.log("Сквозной тест: слух");
  const ear = (a) => js(`return document.querySelector('[data-ear-index]')?.dataset.${a} ?? '';`);
  await waitFor("вкладка тренажёров", () => click("Тренажёры"));
  await waitFor("раздел «Слух»", () => clickSel("[data-trainer-section='ear']"));
  await waitFor("интервалы, ступень 1", () => clickSel("[data-ear-level='interval-1']"));
  await waitFor("первый вопрос", () => ear("earCorrect"));
  // Первый вопрос — сначала неверная кнопка: ответ засчитывается, но не с первой попытки.
  await js("const c = document.querySelector('[data-ear-index]').dataset.earCorrect; [...document.querySelectorAll('[data-ear-option]')].find((b) => b.dataset.earOption !== c).click();");
  for (let i = 0; i < 12; i++) {
    if (await ear("earDone")) break;
    const idx = await ear("earIndex");
    // Чередуем: кнопка и ответ игрой (вторая нота интервала).
    if (i % 2) await press(Number((await ear("earExpected")).split(",")[0]));
    else await clickSel(`[data-ear-option='${await ear("earCorrect")}']`);
    await waitFor(`интервал ${idx}`, async () => (await ear("earIndex")) !== idx, 5000);
  }
  const intervalDone = await waitFor("итог серии интервалов", () => ear("earDone"), 5000);
  if (intervalDone !== "passed") throw new Error(`интервалы: ${await js("return document.querySelector('.ear-drill').innerText;")}`);
  await waitFor("зачёт записан", async () => (await invoke("exercise_stats")).some((x) => x.exercise === "ear-interval-1" && x.passed), 5000);
  ok("слух: интервалы — 9 из 10 с первой попытки (кнопками и игрой), серия засчитана");
  await waitFor("к списку", () => click("К списку"));
  await waitFor("ступень 2 интервалов открыта", () => js("return !document.querySelector(\"[data-ear-level='interval-2']\")?.disabled;"));

  // Мелодический диктант: ошибка в первой ноте, затем мелодии целиком.
  await waitFor("диктант 1", () => clickSel("[data-ear-level='melody-1']"));
  await waitFor("мелодия", () => ear("earExpected"));
  await press(Number((await ear("earExpected")).split(",")[0]) + 1);
  await waitFor("ошибка отмечена", () => js("return !!document.querySelector('.dictation-slot.bad');"), 3000);
  for (let i = 0; i < 6; i++) {
    if (await ear("earDone")) break;
    const idx = await ear("earIndex");
    for (const p of (await ear("earExpected")).split(",").map(Number)) await press(p);
    await waitFor(`мелодия ${idx}`, async () => (await ear("earIndex")) !== idx, 5000);
  }
  if ((await waitFor("итог диктанта", () => ear("earDone"), 5000)) !== "passed") throw new Error("мелодический диктант не засчитан");
  ok("слух: мелодический диктант — ошибка показана, 4 из 5 с первой попытки, засчитан");
  await waitFor("к списку", () => click("К списку"));

  // Ритмический диктант: удары в нужные моменты — отсчёт и такты идут в самом окне.
  await waitFor("ритм 1", () => clickSel("[data-ear-level='rhythm-1']"));
  await waitFor("кнопка «Твоя очередь»", () => clickSel("[data-ear-start]"));
  await waitFor("фаза ударов", async () => (await ear("earPhase")) === "tap", 8000);
  const onsets = (await ear("earRhythm")).split(",").map(Number);
  await jsAsync(
    "const [on, done] = arguments; const t0 = performance.now(); const hit = (p) => window.__TAURI_INTERNALS__.invoke('simulate_midi', { device: 'E2E', bytes: [0x90, 60, 100] }).then(() => window.__TAURI_INTERNALS__.invoke('simulate_midi', { device: 'E2E', bytes: [0x80, 60, 0] }));" +
      "(async () => { for (const t of on) { while (performance.now() - t0 < t + 150) await new Promise((r) => setTimeout(r, 2)); hit(); } done(true); })();",
    [onsets],
  );
  await sleep(300);
  await clickSel("[data-ear-finish]");
  const rhythmVerdict = await waitFor("вердикт ритма", () => js("return document.querySelector('[data-ear-verdict]')?.dataset.earVerdict ?? '';"), 5000);
  if (rhythmVerdict !== "ok") throw new Error(`ритм: ${await js("return document.querySelector('.ear-drill').innerText;")}`);
  await waitFor("запись ритма нотами", () => js("return !!document.querySelector('.ear-drill .chord-staff svg');"), 10000);
  ok(`слух: ритмический диктант — ${onsets.length} ударов простучаны вовремя, показана запись нотами`);
  await waitFor("к разделу «Слух»", () => click("← Слух"));
  await waitFor("список ступеней слуха", () => js("return !!document.querySelector(\"[data-ear-level='interval-1']\");"));

  await waitFor("главная", () => click("Главная"));
  await waitFor("шаг «Слух» сделан", () =>
    js("return [...document.querySelectorAll('.today-step.done b')].some((b) => b.textContent === 'Слух');"),
  10000);
  ok("главная: шаг «Слух» отмечен сделанным");

  console.log("Сквозной тест: бас");
  await waitFor("вкладка тренажёров", () => click("Тренажёры"));
  await waitFor("раздел «Аккорды»", () => clickSel("[data-trainer-section='chords']"));
  await waitFor("режим «Бас»", () => clickSel("[data-chords-instrument='bass']"));
  await waitFor("ступень 1 «Найди основной тон»", () => clickSel("[data-root-level='1']"));
  await waitFor("старт серии", () => clickSel("[data-root-start]"));
  const rootAttr = (a) => js(`return document.querySelector('[data-root-phase]')?.dataset.${a} ?? '';`);
  await waitFor("часы серии", () => rootAttr("rootT0"), 5000);
  // Бот играет в самой странице по её часам: в момент каждой доли из плана — нужная нота (одна — мимо).
  await js(
    "const el = document.querySelector('[data-root-phase]'); const t0 = Number(el.dataset.rootT0), bm = Number(el.dataset.rootBeatMs);" +
      "const plan = el.dataset.rootPlan.split(',').map((x) => x.split(':').map(Number));" +
      "const inv = (b) => window.__TAURI_INTERNALS__.invoke('simulate_midi', { device: 'E2E', bytes: b });" +
      "(async () => { let i = 0; for (const [beat, pitch] of plan) { while (performance.now() < t0 + beat * bm + 30) await new Promise((r) => setTimeout(r, 3));" +
      "const p = i === 1 ? pitch + 2 : pitch; await inv([0x90, p, 100]); inv([0x80, p, 0]); i++; } })();",
  );
  const rootDone = await waitFor("итог серии баса", () => rootAttr("rootDone"), 45000);
  const noPlayError = async (what) => {
    const err = await js("return document.querySelector('[data-play-error]')?.innerText ?? '';");
    if (err) throw new Error(`${what}: ${err}`);
  };
  await noPlayError("аккомпанемент «Найди основной тон»");
  const rootOkCount = await rootAttr("rootOk");
  if (rootDone !== "passed" || rootOkCount !== "5") throw new Error(`основной тон: ${rootDone}, верно ${rootOkCount}`);
  await waitFor("зачёт записан", async () => (await invoke("exercise_stats")).some((x) => x.exercise === "bassroot-1" && x.passed), 5000);
  ok("бас: «Найди основной тон» — под барабаны и аккорды 5 из 6 основных тонов вовремя, серия засчитана");
  await waitFor("к списку", () => click("К списку"));

  // Песня по буквам басом (walking bass) в темпе: итог с оценкой грува.
  await waitFor("стиль «Walking bass»", () =>
    js("const s = document.querySelector(\"[data-song='builtin-ode'] [data-song-bass-style]\"); if (!s) return false; s.value = 'walking'; s.dispatchEvent(new Event('change', { bubbles: true })); return true;"),
  );
  await waitFor("▶ Басом", () => clickSel("[data-song='builtin-ode'] [data-song-bass-play]"));
  await waitFor("табы баса с буквами аккордов", () => js("return !!document.querySelector('.tab-score g.note') && document.querySelector('.score-page svg').textContent.includes('C');"), 30000);
  await waitFor("режим «в темпе»", () => click("В темпе"));
  await js("document.querySelector('.score-scroll')?.removeAttribute('data-transport');");
  await waitFor("старт", () => click("▶ Старт"));
  await playInTempo();
  await waitFor("итог песни басом", () => js("return !!document.querySelector('.exercise-summary');"), 40000);
  if ((await scroll("exResult")) !== "passed") throw new Error(`бас не засчитан:\n${await js("return document.querySelector('.exercise-summary').innerText;")}`);
  const grooveMean = await waitFor("оценка грува", () => js("return document.querySelector('[data-groove-mean]')?.dataset.grooveMean ?? '';"), 5000);
  if (Math.abs(Number(grooveMean)) > 40) throw new Error(`грув: ${grooveMean} мс`);
  if (!(await js("return document.querySelectorAll('.groove-col').length >= 4;"))) throw new Error("нет полосок грува по долям");
  ok(`бас: «Ода к радости» walking bass в темпе — засчитано, грув ${grooveMean} мс от барабанов, полоски по долям`);
  await waitFor("к списку песен", () => click("К списку"));
  await waitFor("режим «Фортепиано»", () => clickSel("[data-chords-instrument='piano']"));

  console.log("Сквозной тест: джем");
  await waitFor("вкладка тренажёров", () => click("Тренажёры"));
  await waitFor("раздел «Джем»", () => clickSel("[data-trainer-section='jam']"));
  await waitFor("инструмент «Гитара»", () => clickSel("[data-jam-instrument='guitar']"));
  // Урок 1: только ноты минорной пентатоники — бот играет фразами восьмыми по часам страницы.
  await waitFor("урок 1", () => clickSel("[data-jam-lesson='1']"));
  await waitFor("старт урока", () => clickSel("[data-jam-start]"));
  const jamAttr = (a) => js(`return document.querySelector('[data-jam-phase]')?.dataset.${a} ?? '';`);
  await waitFor("часы джема", () => jamAttr("jamT0"), 5000);
  const botScale = (limit) =>
    js(
      "const [limit] = arguments; const el = document.querySelector('[data-jam-phase]'); const t0 = Number(el.dataset.jamT0), bm = Number(el.dataset.jamBeatMs), total = Number(el.dataset.jamTotalMs);" +
        "const sc = el.dataset.jamScale.split(',').map(Number); const inv = (b) => window.__TAURI_INTERNALS__.invoke('simulate_midi', { device: 'E2E', bytes: b });" +
        "(async () => { let i = 0; for (let t = 0; t < total - bm && i < limit; t += bm / 2, i++) { if (i % 8 === 7) continue;" +
        "while (performance.now() < t0 + t) await new Promise((r) => setTimeout(r, 4)); const p = 57 + (((sc[i % sc.length] - 57) % 12) + 12) % 12;" +
        "await inv([0x90, p, 100]); setTimeout(() => inv([0x80, p, 0]), bm / 3); } })();",
      [limit],
    );
  await botScale(1000);
  await sleep(500);
  await noPlayError("аккомпанемент джема");
  const lessonResult = await waitFor("итог урока", () => js("return document.querySelector('[data-jam-review]')?.dataset.jamResult ?? '';"), 60000);
  if (lessonResult !== "passed") throw new Error(`урок 1: ${await js("return document.querySelector('[data-jam-review]').innerText;")}`);
  await waitFor("зачёт урока", async () => (await invoke("exercise_stats")).some((x) => x.exercise === "jam-guitar-1" && x.passed), 5000);
  ok(`джем: урок «Только ноты гаммы» на гитаре — ${await js("return document.querySelector('[data-jam-detail]').innerText;")} Засчитан`);
  await waitFor("к списку", () => click("К списку"));

  // Свободный джем на фортепиано: игра → «Стоп и разбор» → ноты соло → сохранение в библиотеку.
  await waitFor("инструмент «Фортепиано»", () => clickSel("[data-jam-instrument='piano']"));
  await waitFor("▶ Джемовать", () => clickSel("[data-jam-free]"));
  await waitFor("старт джема", () => clickSel("[data-jam-start]"));
  await waitFor("часы джема", () => jamAttr("jamT0"), 5000);
  await botScale(14);
  await sleep(3500 + 14 * 400);
  await waitFor("стоп и разбор", () => clickSel("[data-jam-stop]"));
  const jamNotes = await waitFor("итог джема", () => js("return document.querySelector('[data-jam-review]')?.dataset.jamNotes ?? '';"), 5000);
  if (Number(jamNotes) < 10) throw new Error(`нот в джеме: ${jamNotes}`);
  await waitFor("прослушать", () => clickSel("[data-jam-listen]"));
  await sleep(500);
  await noPlayError("прослушивание джема");
  await waitFor("стоп прослушивания", () => clickSel("[data-jam-listen]"));
  await waitFor("ноты соло", () => clickSel("[data-jam-show-notes]"));
  await waitFor("соло нотами", () => js("return document.querySelectorAll('[data-jam-solo] g.note').length >= 10;"), 20000);
  await waitFor("сохранить", () => clickSel("[data-jam-save]"));
  const jamFile = await waitFor("джем сохранён", () => js("return document.querySelector('[data-jam-saved]')?.dataset.jamSaved ?? '';"), 5000);
  if (!(await invoke("library_list")).items.some((x) => x.id === jamFile && x.format === "midi")) throw new Error(`нет файла джема ${jamFile}`);
  ok(`джем: свободный блюз на фортепиано — ${jamNotes} нот, соло нотами, сохранён в библиотеку («${jamFile}»)`);
  await waitFor("к списку", () => click("К списку"));

  // «Повтори за мной»: бот повторяет каждую фразу в такте ответа.
  await waitFor("повтори за мной, ступень 1", () => clickSel("[data-echo-level='1']"));
  await waitFor("старт серии", () => clickSel("[data-echo-start]"));
  const echoAttr = (a) => js(`return document.querySelector('[data-echo-phase]')?.dataset.${a} ?? '';`);
  await waitFor("часы серии", () => echoAttr("echoT0"), 5000);
  await js(
    "const el = document.querySelector('[data-echo-phase]'); const t0 = Number(el.dataset.echoT0), bm = Number(el.dataset.echoBeatMs);" +
      "const plan = el.dataset.echoPlan.split(',').map((x) => x.split(':').map(Number)); const inv = (b) => window.__TAURI_INTERNALS__.invoke('simulate_midi', { device: 'E2E', bytes: b });" +
      "(async () => { for (const [beat, pitch] of plan) { while (performance.now() < t0 + beat * bm + 20) await new Promise((r) => setTimeout(r, 4)); await inv([0x90, pitch, 100]); setTimeout(() => inv([0x80, pitch, 0]), bm / 3); } })();",
  );
  await sleep(500);
  await noPlayError("«Повтори за мной»");
  const echoDone = await waitFor("итог серии", () => echoAttr("echoDone"), 90000);
  const echoOk = await echoAttr("echoOk");
  if (echoDone !== "passed") throw new Error(`повтори за мной: ${echoDone}, верно ${echoOk}`);
  ok(`джем: «Повтори за мной» — ${echoOk} из 8 фраз повторены, серия засчитана`);
  await waitFor("к списку", () => click("К списку"));

  console.log("Сквозной тест: курс");
  await waitFor("вкладка «Курс»", () => click("Курс"));
  await waitFor("курс фортепиано", () => clickSel("[data-course-instrument-btn='piano']"));
  await waitFor("продолжить курс", () => clickSel("[data-course-continue]"));
  const lessonOpen = () => js("return document.querySelector('[data-course-lesson-open]')?.dataset.courseLessonOpen ?? '';");
  const openId = await waitFor("урок открыт", lessonOpen);
  if (openId !== "piano-1") throw new Error(`текущий урок: ${openId}, ожидался piano-1`);
  const stepDoneAt = (i) => js(`return document.querySelector('[data-course-step="${i}"]')?.dataset.stepDone ?? '';`);
  // Ступень 1 тренажёра нот пройдена в начале теста — шаг засчитан сам.
  const notesIdx = await js("return [...document.querySelectorAll('[data-course-step]')].findIndex((e) => e.dataset.stepKind === 'notes');");
  if ((await stepDoneAt(notesIdx)) !== "1") throw new Error("шаг «Тренажёр нот: ступень 1» не засчитан");
  // Теория: «Понятно» засчитывает шаг.
  await waitFor("шаг теории", () => clickSel("[data-course-run='0']"));
  await waitFor("«Понятно»", () => clickSel("[data-course-theory-ok]"));
  await waitFor("шаг теории засчитан", async () => (await stepDoneAt(0)) === "1", 5000);
  ok("курс: урок 1 открыт сам, ступень тренажёра засчитана, теория — «Понятно»");
  // Пьеса правой рукой в режиме ожидания: бот играет без ошибок → шаг засчитан.
  const pieceIdx = await js("return [...document.querySelectorAll('[data-course-step]')].findIndex((e) => e.dataset.stepKind === 'piece');");
  await waitFor("шаг пьесы", () => clickSel(`[data-course-run='${pieceIdx}']`));
  await waitFor("ноты пьесы", () => js("return !!document.querySelector('.score-page svg g.note');"), 30000);
  await waitFor("первый шаг пьесы", pitches);
  for (let i = 0; i < 300 && !(await finished()); i++) {
    const step = await stepNo();
    const cur = await pitches();
    if (!cur) {
      await sleep(100);
      continue;
    }
    for (const p of cur.split(",")) await press(Number(p));
    await waitFor(`переход с шага ${step}`, async () => (await finished()) || (await stepNo()) !== step, 5000);
  }
  await waitFor("пьеса курса засчитана", async () => (await invoke("exercise_stats")).some((x) => x.exercise === "course-piece-twinkle" && x.passed), 10000);
  await waitFor("назад в урок", () => click("← Курс"));
  await waitFor("шаг пьесы засчитан", async () => (await stepDoneAt(pieceIdx)) === "1", 5000);
  ok("курс: «Ах, скажу я вам, мама» правой рукой сыграна ботом — шаг засчитан");
  // Главная: шаг «Урок курса» засчитан (сегодня сыграно не меньше трёх шагов) и ведёт в урок.
  await waitFor("главная", () => click("Главная"));
  const courseStep = () =>
    js("const b = [...document.querySelectorAll('.today-step')].find((b) => b.textContent.includes('Урок курса')); return b ? (b.classList.contains('done') ? 'done:' : 'open:') + b.innerText : '';");
  const cs = await waitFor("шаг «Урок курса»", async () => {
    const t = await courseStep();
    return t.startsWith("done:") ? t : "";
  }, 10000);
  await js("[...document.querySelectorAll('.today-step')].find((b) => b.textContent.includes('Урок курса')).click();");
  if ((await waitFor("урок с главной", lessonOpen)) !== "piano-1") throw new Error("шаг «Урок курса» открыл не тот урок");
  ok(`главная: ${cs.slice(5).replace(/\s+/g, " ")} — засчитан, открывает урок`);
  await waitFor("к курсу", () => click("← Курс"));

  console.log("Сквозной тест: новая музыка");
  await waitFor("вкладка пьес", () => click("Пьесы"));
  await waitFor("карточка «К Элизе»", () =>
    js("const b = [...document.querySelectorAll('.piece-card')].find((b) => b.textContent.includes('К Элизе')); if (!b) return false; b.click(); return true;"),
  );
  await waitFor("ноты «К Элизе»", () => js("return document.querySelectorAll('.score-page svg g.note').length > 40;"), 30000);
  ok("«К Элизе» открывается: ноты на стане");
  await waitFor("к пьесам", () => click("← Пьесы"));

  // Песня на барабанах: бот играет на пэдах (назначенные — пэдами, томы и тарелка — экранными пэдами).
  const DRUM_ID = { 48: "tom", 43: "floorTom", 49: "crash", 51: "ride" };
  const songHit = async (p) => {
    if (padOf[p]) return padHit(padOf[p]);
    await js(
      `const b = document.querySelector("[data-drum-pads] [data-drum='${DRUM_ID[p]}']"); b.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); b.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));`,
    );
    await sleep(60);
  };
  await waitFor("вкладка барабанов", () => click("Барабаны"));
  await waitFor("песня «Ода к радости · простой бит»", () => clickSel("[data-drum-song='drum-song-ode']"));
  await waitFor("ударный стан песни", () => js("return !!document.querySelector('.score-page svg g.note') && !!document.querySelector('[data-drum-pads]');"), 30000);
  await waitFor("режим ожидания", () => click("Ожидание"));
  await waitFor("первый шаг песни", pitches, 10000);
  const songSteps = await playWait("песня на барабанах", songHit);
  ok(`барабаны к песне: «Ода к радости» сыграна на пэдах — ${songSteps} шагов, сбивки по томам и тарелка, 0 ошибок`);
  await waitFor("к барабанам", () => click("← Барабаны"));

  console.log("Сквозной тест: дневник");
  const setField = (sel, value) =>
    js(
      "const [sel, value] = arguments; const el = document.querySelector(sel); if (!el) return false;" +
        "const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;" +
        "Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value); el.dispatchEvent(new Event('input', { bubbles: true }));" +
        "el.dispatchEvent(new FocusEvent('focusout', { bubbles: true })); return true;",
      [sel, value],
    );
  await waitFor("вкладка «Дневник»", () => click("Дневник"));
  const historyDays = await waitFor("история занятий", () => js("return Number(document.querySelector('[data-journal-history]')?.dataset.journalHistory ?? 0);"), 15000);
  // Недельный файл дневника в папке: формат, пьесы и упражнения сегодняшнего теста.
  const journalDir = join(docs, "MIDI Teacher", "Дневник");
  const weekFile = await waitFor("файл недели", () => existsSync(journalDir) && readdirSync(journalDir).find((f) => /^\d{4}-W\d{2}\.yaml$/.test(f)), 10000);
  const weekText = readFileSync(join(journalDir, weekFile), "utf8");
  if (!weekText.includes("format: midi-teacher/journal@1") || !weekText.includes("Ода к радости") || !weekText.includes("course-piece-twinkle"))
    throw new Error(`дневник недели:\n${weekText.slice(0, 600)}`);
  ok(`дневник: ${historyDays} дн. в истории, файл ${weekFile} в папке (пьесы, упражнения, точность)`);
  // Цель и запрос для Claude.
  await setField("[data-goal-text]", "Сыграть «К Элизе» к Новому году");
  await waitFor("цель сохранена", () => existsSync(join(journalDir, "цель.yaml")) && readFileSync(join(journalDir, "цель.yaml"), "utf8").includes("К Элизе"), 5000);
  const prompt = await js("return document.querySelector('[data-claude-prompt]')?.value ?? '';");
  if (!prompt.includes("midi-teacher/plan@1") || !prompt.includes("К Элизе» к Новому году") || !prompt.includes("piece: fur-elise")) throw new Error("запрос для Claude неполный");
  ok(`запрос для Claude: цель, формат плана, каталог и дневник (${Math.round(prompt.length / 1000)} тыс. знаков)`);
  // План из YAML: ошибка показывается, верный план загружается и виден на сегодня.
  const now = new Date();
  const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  await waitFor("вставить план", () => clickSel("[data-plan-paste]"));
  await setField("[data-plan-text]", "lessons:\n  - id: a\n    steps:\n      - exercise: nope\n");
  await waitFor("проверить", () => clickSel("[data-plan-load]"));
  await waitFor("ошибка в плане", () => js("return (document.querySelector('[data-plan-import-errors]')?.innerText ?? '').includes('нет такого задания');"), 5000);
  const planYaml = [
    "format: midi-teacher/plan@1",
    "title: Тест дневника",
    "instrument: piano",
    "lessons:",
    "  - id: t1",
    "    title: Урок из файла",
    "    steps:",
    "      - theory: durations",
    "      - exercise: major-C-rh",
    "        target: { tempo: 0.8 }",
    "plan:",
    `  - date: ${todayStr}`,
    "    lesson: t1",
  ].join("\n");
  await setField("[data-plan-text]", planYaml);
  await waitFor("загрузить", () => clickSel("[data-plan-load]"));
  await waitFor("план на сегодня", () => js("return document.querySelectorAll('[data-plan-today] [data-course-step]').length === 2;"), 5000);
  if (!existsSync(join(journalDir, "план.yaml"))) throw new Error("план.yaml не сохранён");
  await waitFor("шаг теории из плана", () => clickSel("[data-plan-today] [data-course-run='0']"));
  await waitFor("«Понятно»", () => clickSel("[data-course-theory-ok]"));
  await waitFor("шаг плана сделан сегодня", () => js("return document.querySelector('[data-plan-today] [data-course-step=\"0\"]')?.dataset.stepDone === '1';"), 5000);
  ok("план из YAML: ошибки с местом, верный план загружен, шаг дня сделан");
  await waitFor("главная", () => click("Главная"));
  const planStep = await waitFor("шаг «По плану»", () =>
    js("const b = [...document.querySelectorAll('.today-step')].find((b) => b.textContent.includes('По плану')); return b ? b.innerText.replace(/\\s+/g, ' ') : '';"),
    10000,
  );
  if (!planStep.includes("сделано 1 из 2")) throw new Error(`шаг «По плану»: ${planStep}`);
  ok(`главная: ${planStep}`);

  console.log("Сквозной тест: код (Strudel)");
  await waitFor("вкладка «Код»", () => click("Код"));
  await waitFor("редактор Strudel", () => js("return !!document.querySelector('[data-code-cm] .cm-editor');"), 40000);
  const codeDir = join(docs, "MIDI Teacher", "Код");
  await waitFor("первый трек в папке «Код»", () => existsSync(codeDir) && readdirSync(codeDir).some((f) => f.endsWith(".js")), 10000);
  ok(`вкладка открылась, трек в папке «Код»: ${readdirSync(codeDir).filter((f) => f.endsWith(".js")).join(", ")}`);
  // Код выполняется в настоящем WebView (CSP разрешает eval Strudel): партии появляются в панели.
  await waitFor("кнопка «Играть»", () => js("const b = document.querySelector('[data-code-play]'); if (!b || b.disabled) return false; b.click(); return true;"));
  const codeParts = await waitFor(
    "партии после запуска",
    () => js("const o = [...document.querySelectorAll('[data-code-mypart] option')].map((x) => x.value).filter(Boolean); return o.length ? o.join(',') : (document.querySelector('[data-code-error]')?.textContent ?? false);"),
    20000,
  );
  if (codeParts !== "drums,bass,melody") throw new Error(`партии: ${codeParts}`);
  const rollBoxes = await waitFor("нотная лента рисует", () => js("return Number(document.querySelector('[data-code-roll]')?.dataset.boxes ?? 0);"), 10000);
  await js("document.querySelector('[data-code-stop]')?.click();");
  ok(`код выполняется, партии: ${codeParts}; нотная лента: ${rollBoxes} событий`);
  // Автодополнение: набор в редакторе показывает звуки GM и справку по-русски.
  const cmEl = Object.values(await wd("POST", `/session/${sid}/element`, { using: "css selector", value: "[data-code-cm] .cm-content" }))[0];
  const cmText = () => js("return document.querySelector('[data-code-cm] .cm-content').textContent;");
  const codeBefore = await cmText();
  await js("const v = document.querySelector('[data-code-cm] .cm-content'); v.focus(); const r = document.createRange(); r.selectNodeContents(v); r.collapse(false); const s = getSelection(); s.removeAllRanges(); s.addRange(r);");
  await wd("POST", `/session/${sid}/element/${cmEl}/value`, { text: '\n$: s("gm_acou' });
  const soundHints = await waitFor("подсказки звуков", () => js("return [...document.querySelectorAll('.cm-tooltip-autocomplete li')].map((l) => l.textContent).join('|');"), 8000);
  if (!soundHints.includes("gm_acoustic_bass")) throw new Error(`подсказки звуков: ${soundHints}`);
  await wd("POST", `/session/${sid}/element/${cmEl}/value`, { text: '\uE00C' });
  await wd("POST", `/session/${sid}/element/${cmEl}/value`, { text: 'stic_bass").roo' });
  const fnInfo = await waitFor("справка функции", () => js("return document.querySelector('.cm-completionInfo')?.textContent ?? '';"), 8000);
  if (!/ревербер/i.test(fnInfo)) throw new Error(`справка room: ${fnInfo}`);
  // Откат набранного (Ctrl+Z), чтобы трек остался прежним для следующих шагов.
  await wd("POST", `/session/${sid}/element/${cmEl}/value`, { text: "\uE00C" });
  await waitFor("код восстановлен", async () => {
    if ((await cmText()) === codeBefore) return true;
    await wd("POST", `/session/${sid}/element/${cmEl}/value`, { text: "\uE009z\uE009" });
    return false;
  }, 15000);
  ok("автодополнение: звуки gm_… в s(\"…\"), справка room() по-русски");
  // Сэмплы (как при перетаскивании): копия в «Сэмплы\e2edrop», звук доступен по протоколу.
  const dropDir = join(profile, "drop");
  mkdirSync(dropDir, { recursive: true });
  const tone = Buffer.alloc(44 + 8820);
  tone.write("RIFF", 0, "ascii"); tone.writeUInt32LE(36 + 8820, 4); tone.write("WAVEfmt ", 8, "ascii");
  tone.writeUInt32LE(16, 16); tone.writeUInt16LE(1, 20); tone.writeUInt16LE(1, 22); tone.writeUInt32LE(44100, 24);
  tone.writeUInt32LE(88200, 28); tone.writeUInt16LE(2, 32); tone.writeUInt16LE(16, 34); tone.write("data", 36, "ascii"); tone.writeUInt32LE(8820, 40);
  for (let i = 0; i < 4410; i++) tone.writeInt16LE(Math.round(8000 * Math.sin(i / 10)), 44 + i * 2);
  writeFileSync(join(dropDir, "kick.wav"), tone);
  const dropped = await invoke("code_import_samples", { paths: [dropDir], folder: "e2edrop" });
  const banksAfter = await invoke("code_sample_banks");
  if (dropped !== "e2edrop" || !banksAfter.user.e2edrop?.length) throw new Error(`сэмплы: ${dropped} ${JSON.stringify(banksAfter.user)}`);
  // Протокол mtsound: свои файлы и (если SoundFont скачан) ноты GM.
  const proto = (path) =>
    jsAsync(
      "const [p, done] = arguments; const u = (navigator.userAgent.includes('Windows') ? 'http://mtsound.localhost/' : 'mtsound://localhost/') + encodeURIComponent(p);" +
        "fetch(u).then(async (r) => done({ status: r.status, len: (await r.arrayBuffer()).byteLength })).catch((e) => done({ e: String(e) }));",
      [path],
    );
  const kick = await proto("drum/36.wav");
  const noFile = await proto("user/../x.wav");
  if (noFile.status !== 404) throw new Error(`путь с «..» не отвергнут: ${JSON.stringify(noFile)}`);
  ok(`протокол mtsound: бочка ${kick.status === 200 ? `${kick.len} байт` : `нет SoundFont (${kick.status})`}, выход из папки отвергнут`);
  const userKick = await proto(`user/${banksAfter.user.e2edrop[0]}`);
  if (userKick.status !== 200 || userKick.len !== tone.length) throw new Error(`свой сэмпл: ${JSON.stringify(userKick)}`);
  ok(`папка сэмплов → s("e2edrop:0"), файл отдаётся протоколом (${userKick.len} байт)`);
  // Код → трек Студии (без звука: выполнение и разбор событий).
  await js("document.querySelector('[data-code-tonotes]').click();");
  await waitFor("окно «Код → ноты»", () => js("return document.querySelectorAll('[data-code-notes-part] option').length > 1;"));
  await js("const s = document.querySelector('[data-code-notes-part]'); s.value = 'bass'; s.dispatchEvent(new Event('change', { bubbles: true }));");
  await js("document.querySelector('[data-code-notes-studio]').click();");
  await waitFor("трек в Студии", async () => (await invoke("studio_list")).some((x) => x.name.includes("bass")), 10000);
  ok("партия bass → трек Студии");
  // WAV: офлайн-рендер, файл в «Треки».
  // Первый трек — бочка, пила и треугольник: синтезаторы звучат и без SoundFont.
  await js("document.querySelector('[data-code-wav]').click();");
  await waitFor("окно WAV", () => js("return !!document.querySelector('[data-code-wav-save]');"));
  await js("document.querySelector('[data-code-wav-save]').click();");
  const tracksDir = join(docs, "MIDI Teacher", "Треки");
  const wav = await waitFor(
    "WAV в «Треки»",
    async () => {
      const err = await js("return document.querySelector('[data-code-wav-dialog] .code-error')?.textContent ?? '';");
      if (err) throw new Error(`WAV: ${err}`);
      return existsSync(tracksDir) && readdirSync(tracksDir).find((f) => f.startsWith("Первый трек") && f.endsWith(".wav"));
    },
    30000,
  );
  const wavBytes = readFileSync(join(tracksDir, wav));
  if (wavBytes.length < 44 + 44100 * 2 * 2 * 4 || wavBytes.toString("ascii", 0, 4) !== "RIFF") throw new Error(`WAV: ${wavBytes.length} байт`);
  const pcm = new Int16Array(wavBytes.buffer, wavBytes.byteOffset + 44, Math.floor((wavBytes.length - 44) / 2));
  if (!pcm.some((v) => Math.abs(v) > 1000)) throw new Error("WAV — тишина");
  ok(`WAV: ${wav}, ${Math.round(wavBytes.length / 1024)} КБ, звук есть`);
  // Урок курса «Музыка кодом»: ответ засчитан, шаг пройден.
  await waitFor("вкладка курса", () => click("Курс"));
  await waitFor("направление «Музыка кодом»", () => js("const b = document.querySelector('[data-course-instrument-btn=code]'); if (!b) return false; b.click(); return true;"));
  await waitFor("урок открыт", () => js("const b = document.querySelector('[data-course-continue]'); if (!b) return false; b.click(); return true;"));
  await waitFor("шаг урока", () => js("const b = document.querySelector('[data-course-go]'); if (!b) return false; b.click(); return true;"));
  await waitFor("редактор урока", () => js("return !!document.querySelector('[data-code-lesson] .cm-editor');"), 30000);
  await js("document.querySelector('[data-code-lesson-answer]').click();");
  await sleep(300);
  await js("document.querySelector('[data-code-lesson-check]').click();");
  const verdict = await waitFor("проверка урока", () => js("return document.querySelector('[data-code-lesson-result]')?.dataset.codeLessonResult ?? false;"), 15000);
  if (verdict !== "ok") throw new Error(`урок не засчитан: ${await js("return document.querySelector('[data-code-lesson-result]')?.textContent;")}`);
  const lessonStat = (await invoke("exercise_stats")).find((x) => x.exercise === "code-1");
  if (!lessonStat?.passed) throw new Error("результат урока code-1 не записан");
  ok("урок «Цикл и звук»: ответ засчитан, результат в статистике");
  await js("document.querySelector('[data-code-lesson-next]')?.click();");
  await sleep(300);

  console.log("Сквозной тест: доводка");
  // Панель пьесы: редкое — в меню «⋯»; Esc закрывает только меню.
  await waitFor("вкладка пьес", () => click("Пьесы"));
  await waitFor("карточка «Оды к радости»", () =>
    js("const b = [...document.querySelectorAll('.piece-card')].find((b) => b.textContent.includes('Ода к радости')); if (!b) return false; b.click(); return true;"),
  );
  await waitFor("ноты пьесы", () => js("return !!document.querySelector('.score-page svg g.note');"), 30000);
  // Схема ладоней: палец следующей ноты, вспышка при верном нажатии.
  await waitFor("«Свободно»", () => click("Свободно"));
  await waitFor("переключатель «Ладони»", () =>
    js("const l = [...document.querySelectorAll('label.toggle')].find((l) => l.textContent.trim() === 'Ладони'); if (!l) return false; const i = l.querySelector('input'); if (!i.checked) i.click(); return true;"),
  );
  const palmNext = await waitFor("палец на ладони", () => js("return document.querySelector('[data-palm=right]')?.dataset.next ?? '';"), 10000);
  await invoke("simulate_midi", { device: "E2E", bytes: [0x90, 64, 100] });
  const palmHit = await waitFor("вспышка пальца", () => js("return document.querySelector('[data-palm-last]')?.dataset.palmLast ?? '';"), 3000);
  await invoke("simulate_midi", { device: "E2E", bytes: [0x80, 64, 0] });
  if (!palmHit.endsWith(":ok")) throw new Error(`ладонь: ${palmHit}`);
  ok(`ладони: палец ${palmNext} правой руки, нажатие — вспышка пальца ${palmHit.split(":")[1]} (${palmHit.split(":")[0]})`);
  // Подсветка клавиш (без платы — по последнему кадру ядра): следующая нота правой руки горит голубым (1).
  const framePairs = async () => {
    const f = await invoke("lights_frame");
    const out = [];
    for (let i = 6; i + 1 < f.length - 0; i += 2) if (f[i] !== 0xf7) out.push([f[i], f[i + 1]]);
    return { head: f.slice(0, 5).join(","), pairs: out };
  };
  // В кадре — те же клавиши, что подсвечены на экранной клавиатуре, цветом руки (1 — правая, 2 — левая).
  const pieceFrame = await waitFor("кадр подсветки с подсказками пьесы", async () => {
    const f = await framePairs();
    const screen = await js("return [...document.querySelectorAll('.session-piano .key.active')].map((k) => Number(k.dataset.note));");
    const hints = f.pairs.filter(([, c]) => c === 1 || c === 2).map(([n]) => n);
    if (hints.length && hints.every((n) => screen.includes(n))) return f;
    const lightsDev = (await invoke("get_state")).devices?.lights;
    throw new Error(`кадр ${JSON.stringify(f)}, настройки ${JSON.stringify(lightsDev)}, на экране: ${screen}`);
  }, 5000);
  if (pieceFrame.head !== "240,125,77,84,16") throw new Error(`кадр подсветки: ${pieceFrame.head}`);
  ok(`подсветка клавиш: кадр SysEx, горит ${pieceFrame.pairs.map(([n, c]) => `${n}:${c}`).join(" ")}`);
  await js("const l = [...document.querySelectorAll('label.toggle')].find((l) => l.textContent.trim() === 'Ладони'); l?.querySelector('input:checked')?.click();");
  await waitFor("обратно «Разучить»", () => click("Разучить"));
  await js("document.querySelector('[data-more]').click();");
  await waitFor("меню «⋯» открыто", () => js("return document.querySelector('.more-pop')?.hidden === false && !!document.querySelector('.more-pop [data-layout-select]');"));
  const escape = () => js("window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));");
  await escape();
  await waitFor("меню закрыто, пьеса открыта", () => js("return document.querySelector('.more-pop')?.hidden === true && !!document.querySelector('.piece-bar');"));
  // Горячие клавиши: «?» открывает окно, Esc закрывает его и не уводит из пьесы.
  await js("window.dispatchEvent(new KeyboardEvent('keydown', { key: '?', bubbles: true }));");
  await waitFor("окно горячих клавиш", () => js("return !!document.querySelector('[data-hotkeys] kbd');"));
  await escape();
  await waitFor("окно закрыто, пьеса открыта", () => js("return !document.querySelector('[data-hotkeys]') && !!document.querySelector('.piece-bar');"));
  ok("панель пьесы: меню «⋯» и окно горячих клавиш, Esc закрывает только их");
  await escape();
  await waitFor("список пьес", () => js("return !!document.querySelector('.piece-card');"));
  // Новые пьесы из Mutopia: «К Элизе» целиком открывается и рисуется.
  await waitFor("карточка «К Элизе (полностью)»", () =>
    js("const b = [...document.querySelectorAll('.piece-card')].find((b) => b.textContent.includes('К Элизе (полностью)')); if (!b) return false; b.click(); return true;"),
  );
  const eliseNotes = await waitFor("ноты «К Элизе»", () => js("return document.querySelectorAll('.score-page svg g.note').length;"), 40000);
  if (eliseNotes < 500) throw new Error(`«К Элизе (полностью)»: ${eliseNotes} нот`);
  ok(`«К Элизе (полностью)»: ${eliseNotes} нот на стане`);
  await escape();
  await waitFor("список пьес", () => js("return !!document.querySelector('.piece-card');"));

  // Подсветка: моё нажатие вне занятий — ярким нейтральным огоньком (6).
  await waitFor("главная", () => click("Главная"));
  await waitFor("главный экран", () => js("return !!document.querySelector('.home');"));
  await invoke("simulate_midi", { device: "E2E", bytes: [0x90, 72, 100] });
  const pressFrame = await waitFor("огонёк нажатия", async () => {
    const f = await invoke("lights_frame");
    for (let i = 6; i + 1 < f.length; i += 2) if (f[i] === 72 && f[i + 1] === 6) return true;
    return false;
  }, 5000);
  await invoke("simulate_midi", { device: "E2E", bytes: [0x80, 72, 0] });
  if (pressFrame) ok("подсветка: моё нажатие на главной — огонёк над клавишей");

  // «О программе»: номер сборки.
  await waitFor("вкладка настроек", () => click("Настройки"));
  const build = await waitFor("номер сборки", () => js("return document.querySelector('[data-about]')?.dataset.build ?? '';"));
  if (build === "dev" || build.length < 7) throw new Error(`номер сборки: ${build}`);

  // Подсветка без провода: статус радио от платы (без платы — имитация сообщения от неё).
  // F0 7D 4D 54 20 <версия> <связь> <связка> <−дБм> <потери> F7; статус живёт 3 секунды — повторяем, пока ждём.
  const radio = async (name, bytes, check) =>
    waitFor(name, async () => {
      await invoke("lights_inject", { bytes });
      return js(check);
    }, 5000);
  const online = [0xf0, 0x7d, 0x4d, 0x54, 0x20, 1, 1, 2, 58, 1, 0xf7];
  const radioText = await radio(
    "лента по радио на связи",
    online,
    "const s = document.querySelector('[data-lights-status]'); const q = document.querySelector('[data-lights-quality]'); return s?.dataset.lightsLink === 'online' && q && document.querySelector('[data-lights-radio]')?.dataset.lightsRadio === 'done' && document.querySelector('[data-lights-unpair]') ? s.textContent + ' · ' + q.textContent : false;",
  );
  if (!radioText.includes("по радио") || !radioText.includes("хороший (-58 дБм)")) throw new Error(`статус радио: ${radioText}`);
  await radio(
    "лента не отвечает",
    [0xf0, 0x7d, 0x4d, 0x54, 0x20, 1, 2, 0, 0, 0, 0xf7],
    "const s = document.querySelector('[data-lights-status]'); return s?.dataset.lightsLink === 'lost' && s.classList.contains('warn') && s.textContent.includes('не отвечает');",
  );
  await radio(
    "по проводу, кнопка «Связать»",
    [0xf0, 0x7d, 0x4d, 0x54, 0x20, 1, 0, 3, 0, 0, 0xf7],
    "const s = document.querySelector('[data-lights-status]'); return s?.dataset.lightsLink === 'wired' && s.textContent.includes('по проводу') && document.querySelector('[data-lights-radio]')?.dataset.lightsRadio === 'notFound' && !!document.querySelector('[data-lights-pair]') && !document.querySelector('[data-lights-unpair]');",
  );
  // Статус перестал приходить (плату выдернули) — через 3 секунды его нет.
  await waitFor("статус радио устарел", () => js("return document.querySelector('[data-lights-section]')?.dataset.lightsConnected === '0' && !document.querySelector('[data-lights-radio]');"), 8000);
  ok(`подсветка без провода: ${radioText.replace(/\s+/g, " ").trim()}; «не отвечает», «по проводу», статус устаревает`);

  // Резервная копия: сохранить → удалить трек → восстановить (трек сразу, настройки и база — при запуске).
  const backupPath = join(profile, "копия.mtbackup");
  const backupInfo = await invoke("backup_export", { path: backupPath });
  const backup = JSON.parse(readFileSync(backupPath, "utf8"));
  if (backup.kind !== "MIDI Teacher backup" || !backup.settings || !backup.progress || backupInfo.songs < 2)
    throw new Error(`копия: ${JSON.stringify(backupInfo)}`);
  const before = await invoke("studio_list");
  const victim = before.find((x) => x.name === "E2E трек");
  await invoke("studio_delete", { file: victim.file });
  const restored = await invoke("backup_import", { path: backupPath });
  const after = await invoke("studio_list");
  if (!after.some((x) => x.name === "E2E трек") || restored.songs !== backupInfo.songs) throw new Error(`восстановление: ${JSON.stringify(after)}`);
  const pending = [
    join(profile, "config", "com.g1pd78.miditeacher", "settings.json.restore"),
    join(profile, "data", "com.g1pd78.miditeacher", "progress.db.restore"),
  ];
  for (const p of pending) {
    if (!existsSync(p)) throw new Error(`нет ${p}`);
    rmSync(p);
  }
  ok(`сборка ${build.slice(0, 7)}; резервная копия: настройки, прогресс и ${backupInfo.songs} трека — сохранена и восстановлена`);

  console.log("Готово: все проверки пройдены");
} catch (e) {
  console.error(`✗ ${e.message}`);
  process.exitCode = 1;
} finally {
  if (sid) await wd("DELETE", `/session/${sid}`).catch(() => {});
  driver.kill();
}
