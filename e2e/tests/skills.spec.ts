import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, signIn, test } from "../support/office.ts";

// The office Skill library from General Settings (PRD FR-71, FR-72, FR-76),
// in a real browser against the built app and Postgres: a Skill written in
// the editor starts enabled; an uploaded one starts disabled, is read in
// full, then enabled; each step is in the Activity Feed.

const skillMd = (name: string, description: string) =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\nSteps.\n`;

let folder = "";

test.beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), "ai-office-e2e-skill-"));
  const skill = join(folder, "pdf-processing");
  await mkdir(join(skill, "scripts"), { recursive: true });
  await writeFile(
    join(skill, "SKILL.md"),
    skillMd("pdf-processing", "Extract text from PDFs."),
  );
  await writeFile(
    join(skill, "scripts", "extract.py"),
    "print('every line is read')\n",
  );
});

test.afterEach(async () => {
  await rm(folder, { recursive: true, force: true });
});

test("writes a Skill, and uploads one that is reviewed before it is enabled", async ({
  office,
  page,
}) => {
  await office.setUp();
  await signIn(page);
  await page.getByRole("link", { name: "General Settings" }).click();
  await expect(page.getByText(/No Skills yet/)).toBeVisible();
  const library = page.getByRole("list", { name: "Skills" });
  const added = page
    .getByRole("region", { name: "Add a Skill" })
    .getByRole("status");

  // Written in the editor: the Owner's own, so enabled.
  await page.getByRole("button", { name: "Write one" }).click();
  await page
    .getByLabel("SKILL.md")
    .fill(skillMd("release-notes", "Writes release notes."));
  await page.getByRole("button", { name: "Add Skill" }).click();
  await expect(added).toHaveText("Added release-notes. It is enabled.");
  const notes = library.getByRole("listitem", { name: "release-notes" });
  await expect(notes).toContainText("Enabled");
  await expect(notes).toContainText("Written in the editor · 1 file");

  // Uploaded as a folder: waits for review.
  await page.getByRole("button", { name: "Upload a folder" }).click();
  await page
    .getByLabel("Skill folder")
    .setInputFiles(join(folder, "pdf-processing"));
  await expect(
    page.getByText("pdf-processing: SKILL.md, scripts/extract.py"),
  ).toBeVisible();
  await page.getByRole("button", { name: "Upload Skill" }).click();
  await expect(added).toHaveText(
    "Added pdf-processing. It stays disabled until you review it in the library above.",
  );
  const pdf = library.getByRole("listitem", { name: "pdf-processing" });
  await expect(pdf).toContainText("Needs review");
  await expect(
    pdf.getByRole("button", { name: "Enable pdf-processing" }),
  ).toHaveCount(0);

  // It survives a reload, still disabled.
  await page.reload();
  await expect(pdf).toContainText("Needs review");

  // Read in full, then enabled.
  await pdf.getByRole("button", { name: "Review pdf-processing" }).click();
  const review = pdf.getByRole("region", { name: "Review pdf-processing" });
  await expect(review.getByLabel("SKILL.md")).toHaveText(
    skillMd("pdf-processing", "Extract text from PDFs."),
  );
  await expect(review.getByLabel("scripts/extract.py")).toHaveText(
    "print('every line is read')\n",
  );
  await review
    .getByRole("button", { name: "I have read it all: enable pdf-processing" })
    .click();
  await expect(pdf).toContainText("Enabled");
  await page.reload();
  await expect(pdf).toContainText("Enabled");

  // Delete the written one, once confirmed.
  await notes.getByRole("button", { name: "Delete release-notes" }).click();
  await notes
    .getByRole("button", { name: "Yes, delete release-notes" })
    .click();
  await expect(notes).toHaveCount(0);

  // Every add, change and removal is in the Activity Feed.
  await page.getByRole("link", { name: "Activity" }).click();
  for (const text of [
    'Skill "release-notes" written in the editor.',
    'Skill "pdf-processing" uploaded; it waits for review before it can be enabled.',
    'Skill "pdf-processing" reviewed and enabled.',
    'Skill "release-notes" removed.',
  ]) {
    await expect(page.getByText(text)).toBeVisible();
  }
  expect(office.log()).toContain("A Skill was reviewed and enabled.");
});
