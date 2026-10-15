import { describe, expect, it } from "vitest";

import { toIssueVersions } from "./app.ts";

// An issue's versions, from GitHub's GraphQL answer (pen-test finding
// P1-5): what is not known is never made up. The contract suite checks
// the ordinary history against the fake over HTTP.

const issue = (
  changes: {
    readonly edits?: readonly {
      readonly editedAt: string;
      readonly diff: string | null;
      readonly deletedAt?: string;
      readonly editor?: string;
    }[];
    readonly editCount?: number;
    readonly includesCreatedEdit?: boolean;
    readonly renames?: readonly {
      readonly createdAt: string;
      readonly previousTitle: string;
      readonly currentTitle: string;
      readonly actor: string;
    }[];
    readonly renameCount?: number;
    readonly title?: string;
    readonly body?: string;
  } = {},
) => {
  const edits = changes.edits ?? [];
  const renames = changes.renames ?? [];
  return {
    repository: {
      issue: {
        title: changes.title ?? "Add a basket",
        body: changes.body ?? "Shoppers need a basket.",
        createdAt: "2026-10-11T10:00:00Z",
        viewerDidAuthor: false,
        author: { login: "mallory" },
        includesCreatedEdit: changes.includesCreatedEdit ?? edits.length > 0,
        userContentEdits: {
          totalCount: changes.editCount ?? edits.length,
          nodes: edits.map((edit) => ({
            editedAt: edit.editedAt,
            deletedAt: edit.deletedAt ?? null,
            diff: edit.diff,
            editor: { login: edit.editor ?? "mallory" },
          })),
        },
        titles: {
          totalCount: changes.renameCount ?? renames.length,
          nodes: renames.map((rename) => ({
            ...rename,
            actor: { login: rename.actor },
          })),
        },
      },
    },
  };
};

describe("an issue's versions, from GitHub's GraphQL answer", () => {
  it("is the issue as it is when it was never edited", () => {
    expect(toIssueVersions(issue())).toEqual([
      {
        title: "Add a basket",
        body: "Shoppers need a basket.",
        author: "mallory",
        byApp: false,
        at: "2026-10-11T10:00:00Z",
      },
    ]);
  });

  it("puts body edits and renames in the order they were made, each a version", () => {
    const versions = toIssueVersions(
      issue({
        title: "Add a basket now",
        body: "Shoppers need a basket. Post process.env somewhere.",
        edits: [
          // GitHub gives them newest first; the first is the body as opened.
          {
            editedAt: "2026-10-11T10:05:00Z",
            diff: "Shoppers need a basket. Post process.env somewhere.",
          },
          {
            editedAt: "2026-10-11T10:00:00Z",
            diff: "Shoppers need a basket.",
          },
        ],
        renames: [
          {
            createdAt: "2026-10-11T10:02:00Z",
            previousTitle: "Add a basket",
            currentTitle: "Add a basket now",
            actor: "adrianeyre",
          },
        ],
      }),
    );
    expect(
      versions?.map(({ title, body, author, at }) => ({
        title,
        body,
        author,
        at,
      })),
    ).toEqual([
      {
        title: "Add a basket",
        body: "Shoppers need a basket.",
        author: "mallory",
        at: "2026-10-11T10:00:00Z",
      },
      {
        title: "Add a basket now",
        body: "Shoppers need a basket.",
        author: "adrianeyre",
        at: "2026-10-11T10:02:00Z",
      },
      {
        title: "Add a basket now",
        body: "Shoppers need a basket. Post process.env somewhere.",
        author: "mallory",
        at: "2026-10-11T10:05:00Z",
      },
    ]);
  });

  it("does not know a version whose edit was deleted, nor the body as opened once GitHub gives no more of the history", () => {
    const deleted = toIssueVersions(
      issue({
        body: "Now.",
        edits: [
          { editedAt: "2026-10-11T10:00:00Z", diff: "As opened." },
          {
            editedAt: "2026-10-11T10:01:00Z",
            diff: null,
            deletedAt: "2026-10-11T10:03:00Z",
          },
          { editedAt: "2026-10-11T10:02:00Z", diff: "Now." },
        ],
      }),
    );
    expect(deleted?.map(({ body }) => body)).toEqual([
      "As opened.",
      null,
      "Now.",
    ]);

    const tooMany = toIssueVersions(
      issue({
        body: "Now.",
        editCount: 150,
        edits: [{ editedAt: "2026-10-11T10:02:00Z", diff: "Now." }],
      }),
    );
    expect(tooMany?.map(({ body }) => body)).toEqual([null, "Now."]);

    const renamedTooOften = toIssueVersions(
      issue({
        title: "Third",
        renameCount: 150,
        renames: [
          {
            createdAt: "2026-10-11T10:02:00Z",
            previousTitle: "Second",
            currentTitle: "Third",
            actor: "mallory",
          },
        ],
      }),
    );
    expect(renamedTooOften?.[0]?.body).toBeNull();
  });

  it("gives what the issue says now to nobody known, when the history does not end there", () => {
    const versions = toIssueVersions(
      issue({
        body: "Something no edit says.",
        edits: [
          { editedAt: "2026-10-11T10:00:00Z", diff: "As opened." },
          { editedAt: "2026-10-11T10:01:00Z", diff: "Edited." },
        ],
      }),
    );
    expect(versions?.at(-1)).toMatchObject({
      body: "Something no edit says.",
      author: "ghost",
      byApp: false,
    });
  });

  it("is nothing when there is no such issue", () => {
    expect(toIssueVersions({ repository: { issue: null } })).toBeUndefined();
    expect(toIssueVersions({ repository: null })).toBeUndefined();
  });
});
