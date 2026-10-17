import type { OfficeEvent } from "@ai-office/events/schema";
import { agentListSchema } from "@ai-office/shared";
import type { Page } from "@playwright/test";

import { expectAccessible } from "../support/accessibility.ts";
import { testAction } from "../support/control.ts";
import {
  expect,
  ownerPassword,
  signIn,
  test,
  type Office,
} from "../support/office.ts";

// Every page and panel against axe-core (PRD §7: every page, the policies'
// dialogs included, meets WCAG 2.2 AA), in a real browser against the built
// app, Postgres and a fake GitHub. The Office is given something on every
// page first (a Floor, Notices, events, Gateway requests and a Batch), so
// each is checked as the Owner sees it in use, not only empty. The signed-in
// pages are checked in light and in dark mode, each in a test of its own.
// A serious or critical violation fails; see `support/accessibility.ts`.

const colourSchemes = ["light", "dark"] as const;

/** The level-1 heading every page has. */
const pageHeading = (page: Page, name: string | RegExp) =>
  page.getByRole("heading", { level: 1, name });

test("the setup and sign-in screens", async ({ office, page }) => {
  for (const colorScheme of colourSchemes) {
    await page.emulateMedia({ colorScheme });
    await page.goto("/setup");
    await expect(
      page.getByRole("heading", { name: "Welcome to AI Office" }),
    ).toBeVisible();
    await expectAccessible(page, `setup (${colorScheme})`);
    // With the password refused, its message beside the field.
    await page.getByLabel("Password", { exact: true }).fill("short");
    await page.getByRole("button", { name: "Set password" }).click();
    await expect(page.getByText("Use at least 12 characters.")).toBeVisible();
    await expectAccessible(page, `setup, password refused (${colorScheme})`);
  }

  await office.setUp();
  for (const colorScheme of colourSchemes) {
    await page.emulateMedia({ colorScheme });
    await page.goto("/login");
    await expect(pageHeading(page, "Sign in")).toBeVisible();
    await expectAccessible(page, `sign in (${colorScheme})`);
    await signIn(page, `${ownerPassword}-wrong`);
    await expect(page.getByText("That password is not right.")).toBeVisible();
    await expectAccessible(page, `sign in, wrong password (${colorScheme})`);
  }
});

/** An Agent, as the checks below need it. */
interface Named {
  readonly id: string;
  readonly name: string;
}

/** Adds the web-shop Floor in Floor Settings; resolves with its coder. */
async function addFloor(office: Office, page: Page): Promise<Named> {
  await page.goto("/floor-settings");
  await page
    .getByRole("button", { name: "Add adrianeyre/web-shop as a Floor" })
    .click();
  await expect(page.getByText("Already a Floor")).toBeVisible();
  const team = agentListSchema.parse(
    await (await page.request.get("/api/floors/web-shop/agents")).json(),
  ).agents;
  const coder = team.find(({ role }) => role === "coder");
  if (coder === undefined) {
    throw new Error("The new Floor has no coder.");
  }
  await office.raiseNotice({
    kind: "action",
    title: "PR #14 awaiting your approval",
    floorId: "web-shop",
    agentId: coder.id,
    issue: {
      number: 1,
      url: "https://github.com/adrianeyre/web-shop/issues/1",
    },
    pullRequest: {
      number: 14,
      url: "https://github.com/adrianeyre/web-shop/pull/14",
    },
    actions: [testAction],
  });
  return coder;
}

/**
 * Gives the Office something on every page: the web-shop Floor and its
 * team, Notices of both kinds, the coder's work, requests through the
 * Gateway and a Batch whose Plan awaits approval. Resolves with the coder.
 */
async function putToUse(office: Office, page: Page): Promise<Named> {
  office.github.installRepository("adrianeyre/web-shop");
  for (const title of ["Add a basket", "Add a wish list"]) {
    office.github.createIssue("adrianeyre/web-shop", {
      title,
      body: "## Acceptance criteria\n\n- [ ] It works",
    });
  }
  await office.setUp();
  await signIn(page);
  await expect(pageHeading(page, "Office")).toBeVisible();

  // A Floor, with its team, and Notices of both kinds.
  const coder = await addFloor(office, page);
  await office.raiseNotice({
    kind: "info",
    title: "PR #12 merged by the App",
    floorId: "web-shop",
  });

  // The coder's work, for its live view and the Activity Feed.
  const subject = {
    version: 1,
    floorId: "web-shop",
    agentId: coder.id,
    issue: 1,
    sandboxId: "sbx-e2e",
  } as const;
  const events: OfficeEvent[] = [
    { type: "sandbox.started", ...subject, branch: "ai-office/1-add-a-basket" },
    { type: "sandbox.text", ...subject, text: "Adding the basket page." },
    { type: "sandbox.tool_call", ...subject, name: "Bash", args: "pnpm test" },
    {
      type: "sandbox.diff",
      ...subject,
      path: "src/basket.ts",
      diff: "-export const total = 0;\n+export const total = sum(items);",
      added: 1,
      removed: 1,
    },
    {
      type: "model_call.completed",
      version: 1,
      floorId: "web-shop",
      agentId: coder.id,
      issue: 1,
      aiAccount: "claude-1",
      aiProvider: "Claude",
      model: "claude-opus-5-5",
      status: 200,
      latencyMs: 812,
      inputTokens: 1200,
      outputTokens: 300,
      cacheReadTokens: 0,
      cacheWriteTokens: null,
    },
  ];
  for (const event of events) {
    await office.publish(event);
  }

  // Requests through the Gateway, for its history and the analytics.
  const hoursAgo = (hours: number) =>
    new Date(Date.now() - hours * 3_600_000).toISOString();
  await office.recordGatewayRequests([
    {
      startedAt: hoursAgo(1),
      model: "claude-opus-5-5",
      account: "Work",
      status: 200,
      latencyMs: 1_200,
      inputTokens: 40_000,
      outputTokens: 10_000,
      cacheReadInputTokens: 120_000,
      estimatedCostUsd: 0.9,
      floorId: "web-shop",
      agentId: coder.id,
      issue: 1,
    },
    {
      startedAt: hoursAgo(1),
      model: "claude-haiku-5-5",
      account: "Work",
      status: 400,
      latencyMs: 90,
      inputTokens: 0,
      outputTokens: 0,
      estimatedCostUsd: null,
      ownerTool: "laptop",
    },
    {
      startedAt: hoursAgo(2),
      model: "grok-5",
      account: "xAI",
      status: 529,
      latencyMs: 300,
      inputTokens: 0,
      outputTokens: 0,
      estimatedCostUsd: null,
      ownerTool: "laptop",
    },
  ]);

  // A Batch, whose Plan awaits approval on the whiteboard.
  await page.goto("/floors/web-shop/manager");
  await expect(page.getByRole("status", { name: "Connection" })).toHaveText(
    "Live",
  );
  const box = page.getByLabel(/^Message /);
  await box.fill("complete issues 1 to 2");
  await box.press("Enter");
  await expect(
    page
      .getByRole("log", { name: "Manager chat" })
      .locator('[data-kind="command"]'),
  ).toContainText("Plan approval is on for this Floor");
  return coder;
}

/** Every page, with what shows once it holds what `putToUse` gave it. */
const pages = (
  coder: Named,
): readonly {
  readonly name: string;
  readonly url: string;
  readonly heading: string | RegExp;
  readonly ready: (page: Page) => ReturnType<Page["getByText"]>;
}[] => [
  {
    name: "Office (lobby)",
    url: "/",
    heading: "Office",
    ready: (page) => page.getByRole("button", { name: "Lift" }),
  },
  {
    name: "Notice Board",
    url: "/notices",
    heading: "Notice Board",
    ready: (page) =>
      page.getByRole("heading", { name: "PR #14 awaiting your approval" }),
  },
  {
    name: "Activity",
    url: "/activity",
    heading: "Activity",
    ready: (page) => page.getByText("Adding the basket page.").first(),
  },
  {
    name: "Gateway requests",
    url: "/gateway",
    heading: "Gateway requests",
    ready: (page) => page.getByRole("row", { name: "Request 3" }),
  },
  {
    name: "a Gateway request",
    url: "/gateway/requests/1",
    heading: "Request 1",
    ready: (page) => page.getByText("claude-opus-5-5").first(),
  },
  {
    name: "Analytics",
    url: "/analytics",
    heading: "Analytics",
    ready: (page) => page.getByText("claude-opus-5-5").first(),
  },
  {
    name: "Branches",
    url: "/branches?floor=web-shop",
    heading: "Branches",
    ready: (page) => page.getByText("read from GitHub at"),
  },
  {
    name: "Agent Settings, a Floor",
    url: "/agent-settings?floor=web-shop",
    heading: "Agent Settings",
    ready: (page) => page.getByRole("tablist", { name: /^Agents on / }),
  },
  {
    name: "Agent Settings, the lobby",
    url: "/agent-settings?floor=lobby",
    heading: "Agent Settings",
    ready: (page) =>
      page.getByRole("heading", { name: /, the Communications Agent$/ }),
  },
  {
    name: "AI Settings",
    url: "/ai-settings",
    heading: "AI Settings",
    ready: (page) => page.getByRole("heading", { name: "AI Accounts" }),
  },
  {
    name: "Floor Settings",
    url: "/floor-settings",
    heading: "Floor Settings",
    ready: (page) => page.getByRole("link", { name: "web-shop", exact: true }),
  },
  {
    name: "General Settings",
    url: "/general-settings",
    heading: "General Settings",
    ready: (page) => page.getByRole("heading", { name: "Appearance" }),
  },
  {
    name: "the Role library",
    url: "/general-settings/roles",
    heading: "Role library",
    ready: (page) => page.getByRole("table", { name: "Roles" }),
  },
  {
    name: "the Floor Templates",
    url: "/general-settings/templates",
    heading: "Floor Templates",
    ready: (page) => page.getByRole("table", { name: "Floor Templates" }),
  },
  {
    name: "Connections",
    url: "/general-settings/connections",
    heading: "Connections",
    ready: (page) => page.getByRole("form", { name: "Add a Connection" }),
  },
  {
    name: "a Floor's settings",
    url: "/floor-settings/web-shop",
    heading: "web-shop",
    ready: (page) =>
      page.getByRole("link", { name: "Open web-shop's Agent Settings" }),
  },
  {
    name: "an Agent's live view",
    url: `/floors/web-shop/agents/${coder.id}`,
    heading: coder.name,
    ready: (page) => page.getByText("Adding the basket page."),
  },
  {
    name: "the Manager chat",
    url: "/floors/web-shop/manager",
    heading: /^Chat with /,
    ready: (page) =>
      page
        .getByRole("log", { name: "Manager chat" })
        .locator('[data-kind="command"]'),
  },
  {
    name: "the whiteboard",
    url: "/floors/web-shop/whiteboard?batch=1",
    heading: "Whiteboard",
    ready: (page) =>
      page.getByRole("heading", { name: "Batch 1: Awaiting approval" }),
  },
  {
    name: "a page that does not exist",
    url: "/nowhere",
    heading: "Page not found",
    ready: (page) => page.getByText("There is no page at this address."),
  },
];

for (const colorScheme of colourSchemes) {
  test(`every page, in use (${colorScheme})`, async ({ office, page }) => {
    test.setTimeout(120_000);
    const coder = await putToUse(office, page);
    await page.emulateMedia({ colorScheme });
    for (const { name, url, heading, ready } of pages(coder)) {
      await page.goto(url);
      await expect(pageHeading(page, heading)).toBeVisible();
      await expect(ready(page)).toBeVisible();
      await expectAccessible(page, `${name} (${colorScheme})`);
    }
  });
}

// The narrowest screen the Office is made for (PRD §7), in the darker
// scheme, where borders and muted text have the least room: every page is
// checked again, and none is wider than the screen.
test("every page, in use, on a 375 px phone (dark)", async ({
  office,
  page,
}) => {
  test.setTimeout(120_000);
  const coder = await putToUse(office, page);
  await page.setViewportSize({ width: 375, height: 812 });
  await page.emulateMedia({ colorScheme: "dark" });
  for (const { name, url, heading, ready } of pages(coder)) {
    // The phone's Office is in 2D, without the lift.
    if (url === "/") {
      continue;
    }
    await page.goto(url);
    await expect(pageHeading(page, heading)).toBeVisible();
    await expect(ready(page)).toBeVisible();
    await expectAccessible(page, `${name} (375 px, dark)`);
    const overflow = await page.evaluate(
      () =>
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
    );
    expect.soft(overflow, `${name} scrolls sideways at 375 px`).toBe(0);
  }
});

for (const colorScheme of colourSchemes) {
  test(`the 3D Office's panels (${colorScheme})`, async ({ office, page }) => {
    // The scene is drawn on the CPU here (no GPU), which slows everything
    // the page does. The panels are the same HTML at every quality and with
    // or without motion, so the scene is drawn at Low, and the lift arrives
    // at once.
    test.setTimeout(180_000);
    await page.addInitScript(() => {
      localStorage.setItem(
        "ai-office:scene-settings",
        JSON.stringify({ state: { quality: "low" }, version: 0 }),
      );
    });
    await page.emulateMedia({ reducedMotion: "reduce" });
    office.github.installRepository("adrianeyre/web-shop");
    await office.setUp();
    await signIn(page);
    await expect(pageHeading(page, "Office")).toBeVisible();
    const coder = await addFloor(office, page);
    await page.emulateMedia({ colorScheme });

    // The lobby, with every panel over the scene open. The lift's floor
    // picker starts open.
    await page.goto("/");
    await page.getByRole("button", { name: "Inspect" }).click();
    await page.getByRole("button", { name: "Scene settings" }).click();
    await expect(
      page.getByRole("navigation", { name: "Floors" }),
    ).toBeVisible();
    await expect(
      page.getByRole("navigation", { name: "Objects to inspect" }),
    ).toBeVisible();
    await expect(page.getByLabel("Reduce motion")).toBeVisible();
    await expectAccessible(page, `the lobby's panels (${colorScheme})`);

    // Each inspectable object's panel, opened from its address.
    for (const address of [
      "/?inspect=notice-board:office",
      `/?floor=web-shop&inspect=monitor:${coder.id}`,
      "/?floor=web-shop&inspect=whiteboard:web-shop",
      "/?floor=web-shop&inspect=wall-board:web-shop",
      "/?floor=web-shop&inspect=bookshelf:web-shop",
    ]) {
      await page.goto(address);
      await expect(page.getByRole("dialog")).toBeVisible({ timeout: 15_000 });
      await expectAccessible(page, `${address} (${colorScheme})`);
    }
  });
}

for (const colorScheme of colourSchemes) {
  test(`the editors and forms that open in place (${colorScheme})`, async ({
    office,
    page,
  }) => {
    // Four pages and six axe passes: 25–30 s even with nothing else running.
    test.setTimeout(90_000);
    office.github.installRepository("adrianeyre/web-shop");
    await office.setUp();
    await signIn(page);
    await expect(pageHeading(page, "Office")).toBeVisible();
    const coder = await addFloor(office, page);
    await page.emulateMedia({ colorScheme });

    // Agent Settings' Agent editor, then the Floor's settings' archiving
    // confirmation.
    await page.goto("/agent-settings?floor=web-shop");
    await page
      .getByRole("button", { name: `Edit ${coder.name}`, exact: true })
      .click();
    // The first Agent's tab has an editor open too.
    await expect(
      page
        .getByRole("form", { name: `Edit ${coder.name}` })
        .last()
        .getByLabel("Extra instructions"),
    ).toBeVisible();
    await expectAccessible(page, `the Agent editor (${colorScheme})`);
    await page.goto("/floor-settings/web-shop");
    await page.getByRole("button", { name: "Archive Floor" }).click();
    await expect(
      page.getByRole("button", { name: "Archive web-shop" }),
    ).toBeVisible();
    await expectAccessible(page, `archiving a Floor (${colorScheme})`);

    // The Role library: a Role's form, a new one's, and deleting's
    // confirmation (for docs, which no Floor Template starts Floors with).
    await page.goto("/general-settings/roles");
    await page.getByRole("button", { name: "Open coder" }).click();
    await page.getByRole("button", { name: "New Role" }).click();
    await page.getByRole("button", { name: "Delete docs" }).click();
    await expect(
      page.getByRole("button", { name: "Yes, delete docs" }),
    ).toBeVisible();
    await expect(page.getByRole("form", { name: "Edit coder" })).toBeVisible();
    await expectAccessible(page, `the Role library's forms (${colorScheme})`);

    // The Floor Templates: a copy of Development in its editor, with its
    // full contents.
    await page.goto("/general-settings/templates");
    await page.getByRole("button", { name: "Duplicate Development" }).click();
    const copy = page.getByRole("form", { name: /^Edit Development copy/ });
    await expect(copy).toBeVisible();
    await page.locator("summary", { hasText: "Its full contents" }).click();
    await expect(
      page.getByRole("article", { name: "Role coder" }),
    ).toBeVisible();
    await expectAccessible(
      page,
      `the Floor Templates' editor (${colorScheme})`,
    );

    // AI Settings: a Claude subscription's terms, and a Gateway Key shown
    // once.
    await page.goto("/ai-settings");
    const accounts = page.getByRole("form", { name: "Add an AI Account" });
    await accounts
      .getByLabel("Account type")
      .selectOption({ label: "Claude subscription (Pro or Max)" });
    await expect(accounts.getByRole("checkbox")).toBeVisible();
    const keys = page.getByRole("form", { name: "Make a Gateway Key" });
    await keys.getByLabel("Tool").fill("laptop");
    await keys.getByRole("button", { name: "Make Gateway Key" }).click();
    await expect(keys.getByLabel("The key for laptop")).toBeVisible();
    await expectAccessible(
      page,
      `AI Settings' forms, part way (${colorScheme})`,
    );

    // General Settings: each way to add a Skill, and turning on TOTP, which asks for
    // the current password first.
    await page.goto("/general-settings");
    await page.getByRole("button", { name: "Turn on TOTP" }).click();
    const turnOn = page.getByRole("form", { name: "Turn on TOTP" });
    await turnOn.getByLabel("Your current password").fill(ownerPassword);
    await turnOn.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByLabel("Code from the app")).toBeVisible();
    await expectAccessible(
      page,
      `General Settings' forms, part way (${colorScheme})`,
    );
    for (const mode of ["Import from Git", "Write one"]) {
      await page.getByRole("button", { name: mode }).click();
      await expectAccessible(page, `adding a Skill: ${mode} (${colorScheme})`);
    }
  });
}

// The pages above are in the default theme. The others change the primary,
// accent and focus colours, so General Settings, which holds the most kinds of
// control, is checked in each, chosen in its Appearance card.
test("General Settings in every theme, in light and dark mode", async ({
  office,
  page,
}) => {
  test.setTimeout(120_000);
  office.github.installRepository("adrianeyre/web-shop");
  await office.setUp();
  await signIn(page);
  await expect(pageHeading(page, "Office")).toBeVisible();
  await addFloor(office, page);
  await page.goto("/general-settings");
  for (const mode of ["Light", "Dark"]) {
    await page.getByRole("radio", { name: mode, exact: true }).check();
    for (const theme of [
      "Neutral",
      "Indigo",
      "Ocean",
      "Emerald",
      "Rose",
      "Amber",
    ]) {
      await page.getByRole("radio", { name: theme, exact: true }).check();
      await expectAccessible(
        page,
        `General Settings, ${theme} (${mode.toLowerCase()})`,
      );
    }
  }
});

test("the Office in a browser without WebGL 2", async ({ office, page }) => {
  await page.addInitScript(() => {
    Reflect.deleteProperty(window, "WebGL2RenderingContext");
  });
  await office.setUp();
  await signIn(page);
  await expect(pageHeading(page, "Office")).toBeVisible();
  for (const colorScheme of colourSchemes) {
    await page.emulateMedia({ colorScheme });
    await page.goto("/");
    await expect(
      page.getByText(/This browser cannot show the 3D Office/),
    ).toBeVisible();
    await expectAccessible(page, `the Office without WebGL 2 (${colorScheme})`);
  }
});

test("the footer's dialogs, and the navigation on a narrow screen", async ({
  office,
  page,
}) => {
  await office.setUp();
  await signIn(page);
  await expect(pageHeading(page, "Office")).toBeVisible();
  await page.goto("/notices");
  for (const colorScheme of colourSchemes) {
    await page.emulateMedia({ colorScheme });
    for (const [opener, title] of [
      [/^Version: .+, changelog$/, "Changelog"],
      ["Privacy Policy", "Privacy Policy"],
      ["Terms and Conditions", "Terms and Conditions"],
      ["Cookie Policy", "Cookie Policy"],
      ["Accessibility", "Accessibility"],
    ] as const) {
      await page
        .getByRole("contentinfo")
        .getByRole("button", { name: opener })
        .click();
      const dialog = page.getByRole("dialog", { name: title });
      await expect(dialog).toBeVisible();
      await expectAccessible(page, `the ${title} dialog (${colorScheme})`);
      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
    }
  }

  // The menu that holds the navigation below the tablet breakpoint.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Open navigation" }).click();
  await expect(page.getByRole("navigation", { name: "Main" })).toBeVisible();
  await expectAccessible(page, "the navigation menu on a narrow screen");
});

// What axe cannot check: that the keyboard reaches everything and focus
// goes where it should (WCAG 2.1.1, 2.4.3, 2.4.11), in a real browser, whose
// modal dialogs (unlike jsdom's) make the page behind them inert.
test("the keyboard: the skip link, a policy dialog and an object's panel", async ({
  office,
  page,
}) => {
  test.setTimeout(90_000);
  // The scene drawn at Low, and the camera cutting to its views, as above.
  await page.addInitScript(() => {
    localStorage.setItem(
      "ai-office:scene-settings",
      JSON.stringify({ state: { quality: "low" }, version: 0 }),
    );
  });
  await page.emulateMedia({ reducedMotion: "reduce" });
  office.github.installRepository("adrianeyre/web-shop");
  await office.setUp();
  await signIn(page);
  await expect(pageHeading(page, "Office")).toBeVisible();
  await addFloor(office, page);

  // The skip link is the first thing the keyboard reaches, and leads to
  // the page's main content.
  await page.goto("/notices");
  await expect(pageHeading(page, "Notice Board")).toBeVisible();
  await page.keyboard.press("Tab");
  const skip = page.getByRole("link", { name: "Skip to main content" });
  await expect(skip).toBeFocused();
  await expect(skip).toBeInViewport();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("main")).toBeFocused();

  // A policy opens from the keyboard with focus on its close button; Tab
  // never leaves it for the page behind; Escape closes it and gives focus
  // back to its button.
  const opener = page
    .getByRole("contentinfo")
    .getByRole("button", { name: "Privacy Policy" });
  await opener.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Privacy Policy" });
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Close privacy policy" }),
  ).toBeFocused();
  const focusLeftTheDialog = () =>
    page.evaluate(() => {
      const focused = document.activeElement;
      return (
        focused !== null &&
        focused !== document.body &&
        focused.closest("dialog") === null
      );
    });
  let insideAgain = 0;
  for (let press = 0; press < 12; press += 1) {
    await page.keyboard.press("Tab");
    expect(await focusLeftTheDialog()).toBe(false);
    if (
      await dialog.evaluate((element) =>
        element.contains(document.activeElement),
      )
    ) {
      insideAgain += 1;
    }
  }
  expect(insideAgain).toBeGreaterThan(0);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(opener).toBeFocused();

  // The Office: the lift's floor picker rides to the Floor; Inspect lists
  // its objects, the arrow keys, Home and End move through them, Enter
  // opens one's panel with focus in it, and Escape closes it and gives
  // focus back to the list.
  await page.goto("/");
  const floors = page.getByRole("navigation", { name: "Floors" });
  await floors.getByRole("button", { name: /^web-shop/ }).focus();
  await page.keyboard.press("Enter");
  await expect(floors.getByRole("status")).toHaveText("You are in web-shop.", {
    timeout: 15_000,
  });
  const inspect = page.getByRole("button", { name: "Inspect" });
  await inspect.focus();
  await page.keyboard.press("Enter");
  await expect(inspect).toHaveAttribute("aria-expanded", "true");
  const objects = page
    .getByRole("navigation", { name: "Objects to inspect" })
    .getByRole("button");
  expect(await objects.count()).toBeGreaterThan(2);
  await page.keyboard.press("Tab");
  await expect(objects.first()).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(objects.nth(1)).toBeFocused();
  await page.keyboard.press("End");
  await expect(objects.last()).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(objects.first()).toBeFocused();
  await page.keyboard.press("ArrowUp");
  await expect(objects.last()).toBeFocused();
  await page.keyboard.press("Home");
  await expect(objects.first()).toBeFocused();
  await page.keyboard.press("ArrowDown");
  const chosen = (await objects.nth(1).textContent()) ?? "";
  await page.keyboard.press("Enter");
  const panel = page.getByRole("dialog", { name: chosen });
  await expect(panel).toBeVisible({ timeout: 15_000 });
  await expect(panel).toBeFocused();
  // Its header's buttons, in order: move it, fill the screen, close it.
  for (const name of ["Move panel", "Full screen", "Close panel"]) {
    await page.keyboard.press("Tab");
    await expect(panel.getByRole("button", { name })).toBeFocused();
  }
  await page.keyboard.press("Escape");
  await expect(panel).toBeHidden();
  await expect(objects.nth(1)).toBeFocused();
});
