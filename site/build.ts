// Builds the project website (GitHub Pages) in `site/dist/` with Vite: the
// page, its stylesheet and fonts from `site/`, and its one script, which
// runs the page's enhancements and mounts the product demos (React, on the
// Stageshow kit vendored in `site/stageshow/`). The screenshots from
// `docs/images/` and the logo and icons from the web app are copied in, not
// kept twice in Git. `.github/workflows/pages.yml` runs it and publishes
// `site/dist/`. Run it yourself with `pnpm site:build`, then serve
// `site/dist/` (`pnpm site:preview`); `pnpm site:dev` serves the page as you
// edit it.
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import react from "@vitejs/plugin-react";
import { build, createServer, preview, type InlineConfig } from "vite";

/** The repository, named once: every link to it on the page comes from here. */
export const repositoryUrl = "https://github.com/adrianeyre/ai-office";

/** The website's own address, which `CNAME` gives GitHub Pages. */
export const siteDomain = "ai-office.adrianeyre.co.uk";

const root = join(import.meta.dirname, "..");
const source = import.meta.dirname;
const output = join(source, "dist");

/** Each `{{NAME}}` placeholder in the page, and what it becomes. */
const placeholders: Record<string, string> = {
  REPO_URL: repositoryUrl,
  REPO_NAME: repositoryUrl.split("/").at(-1) ?? "ai-office",
  SITE_URL: `https://${siteDomain}`,
};

/**
 * The files the page names by absolute path (`/images/…`, `/brand/…`, the
 * icons and `CNAME`), gathered in a folder of their own that Vite serves
 * and copies into `dist/` as they are.
 */
function gatherPublicFiles(): string {
  const folder = mkdtempSync(join(tmpdir(), "ai-office-site-"));
  cpSync(join(root, "docs/images"), join(folder, "images"), {
    recursive: true,
  });
  for (const file of ["icon.svg", "logo.svg", "logo-dark.svg"]) {
    cpSync(join(root, "apps/web/src/brand", file), join(folder, "brand", file));
  }
  for (const file of ["favicon.ico", "apple-touch-icon.png", "og-image.png"]) {
    cpSync(join(root, "apps/web/public", file), join(folder, file));
  }
  writeFileSync(join(folder, "CNAME"), `${siteDomain}\n`);
  return folder;
}

function config(publicDir: string): InlineConfig {
  return {
    configFile: false,
    root: source,
    // Relative, so the built page works from any folder as well as the
    // domain's root.
    base: "./",
    publicDir,
    logLevel: "warn",
    plugins: [
      react(),
      {
        name: "ai-office-placeholders",
        transformIndexHtml: (page) =>
          page.replaceAll(/\{\{([A-Z_]+)\}\}/g, (match, name: string) => {
            const value = placeholders[name];
            if (value === undefined) {
              throw new Error(
                `site/index.html names an unknown placeholder ${match}`,
              );
            }
            return value;
          }),
      },
    ],
    resolve: { dedupe: ["react", "react-dom"] },
    // The demos import the brand icon from apps/web, outside site/.
    server: { fs: { allow: [root] } },
    build: {
      outDir: output,
      emptyOutDir: true,
      target: "es2022",
    },
  };
}

const mode = process.argv[2];
const publicDir = gatherPublicFiles();

if (mode === "--dev") {
  const server = await createServer(config(publicDir));
  await server.listen();
  server.printUrls();
} else if (mode === "--preview") {
  const server = await preview(config(publicDir));
  server.printUrls();
} else {
  try {
    await build(config(publicDir));
  } finally {
    rmSync(publicDir, { recursive: true, force: true });
  }
  console.log(`Built the website in ${output}`);
}
