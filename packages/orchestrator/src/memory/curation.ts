import type { EventBus } from "@ai-office/events";
import type { GitHubApp, Repository } from "@ai-office/github";
import {
  createRedactor,
  memoryBranch,
  memoryPath,
  redactedText,
  type GitIdentity,
  type MemoryCurator,
  type Redactor,
} from "@ai-office/shared";

import { modelOf } from "../agents/agents.ts";
import type { AgentRecord, AgentStore } from "../agents/store.ts";
import type { DefaultModels } from "../ai-providers/ai-providers.ts";
import type { BatchStore } from "../batches/store.ts";
import type { FloorRecord, FloorStore } from "../floors/store.ts";
import { commitFile } from "../git/commit-file.ts";
import { agentTrailer, type TrailerAgent } from "../git/identity.ts";
import type { ModelClient, ModelMessage } from "../models/client.ts";
import type { Notices } from "../notices/notices.ts";
import { curateByRules, memoryEntries, memoryFile, sameEntry } from "./file.ts";
import {
  curationPrompt,
  curationRetryMessage,
  parseCuration,
} from "./prompt.ts";
import type { CurationRecord, MemoryStore, ProposalRecord } from "./store.ts";

// The Manager curates the repository's memory (PRD FR-53, FR-56): at the
// end of each Batch (once it finishes, or every issue in its Plan is
// closed) and as a
// weekly tidy-up (a week after the Floor's last curation, or its oldest
// proposal waiting), it takes the entries Agents proposed in their
// Handoffs and the memory as it is, and curates them, through its own
// Model and Gateway Key: duplicates merged, stale entries dropped, short.
// An answer that is not a curated memory is sent back once; when the Model
// cannot be asked or answers twice with none, AI Office's own rules curate
// (FR-17): the proposals added, exact duplicates merged, the oldest
// entries dropped beyond the limit.
//
// Plain code writes the file, every entry redacted (one that held a
// credential is dropped), and AI Office, as the GitHub App, commits it as
// the Owner with the Manager's `Agent:` trailer (ADR 0002) on one branch,
// `ai-office/memory`, and opens one pull request for it, or updates the
// one still open: a curation while it is open builds on its branch, so
// nothing curated is lost. The Manager never merges: the Owner does. The
// proposals it took, the curation and its pull request are kept, a
// `memory.curated` event records it, and an info Notice tells the Owner.

export type CurationTrigger =
  | { readonly reason: "batch"; readonly batchId: number }
  | { readonly reason: "weekly" };

/** What a curation did. */
export interface CurationOutcome {
  readonly curation: CurationRecord;
  readonly entries: readonly string[];
  readonly added: readonly string[];
  readonly removed: readonly string[];
  /** The proposals it took. */
  readonly proposals: readonly ProposalRecord[];
  /** Its pull request, unless the memory was already as curated. */
  readonly pullRequest?: {
    readonly number: number;
    readonly url: string;
    readonly opened: boolean;
  };
  /** Why the Manager's Model did not curate, if it did not. */
  readonly fallback?: string;
}

export interface MemoryCuration {
  /**
   * Curates the Floor's memory now; undefined when there is nothing to
   * curate (no proposals and no memory) or the Floor is archived.
   */
  curate(
    floorId: string,
    trigger: CurationTrigger,
  ): Promise<CurationOutcome | undefined>;
  /**
   * Curates each Floor whose Batch has ended, or whose weekly tidy-up is
   * due; answers what each curation did.
   */
  check(): Promise<CurationOutcome[]>;
  /** Checks every hour, until stopped. */
  start(): void;
  /** Stops checking, waiting for a check in progress. */
  stop(): Promise<void>;
}

export interface MemoryCurationOptions {
  readonly floors: FloorStore;
  readonly agents: AgentStore;
  /** The GitHub App: it reads the memory, pushes and opens the pull request. */
  readonly github: GitHubApp;
  /** Makes the Manager's model calls, through the AI Gateway. */
  readonly models: ModelClient;
  /** Each AI Provider's default Model, for a Manager without its own. */
  readonly defaultModels?: () => Promise<DefaultModels>;
  readonly store: MemoryStore;
  /** Batches, whose end is a curation. */
  readonly batches?: BatchStore;
  readonly events: EventBus;
  readonly notices: Notices;
  /** Who a Floor's commits are by (FR-68). */
  readonly gitIdentity: (floorId: string) => Promise<GitIdentity>;
  /** Where the memory's commit is made, in a directory of its own. */
  readonly scratchDir: string;
  /** Where to push a repository; its GitHub page plus `.git` by default. */
  readonly pushUrl?: (repository: Repository) => string;
  /** Removes credentials from memory before anyone reads it. */
  readonly redactor?: Redactor;
  readonly now?: () => Date;
  /** How often to look for Batches that ended, and tidy-ups due; an hour. */
  readonly intervalMs?: number;
  /** Told when a Floor could not be curated, or a check failed. */
  readonly onError?: (error: unknown) => void;
}

/** A week: how often the memory is tidied up. */
export const tidyUpMs = 7 * 24 * 60 * 60 * 1000;
/** The most tokens the Manager's curation may use. */
const maxAnswerTokens = 8192;
/** The title of the memory's pull request. */
export const memoryPullRequestTitle = "Curate the repository's memory";

const reasonOf = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error))
    .replaceAll(/\s+/g, " ")
    .trim();

const shorten = (text: string, length: number): string =>
  text.length <= length ? text : `${text.slice(0, length - 1)}…`;

const plural = (count: number, one: string, many: string): string =>
  `${String(count)} ${count === 1 ? one : many}`;

export function createMemoryCuration(
  options: MemoryCurationOptions,
): MemoryCuration {
  const { store, events, notices, models, github } = options;
  const redactor = options.redactor ?? createRedactor();
  const now = options.now ?? (() => new Date());
  const report = (error: unknown): void => {
    options.onError?.(error);
  };

  /** One curation at a time, so no Batch is curated twice. */
  let curating: Promise<unknown> = Promise.resolve();
  const exclusive = <Value>(work: () => Promise<Value>): Promise<Value> => {
    const next = curating.then(work, work);
    curating = next.catch(() => undefined);
    return next;
  };

  /** The Manager's Model's curation, asked again once; or the rules'. */
  const curated = async (
    floor: FloorRecord,
    manager: AgentRecord,
    trigger: CurationTrigger,
    current: readonly string[],
    proposals: readonly ProposalRecord[],
    nameOf: (agentId: string) => string,
  ): Promise<{
    entries: readonly string[];
    summary: string;
    curatedBy: MemoryCurator;
    fallback?: string;
  }> => {
    const byRules = (fallback: string) => ({
      entries: curateByRules(
        current,
        proposals.map(({ text }) => text),
      ),
      summary: `AI Office's rules curated the memory, as ${fallback}: they added ${plural(proposals.length, "proposal", "proposals")}, merged entries that say the same in the same words, and kept the newest entries within the limit.`,
      curatedBy: "rules" as const,
      fallback,
    });
    if (!manager.enabled) {
      return byRules(`${manager.name} is paused`);
    }
    const model = modelOf(manager, await options.defaultModels?.());
    if (model === undefined) {
      return byRules(
        `${manager.name} has no Model (choose a default Model for ${manager.aiProvider} in General Settings)`,
      );
    }
    const prompt = curationPrompt({
      floor,
      manager,
      reason: trigger.reason,
      current,
      proposals: proposals.map(({ text, agentId, issue }) => ({
        text,
        agent: nameOf(agentId),
        issue,
      })),
    });
    const messages: ModelMessage[] = [{ role: "user", content: prompt.user }];
    const ask = () =>
      models.complete({
        agentId: manager.id,
        model,
        system: prompt.system,
        messages,
        maxTokens: maxAnswerTokens,
      });
    try {
      const first = await ask();
      let answer = parseCuration(first.text);
      if (!answer.ok) {
        messages.push(
          { role: "assistant", content: first.text },
          { role: "user", content: curationRetryMessage(answer.problem) },
        );
        answer = parseCuration((await ask()).text);
      }
      return answer.ok
        ? { ...answer.value, curatedBy: "model" }
        : byRules(
            `${manager.name} gave no valid curated memory: ${answer.problem}`,
          );
    } catch (error) {
      return byRules(`${manager.name} could not be asked: ${reasonOf(error)}`);
    }
  };

  /** The pull request's body, or a comment on it when it is updated. */
  const describe = (input: {
    readonly manager: AgentRecord;
    readonly trailer: TrailerAgent;
    readonly trigger: CurationTrigger;
    readonly summary: string;
    readonly added: readonly string[];
    readonly removed: readonly string[];
    readonly proposals: readonly ProposalRecord[];
    readonly nameOf: (agentId: string) => string;
  }): string => {
    const list = (entries: readonly string[]) =>
      entries.length === 0 ? ["None."] : entries.map((entry) => `- ${entry}`);
    return [
      `${input.manager.name}, the Floor's Manager, curated the repository's memory (\`${memoryPath}\`) ${
        input.trigger.reason === "batch"
          ? `as Batch ${String(input.trigger.batchId)} ended`
          : "in its weekly tidy-up"
      }.`,
      "",
      input.summary,
      "",
      "**Added**",
      "",
      ...list(input.added),
      "",
      "**Removed**",
      "",
      ...list(input.removed),
      "",
      `**Proposals taken** (${String(input.proposals.length)})`,
      "",
      ...(input.proposals.length === 0
        ? ["None."]
        : input.proposals.map(
            ({ text, agentId, issue }) =>
              `- ${text} (${input.nameOf(agentId)}, on #${String(issue)})`,
          )),
      "",
      "Every Agent reads this file at the start of a task: review it as you would instructions. Merging is yours: a Manager never merges.",
      "",
      `Curated by ${agentTrailer(input.trailer).replace(/^Agent: /, "")} in AI Office.`,
      "",
    ].join("\n");
  };

  const curateNow = async (
    floorId: string,
    trigger: CurationTrigger,
  ): Promise<CurationOutcome | undefined> => {
    const floor = await options.floors.get(floorId);
    // Work on archived Floors stops (FR-9).
    if (floor?.archivedAt !== null) {
      return undefined;
    }
    const agents = await options.agents.list(floor.id);
    const manager = agents.find(({ role }) => role === "manager");
    if (manager === undefined) {
      throw new Error(`The Floor "${floor.name}" has no Manager to curate.`);
    }
    const nameOf = (agentId: string): string =>
      agents.find(({ id }) => id === agentId)?.name ?? "An Agent";
    const proposals = await store.pending(floor.id);
    const client = github.repository(floor.repository);
    // A curation while the last one's pull request is open builds on it.
    const [open] = await client.listPullRequests({ head: memoryBranch });
    const from = open === undefined ? floor.defaultBranch : memoryBranch;
    const current = memoryEntries(
      redactor.redactText(
        (await client.getFileContent(memoryPath, from)) ?? "",
      ),
    );
    const record = (
      curation: Omit<
        CurationRecord,
        "id" | "floorId" | "reason" | "batchId" | "agentId" | "createdAt"
      >,
    ) =>
      store.recordCuration(
        {
          floorId: floor.id,
          reason: trigger.reason,
          batchId: trigger.reason === "batch" ? trigger.batchId : null,
          agentId: manager.id,
          createdAt: now(),
          ...curation,
        },
        proposals.map(({ id }) => id),
      );

    if (proposals.length === 0 && current.length === 0) {
      // Nothing to curate: kept, so the Batch (or the week) is done with.
      await record({
        curatedBy: "rules",
        summary: "Nothing to curate: no proposals, and no memory yet.",
        entries: 0,
        pullRequest: null,
      });
      return undefined;
    }

    const drafted = await curated(
      floor,
      manager,
      trigger,
      current,
      proposals,
      nameOf,
    );
    // Memory never holds a credential (FR-56): an entry that held one,
    // even one already redacted, is dropped.
    const entries: string[] = [];
    for (const entry of drafted.entries) {
      if (
        redactor.redactText(entry) === entry &&
        !entry.includes(redactedText) &&
        !entries.some((known) => sameEntry(known, entry))
      ) {
        entries.push(entry);
      }
    }
    const summary = redactor.redactText(drafted.summary);
    const added = entries.filter(
      (entry) => !current.some((known) => known === entry),
    );
    const removed = current.filter(
      (entry) => !entries.some((kept) => kept === entry),
    );
    const trailer: TrailerAgent = {
      name: manager.name,
      role: manager.role,
      aiProvider: manager.aiProvider,
      model: modelOf(manager, await options.defaultModels?.()) ?? "",
    };

    let pullRequest: CurationOutcome["pullRequest"];
    if (added.length > 0 || removed.length > 0) {
      const [repository, writable] = await Promise.all([
        client.get(),
        client.installationToken(),
      ]);
      await commitFile({
        url: options.pushUrl?.(repository) ?? `${repository.htmlUrl}.git`,
        token: writable.token,
        from,
        to: memoryBranch,
        path: memoryPath,
        content: memoryFile(entries),
        message: `docs(memory): curate the repository's memory\n\n${summary}`,
        identity: await options.gitIdentity(floor.id),
        agent: trailer,
        scratchDir: options.scratchDir,
      });
      const body = describe({
        manager,
        trailer,
        trigger,
        summary,
        added,
        removed,
        proposals,
        nameOf,
      });
      if (open === undefined) {
        const opened = await client.createPullRequest({
          title: memoryPullRequestTitle,
          body,
          head: memoryBranch,
          base: floor.defaultBranch,
        });
        pullRequest = {
          number: opened.number,
          url: opened.htmlUrl,
          opened: true,
        };
      } else {
        // The pull request follows its branch; the comment says what changed.
        await client.createComment(open.number, body);
        pullRequest = { number: open.number, url: open.htmlUrl, opened: false };
      }
    }

    const curation = await record({
      curatedBy: drafted.curatedBy,
      summary: shorten(summary, 2000),
      entries: entries.length,
      pullRequest: pullRequest?.number ?? null,
    });
    if (curation === undefined) {
      throw new Error(
        `${manager.name} curated the memory for this Batch already.`,
      );
    }
    await events.publish({
      type: "memory.curated",
      version: 1,
      floorId: floor.id,
      agentId: manager.id,
      reason: trigger.reason,
      ...(trigger.reason === "batch" ? { batchId: trigger.batchId } : {}),
      curatedBy: drafted.curatedBy,
      entries: entries.length,
      added: added.length,
      removed: removed.length,
      proposals: proposals.length,
      ...(pullRequest === undefined
        ? {}
        : { pullRequest: pullRequest.number, url: pullRequest.url }),
    });
    if (pullRequest !== undefined) {
      await notices
        .raise({
          kind: "info",
          title: shorten(
            `Memory PR #${String(pullRequest.number)} ${pullRequest.opened ? "opened" : "updated"} on ${floor.name}: ${plural(added.length, "entry", "entries")} added, ${String(removed.length)} removed`,
            200,
          ),
          floorId: floor.id,
          agentId: manager.id,
          pullRequest: { number: pullRequest.number, url: pullRequest.url },
        })
        // The pull request is open; a Notice that fails undoes none of it.
        .catch(report);
    }
    return {
      curation,
      entries,
      added,
      removed,
      proposals,
      ...(pullRequest === undefined ? {} : { pullRequest }),
      ...(drafted.fallback === undefined ? {} : { fallback: drafted.fallback }),
    };
  };

  const curate = (floorId: string, trigger: CurationTrigger) =>
    exclusive(() => curateNow(floorId, trigger));

  /** The Batches in progress that have ended and were not curated yet. */
  const endedBatches = async (): Promise<
    { readonly floorId: string; readonly batchId: number }[]
  > => {
    if (options.batches === undefined) {
      return [];
    }
    // A finished Batch has ended; one in progress has once its issues are
    // all closed, though it may wait on a blocked one to finish.
    const finished = await options.batches.finishedSince(
      new Date(now().getTime() - tidyUpMs),
    );
    const open = (await options.batches.open()).filter(
      ({ status }) => status === "in_progress",
    );
    const candidates = [...finished, ...open];
    const done = await store.curatedBatches(candidates.map(({ id }) => id));
    const ended: { floorId: string; batchId: number }[] = [];
    for (const batch of candidates.filter(({ id }) => !done.has(id))) {
      try {
        const floor = await options.floors.get(batch.floorId);
        const plan = await options.batches.latestPlan(batch.id);
        if (floor?.archivedAt !== null || plan === undefined) {
          continue;
        }
        if (batch.status === "finished") {
          ended.push({ floorId: floor.id, batchId: batch.id });
          continue;
        }
        const client = github.repository(floor.repository);
        let closed = true;
        for (const { issue } of plan.items) {
          if ((await client.getIssue(issue)).state !== "closed") {
            closed = false;
            break;
          }
        }
        if (closed) {
          ended.push({ floorId: floor.id, batchId: batch.id });
        }
      } catch (error) {
        report(error);
      }
    }
    return ended;
  };

  /** The Floors whose weekly tidy-up is due. */
  const tidyUpsDue = async (): Promise<string[]> => {
    const waiting = new Set(await store.floorsWithPending());
    const due: string[] = [];
    for (const floor of await options.floors.list()) {
      const latest = await store.latestCuration(floor.id);
      const since =
        latest?.createdAt ??
        (waiting.has(floor.id)
          ? (await store.pending(floor.id))[0]?.createdAt
          : undefined);
      if (
        since !== undefined &&
        now().getTime() - since.getTime() >= tidyUpMs
      ) {
        due.push(floor.id);
      }
    }
    return due;
  };

  const check = async (): Promise<CurationOutcome[]> => {
    const outcomes: CurationOutcome[] = [];
    const run = async (floorId: string, trigger: CurationTrigger) => {
      try {
        const outcome = await curate(floorId, trigger);
        if (outcome !== undefined) {
          outcomes.push(outcome);
        }
      } catch (error) {
        report(error);
      }
    };
    for (const { floorId, batchId } of await endedBatches()) {
      await run(floorId, { reason: "batch", batchId });
    }
    for (const floorId of await tidyUpsDue()) {
      await run(floorId, { reason: "weekly" });
    }
    return outcomes;
  };

  let running = false;
  let timer: NodeJS.Timeout | undefined;
  let round: Promise<unknown> = Promise.resolve();

  const tick = (): void => {
    round = (async () => {
      await check().catch(report);
      if (running) {
        timer = setTimeout(tick, options.intervalMs ?? 60 * 60 * 1000);
      }
    })();
  };

  return {
    curate,
    check,
    start() {
      if (running) {
        return;
      }
      running = true;
      timer = setTimeout(tick, options.intervalMs ?? 60 * 60 * 1000);
    },
    async stop() {
      running = false;
      clearTimeout(timer);
      await round;
    },
  };
}
