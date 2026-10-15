import { expect, test, type Page } from "@playwright/test";

// Screenshot tests of the 3D Office's key scenes (PRD §9, Visual): the
// lobby, its reception desk close in (the Communications Agent, the
// envelopes in its out-tray and a failing Connection's red marker, FR-96),
// a Floor, that Floor with what floats above its Agents' heads (their
// Context Usage bars and tokens today, FR-62 and FR-85), its meeting room
// and the Avatar Editor's preview, each
// drawn by the Office's own components from fixed data (fixed seeds for
// the Avatars, fixed Notices and monitors) and seen from a fixed camera
// (apps/web/screenshots/), with reduced motion so nothing moves. Each is
// compared with its reference picture in reference/.
//
// The tolerance: a pixel counts as changed only when its colour moves past
// `threshold` (pixelmatch's perceptual distance, 0 to 1; Playwright's
// default), and a picture fails when more than `maxDiffPixels` of its
// pixels change. Software WebGL draws the same build to the same pixels:
// eight runs, at 1 to 4 workers and on 2 CPUs, differed by none. The
// smallest change that matters, one Agent on the Floor stopping work (its
// monitor dark, its hands off the keyboard), is 252 pixels, and another
// hair colour in the Avatar Editor's preview is 418. So 100 pixels catch
// those and leave room for a scatter of edge pixels drawn differently on
// another CPU, never for anything moved, recoloured, missing or relit.
// Only the canvas is compared, so fonts play no part, except in the scene
// of the displays above the Agents' heads, which are HTML over the canvas:
// that one compares the canvas and its labels together.
const tolerance = { threshold: 0.2, maxDiffPixels: 100 } as const;

/**
 * The WebGL renderer the page draws with: SwiftShader, Chromium's software
 * one, or the pictures would not be comparable.
 */
async function renderer(page: Page): Promise<string> {
  return page.evaluate(() => {
    const context = document.createElement("canvas").getContext("webgl2");
    if (context === null) {
      return "none";
    }
    const info = context.getExtension("WEBGL_debug_renderer_info");
    return String(
      context.getParameter(
        info === null ? context.RENDERER : info.UNMASKED_RENDERER_WEBGL,
      ),
    );
  });
}

/** Opens a scene's page and waits until it has drawn and settled. */
async function openScene(page: Page, scene: string): Promise<void> {
  await page.goto(`/?scene=${scene}`);
  const html = page.locator("html");
  await expect(html).toHaveAttribute("data-scene", /^(ready|failed)$/, {
    timeout: 60_000,
  });
  const error = await html.getAttribute("data-scene-error");
  expect(error, "The scene could not be drawn.").toBeNull();
  expect(await renderer(page)).toContain("SwiftShader");
}

test("the lobby", async ({ page }) => {
  await openScene(page, "lobby");
  await expect(page.locator("canvas")).toHaveScreenshot("lobby.png", tolerance);
});

test("the lobby's reception desk, with a failing Connection's marker", async ({
  page,
}) => {
  await openScene(page, "reception");
  await expect(page.locator("canvas")).toHaveScreenshot(
    "reception.png",
    tolerance,
  );
});

test("a Floor", async ({ page }) => {
  await openScene(page, "floor");
  await expect(page.locator("canvas")).toHaveScreenshot("floor.png", tolerance);
});

test("a Floor's Context Usage bars and tokens above its Agents' heads", async ({
  page,
}) => {
  await openScene(page, "above-head");
  // One over every Agent, the first drawn (the Manager's) included.
  await expect(page.locator("[data-above-head]")).toHaveCount(7);
  // The busy coder: its Context Usage bar, amber at 62%, and its tokens.
  const busy = page.locator("[data-above-head='ada']");
  await expect(busy.locator("[data-context-usage='amber']")).toHaveText("62%");
  await expect(busy.locator("[data-tokens-today='neutral']")).toHaveText(
    "128k today",
  );
  // The idle designer: its tokens only.
  const idle = page.locator("[data-above-head='dieter']");
  await expect(idle.locator("[data-context-usage]")).toHaveCount(0);
  await expect(idle).toHaveText("9.4k today");
  // From 80% of the daily cap, amber; at it, red.
  await expect(
    page.locator("[data-above-head='linus'] [data-tokens-today='warning']"),
  ).toHaveText("812k today");
  await expect(
    page.locator("[data-above-head='hedy'] [data-tokens-today='reached']"),
  ).toHaveText("1M today");
  await expect(page.locator("[data-scene-view]")).toHaveScreenshot(
    "above-head.png",
    tolerance,
  );
});

test("the meeting room", async ({ page }) => {
  await openScene(page, "meeting-room");
  await expect(page.locator("canvas")).toHaveScreenshot(
    "meeting-room.png",
    tolerance,
  );
});

test("the Avatar Editor's preview", async ({ page }) => {
  await openScene(page, "avatar-editor");
  await expect(page.locator("canvas")).toHaveScreenshot(
    "avatar-editor.png",
    tolerance,
  );
});
