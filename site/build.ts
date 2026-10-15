// Assembles the project website (GitHub Pages) in `site/dist/`: the page, its
// stylesheet, script (its types stripped) and fonts from `site/`, the screenshots from `docs/images/` and the
// logo and icons from the web app, copied rather than kept twice in Git.
// `.github/workflows/pages.yml` runs it and publishes `site/dist/`; run it
// yourself with `pnpm site:build`, then open `site/dist/index.html`.
import {
  cpSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { join } from "node:path";

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

rmSync(output, { recursive: true, force: true });
mkdirSync(output, { recursive: true });

const page = readFileSync(join(source, "index.html"), "utf8").replaceAll(
  /\{\{([A-Z_]+)\}\}/g,
  (match, name: string) => {
    const value = placeholders[name];
    if (value === undefined) {
      throw new Error(`site/index.html names an unknown placeholder ${match}`);
    }
    return value;
  },
);
writeFileSync(join(output, "index.html"), page);
cpSync(join(source, "styles.css"), join(output, "styles.css"));
// The page's script, as the browser runs it: its types stripped, as Node
// strips them, so the build still needs no install.
writeFileSync(
  join(output, "script.js"),
  stripTypeScriptTypes(readFileSync(join(source, "script.mts"), "utf8")),
);
cpSync(join(source, "fonts"), join(output, "fonts"), { recursive: true });
writeFileSync(join(output, "CNAME"), `${siteDomain}\n`);

cpSync(join(root, "docs/images"), join(output, "images"), { recursive: true });
for (const file of ["icon.svg", "logo.svg", "logo-dark.svg"]) {
  cpSync(join(root, "apps/web/src/brand", file), join(output, "brand", file));
}
for (const file of ["favicon.ico", "apple-touch-icon.png", "og-image.png"]) {
  cpSync(join(root, "apps/web/public", file), join(output, file));
}

console.log(`Built the website in ${output}`);
