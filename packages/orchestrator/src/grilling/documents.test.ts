import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import {
  createEventBus,
  memoryEventStore,
  type OfficeEvent,
} from "@ai-office/events";
import { createFakeGitHub } from "@ai-office/github/testing";
import { afterEach, describe, expect, it } from "vitest";

import { gitBackedGitHub, gitIn } from "../sandbox/git-backed-github.ts";
import {
  adrPaths,
  createGrillingDocuments,
  prdDocument,
  slugOf,
  withTerms,
} from "./documents.ts";
import type { GrillingSessionRecord } from "./session.ts";

// A Grilling Session's documents (PRD FR-80): the files written from the
// session's stored data, in plain code, and the writer that commits them
// on the session's branch as the GitHub App and opens their pull request,
// against a local bare repository standing in for GitHub's remote.

const exec = promisify(execFile);
const at = new Date("2026-10-10T12:00:00.000Z");
const repository = "adrianeyre/web-shop";

const session: GrillingSessionRecord = {
  id: 4,
  floorId: "web-shop",
  topic: "Gift cards",
  skill: "grilling",
  status: "active",
  round: 1,
  awaitingConfirmation: false,
  questions: [],
  decisions: [],
  terms: [],
  facts: [],
  outline: [],
  adrs: [],
  processes: [],
  documents: null,
  issues: null,
  sources: [],
  startedAt: at,
  updatedAt: at,
  pausedAt: null,
  endedAt: null,
};

describe("the documents' files", () => {
  it("names files from their titles", () => {
    expect(slugOf("CSV export: for Orders!")).toBe("csv-export-for-orders");
    expect(slugOf("Café crème")).toBe("cafe-creme");
    expect(slugOf("¿?")).toBe("");
  });

  it("writes a session's terms into the glossary: in place of an entry of the name, or under the session's heading", () => {
    const glossary = [
      "# Glossary",
      "",
      "**Order**: A purchase.",
      "_Avoid_: sale",
      "",
      "**Basket**:",
      "What a customer means to buy.",
      "",
    ].join("\n");
    const once = withTerms(
      glossary,
      [
        { term: "order", definition: "A paid purchase.", avoid: [] },
        {
          term: "Gift card",
          definition: "Credit to spend.",
          avoid: ["voucher"],
        },
      ],
      "## Gift cards",
    );
    expect(once).toBe(
      [
        "# Glossary",
        "",
        "**order**:",
        "A paid purchase.",
        "",
        "**Basket**:",
        "What a customer means to buy.",
        "",
        "## Gift cards",
        "",
        "**Gift card**:",
        "Credit to spend.",
        "_Avoid_: voucher",
        "",
      ].join("\n"),
    );
    // Written again, with one more term: the heading is not repeated.
    expect(
      withTerms(
        once,
        [
          {
            term: "Gift card",
            definition: "Credit to spend.",
            avoid: ["voucher"],
          },
          { term: "Balance", definition: "What is left on it.", avoid: [] },
        ],
        "## Gift cards",
      ),
    ).toBe(`${once}\n**Balance**:\nWhat is left on it.\n`);
    // Without a glossary, a new one; a `$` in a definition is kept as it is.
    expect(
      withTerms(
        undefined,
        [{ term: "Price", definition: "In $ and pence: $&.", avoid: [] }],
        "## Gift cards",
      ),
    ).toBe("# Glossary\n\n## Gift cards\n\n**Price**:\nIn $ and pence: $&.\n");
  });

  it("numbers new ADRs on from the directory's highest, keeps the number of one the session wrote, and never rewrites one of the Floor's own", () => {
    const adr = (title: string) => ({
      title,
      decision: "",
      options: [],
      consequences: [],
      hardToReverse: "",
      surprising: "",
      tradeOff: "",
    });
    expect(
      adrPaths(
        [
          adr("Gift cards never expire"),
          adr("Balances are in pence"),
          adr("The gateway"),
        ],
        [
          "0001-the-gateway.md",
          "0007-gift-cards-never-expire.md",
          "0003-roles.md",
          "README.md",
        ],
        new Set([
          "docs/architectural-decision-record/0007-gift-cards-never-expire.md",
        ]),
      ),
    ).toEqual([
      "docs/architectural-decision-record/0007-gift-cards-never-expire.md",
      "docs/architectural-decision-record/0008-balances-are-in-pence.md",
      // The Floor's own 0001 has its title, so the session's is new.
      "docs/architectural-decision-record/0009-the-gateway.md",
    ]);
    expect(adrPaths([adr("First")], [], new Set())).toEqual([
      "docs/architectural-decision-record/0001-first.md",
    ]);
  });

  it("writes the PRD from the outline, then the decisions word for word", () => {
    expect(
      prdDocument({
        ...session,
        topic: "",
        outline: [{ heading: "Problem", text: "No gift cards.\n" }],
        decisions: [
          {
            number: 1,
            text: "Gift cards never expire.",
            questions: [1],
            round: 1,
            settledAt: at.toISOString(),
          },
        ],
      }),
    ).toBe(
      [
        "# Grilling Session 4",
        "",
        "| | |",
        "|---|---|",
        "| **Status** | Draft, from Grilling Session 4 |",
        "| **Glossary** | [`GLOSSARY.md`](../../GLOSSARY.md) |",
        "",
        "## Problem",
        "",
        "No gift cards.",
        "",
        "## Decisions",
        "",
        "Settled in Grilling Session 4, word for word:",
        "",
        "1. Gift cards never expire.",
        "",
      ].join("\n"),
    );
  });
});

describe("the documents' writer", () => {
  let root: string | undefined;
  afterEach(async () => {
    if (root !== undefined) {
      await rm(root, { recursive: true, force: true });
    }
  });

  const setUp = async () => {
    root = await mkdtemp(join(tmpdir(), "ai-office-documents-"));
    const remote = join(root, "web-shop.git");
    const seed = join(root, "seed");
    await exec("git", ["init", "--quiet", "--bare", "-b", "main", remote]);
    await exec("git", ["init", "--quiet", "-b", "main", seed]);
    // The Floor already has a PRD named for the topic.
    await mkdir(join(seed, "docs/product-requirements-document"), {
      recursive: true,
    });
    await writeFile(
      join(seed, "docs/product-requirements-document/gift-cards.md"),
      "# Gift cards\n\nThe Owner's own.\n",
    );
    await gitIn(seed, "add", "-A");
    await gitIn(seed, "commit", "--quiet", "-m", "chore: start");
    await gitIn(seed, "push", "--quiet", remote, "main");
    const fake = createFakeGitHub();
    fake.installRepository(repository);
    const events = createEventBus({ store: memoryEventStore() });
    const published: OfficeEvent[] = [];
    events.subscribe(({ event }) => {
      published.push(event);
    });
    const writer = createGrillingDocuments({
      github: gitBackedGitHub(fake, remote),
      events,
      gitIdentity: () =>
        Promise.resolve({ name: "Owner", email: "owner@example.com" }),
      scratchDir: root,
      pushUrl: () => remote,
      now: () => at,
    });
    const input = (current: GrillingSessionRecord) => ({
      floor: {
        id: "web-shop",
        name: "Web shop",
        repository,
        defaultBranch: "main",
      },
      manager: {
        id: "mo",
        name: "Mo",
        role: "manager" as const,
        aiProvider: "Claude",
        model: "claude-opus-5-5",
      },
      session: current,
    });
    return { remote, fake, published, writer, input };
  };

  it("leaves the Floor's own PRD be, commits only what changed, and builds on the session's branch", async () => {
    const s = await setUp();
    const first = await s.writer.write(s.input(session));
    const prd = "docs/product-requirements-document/gift-cards-grilling-4.md";
    expect(first).toEqual({
      documents: {
        branch: "ai-office/grilling-4",
        files: [prd],
        commit: await gitIn(s.remote, "rev-parse", "ai-office/grilling-4"),
        writtenAt: at.toISOString(),
        pullRequest: null,
        problem: null,
      },
      changed: [prd],
    });
    expect(
      await gitIn(
        s.remote,
        "show",
        "main:docs/product-requirements-document/gift-cards.md",
      ),
    ).toBe("# Gift cards\n\nThe Owner's own.");

    // Written again with nothing new: no commit, and no event.
    const again = await s.writer.write(
      s.input({ ...session, documents: first.documents }),
    );
    expect(again).toEqual({ documents: first.documents, changed: [] });
    expect(s.published).toHaveLength(1);

    // A term settled: one commit more, on top of the last.
    const third = await s.writer.write(
      s.input({
        ...session,
        documents: first.documents,
        terms: [{ term: "Gift card", definition: "Credit.", avoid: [] }],
      }),
    );
    expect(third.changed).toEqual(["GLOSSARY.md"]);
    expect(await gitIn(s.remote, "rev-parse", "ai-office/grilling-4~1")).toBe(
      first.documents.commit,
    );
    expect(s.published.map(({ type }) => type)).toEqual([
      "grilling.documents_written",
      "grilling.documents_written",
    ]);
  });

  it("opens one pull request, and answers the one already open from the branch", async () => {
    const s = await setUp();
    const proposed = await s.writer.propose(s.input(session));
    expect(proposed.documents.pullRequest).toEqual({
      number: 1,
      url: "https://github.com/adrianeyre/web-shop/pull/1",
    });
    const again = await s.writer.propose(
      s.input({ ...session, documents: proposed.documents }),
    );
    expect(again.documents.pullRequest).toEqual(proposed.documents.pullRequest);
    expect(
      await s.fake.repository(repository).listPullRequests({ state: "all" }),
    ).toHaveLength(1);
    expect(
      s.published.filter(({ type }) => type === "grilling.pull_request_opened"),
    ).toHaveLength(1);
  });
});
