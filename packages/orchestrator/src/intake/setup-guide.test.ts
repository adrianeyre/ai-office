import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { appPermissions } from "@ai-office/github";
import { pipelineLabels } from "@ai-office/shared";
import { describe, expect, it } from "vitest";

// The setup guide (PRD FR-70) tells the Owner which permissions to give
// the GitHub App and which labels intake creates. Both are in code
// (`appPermissions` in `@ai-office/github`, `pipelineLabels` in
// `@ai-office/shared`), so the guide is read here and held to them.

const guidePath = join(
  import.meta.dirname,
  "../../../../docs/processes/setting-up-a-floor.md",
);

/** The lines of the guide under `heading`, up to the next heading. */
function section(guide: string, heading: string): string[] {
  const lines = guide.split("\n");
  const start = lines.indexOf(heading);
  expect(start, `the guide has "${heading}"`).toBeGreaterThanOrEqual(0);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^#{1,6} /.test(line));
  return end === -1 ? rest : rest.slice(0, end);
}

/** The first table's rows, each a list of its cells, without the header. */
function tableRows(lines: readonly string[]): string[][] {
  const table = lines.filter((line) => line.startsWith("|"));
  // The header, then the `| --- |` line under it.
  expect(table[1], "a Markdown table").toMatch(/^\|[\s|:-]+\|$/);
  return table.slice(2).map((line) =>
    line
      .slice(1, -1)
      .split("|")
      .map((cell) => cell.trim()),
  );
}

const unquoted = (cell: string): string => cell.replace(/^`(.*)`$/, "$1");

/** GitHub's settings page's words for an access, as the API has them. */
const accessOf = (cell: string): string => {
  const access = { "Read-only": "read", "Read and write": "write" }[cell];
  expect(access, `"${cell}" is an access GitHub offers`).toBeDefined();
  return access ?? "";
};

/**
 * A permission's API name from its name on GitHub's settings page: "Pull
 * requests" is `pull_requests`, but "Commit statuses" is `statuses`.
 */
const permissionOf = (cell: string): string =>
  cell === "Commit statuses"
    ? "statuses"
    : cell.toLowerCase().replaceAll(" ", "_");

describe("the setup guide, docs/processes/setting-up-a-floor.md", () => {
  it("lists exactly the permissions the GitHub App needs, each with its access", async () => {
    const guide = await readFile(guidePath, "utf8");
    const rows = tableRows(section(guide, "### The App's permissions"));
    const listed = Object.fromEntries(
      rows.map(([permission = "", access = ""]) => [
        permissionOf(permission),
        accessOf(access),
      ]),
    );
    expect(rows).toHaveLength(Object.keys(listed).length);
    expect(listed).toEqual(appPermissions);
  });

  it("asks for nothing it says is not asked for", async () => {
    const guide = await readFile(guidePath, "utf8");
    const lines = section(guide, "### The App's permissions");
    const notAsked = lines
      .slice(lines.indexOf("Not asked for, on purpose:"))
      .flatMap((line) => /^- \*\*(.+?)\.\*\*/.exec(line)?.[1] ?? []);
    expect(notAsked).toEqual([
      "Administration",
      "Workflows",
      "Commit statuses",
    ]);
    for (const permission of notAsked) {
      expect(appPermissions).not.toHaveProperty(permissionOf(permission));
    }
  });

  it("lists exactly the labels intake creates, each with its colour and description", async () => {
    const guide = await readFile(guidePath, "utf8");
    const rows = tableRows(section(guide, "## Labels AI Office creates"));
    expect(
      rows.map(([name = "", colour = "", description = ""]) => ({
        name: unquoted(name),
        color: unquoted(colour).replace(/^#/, ""),
        description,
      })),
    ).toEqual(pipelineLabels);
    for (const [, , , meaning = ""] of rows) {
      expect(meaning).not.toBe("");
    }
  });
});
