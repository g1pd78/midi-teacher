#!/usr/bin/env node
// Скачивает SoundFont рояля в src-tauri/resources/soundfonts/ для сборки установщика.
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
// Закрепляется после первой успешной загрузки в CI (значение печатается в лог).
const DEFAULT_SHA256 = "";

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

main().catch((e) => {
  const msg = `SoundFont не загружен: ${e.message}`;
  if (optional) {
    console.log(`::warning::${msg}. Установщик будет со встроенным простым синтезом.`);
    process.exit(0);
  }
  console.error(msg);
  process.exit(1);
});

