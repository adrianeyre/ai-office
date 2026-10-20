import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { loadEnv, type Plugin } from "vite";
import { defineConfig } from "vitest/config";

import { waitForServer } from "./scripts/wait-for-server.ts";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));

const { version } = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
) as { version: string };

/**
 * index.html's absolute URLs (link previews, canonical) are filled in by the
 * server from PUBLIC_URL; in `pnpm dev`, Vite fills them in with its own
 * (docker-compose.dev.yml gives it PUBLIC_URL, http://ai-office.localhost:3045).
 */
function devPageUrls(publicUrl: string | undefined): Plugin {
  return {
    name: "ai-office-dev-page-urls",
    apply: "serve",
    transformIndexHtml(html, { originalUrl, server }) {
      const origin =
        publicUrl === undefined || publicUrl === ""
          ? `http://localhost:${String(server?.config.server.port ?? 3045)}`
          : new URL(publicUrl).origin;
      const path = (originalUrl ?? "/").split("?", 1)[0] ?? "/";
      return html
        .replaceAll("__AI_OFFICE_PAGE_URL__", new URL(path, origin).href)
        .replaceAll("__AI_OFFICE_ORIGIN__", origin);
    },
  };
}

// `pnpm build` writes dist/, which the server serves at `/`. In `pnpm dev`,
// Vite serves the app on 3045 and proxies the API, and the AI Gateway's
// `/v1` paths (one entry point), to the server: AI_OFFICE_SERVER_URL, which
// docker-compose.dev.yml sets to its `server`, or else localhost on the PORT
// from the root .env (3046 unless set).
export default defineConfig(({ mode }) => {
  const { PORT: port } = loadEnv(mode, repositoryRoot, "");
  // An empty PORT (as `.env.example` has it) means the default.
  const server =
    process.env["AI_OFFICE_SERVER_URL"] ??
    `http://localhost:${port === undefined || port === "" ? "3046" : port}`;
  // `changeOrigin: false` keeps the browser's Host header (localhost:3045),
  // so it matches the Origin of the server's same-site check; Vite's
  // string shorthand would rewrite it to the server's and every sign-in
  // and setup would be refused as cross-site.
  const toServer = { target: server, changeOrigin: false };
  // The API, the health check, and the AI Gateway for the Owner's tools:
  // Claude Code with ANTHROPIC_BASE_URL=http://localhost:3045, OpenAI
  // clients with http://localhost:3045/v1. Bodies and server-sent events
  // pass through as they are; the Gateway Key is all that authorises them.
  const proxied = ["/api", "/health", "/v1/"];
  return {
    plugins: [
      react(),
      tailwindcss(),
      devPageUrls(process.env["PUBLIC_URL"]),
      // While the server starts or restarts, these wait for it rather
      // than fail.
      waitForServer({ target: server, paths: proxied }),
    ],
    // The footer's version: the root package.json's.
    define: { __APP_VERSION__: JSON.stringify(version) },
    resolve: {
      alias: { "@": fileURLToPath(new URL("src", import.meta.url)) },
    },
    server: {
      port: 3045,
      strictPort: true,
      proxy: Object.fromEntries(proxied.map((path) => [path, toServer])),
    },
    test: {
      name: "@ai-office/web",
      environment: "jsdom",
      setupFiles: ["./src/test-setup.ts"],
    },
  };
});
