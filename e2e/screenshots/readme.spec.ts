import { fileURLToPath } from "node:url";

import type { OfficeEvent } from "@ai-office/events/schema";
import {
  agentListSchema,
  sessionResponseSchema,
  type WorkingNow,
} from "@ai-office/shared";
import type { Page } from "@playwright/test";

import { testAction } from "../support/control.ts";
import { expect, signIn, test } from "../support/office.ts";

// Takes the README's screenshots: the Office and one of its Floors, given a Floor, Notices, an
// Agent's work, requests through the AI Gateway and an AI Account, then
// each page as the Owner sees it.

const imagesDir = fileURLToPath(new URL("../../docs/images/", import.meta.url));

const heading = (page: Page, name: string) =>
  page.getByRole("heading", { level: 1, name });

/** Scrolls the heading to the top of the page. */
async function scrollTo(page: Page, name: string) {
  await page.getByRole("heading", { name }).evaluate((element) => {
    element.scrollIntoView({ block: "start" });
  });
}

/** Waits for the page to settle, then screenshots it as `name`.png. */
async function shoot(page: Page, name: string, fullPage = false) {
  await page.waitForLoadState("networkidle");
  await page.screenshot({ path: `${imagesDir}${name}.png`, fullPage });
}

test("the README's screenshots", async ({ office, page }) => {
  office.github.installRepository("adrianeyre/web-shop");
  for (const title of ["Add a basket", "Add a wish list"]) {
    office.github.createIssue("adrianeyre/web-shop", {
      title,
      body: "## Acceptance criteria\n\n- [ ] It works",
    });
  }
  await office.setUp();
  await signIn(page);
  await expect(heading(page, "Office")).toBeVisible();

  // A Floor, its team and Notices.
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
  await office.raiseNotice({
    kind: "info",
    title: "PR #12 merged by the App",
    floorId: "web-shop",
  });

  // The coder's work.
  const subject = {
    version: 1,
    floorId: "web-shop",
    agentId: coder.id,
    issue: 1,
    sandboxId: "sbx-readme",
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
  ];
  for (const event of events) {
    await office.publish(event);
  }

  // Requests through the Gateway, over the last day.
  const hoursAgo = (hours: number) =>
    new Date(Date.now() - hours * 3_600_000).toISOString();
  await office.recordGatewayRequests(
    Array.from({ length: 24 }, (_, hour) => ({
      startedAt: hoursAgo(hour + 0.5),
      model: hour % 3 === 0 ? "claude-haiku-5-5" : "claude-opus-5-5",
      account: hour % 4 === 0 ? "Claude Max" : "Work",
      status: hour === 5 ? 529 : 200,
      latencyMs: 600 + ((hour * 137) % 900),
      inputTokens: 8_000 + ((hour * 3_217) % 30_000),
      outputTokens: 1_500 + ((hour * 911) % 6_000),
      cacheReadInputTokens: 40_000 + ((hour * 7_919) % 80_000),
      estimatedCostUsd: 0.2 + ((hour * 37) % 90) / 100,
      floorId: "web-shop",
      agentId: coder.id,
      issue: 1 + (hour % 2),
    })),
  );

  // An AI Account.
  const session = sessionResponseSchema.parse(
    await (await page.request.get("/api/session")).json(),
  );
  await page.request.post("/api/ai-accounts", {
    headers: { "x-csrf-token": session.csrfToken },
    data: {
      name: "Work",
      aiProvider: "Claude",
      accountType: "api_key",
      credential: "sk-ant-api03-readme-screenshot-key-0000000000",
    },
  });

  await page.goto("/");
  await expect(page.getByRole("button", { name: "Lift" })).toBeVisible();
  await page.waitForTimeout(3_000);
  await shoot(page, "office");

  // A Floor: up the lift to web-shop, its team at their desks.
  const floorsList = page.getByRole("navigation", { name: "Floors" });
  if (!(await floorsList.isVisible())) {
    await page.getByRole("button", { name: "Lift" }).click();
  }
  await floorsList.getByRole("button", { name: /web-shop/ }).click();
  await expect(
    page.getByRole("button", { name: "Chat with the Manager" }),
  ).toBeVisible();
  await page.waitForTimeout(6_000);
  await shoot(page, "office-floor");

  // The Overview, at a busy moment: the stand-in sandbox runner ends each
  // task at once, so the page is given one, of the Floor's own team.
  const manager = team.find(({ role }) => role === "manager");
  const reviewer = team.find(({ role }) => role === "reviewer");
  const minutesAgo = (minutes: number) =>
    new Date(Date.now() - minutes * 60_000).toISOString();
  const busy: WorkingNow = {
    work: [
      {
        id: 1,
        floorId: "web-shop",
        floorName: "web-shop",
        repository: "adrianeyre/web-shop",
        issue: 1,
        issueTitle: "Add a basket",
        stage: "needs-work",
        status: "running",
        agentId: coder.id,
        agentName: coder.name,
        role: "coder",
        queuedAt: minutesAgo(14),
        startedAt: minutesAgo(13),
        latest: {
          kind: "tool",
          text: "Bash pnpm test",
          at: minutesAgo(0),
        },
      },
      {
        id: 2,
        floorId: "web-shop",
        floorName: "web-shop",
        repository: "adrianeyre/web-shop",
        issue: 2,
        issueTitle: "Add a wish list",
        stage: "needs-review",
        status: "queued",
        agentId: reviewer?.id ?? null,
        agentName: reviewer?.name ?? null,
        role: "reviewer",
        queuedAt: minutesAgo(3),
        startedAt: null,
        latest: null,
      },
    ],
    managers: [
      {
        floorId: "web-shop",
        floorName: "web-shop",
        agentId: manager?.id ?? null,
        agentName: manager?.name ?? "The Manager",
        phase: "writing",
        since: minutesAgo(1),
      },
    ],
  };
  await page.route("**/api/working-now", (route) =>
    route.fulfill({ json: busy }),
  );
  await page.goto("/overview");
  await expect(page.getByRole("table", { name: "Agents' work" })).toBeVisible();
  await shoot(page, "overview");
  await page.unroute("**/api/working-now");

  await page.goto("/notices");
  await expect(
    page.getByRole("heading", { name: "PR #14 awaiting your approval" }),
  ).toBeVisible();
  await shoot(page, "notice-board");

  await page.goto("/activity");
  await expect(page.getByText("Adding the basket page.").first()).toBeVisible();
  await shoot(page, "activity");

  await page.goto("/gateway");
  await expect(heading(page, "Gateway requests")).toBeVisible();
  await expect(page.getByText("claude-opus-5-5").first()).toBeVisible();
  await shoot(page, "gateway-requests");

  await page.goto("/analytics");
  await expect(page.getByText("claude-opus-5-5").first()).toBeVisible();
  await page.waitForTimeout(1_000);
  await shoot(page, "analytics");

  await page.goto("/ai-settings");
  await expect(
    page.getByRole("listitem", { name: "Work" }).first(),
  ).toBeVisible();
  await scrollTo(page, "AI Accounts");
  await shoot(page, "ai-settings");

  await page.goto("/general-settings");
  await expect(page.getByRole("heading", { name: "Storage" })).toBeVisible();
  await expect(page.getByText(/The database takes/)).toBeVisible();
  await scrollTo(page, "Prompt cache TTL");
  await shoot(page, "admin-storage");

  await page.goto("/agent-settings?floor=web-shop");
  await expect(
    page.getByRole("tablist", { name: /^Agents on / }),
  ).toBeVisible();
  await page.getByRole("tab", { name: coder.name, exact: true }).click();
  await expect(page.getByLabel("Daily Token Cap")).toBeVisible();
  await shoot(page, "agent-settings");

  await page.goto("/floor-settings");
  await expect(
    page.getByRole("heading", { name: "GitHub", exact: true }),
  ).toBeVisible();
  await shoot(page, "floor-settings");

  await page.goto(`/floors/web-shop/agents/${coder.id}`);
  await expect(page.getByText("Adding the basket page.").first()).toBeVisible();
  await shoot(page, "agent-live-view");
});
