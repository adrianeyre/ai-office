import { fileURLToPath } from "node:url";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The screenshot tests' page (screenshots/), built on its own into
// screenshots/dist, never into the app's dist/: `pnpm screenshots:serve`
// builds it and serves it on 3049 for e2e/playwright.screenshots.config.ts.
// It draws the Office's own scene components, so it resolves imports as
// vite.config.ts does, and styles their HTML labels with the app's
// Tailwind.
export default defineConfig({
  root: fileURLToPath(new URL("screenshots", import.meta.url)),
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("src", import.meta.url)) },
  },
  // One chunk for the whole page, three.js and all: it is only for tests.
  build: { emptyOutDir: true, chunkSizeWarningLimit: 4096 },
  preview: { port: 3049, strictPort: true, host: "127.0.0.1" },
});
