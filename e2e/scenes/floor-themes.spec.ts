import { floorThemes } from "@ai-office/shared";
import { expect, test } from "@playwright/test";

// A Floor in each 3D theme (PRD FR-57, FR-99): each added from the built-in
// Floor Template the theme is first for, with that template's starting
// team, so each desk is dressed as its Role is. Drawn at Medium, the
// quality the frame-rate target is for: from the default overview, then
// close up on the theme along the Floor's left wall.

const floors = [
  ["office", "development"],
  ["stockroom", "online-store"],
  ["studio", "website-and-marketing"],
  ["editorial", "content-and-blog"],
  ["library", "documentation"],
  ["atelier", "design-system"],
  ["observatory", "data-and-analytics"],
  ["data-centre", "infrastructure"],
  ["device-lab", "mobile-app"],
] as const;

test("covers every theme", () => {
  expect(floors.map(([theme]) => theme).sort()).toEqual(
    [...floorThemes].sort(),
  );
});

for (const [theme, template] of floors) {
  test(`a Floor in the ${theme} theme, from ${template}`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const shoot = async (view: "overview" | "theme", name: string) => {
      await page.goto(
        `/scene-fixtures.html?template=${template}&quality=medium&view=${view}`,
      );
      await page.waitForFunction(
        () => document.body.dataset["ready"] === "true",
        undefined,
        { timeout: 90_000 },
      );
      expect(errors).toEqual([]);
      await expect(page).toHaveScreenshot(name);
    };
    // The whole Floor, as the Owner first sees it.
    await shoot("overview", `floor-${theme}.png`);
    // And its theme close up, where each of its props counts.
    await page.setViewportSize({ width: 960, height: 540 });
    await shoot("theme", `floor-${theme}-close.png`);
  });
}
