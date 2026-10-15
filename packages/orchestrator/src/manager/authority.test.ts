import { createFakeGitHub } from "@ai-office/github/testing";
import {
  forbiddenManagerActions,
  managerActions,
  pipelineStages,
} from "@ai-office/shared";
import { describe, expect, it } from "vitest";

import {
  assertManagerMay,
  assertManagerMayForChat,
  assertManagerMayMove,
  ManagerAuthorityError,
  managerChatActions,
  managerChatIssues,
  managerGitHub,
} from "./authority.ts";

// The Manager's authority (PRD FR-23): the permission check every one of
// its actions passes, and the GitHub client it holds; and, for the Owner's
// chat requests (ADR 0004), filing issues and adding and letting go of
// Contractors, through a narrow path of its own.

describe("the Manager's authority", () => {
  it("lets it retry, reassign, relabel, pause and escalate", () => {
    for (const action of managerActions) {
      expect(() => {
        assertManagerMay(action);
      }).not.toThrow();
    }
  });

  it("refuses merging, changing repository settings, raising caps and anything else", () => {
    for (const action of [...forbiddenManagerActions, "close_issue", ""]) {
      expect(() => {
        assertManagerMay(action);
      }).toThrow(ManagerAuthorityError);
    }
    expect(() => {
      assertManagerMay("raise_cap");
    }).toThrow(
      "A Manager may not raise cap: it may retry, reassign, relabel, pause or escalate, and never merge, change repository settings or raise a cap.",
    );
  });

  it("moves an issue only back to needs-work or out to needs-human", () => {
    const allowed = pipelineStages.filter((stage) => {
      try {
        assertManagerMayMove(stage);
        return true;
      } catch (error) {
        expect(error).toBeInstanceOf(ManagerAuthorityError);
        return false;
      }
    });
    expect(allowed).toEqual(["needs-work", "needs-human"]);
  });

  it("holds a GitHub client that reads, labels issues and comments, and refuses the rest", async () => {
    const github = createFakeGitHub();
    github.installRepository("adrianeyre/web-shop");
    const issue = github.createIssue("adrianeyre/web-shop", {
      title: "Add a basket",
      labels: ["ai-office"],
    });
    const client = managerGitHub(github).repository("adrianeyre/web-shop");

    expect((await client.getIssue(issue.number)).title).toBe("Add a basket");
    await client.addLabels(issue.number, ["needs-human"]);
    await client.removeLabel(issue.number, "ai-office");
    await client.createComment(issue.number, "Escalated.");
    expect((await client.getIssue(issue.number)).labels).toEqual([
      "needs-human",
    ]);
    expect(await client.listComments(issue.number)).toHaveLength(1);

    const refused: [string, Promise<unknown>][] = [
      ["merge", client.mergePullRequest(1, { method: "squash" })],
      ["change_repository_settings", client.installationToken()],
      [
        "change_repository_settings",
        client.ensureLabel({ name: "x", color: "ffffff" }),
      ],
      ["github_close_issue", client.closeIssue(issue.number)],
      // Chat requests file through their own narrow path, never this one.
      ["github_create_issue", client.createIssue({ title: "Anything" })],
      ["github_delete_branch", client.deleteBranch("main")],
      ["github_create_review", client.createReview(1, { body: "LGTM" })],
    ];
    for (const [action, call] of refused) {
      await expect(call).rejects.toMatchObject({
        name: "ManagerAuthorityError",
        action,
      });
    }
    expect(
      (await github.repository("adrianeyre/web-shop").getIssue(issue.number))
        .state,
    ).toBe("open");
  });

  it("may file issues and add or let go of Contractors for its chat's requests, and nothing more", () => {
    for (const action of managerChatActions) {
      expect(() => {
        assertManagerMayForChat(action);
      }).not.toThrow();
    }
    for (const action of [
      ...forbiddenManagerActions,
      "close_issue",
      "change_token_caps",
      "",
    ]) {
      expect(() => {
        assertManagerMayForChat(action);
      }).toThrow(ManagerAuthorityError);
    }
  });

  it("files a chat request's issue labelled ai-office, with its note, and does nothing else", async () => {
    const github = createFakeGitHub();
    github.installRepository("adrianeyre/web-shop");
    const issue = await managerChatIssues(github).file("adrianeyre/web-shop", {
      title: "Add the status column",
      body: "## What to build\n\nIt.",
      note: "### Filed for the Owner's chat request",
    });
    const repository = github.repository("adrianeyre/web-shop");
    expect(await repository.getIssue(issue.number)).toMatchObject({
      title: "Add the status column",
      labels: ["ai-office"],
      author: github.botLogin,
      state: "open",
    });
    expect(
      (await repository.listComments(issue.number)).map(({ body }) => body),
    ).toEqual(["### Filed for the Owner's chat request"]);
    expect(
      github.labels("adrianeyre/web-shop").map(({ name }) => name),
    ).toContain("ai-office");
  });
});
