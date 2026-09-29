#!/usr/bin/env node
// Сквозной тест «бот играет»: настоящее приложение (Rust + WebView) проходит
// серию тренажёра через имитацию MIDI-входа.
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

  console.log("Готово: все проверки пройдены");
} catch (e) {
  console.error(`✗ ${e.message}`);
  process.exitCode = 1;
} finally {
  if (sid) await wd("DELETE", `/session/${sid}`).catch(() => {});
  driver.kill();
}
