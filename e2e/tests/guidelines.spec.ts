import { expect, signIn, test } from "../support/office.ts";

// The Floor admin's Guidelines card (Guidelines, Specs and Hooks PRD,
// FR-103, FR-111; ADR 0014) in a real browser, against the built app,
// Postgres and the test's fake GitHub: a Guideline someone else changed
// waits for the Owner, with an action Notice that opens the card, and the
// Owner approves exactly the version the card shows.

const repository = "adrianeyre/web-shop";
/** General Settings' Intake card's Owner login. */
const owner = "adrianeyre";

test("approves a Guideline awaiting approval from the Notice's card", async ({
  office,
  page,
}) => {
  office.github.installRepository(repository);
  // The Owner pushed one; someone else then changed it.
  office.github.pushCommit(repository, "main", {
    files: {
      ".agents/guidelines/migrations.md":
        '---\ninclusion: fileMatch\nfileMatchPattern: "packages/db/**"\ndescription: How migrations are written\n---\n\nOne migration per change.\nKeep them small.\n',
    },
    pusher: owner,
  });
  await office.setUp();
  await signIn(page);
  await page.getByRole("link", { name: "Floor Settings" }).click();
  await page
    .getByRole("button", { name: `Add ${repository} as a Floor` })
    .click();
  await expect(page.getByText("Already a Floor")).toBeVisible();
  // Intake reads the Guidelines: the Owner's version is approved.
  await office.pollIntake();
  office.github.pushCommit(repository, "main", {
    files: {
      ".agents/guidelines/migrations.md":
        '---\ninclusion: fileMatch\nfileMatchPattern: "packages/db/**"\ndescription: How migrations are written\n---\n\nOne migration per change.\nNever edit a merged one.\n',
    },
    // Whatever the commit says about who wrote it.
    author: owner,
    pusher: "mallory",
  });
  await office.pollIntake();

  // One action Notice, which opens the Floor admin at its Guidelines.
  await page.getByRole("link", { name: "Notices" }).click();
  const notice = page
    .getByRole("list", { name: "Notices" })
    .getByRole("listitem")
    .filter({
      has: page.getByRole("heading", {
        name: "Guidelines changed on web-shop: 1 awaiting approval",
      }),
    });
  await expect(notice).toBeVisible();
  await notice.getByRole("link", { name: "Open Guidelines" }).click();
  await expect(page).toHaveURL(/\/floor-settings\/web-shop#guidelines$/);

  const card = page.locator("#guidelines");
  await expect(
    card.getByRole("heading", { level: 2, name: "Guidelines" }),
  ).toBeInViewport();
  await expect(card.getByRole("status")).toHaveText(
    "1 Guideline awaits your approval.",
  );
  const migrations = card
    .getByRole("list", { name: "Guidelines" })
    .getByRole("listitem", { name: "migrations" });
  await expect(migrations).toContainText("File match");
  await expect(migrations).toContainText("packages/db/**");
  await expect(migrations).toContainText("How migrations are written");
  await expect(migrations).toContainText("pushed by you");
  const changes = migrations.getByLabel("Changes to migrations");
  await expect(changes.locator("del")).toHaveText(["- Keep them small."]);
  await expect(changes.locator("ins")).toHaveText([
    "+ Never edit a merged one.",
  ]);

  await migrations.getByRole("button", { name: "Approve migrations" }).click();
  await expect(migrations).toContainText("approved by you here.");
  await expect(migrations.getByRole("button")).toHaveCount(0);
  await expect(card.getByRole("status")).toHaveCount(0);

  // Kept, and the Notice is off the board.
  await page.reload();
  await expect(
    page.locator("#guidelines").getByRole("listitem", { name: "migrations" }),
  ).toContainText("approved by you here.");
  await page.getByRole("link", { name: "Notices" }).click();
  await expect(
    page.getByText("No Notices. Nothing needs you right now."),
  ).toBeVisible();
});
