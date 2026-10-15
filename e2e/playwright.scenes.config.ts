import { defineConfig, devices } from "@playwright/test";

// The 3D scenes' screenshot tests (PRD §9, Visual), in headless Chromium
// with WebGL drawn in software (SwiftShader, through ANGLE, as in CI), so no
// GPU is needed and a GPU on the machine changes nothing. Two sets, each
// with its own page and server:
//
// - The Floor themes (`floor-themes.spec.ts`, project `chromium`): scenes
//   at fixed seeds, compared with the screenshots kept beside the spec.
//   Vite alone serves the fixture page (apps/web/scene-fixtures.html) on
//   3047, so they need no server, database or build.
// - The 3D Office's key scenes (`scenes.spec.ts`, project `key-scenes`):
//   the lobby, a Floor, the meeting room and the Avatar Editor's preview,
//   from fixed data and a fixed camera (apps/web/screenshots/). The page is
//   built and served on 3049 by `pnpm --filter @ai-office/web
//   screenshots:serve`. Their reference pictures are in scenes/reference/.
//
// `pnpm scenes` runs both; `pnpm scenes --update-snapshots` takes new
// reference pictures after a change to how a scene looks, which are
// committed.
const ci = process.env["CI"] !== undefined && process.env["CI"] !== "";
const themesPort = 3047;
const themesURL = `http://localhost:${String(themesPort)}`;
const scenesURL = "http://127.0.0.1:3049";

export default defineConfig({
  testDir: "./scenes",
  fullyParallel: true,
  forbidOnly: ci,
  // CI only compares: a missing reference fails there, never gets written.
  updateSnapshots: ci ? "none" : "missing",
  // Never retried: a retry would hide a flaky picture, which the
  // tolerances are there to absorb.
  retries: 0,
  workers: ci ? 2 : 3,
  reporter: ci
    ? [["github"], ["list"], ["html", { open: "never" }]]
    : [["list"], ["html", { open: "never" }]],
  outputDir: "test-results/scenes",
  use: {
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      testMatch: "floor-themes.spec.ts",
      // Software rendering is slow: a scene takes seconds to draw, and each
      // test draws two.
      timeout: 300_000,
      expect: {
        // Waiting for two screenshots alike, of a scene that takes seconds
        // to draw.
        timeout: 60_000,
        toHaveScreenshot: {
          // SwiftShader draws the same scene alike, but not always bit for
          // bit, from one CPU to another. A theme's props are close in
          // colour to the floor (birch parcels on oak), so a pixel counts
          // as changed at a small difference, and a prop the size of a
          // pallet, close up, is well over this share of them.
          maxDiffPixelRatio: 0.002,
          threshold: 0.1,
          animations: "disabled",
        },
      },
      use: {
        ...devices["Desktop Chrome"],
        baseURL: themesURL,
        viewport: { width: 1280, height: 720 },
        deviceScaleFactor: 1,
        launchOptions: {
          args: [
            "--use-gl=angle",
            "--use-angle=swiftshader",
            "--enable-unsafe-swiftshader",
          ],
        },
      },
    },
    {
      name: "key-scenes",
      testMatch: "scenes.spec.ts",
      // The reference pictures, beside the tests. They are Linux's: another
      // system has none, so its run fails as missing rather than comparing.
      snapshotPathTemplate: "{testDir}/reference/{arg}-{platform}{ext}",
      // Software rendering is slow: the first frames compile every shader.
      timeout: 90_000,
      expect: { timeout: 30_000 },
      use: {
        ...devices["Desktop Chrome"],
        baseURL: scenesURL,
        viewport: { width: 1280, height: 720 },
        deviceScaleFactor: 1,
        colorScheme: "light",
        reducedMotion: "reduce",
        launchOptions: {
          // WebGL in software, the same on every machine with or without a
          // GPU: ANGLE on SwiftShader, which Chromium otherwise only falls
          // back to.
          args: [
            "--use-angle=swiftshader",
            "--enable-unsafe-swiftshader",
            "--ignore-gpu-blocklist",
          ],
        },
      },
    },
  ],
  webServer: [
    {
      command: `pnpm --filter @ai-office/web exec vite --port ${String(themesPort)} --strictPort`,
      url: `${themesURL}/scene-fixtures.html`,
      reuseExistingServer: !ci,
      timeout: 120_000,
    },
    {
      command: "pnpm --filter @ai-office/web screenshots:serve",
      url: scenesURL,
      reuseExistingServer: !ci,
      timeout: 120_000,
    },
  ],
});
