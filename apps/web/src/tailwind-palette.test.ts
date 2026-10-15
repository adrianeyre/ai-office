import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { palette, paletteTokens } from "@ai-office/shared";
import { compile } from "@tailwindcss/node";
import { describe, expect, it } from "vitest";

import tailwindConfig from "../tailwind.config.ts";

// The web app's Tailwind build takes the Office's palette from
// @ai-office/shared (tailwind.config.ts, loaded by styles.css), as the
// `office-*` colours. Compiled here as Vite's Tailwind compiles it.
// jsdom gives import.meta.url an http: address, so paths come from dirname.
const stylesPath = join(import.meta.dirname, "styles.css");
const tailwindConfigPath = join(import.meta.dirname, "../tailwind.config.ts");

async function buildStyles(candidates: string[]) {
  const dependencies: string[] = [];
  const compiler = await compile(await readFile(stylesPath, "utf8"), {
    base: import.meta.dirname,
    from: stylesPath,
    onDependency: (path) => dependencies.push(path),
  });
  return { css: compiler.build(candidates), dependencies };
}

describe("the Tailwind config", () => {
  it("is loaded by styles.css, and takes the palette from @ai-office/shared", async () => {
    const { dependencies } = await buildStyles([]);
    expect(dependencies).toContain(tailwindConfigPath);
    // The very object @ai-office/shared exports, not a copy of it.
    expect(tailwindConfig.theme.extend.colors.office).toBe(palette);
  });

  it("makes every palette token an office-* colour with its value", async () => {
    const { css } = await buildStyles(
      paletteTokens.flatMap((token) => [
        `bg-office-${token}`,
        `text-office-${token}`,
      ]),
    );
    for (const token of paletteTokens) {
      expect(css).toMatch(
        new RegExp(
          `\\.bg-office-${token} \\{\\s*background-color: ${palette[token]};`,
        ),
      );
      expect(css).toMatch(
        new RegExp(`\\.text-office-${token} \\{\\s*color: ${palette[token]};`),
      );
    }
  });

  it("keeps the shadcn/ui theme and Tailwind's own colours", async () => {
    const { css } = await buildStyles(["bg-background", "text-red-500"]);
    expect(css).toContain(".bg-background {");
    expect(css).toContain(".text-red-500 {");
  });

  it("gives the charts' state colours the palette's values", async () => {
    // The analytics charts (.viz) have their own validated series colours,
    // but a warning or a critical value is the same colour as everywhere.
    const styles = await readFile(stylesPath, "utf8");
    expect(styles).toContain(
      `--viz-status-warning: ${palette["state-warning"]};`,
    );
    expect(styles).toContain(
      `--viz-status-critical: ${palette["state-critical"]};`,
    );
  });
});
