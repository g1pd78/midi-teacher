import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Tauri ожидает dev-сервер на фиксированном порту.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 1420, strictPort: true, watch: { ignored: ["**/src-tauri/**"] } },
  build: { target: "es2022", outDir: "dist" },
  test: { environment: "node", include: ["src/**/*.test.ts"] },
});
