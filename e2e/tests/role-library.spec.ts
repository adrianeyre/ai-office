import { agentListSchema } from "@ai-office/shared";

import { expect, signIn, test } from "../support/office.ts";

// The Role library's admin (PRD FR-98, FR-65, FR-10), in a real browser
// against the built app, Postgres and the test's fake GitHub: a proofreader
// Role is made, a proofreader Agent is added to a Floor in it, then the
// Role's instructions are edited. The page says the edit reaches that
// Agent, the Activity Feed records each change, and the Agent's next task
// is given the new instructions. The stand-in sandbox runner records the
// task's prompt, then fails it, as no Docker runs here.

/** An issue body clear enough to work (FR-23). */
const withCriteria = (criterion: string): string =>
  `## Acceptance criteria\n\n- [ ] ${criterion}`;

test("makes a proofreader Role, adds a proofreader Agent to a Floor, then edits the Role's instructions", async ({
  office,
  page,
}) => {
  office.github.installRepository("adrianeyre/web-shop");
  await office.setUp();
  await signIn(page);
  await page.getByRole("link", { name: "General Settings" }).click();
  await page.getByRole("link", { name: "Open the Role library" }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: "Role library" }),
  ).toBeVisible();
  const roles = page.getByRole("table", { name: "Roles" });
  await expect(roles.getByRole("rowheader")).toHaveText([
    "coder",
    "reviewer",
    "QA",
    "docs",
    "designer",
  ]);

  // A proofreader Role, in the work Stage.
  await page.getByRole("button", { name: "New Role" }).click();
  const made = page.getByRole("form", { name: "New Role" });
  await made.getByLabel("Name").fill("proofreader");
  await expect(made.getByLabel("Stage")).toHaveValue("work");
  await made
    .getByLabel("Routing description")
    .fill("Proofreads the copy: spelling, grammar and house style.");
  await made
    .getByLabel("Instructions")
    .fill(
      "- Write in British English, in the brand's voice.\n- Commit the copy you change.",
    );
  await made.getByLabel("Desk dressing").selectOption("books");
  await made.getByLabel("Suggested AI Provider").selectOption("Claude");
  await made.getByRole("button", { name: "Make Role" }).click();
  await expect(
    page.getByText(
      "Made proofreader. Add an Agent in it from a Floor's admin.",
    ),
  ).toBeVisible();
  const proofreader = roles.getByRole("row", { name: /proofreader/ });
  await expect(proofreader.getByRole("cell")).toHaveText([
    "Work",
    "Proofreads the copy: spelling, grammar and house style.",
    "0",
    /Open/,
  ]);

  // A Floor, and a proofreader Agent on it: the Floor's settings offer the Role.
  await page.getByRole("link", { name: "Floor Settings" }).click();
  await page
    .getByRole("button", { name: "Add adrianeyre/web-shop as a Floor" })
    .click();
  await page.getByRole("link", { name: "web-shop", exact: true }).click();
  const add = page.getByRole("form", { name: "Add an Agent" });
  await add.getByLabel("Role").selectOption("proofreader");
  await add.getByLabel("Name").fill("Cora");
  await add.getByRole("button", { name: "Add Agent" }).click();
  await expect(
    page.getByText(
      "Added Cora, a proofreader Agent. Choose its AI Provider and Model below.",
    ),
  ).toBeVisible();
  const agents = page.getByRole("table", { name: "Agents on web-shop" });
  await expect(agents.getByRole("row", { name: /Cora/ })).toContainText(
    /Proofreader\s*Claude\s*claude-opus-5-5/,
  );
  // The proofreader is the Floor's only work-Stage Agent.
  const team = page.getByRole("form", { name: "Team size" });
  await expect(team.getByLabel("Proofreader")).toHaveValue("1");
  await team.getByLabel("Coder").fill("0");
  await team.getByRole("button", { name: "Save team" }).click();
  await expect(agents.getByRole("row", { name: /Coder/ })).toHaveCount(0);

  // Cora's Role can no longer be deleted.
  await page.goto("/general-settings/roles");
  await expect(proofreader.getByRole("cell").nth(2)).toHaveText("1");
  await expect(
    proofreader.getByRole("button", { name: "Delete proofreader" }),
  ).toBeDisabled();
  await expect(proofreader).toContainText(
    "1 Agent fills it: remove it from its Floor first.",
  );

  // The edit, which says whom it reaches.
  await proofreader.getByRole("button", { name: "Open proofreader" }).click();
  const editor = page.getByRole("form", { name: "Edit proofreader" });
  await expect(editor.getByRole("status")).toHaveText(
    "1 Agent fills this Role. A change reaches it from its next task; its own extra instructions still apply on top.",
  );
  await expect(editor.getByLabel("Stage")).toBeDisabled();
  await editor
    .getByLabel("Instructions")
    .fill(
      "- Write in American English, short and plain.\n- Commit the copy you change.",
    );
  await editor.getByRole("button", { name: "Save proofreader" }).click();
  await expect(
    page.getByText(
      "Saved proofreader. 1 Agent with it uses the change from their next task.",
    ),
  ).toBeVisible();
  // Kept: the same after a reload.
  await page.reload();
  await expect(editor.getByLabel("Instructions")).toHaveValue(
    "- Write in American English, short and plain.\n- Commit the copy you change.",
  );

  // Each change is in the Activity Feed, with a link to the Role.
  await page.getByRole("link", { name: "Activity" }).click();
  await expect(
    page.getByText(
      'Role "proofreader" changed: instructions. It reaches 1 Agent from their next task.',
    ),
  ).toBeVisible();
  await expect(
    page.getByText('Role "proofreader" made, in the work Stage.'),
  ).toBeVisible();

  // Cora's next task is given the Role's new instructions.
  const cora = agentListSchema
    .parse(await (await page.request.get("/api/floors/web-shop/agents")).json())
    .agents.find(({ name }) => name === "Cora");
  expect(cora?.role).toBe("proofreader");
  office.github.createIssue("adrianeyre/web-shop", {
    title: "Write the autumn range's copy",
    body: withCriteria("Every autumn product has a description"),
    labels: ["ai-office"],
  });
  expect(await office.pollIntake()).toBe(1);
  await expect
    .poll(async () =>
      (await office.sandboxTasks()).map(({ agentId }) => agentId),
    )
    .toEqual([cora?.id]);
  const prompt = await office.sandboxPrompt(cora?.id ?? "", 1);
  expect(prompt).toContain("You are Cora, a proofreader Agent in AI Office");
  expect(prompt).toContain(
    "- Write in American English, short and plain.\n- Commit the copy you change.",
  );
  expect(prompt).not.toContain("British English");
});
