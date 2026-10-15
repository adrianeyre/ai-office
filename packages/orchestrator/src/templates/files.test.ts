import { describe, expect, it } from "vitest";

import {
  FloorTemplateError,
  floorTemplateDigest,
  floorTemplateFiles,
  floorTemplateFromFiles,
} from "./files.ts";
import { loadFloorTemplates } from "./load.ts";

// A Floor Template as the files of its folder, and back (PRD FR-101): what
// an export holds, and what an import and a Git repository are read from.

/** A template, without the list of the files it was read from. */
const withoutFiles = (
  template: Awaited<ReturnType<typeof loadFloorTemplates>>[number],
) => ({ ...template, files: undefined });

describe("a Floor Template's files", () => {
  it("read back as the same template, for every built-in one", async () => {
    const templates = await loadFloorTemplates();
    expect(templates.length).toBeGreaterThan(2);
    for (const template of templates) {
      const files = floorTemplateFiles(template);
      const read = floorTemplateFromFiles(template.id, files);
      expect(withoutFiles(read)).toEqual(withoutFiles(template));
      // Written again, they are the same files, so the digest is stable.
      expect(floorTemplateFiles(read)).toEqual(files);
      expect(floorTemplateDigest(floorTemplateFiles(read))).toBe(
        floorTemplateDigest(files),
      );
    }
  });

  it("hold the manifest, each Role's file and each Skill's folder", async () => {
    const online = (await loadFloorTemplates()).find(
      ({ id }) => id === "online-store",
    );
    expect(online).toBeDefined();
    if (online === undefined) {
      return;
    }
    const paths = floorTemplateFiles(online).map(({ path }) => path);
    expect(paths).toEqual([
      "template.yaml",
      "roles/merchandiser.md",
      "roles/copywriter.md",
      "roles/storefront-developer.md",
      "roles/brand-reviewer.md",
      "roles/store-qa.md",
      "skills/product-data/SKILL.md",
      "skills/store-checks/SKILL.md",
    ]);
    // The same set of files the built-in folder holds.
    expect([...paths].sort()).toEqual(online.files);
  });

  it("are refused, naming the file at fault, when one is not part of a template", () => {
    const fails = (files: { path: string; content: string }[]) => {
      try {
        floorTemplateFromFiles("garden-centre", files);
      } catch (error) {
        expect(error).toBeInstanceOf(FloorTemplateError);
        return error as FloorTemplateError;
      }
      throw new Error("It was read.");
    };
    expect(fails([{ path: "roles/x.md", content: "" }]).problems).toEqual([
      "A Floor Template has a template.yaml.",
    ]);
    const stray = fails([
      { path: "template.yaml", content: "name: x" },
      { path: "../outside.md", content: "" },
    ]);
    expect(stray.path).toBe("../outside.md");
    const manifest = fails([
      { path: "template.yaml", content: "name: Garden centre\n" },
    ]);
    expect(manifest.path).toBe("template.yaml");
    expect(manifest.problems).toContain(
      "description: Describe the template in one line.",
    );
  });
});
