#!/usr/bin/env node
// Скачивает SoundFont рояля в src-tauri/resources/soundfonts/ и GM-банк аккомпанемента
// (GeneralUser GS, © S. Christian Collins, свободная лицензия) в src-tauri/resources/gm/
// для сборки установщика.
//
// YDP Grand Piano (Yamaha Disklavier Pro), © Roberto Gordo Saez, CC BY 3.0,
// проект FreePats: https://freepats.zenvoid.org/Piano/acoustic-grand-piano.html
//
// Использование:
//   node scripts/fetch-soundfont.mjs            — ошибка загрузки завершает скрипт с кодом 1
//   node scripts/fetch-soundfont.mjs --optional — при ошибке только предупреждение (сборка
//                                                  продолжится со встроенным простым синтезом)
// Переменные окружения:
//   SOUNDFONT_URL    — другой адрес архива (.tar.bz2/.tar.xz/.tar.gz или .sf2)
//   SOUNDFONT_SHA256 — ожидаемая контрольная сумма скачанного файла

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, statSync, copyFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_URL = "https://freepats.zenvoid.org/Piano/YDP-GrandPiano/YDP-GrandPiano-SF2-20160804.tar.bz2";
// Контрольная сумма архива (проверена в CI 2026-09-29).
const DEFAULT_SHA256 = "d243dc3e182a60df2a16e92828c1821cf3eb5748b45e2e2bdcfa9cf7af056026";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const destDir = join(root, "src-tauri", "resources", "soundfonts");
const destFile = join(destDir, "YDP-GrandPiano.sf2");
const optional = process.argv.includes("--optional");
const url = process.env.SOUNDFONT_URL || DEFAULT_URL;
const expected = (process.env.SOUNDFONT_SHA256 || DEFAULT_SHA256).toLowerCase();

function findSf2(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      const found = findSf2(p);
      if (found) return found;
    } else if (name.toLowerCase().endsWith(".sf2")) return p;
  }
  return null;
}

async function main() {
  if (existsSync(destFile) && statSync(destFile).size > 1_000_000) {
    console.log(`SoundFont уже на месте: ${destFile}`);
    return;
  }
  console.log(`Скачиваю ${url}`);
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  const data = Buffer.from(await res.arrayBuffer());
  const sha = createHash("sha256").update(data).digest("hex");
  console.log(`Размер: ${(data.length / 1e6).toFixed(1)} МБ, SHA-256: ${sha}`);
  if (expected && sha !== expected) throw new Error(`контрольная сумма не совпала (ожидалась ${expected})`);
  if (!expected) console.log("::notice::SHA-256 SoundFont не закреплён: " + sha);

  const work = mkdtempSync(join(tmpdir(), "mt-sf-"));
  try {
    const archive = join(work, basename(new URL(url).pathname));
    writeFileSync(archive, data);
    let sf2 = archive.toLowerCase().endsWith(".sf2") ? archive : null;
    if (!sf2) {
      // tar есть и в Linux, и в Windows 10+ (bsdtar понимает bz2/xz/gz).
      execFileSync("tar", ["-xf", archive, "-C", work], { stdio: "inherit" });
      sf2 = findSf2(work);
    }
    if (!sf2) throw new Error("в архиве нет файла .sf2");
    copyFileSync(sf2, destFile);
    console.log(`Готово: ${destFile} (${(statSync(destFile).size / 1e6).toFixed(1)} МБ)`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

// GM-банк: версия закреплена коммитом репозитория автора, файл проверяется по SHA-256.
const GM_URL = "https://raw.githubusercontent.com/mrbumpy409/GeneralUser-GS/684543d5e5efaef08d02be50dcda8d552478fa60/GeneralUser-GS.sf2";
const GM_SHA256 = "9575028c7a1f589f5770fccc8cff2734566af40cd26ed836944e9a5152688cfe";
const gmFile = join(root, "src-tauri", "resources", "gm", "GeneralUser-GS.sf2");

async function fetchGm() {
  if (existsSync(gmFile) && statSync(gmFile).size > 1_000_000) {
    console.log(`GM-банк уже на месте: ${gmFile}`);
    return;
  }
  console.log(`Скачиваю ${GM_URL}`);
  const res = await fetch(GM_URL, { redirect: "follow" });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  const data = Buffer.from(await res.arrayBuffer());
  const sha = createHash("sha256").update(data).digest("hex");
  if (sha !== GM_SHA256) throw new Error(`контрольная сумма GM-банка не совпала: ${sha}`);
  writeFileSync(gmFile, data);
  console.log(`Готово: ${gmFile} (${(data.length / 1e6).toFixed(1)} МБ)`);
}

main()
  .catch((e) => {
    const msg = `SoundFont не загружен: ${e.message}`;
    if (optional) {
      console.log(`::warning::${msg}. Установщик будет со встроенным простым синтезом.`);
      return;
    }
    console.error(msg);
    process.exit(1);
  })
  .then(() => fetchGm())
  .catch((e) => {
    const msg = `GM-банк не загружен: ${e.message}`;
    if (optional) {
      console.log(`::warning::${msg}. Аккомпанемент MIDI будет звучать роялем.`);
      return;
    }
    console.error(msg);
    process.exit(1);
  });

