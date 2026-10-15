import { expect, signIn, test } from "../support/office.ts";

// Browser notifications for action Notices (PRD FR-51) in real Chromium,
// with notifications allowed. The page's Notification is wrapped so the
// test can see what was shown. Whether a notification really appears (and
// sounds) on a desktop is checked on the host.

interface Shown {
  readonly title: string;
  readonly body?: string;
  readonly tag?: string;
}

// Chromium's headless shell reports notifications as denied whatever the
// permission, so this runs in full Chromium (its new headless mode), which
// `playwright install chromium` installs too.
test.use({ permissions: ["notifications"], channel: "chromium" });

test("an action Notice notifies once notifications are on; an info one does not", async ({
  office,
  page,
}) => {
  await page.addInitScript(() => {
    const shown: Shown[] = [];
    (window as unknown as { shown: Shown[] }).shown = shown;
    const Real = window.Notification;
    class Recording extends Real {
      constructor(title: string, options?: NotificationOptions) {
        shown.push({
          title,
          ...(options?.body === undefined ? {} : { body: options.body }),
          ...(options?.tag === undefined ? {} : { tag: options.tag }),
        });
        super(title, options);
      }
    }
    window.Notification = Recording;
  });
  const shownSoFar = () =>
    page.evaluate(() => (window as unknown as { shown: Shown[] }).shown);

  await office.setUp();
  await signIn(page);
  // Off until the Owner turns them on.
  await office.raiseNotice({ kind: "action", title: "Before turning on" });
  await page.getByRole("link", { name: "General Settings" }).click();
  const notify = page.getByRole("checkbox", {
    name: "Notify me of action Notices",
  });
  await expect(notify).not.toBeChecked();
  await notify.check();
  await expect(notify).toBeChecked();
  await expect(
    page.getByRole("checkbox", { name: "Play a sound" }),
  ).toBeChecked();

  // The stream opens once they are on; give it a moment to connect.
  await page.waitForTimeout(500);
  await office.raiseNotice({ kind: "info", title: "PR #3 opened" });
  const id = await office.raiseNotice({
    kind: "action",
    title: "PR #14 awaiting your approval",
  });
  await expect.poll(shownSoFar).toEqual([
    {
      title: "PR #14 awaiting your approval",
      body: "Needs your action.",
      tag: id,
    },
  ]);

  // The setting is kept in this browser.
  await page.reload();
  await expect(notify).toBeChecked();
});
