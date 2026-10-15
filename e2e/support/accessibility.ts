import { AxeBuilder } from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

// axe-core's checks (PRD §7: every page meets WCAG 2.2 AA), run in the
// page as it is now. Every rule axe runs by default is run, WCAG 2.2 A
// and AA and axe's best practices; a serious or critical violation fails
// the test, naming the rule and the elements. Every violation, whatever
// its impact, is attached to the test's report.

/** The impacts that fail a check. */
const failing = new Set(["serious", "critical"]);

/** What is still loading: "Loading…", "Reading the memory…" and the like. */
const loading = /^(Loading|Reading|Checking)\b.*…$/;

/**
 * Waits until nothing on the page says it is still loading, and every
 * animation and transition has finished (a dialog fading in, a button
 * changing colour with the colour scheme), so the check sees what the
 * Owner will rather than a colour on its way.
 */
export async function settled(page: Page): Promise<void> {
  await expect(page.getByText(loading)).toHaveCount(0, { timeout: 15_000 });
  await page.waitForFunction(() =>
    document
      .getAnimations()
      .every(
        (animation) =>
          animation.playState !== "running" ||
          animation.effect?.getTiming().iterations === Infinity,
      ),
  );
}

/**
 * Runs axe on the page as it is, once it has settled, and fails on any
 * serious or critical violation (once the test ends, so the rest of its
 * pages are still checked). `what` names the page and its state in
 * the report, such as "General Settings (dark)".
 */
export async function expectAccessible(
  page: Page,
  what: string,
): Promise<void> {
  await test.step(`axe: ${what}`, async () => {
    await settled(page);
    const { violations } = await new AxeBuilder({ page }).analyze();
    await test.info().attach(`axe: ${what}`, {
      body: JSON.stringify(violations, null, 2),
      contentType: "application/json",
    });
    const serious = violations
      .filter(({ impact }) => failing.has(impact ?? ""))
      .map(
        ({ id, impact, help, nodes }) =>
          `${id} (${String(impact)}): ${help}, at ${nodes
            .map(({ target }) => target.join(" "))
            .join("; ")}`,
      );
    // Soft, so one run reports every page's violations, not only the first's.
    expect
      .soft(serious, `axe's serious and critical violations on ${what}`)
      .toEqual([]);
  });
}
