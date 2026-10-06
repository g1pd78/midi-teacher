#!/usr/bin/env node
// Справка Strudel для автодополнения: из встроенного в @strudel/codemirror doc.json берём имя,
// синонимы, описание (без HTML), параметры и первый пример. Запуск: node scripts/gen-strudel-docs.mjs
// (после обновления пакетов Strudel). Пишет src/lib/strudel/strudelDocs.json.

import { readFileSync, writeFileSync } from "node:fs";

const src = readFileSync("node_modules/@strudel/codemirror/dist/index.mjs", "utf8");
const line = src.split("\n").find((l) => l.includes("JSON.parse(`[{\"comment\""));
if (!line) throw new Error("не найден doc.json в @strudel/codemirror");
const expr = line.slice(line.indexOf("JSON.parse("), line.lastIndexOf(")") + 1);
const docs = new Function(`return ${expr}`)();

const strip = (html) =>
  String(html ?? "")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

const seen = new Set();
const out = [];
for (const d of docs) {
  const name = d.name || d.longname;
  if (!name || name.startsWith("_") || d.kind === "package" || /[.#~]/.test(name)) continue;
  if (d.tags?.some((t) => ["superdirtOnly", "noAutocomplete"].includes(t.originalTitle))) continue;
  if (seen.has(name)) continue;
  seen.add(name);
  const e = { n: name };
  if (d.synonyms?.length) e.s = d.synonyms;
  const desc = strip(d.description);
  if (desc) e.d = desc.length > 300 ? `${desc.slice(0, 297)}…` : desc;
  if (d.params?.length) e.p = d.params.map((p) => p.name).filter(Boolean);
  if (d.examples?.length) e.x = d.examples[0].trim();
  out.push(e);
}
out.sort((a, b) => a.n.localeCompare(b.n));
writeFileSync("src/lib/strudel/strudelDocs.json", JSON.stringify(out) + "\n");
console.log(`функций: ${out.length}`);
