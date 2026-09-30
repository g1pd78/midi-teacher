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
import { existsSync, mkdtempSync } from "node:fs";
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
  await press(60);
  await waitFor("название ноты на главном экране", () => js("return document.querySelector('.now-name')?.textContent;"))
    .then((t) => t.includes("До первой октавы") || Promise.reject(new Error(`на экране: ${t}`)));
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

  console.log("Готово: все проверки пройдены");
} catch (e) {
  console.error(`✗ ${e.message}`);
  process.exitCode = 1;
} finally {
  if (sid) await wd("DELETE", `/session/${sid}`).catch(() => {});
  driver.kill();
}
