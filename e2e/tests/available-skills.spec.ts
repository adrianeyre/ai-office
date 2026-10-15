import { expect, signIn, test } from "../support/office.ts";

// The Available Skills list (PRD FR-73), in a real browser against the
// built app, Postgres and the test's fake GitHub: a Floor's Skills are the
// office library's and its repository's, once the Owner has reviewed it
// (P1-10). One is opened in its modal, with
// its SKILL.md rendered and a supporting file read there, and its run
// button puts `/name` in the Manager chat: beside the chat, and from Floor
// Settings.

const skillMd = (name: string, description: string, body: string) =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}`;

// AI Office's own Skill (#94), on every Floor beside the office library's
// and the repository's.
const grillingDescription =
  "Interview the Owner about a feature or product in rounds of numbered questions, each with a recommended answer, until you share an understanding of it. Run it as /grilling followed by what to grill.";

test.beforeEach(async ({ office, page }) => {
  office.github.installRepository("adrianeyre/web-shop");
  office.github.pushCommit("adrianeyre/web-shop", "main", {
    files: {
      ".claude/skills/pdf-processing/SKILL.md": skillMd(
        "pdf-processing",
        "Extract text from PDFs.",
        "# Extracting text\n\n1. Run `scripts/extract.py` on the file.\n2. Check **every** page.\n",
      ),
      ".claude/skills/pdf-processing/scripts/extract.py":
        "print('every line is read')\n",
    },
  });
  await office.setUp();
  await signIn(page);
  await page.getByRole("link", { name: "Floor Settings" }).click();
  await page
    .getByRole("button", { name: "Add adrianeyre/web-shop as a Floor" })
    .click();
  // An office Skill, written in the editor, in General Settings.
  await page.getByRole("link", { name: "General Settings" }).click();
  await page.getByRole("button", { name: "Write one" }).click();
  await page
    .getByLabel("SKILL.md")
    .fill(
      skillMd("release-notes", "Writes release notes.", "List the changes.\n"),
    );
  await page.getByRole("button", { name: "Add Skill" }).click();
  await expect(
    page.getByRole("region", { name: "Add a Skill" }).getByRole("status"),
  ).toHaveText("Added release-notes. It is enabled.");
  // The Owner reads the repository's Skill in the Floor's settings and
  // reviews it: only then is it the Floor's (P1-10).
  await page.getByRole("link", { name: "Floor Settings" }).click();
  await page.getByRole("link", { name: "web-shop", exact: true }).click();
  const waiting = page.getByRole("region", {
    name: "Repository Skills waiting for your review",
  });
  await waiting
    .getByRole("button", { name: "Read pdf-processing to review it" })
    .click();
  await expect(
    waiting.getByLabel(".claude/skills/pdf-processing/scripts/extract.py"),
  ).toContainText("print('every line is read')");
  await waiting
    .getByRole("button", {
      name: "I have read every file: use pdf-processing on this Floor",
    })
    .click();
  await expect(waiting).toBeHidden();
  await page
    .getByRole("navigation", { name: "Main" })
    .getByRole("link", { name: "Floor Settings" })
    .click();
});

test("opens a Skill beside the Manager chat, views a supporting file, and run puts /name in the box", async ({
  page,
}) => {
  await page.getByRole("link", { name: "web-shop", exact: true }).click();
  await page.getByRole("link", { name: "Chat with the Manager" }).click();
  const skills = page.getByRole("complementary", { name: "Available Skills" });
  const list = skills.getByRole("list", { name: "Available Skills" });
  for (const [name, text] of [
    ["grilling", `grillingBuilt in${grillingDescription}`],
    ["pdf-processing", "pdf-processingRepositoryExtract text from PDFs."],
    ["release-notes", "release-notesOfficeWrites release notes."],
  ] as const) {
    await expect(list.getByRole("listitem", { name, exact: true })).toHaveText(
      text,
    );
  }
  // With the built-in Skills adapted from Matt Pocock's (FR-83b).
  await expect(
    list.getByRole("listitem", { name: "wayfinder", exact: true }),
  ).toContainText("wayfinderBuilt in");

  await skills.getByRole("button", { name: "Open pdf-processing" }).click();
  const modal = page.getByRole("dialog", { name: "pdf-processing" });
  await expect(modal).toBeVisible();
  // SKILL.md, rendered: headings, lists, code and emphasis, not Markdown.
  const rendered = modal.getByRole("region", { name: "SKILL.md, rendered" });
  await expect(
    rendered.getByRole("heading", { name: "Extracting text" }),
  ).toBeVisible();
  await expect(rendered.getByRole("listitem")).toHaveText([
    "Run scripts/extract.py on the file.",
    "Check every page.",
  ]);
  await expect(rendered.locator("strong")).toHaveText("every");
  await expect(modal).toContainText(
    "From the repository, .claude/skills/pdf-processing.",
  );

  // A supporting file, read from the repository and shown in the modal.
  await modal
    .getByRole("list", { name: "Supporting files" })
    .getByRole("button", { name: "scripts/extract.py" })
    .click();
  await expect(modal.getByLabel("scripts/extract.py")).toHaveText(
    "print('every line is read')",
  );

  await modal.getByRole("button", { name: "Run /pdf-processing" }).click();
  await expect(modal).toBeHidden();
  const box = page.getByRole("textbox", { name: /^Message / });
  await expect(box).toHaveValue("/pdf-processing ");
  await expect(box).toBeFocused();
});

test("runs a Skill from Floor Settings' Available Skills, which opens the Floor's Manager chat with /name", async ({
  page,
}) => {
  const card = page
    .locator("[data-slot=card]")
    .filter({ has: page.getByRole("heading", { name: "Available Skills" }) });
  await expect(card.getByLabel("Floor")).toHaveValue("web-shop");
  await card.getByRole("button", { name: "Open release-notes" }).click();
  const modal = page.getByRole("dialog", { name: "release-notes" });
  await expect(
    modal.getByRole("region", { name: "SKILL.md, rendered" }),
  ).toHaveText("List the changes.");
  await expect(modal).toContainText("From the office Skill library.");
  await modal.getByRole("button", { name: "Run /release-notes" }).click();

  await expect(page).toHaveURL(/\/floors\/web-shop\/manager$/);
  await expect(page.getByRole("textbox", { name: /^Message / })).toHaveValue(
    "/release-notes ",
  );
});

test("autocompletes /name in the Manager chat from the Floor's Skills (#93)", async ({
  page,
}) => {
  await page.getByRole("link", { name: "web-shop", exact: true }).click();
  await page.getByRole("link", { name: "Chat with the Manager" }).click();
  const box = page.getByRole("textbox", { name: /^Message / });
  await box.fill("/");
  const options = page
    .getByRole("listbox", { name: "Skills to run" })
    .getByRole("option");
  await expect(options.filter({ hasText: /^\/grilling / })).toHaveText([
    `/grilling ${grillingDescription}`,
  ]);
  await expect(options.nth(0)).toHaveAttribute("aria-selected", "true");
  // Those starting with what is typed first, then those holding it.
  await box.fill("/re");
  await expect(options).toHaveText([
    "/release-notes Writes release notes.",
    /^\/research /,
    /^\/code-review /,
  ]);
  await expect(options.nth(0)).toHaveAttribute("aria-selected", "true");
  await box.press("ArrowDown");
  await expect(options.nth(1)).toHaveAttribute("aria-selected", "true");
  await box.press("ArrowUp");
  await expect(options.nth(0)).toHaveAttribute("aria-selected", "true");
  await box.press("Enter");
  await expect(box).toHaveValue("/release-notes ");
  await expect(page.getByRole("listbox")).toHaveCount(0);
});
