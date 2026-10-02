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
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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

  await waitFor("вкладка тренажёра", () => click("Тренажёр нот"));
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
  await waitFor("экранный пэд", () =>
    js("const b = document.querySelector(\".drums [data-drum='snare']\"); if (!b) return false; b.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); return true;"),
  );
  await waitFor("экранный пэд вспыхнул", () => js("return !!document.querySelector(\".drums [data-drum='snare'].held\");"), 3000);
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

  console.log("Готово: все проверки пройдены");
} catch (e) {
  console.error(`✗ ${e.message}`);
  process.exitCode = 1;
} finally {
  if (sid) await wd("DELETE", `/session/${sid}`).catch(() => {});
  driver.kill();
}
