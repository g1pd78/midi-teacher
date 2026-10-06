import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { execSync } from "node:child_process";

// Номер сборки: в CI — коммит из GITHUB_SHA, локально — из git.
function buildSha(): string {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA;
  try {
    return execSync("git rev-parse HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return "dev";
  }
}

// Tauri ожидает dev-сервер на фиксированном порту.
export default defineConfig({
  plugins: [react()],
  define: {
    __BUILD_SHA__: JSON.stringify(buildSha()),
    __BUILD_DATE__: JSON.stringify(new Date().toISOString()),
  },
  clearScreen: false,
  // У части пакетов @tonaljs (зависимость Strudel) в поле «main» указан несуществующий файл — берём ESM-сборку.
  resolve: { alias: [{ find: /^@tonaljs\/([a-z-]+)$/, replacement: `${process.cwd()}/node_modules/@tonaljs/$1/dist/index.mjs` }] },
  server: { port: 1420, strictPort: true, watch: { ignored: ["**/src-tauri/**"] } },
  build: { target: "es2022", outDir: "dist" },
  worker: { format: "es" },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Strudel и его зависимость @kabelsalat/web — ESM только через поле «module»: пусть их собирает vite.
    server: { deps: { inline: [/@strudel\//, /@kabelsalat\//, /@tonaljs\//, /superdough/] } },
    // chord-voicings — CommonJS: собрать заранее, чтобы его require("@tonaljs/tonal") попал на ESM-сборку.
    deps: { optimizer: { ssr: { enabled: true, include: ["chord-voicings"] } } },
  },
});
