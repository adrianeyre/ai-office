import type { EventBus } from "@ai-office/events";
import type { GitHubApp, Repository } from "@ai-office/github";
import {
  grillingAdrDirectory,
  grillingBranch,
  grillingGlossaryPath,
  grillingPrdDirectory,
  grillingProcessDirectory,
  type GitIdentity,
  type GrillingAdr,
  type GrillingDocuments,
  type GrillingProcess,
  type GrillingTerm,
} from "@ai-office/shared";

import type { FloorRecord } from "../floors/store.ts";
import { commitFiles, type FileToCommit } from "../git/commit-file.ts";
import { agentTrailer, type TrailerAgent } from "../git/identity.ts";
import type { Notices } from "../notices/notices.ts";
import type { GrillingSessionRecord } from "./session.ts";

// A Grilling Session's documents (PRD FR-80). As decisions settle, the
// Manager keeps the Floor's documents current on a branch of the session's
// own, `ai-office/grilling-<id>`:
// - **PRD:** `docs/product-requirements-document/<topic>.md`, the live
//   outline the Manager writes, section by section, then every settled
//   decision word for word. It never replaces a PRD the Floor has already.
// - **ADRs:** `docs/architectural-decision-record/NNNN-<title>.md`,
//   numbered on from the Floor's own (never rewriting one of them), only
//   for decisions the Manager said are hard to reverse, surprising and the
//   result of a real trade-off.
// - **Glossary:** `GLOSSARY.md`, each settled term written as soon as the
//   turn that settled it is kept: in place of an entry of its name, or
//   added under a heading for the session.
// - **Process docs:** `docs/processes/<title>.md`.
//
// Plain code writes every file from the session's stored data, so writing
// them again changes nothing unless the session did. AI Office, as the
// GitHub App, commits them as the Owner with the Manager's `Agent:`
// trailer (ADR 0002), only when a file changed, and pushes the branch.
// When the session ends it opens one pull request with all of them; the
// Manager never merges. A `grilling.documents_written` event records each
// commit, and `grilling.pull_request_opened` and an info Notice the pull
// request.

export interface GrillingDocumentsOptions {
  /** The GitHub App: it reads the Floor's documents, pushes and opens the pull request. */
  readonly github: GitHubApp;
  readonly events: EventBus;
  /** Tells the Owner of the pull request; without it, no Notice. */
  readonly notices?: Pick<Notices, "raise">;
  /** Who a Floor's commits are by (FR-68). */
  readonly gitIdentity: (floorId: string) => Promise<GitIdentity>;
  /** Where the commits are made, each in a directory of its own. */
  readonly scratchDir: string;
  /** Where to push a repository; its GitHub page plus `.git` by default. */
  readonly pushUrl?: (repository: Repository) => string;
  readonly now?: () => Date;
  /** Told when a Notice could not be raised. */
  readonly onError?: (error: unknown) => void;
}

/** What the documents are written for: a session, by its Floor's Manager. */
export interface GrillingDocumentsInput {
  readonly floor: Pick<
    FloorRecord,
    "id" | "name" | "repository" | "defaultBranch"
  >;
  /** The Manager, as its commits' trailer names it (FR-69). */
  readonly manager: TrailerAgent & { readonly id: string };
  readonly session: GrillingSessionRecord;
  readonly signal?: AbortSignal;
}

/** The documents as written: where they stand, and what this write changed. */
export interface WrittenDocuments {
  readonly documents: GrillingDocuments;
  /** The paths this write changed; none when they were already as settled. */
  readonly changed: readonly string[];
}

export interface GrillingDocumentsWriter {
  /**
   * Writes the session's documents on its branch, committing only what
   * changed. It never rejects: a write that fails is answered with the
   * documents as they were, saying why (`problem`), and the next write
   * tries again.
   */
  write(input: GrillingDocumentsInput): Promise<WrittenDocuments>;
  /**
   * Writes the documents a last time and opens the one pull request with
   * them (or answers the one already open from the branch). It rejects
   * when they cannot be written or the pull request cannot be opened.
   */
  propose(input: GrillingDocumentsInput): Promise<WrittenDocuments>;
}

const reasonOf = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error))
    .replaceAll(/\s+/g, " ")
    .trim();

const shorten = (text: string, length: number): string =>
  text.length <= length ? text : `${text.slice(0, length - 1)}…`;

/** "csv-export-for-orders": lower case, words joined by hyphens, short. */
export const slugOf = (text: string): string =>
  text
    .normalize("NFKD")
    .replaceAll(/\p{M}/gu, "")
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .slice(0, 60)
    .replaceAll(/^-+|-+$/g, "");

/** "Grilling Session 3 on CSV export", or without a topic. */
export const sessionTitle = (
  session: Pick<GrillingSessionRecord, "id" | "topic">,
): string =>
  `Grilling Session ${String(session.id)}${session.topic === "" ? "" : ` on ${session.topic}`}`;

/** The PRD's file name, from the session's topic. */
const prdName = (session: Pick<GrillingSessionRecord, "id" | "topic">) =>
  `${slugOf(session.topic) || `grilling-session-${String(session.id)}`}.md`;

/** The PRD: its title, the live outline, then every settled decision. */
export function prdDocument(session: GrillingSessionRecord): string {
  const title =
    session.topic === ""
      ? `Grilling Session ${String(session.id)}`
      : session.topic;
  return [
    `# ${title}`,
    "",
    "| | |",
    "|---|---|",
    `| **Status** | Draft, from Grilling Session ${String(session.id)} |`,
    `| **Glossary** | [\`${grillingGlossaryPath}\`](../../${grillingGlossaryPath}) |`,
    "",
    ...(session.outline.length === 0
      ? ["The outline is written as the session settles it.", ""]
      : session.outline.flatMap(({ heading, text }) => [
          `## ${heading}`,
          "",
          text.trim(),
          "",
        ])),
    "## Decisions",
    "",
    ...(session.decisions.length === 0
      ? ["None settled yet."]
      : [
          `Settled in Grilling Session ${String(session.id)}, word for word:`,
          "",
          ...session.decisions.map(
            ({ number, text }) => `${String(number)}. ${text}`,
          ),
        ]),
    "",
  ].join("\n");
}

/** A glossary entry, as `GLOSSARY.md` holds its terms. */
export const glossaryEntry = ({ term, definition, avoid }: GrillingTerm) =>
  [
    `**${term}**:`,
    definition.trim(),
    ...(avoid.length === 0 ? [] : [`_Avoid_: ${avoid.join(", ")}`]),
  ].join("\n");

const escaped = (text: string): string =>
  text.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The glossary with the session's terms: each in place of the entry of
 * its name (from its `**Term**:` line to the next blank line), or added
 * at the end, under a heading for the session (`heading`) the first time.
 * Without a glossary, a new one.
 */
export function withTerms(
  glossary: string | undefined,
  terms: readonly GrillingTerm[],
  heading: string,
): string {
  let text = glossary ?? "# Glossary\n";
  for (const term of terms) {
    const entry = new RegExp(
      `^\\*\\*${escaped(term.term.trim())}\\*\\*:[^\\n]*(?:\\n(?!\\s*\\n)[^\\n]*)*`,
      "im",
    );
    if (entry.test(text)) {
      text = text.replace(entry, () => glossaryEntry(term));
      continue;
    }
    const lines = text.split("\n");
    text = [
      text.trimEnd(),
      ...(lines.some((line) => line.trim() === heading) ? [] : ["", heading]),
      "",
      glossaryEntry(term),
    ].join("\n");
  }
  return `${text.trimEnd()}\n`;
}

/** An ADR, as the Floor's own ADRs are written. */
export function adrDocument(adr: GrillingAdr): string {
  const list = (items: readonly string[]) => items.map((item) => `- ${item}`);
  return [
    `# ${adr.title}`,
    "",
    adr.decision.trim(),
    "",
    ...(adr.options.length === 0
      ? []
      : ["## Considered Options", "", ...list(adr.options), ""]),
    ...(adr.consequences.length === 0
      ? []
      : ["## Consequences", "", ...list(adr.consequences), ""]),
  ].join("\n");
}

/** A process doc: its title, then what it says. */
export const processDocument = ({ title, text }: GrillingProcess): string =>
  `# ${title}\n\n${text.trim()}\n`;

/**
 * Each ADR's path: the file the session already wrote for its title, or
 * the next number after the directory's highest, in the session's order.
 * One of the Floor's own ADRs is never rewritten, even of the same title.
 */
export function adrPaths(
  adrs: readonly GrillingAdr[],
  existing: readonly string[],
  written: ReadonlySet<string>,
): string[] {
  const numbered = existing
    .map((name) => /^(\d{4})-(.+)$/.exec(name))
    .filter((match) => match !== null);
  let next = Math.max(0, ...numbered.map((match) => Number(match[1] ?? 0))) + 1;
  return adrs.map(({ title }) => {
    const name = `${slugOf(title) || "decision"}.md`;
    const found = numbered.find(
      (match) =>
        match[2] === name && written.has(`${grillingAdrDirectory}/${match[0]}`),
    );
    if (found !== undefined) {
      return `${grillingAdrDirectory}/${found[0]}`;
    }
    const path = `${grillingAdrDirectory}/${String(next).padStart(4, "0")}-${name}`;
    next += 1;
    return path;
  });
}

/** "a, b and c". */
const inWords = (items: readonly string[]): string =>
  items.length <= 1
    ? (items[0] ?? "")
    : `${items.slice(0, -1).join(", ")} and ${items.at(-1) ?? ""}`;

/** What the chat says of a write: what changed, or why nothing could be. */
export function documentsText(
  written: WrittenDocuments | undefined,
  leftOut: readonly string[],
): string {
  return [
    ...(written === undefined
      ? []
      : written.documents.problem !== null
        ? [
            `The documents could not be written on ${written.documents.branch}: ${written.documents.problem} They are written again as the next decisions settle.`,
          ]
        : written.changed.length === 0
          ? []
          : [
              `Updated on ${written.documents.branch}: ${inWords(written.changed)}.`,
            ]),
    ...leftOut.map(
      (title) =>
        `Left out the ADR "${title}": an ADR is only for a decision that is hard to reverse, surprising and the result of a real trade-off, and it did not say why for each.`,
    ),
  ].join("\n");
}

export function createGrillingDocuments(
  options: GrillingDocumentsOptions,
): GrillingDocumentsWriter {
  const { github, events } = options;
  const now = options.now ?? (() => new Date());

  /** Every document the session has, by path, built on `from`. */
  const filesOf = async (
    input: GrillingDocumentsInput,
    from: string,
  ): Promise<FileToCommit[]> => {
    const { floor, session } = input;
    const client = github.repository(floor.repository);
    const written = new Set(session.documents?.files ?? []);
    // Its own PRD: one of the topic's name the Floor already has is left be.
    let prd = `${grillingPrdDirectory}/${prdName(session)}`;
    if (
      !written.has(prd) &&
      (await client.getFileContent(prd, floor.defaultBranch)) !== undefined
    ) {
      prd = prd.replace(/\.md$/, `-grilling-${String(session.id)}.md`);
    }
    const [glossary, adrs] = await Promise.all([
      client.getFileContent(grillingGlossaryPath, from),
      session.adrs.length === 0
        ? Promise.resolve(undefined)
        : client.listDirectory(grillingAdrDirectory, from),
    ]);
    const adrFiles = adrPaths(
      session.adrs,
      (adrs ?? []).map(({ name }) => name),
      written,
    );
    return [
      { path: prd, content: prdDocument(session) },
      ...(session.terms.length === 0
        ? []
        : [
            {
              path: grillingGlossaryPath,
              content: withTerms(
                glossary,
                session.terms,
                `## ${session.topic === "" ? `Grilling Session ${String(session.id)}` : session.topic}`,
              ),
            },
          ]),
      ...session.adrs.map((adr, index) => ({
        path: adrFiles[index] ?? "",
        content: adrDocument(adr),
      })),
      ...session.processes.map((process) => ({
        path: `${grillingProcessDirectory}/${slugOf(process.title) || "process"}.md`,
        content: processDocument(process),
      })),
    ];
  };

  /** Writes the documents, rejecting when they cannot be. */
  const writeNow = async (
    input: GrillingDocumentsInput,
  ): Promise<WrittenDocuments> => {
    const { floor, manager, session } = input;
    const branch = session.documents?.branch ?? grillingBranch(session.id);
    const client = github.repository(floor.repository);
    // Built on the session's branch once it is written, so its documents
    // keep their history; on the default branch before.
    const from =
      session.documents?.commit != null &&
      (await client.getBranch(branch)) !== undefined
        ? branch
        : floor.defaultBranch;
    const files = await filesOf(input, from);
    const [repository, writable] = await Promise.all([
      client.get(),
      client.installationToken(),
    ]);
    const committed = await commitFiles({
      url: options.pushUrl?.(repository) ?? `${repository.htmlUrl}.git`,
      token: writable.token,
      from,
      to: branch,
      files,
      message: `docs: ${sessionTitle(session)}, as settled${session.round === 0 ? "" : ` in round ${String(session.round)}`}\n\nThe PRD, ADRs, glossary terms and process docs settled so far.`,
      identity: await options.gitIdentity(floor.id),
      agent: manager,
      scratchDir: options.scratchDir,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    if (committed !== undefined) {
      await events.publish({
        type: "grilling.documents_written",
        version: 1,
        floorId: floor.id,
        agentId: manager.id,
        sessionId: session.id,
        branch,
        sha: committed.sha,
        files: committed.changed.length,
      });
    }
    return {
      documents: {
        branch,
        files: files.map(({ path }) => path),
        commit: committed?.sha ?? session.documents?.commit ?? null,
        writtenAt:
          committed === undefined
            ? (session.documents?.writtenAt ?? null)
            : now().toISOString(),
        pullRequest: session.documents?.pullRequest ?? null,
        problem: null,
      },
      changed: committed?.changed ?? [],
    };
  };

  /** The pull request's body: what it holds, and why each ADR is one. */
  const describe = (
    input: GrillingDocumentsInput,
    files: readonly string[],
  ): string => {
    const { session, manager } = input;
    return [
      `${manager.name}, the Floor's Manager, wrote these documents in ${sessionTitle(session)} with the Owner, as its decisions settled.`,
      "",
      "**Files**",
      "",
      ...files.map((path) => `- \`${path}\``),
      "",
      `**Decisions** (${String(session.decisions.length)})`,
      "",
      ...(session.decisions.length === 0
        ? ["None."]
        : session.decisions.map(
            ({ number, text }) => `${String(number)}. ${text}`,
          )),
      "",
      ...(session.terms.length === 0
        ? []
        : [
            `**Glossary terms** (${String(session.terms.length)})`,
            "",
            ...session.terms.map(({ term }) => `- ${term}`),
            "",
          ]),
      ...(session.adrs.length === 0
        ? []
        : [
            "**Why each ADR**",
            "",
            ...session.adrs.flatMap((adr) => [
              `- ${adr.title}`,
              `  - Hard to reverse: ${adr.hardToReverse}`,
              `  - Surprising: ${adr.surprising}`,
              `  - The trade-off: ${adr.tradeOff}`,
            ]),
            "",
          ]),
      "Review them as you would any change to the Floor's canon. Merging is yours: a Manager never merges.",
      "",
      `Written by ${agentTrailer(manager).replace(/^Agent: /, "")} in AI Office.`,
      "",
    ].join("\n");
  };

  return {
    async write(input) {
      try {
        return await writeNow(input);
      } catch (error) {
        input.signal?.throwIfAborted();
        return {
          documents: {
            branch:
              input.session.documents?.branch ??
              grillingBranch(input.session.id),
            files: [...(input.session.documents?.files ?? [])],
            commit: input.session.documents?.commit ?? null,
            writtenAt: input.session.documents?.writtenAt ?? null,
            pullRequest: input.session.documents?.pullRequest ?? null,
            problem: shorten(reasonOf(error), 500),
          },
          changed: [],
        };
      }
    },

    async propose(input) {
      const written = await writeNow(input);
      const { floor, manager, session } = input;
      const { branch } = written.documents;
      const client = github.repository(floor.repository);
      const [open] = await client.listPullRequests({ head: branch });
      const pullRequest =
        open ??
        (await client.createPullRequest({
          title: shorten(`docs: ${sessionTitle(session)}`, 200),
          body: describe(input, written.documents.files),
          head: branch,
          base: floor.defaultBranch,
        }));
      if (open === undefined) {
        await events.publish({
          type: "grilling.pull_request_opened",
          version: 1,
          floorId: floor.id,
          agentId: manager.id,
          sessionId: session.id,
          branch,
          pullRequest: pullRequest.number,
          url: pullRequest.htmlUrl,
        });
        await options.notices
          ?.raise({
            kind: "info",
            title: shorten(
              `PR #${String(pullRequest.number)} opened on ${floor.name}: the documents of ${sessionTitle(session)}`,
              200,
            ),
            floorId: floor.id,
            agentId: manager.id,
            pullRequest: {
              number: pullRequest.number,
              url: pullRequest.htmlUrl,
            },
          })
          // The pull request is open; a Notice that fails undoes none of it.
          .catch((error: unknown) => options.onError?.(error));
      }
      return {
        ...written,
        documents: {
          ...written.documents,
          pullRequest: { number: pullRequest.number, url: pullRequest.htmlUrl },
        },
      };
    },
  };
}
