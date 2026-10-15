import { expect, signIn, test } from "../support/office.ts";

// In dark mode a select's options keep dark mode's colours: the browser
// draws them in its own list, so without their own background, light text
// landed on a white list and could not be read.

test("dropdown options are light text on a dark background in dark mode", async ({
  office,
  page,
}) => {
  await office.setUp();
  await page.emulateMedia({ colorScheme: "dark" });
  await signIn(page);
  await page.getByRole("link", { name: "API Key Management" }).click();
  const zone = page
    .getByRole("form", { name: "Owner's password settings" })
    .getByLabel("Time zone");
  await expect(zone).toBeVisible();
  const colours = await zone.evaluate((select) => {
    const option = (select as HTMLSelectElement).options[0];
    if (option === undefined) {
      throw new Error("The select has no options.");
    }
    const style = getComputedStyle(option);
    return { color: style.color, background: style.backgroundColor };
  });
  // The page's own colours in dark mode, oklch(0.985 0 0) on oklch(0.145 0 0).
  const lightness = (colour: string) =>
    Number(/oklch\(([\d.]+)/.exec(colour)?.[1] ?? Number.NaN);
  expect(lightness(colours.color)).toBeGreaterThan(0.9);
  expect(lightness(colours.background)).toBeLessThan(0.3);
});
