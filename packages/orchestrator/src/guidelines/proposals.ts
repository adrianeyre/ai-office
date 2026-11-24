import type { EventBus } from "@ai-office/events";
import {
  GitHubNotConfiguredError,
  isGitHubError,
  type GitHubApp,
  type Repository,
} from "@ai-office/github";
import {
  createRedactor,
  floorErrorCodes,
  guidelineProposalBranch,
  guidelinesFolder,
  type GitIdentity,
  type GuidelineProposal,
  type GuidelineProposalList,
  type OpenedGuidelineProposal,
  type Redactor,
} from "@ai-office/shared";

import { modelOf } from "../agents/agents.ts";
import type { AgentRecord, AgentStore } from "../agents/store.ts";
import type { DefaultModels } from "../ai-providers/ai-providers.ts";
import { FloorError } from "../floors/errors.ts";
import type { FloorRecord, FloorStore } from "../floors/store.ts";
import { commitFiles } from "../git/commit-file.ts";
import { agentTrailer, type TrailerAgent } from "../git/identity.ts";
import { guidelineContentHash } from "./approval.ts";
import { proposedGuideline, type ProposalTag } from "./proposal.ts";
import type {
  GuidelineProposalRecord,
  GuidelineProposalStore,
} from "./proposal-store.ts";
import type { GuidelineStore } from "./store.ts";

// The Guidelines Agents propose (Guidelines, Specs and Hooks PRD, FR-110,
// FR-111; ADR 0014). The coder, the docs Agent and QA may end a Handoff, or
// QA's report, with one `<guideline name="…">` block; what it holds is
// read by plain code (`proposedGuideline`), dropped when it holds a
// credential or breaks a Guideline's rules, kept per Floor, and is a
// `guideline.proposed` event. No model accepts one, and no Agent gets one:
// it waits in the Floor admin's Guidelines card for the Owner, who
//
// - opens it as a pull request: the GitHub App commits that one file under
//   `.agents/guidelines/`, authored as the Owner with the proposing
//   Agent's trailer (ADR 0002), on a branch of its own made from the
//   default branch, and opens a pull request for the Owner to merge. Its
//   merge by the Owner is what approves it, as for any Guideline; or
// - rejects it.

/** Why the Owner cannot open or reject a proposal. */
export class GuidelineProposalError extends Error {
  /**
   * `not_found`: the Floor has no proposal of that id;
   * `settled`: it was opened or rejected already;
   * `unchanged`: the default branch already holds the file as proposed.
   */
  readonly code: "not_found" | "settled" | "unchanged";

  constructor(code: "not_found" | "settled" | "unchanged", message: string) {
    super(message);
    this.name = "GuidelineProposalError";
    this.code = code;
  }
}

export interface GuidelineProposals {
  /**
   * Keeps the Guideline an Agent's Handoff (or QA report) proposed, if it
   * proposed one that may be kept; undefined otherwise, or when the same
   * version waits already.
   */
  propose(input: {
    readonly floorId: string;
    readonly issue: number;
    readonly agentId: string;
    /** The Agent's last text, with its block. */
    readonly text: string | null;
    readonly tag: ProposalTag;
  }): Promise<GuidelineProposalRecord | undefined>;
  /** The Floor's proposals waiting for the Owner, oldest first. */
  list(floorId: string): Promise<GuidelineProposalList>;
  /** The Owner opens one as a pull request; then those still waiting. */
  open(floorId: string, id: number): Promise<OpenedGuidelineProposal>;
  /** The Owner rejects one; then those still waiting. */
  reject(floorId: string, id: number): Promise<GuidelineProposalList>;
}

export interface GuidelineProposalsOptions {
  readonly floors: Pick<FloorStore, "get">;
  readonly agents: Pick<AgentStore, "list">;
  readonly store: GuidelineProposalStore;
  /** The versions the Owner approved: a name with none proposes a new one. */
  readonly guidelines: Pick<GuidelineStore, "approvals">;
  readonly events: EventBus;
  /** The GitHub App: it pushes the branch and opens the pull request. */
  readonly github: GitHubApp;
  /** Who a Floor's commits are by (FR-68). */
  readonly gitIdentity: (floorId: string) => Promise<GitIdentity>;
  /** Each AI Provider's default Model, for the trailer of an Agent without its own. */
  readonly defaultModels?: () => Promise<DefaultModels>;
  /** Where the commit is made, in a directory of its own. */
  readonly scratchDir: string;
  /** Where to push a repository; its GitHub page plus `.git` by default. */
  readonly pushUrl?: (repository: Repository) => string;
  /** Finds what looks like a credential in a proposal. */
  readonly redactor?: Redactor;
  readonly now?: () => Date;
}

/** Its file from the top of the repository. */
const pathOf = (name: string): string => `${guidelinesFolder}/${name}.md`;

/** A proposal as the Guidelines card shows it. */
const shown = (
  record: GuidelineProposalRecord,
  agents: readonly AgentRecord[],
): GuidelineProposal => ({
  id: record.id,
  name: record.name,
  path: pathOf(record.name),
  content: record.content,
  contentHash: record.contentHash,
  agentId: record.agentId,
  agentName: agents.find(({ id }) => id === record.agentId)?.name ?? null,
  issue: record.issue,
  proposedAt: record.createdAt.toISOString(),
});

export function createGuidelineProposals(
  options: GuidelineProposalsOptions,
): GuidelineProposals {
  const { store, events, github } = options;
  const redactor = options.redactor ?? createRedactor();
  const now = options.now ?? (() => new Date());
  // One Owner's action on a proposal at a time, so two clicks open one
  // pull request.
  let queue: Promise<unknown> = Promise.resolve();
  const exclusive = <Result>(run: () => Promise<Result>): Promise<Result> => {
    const result = queue.then(run);
    queue = result.catch(() => undefined);
    return result;
  };

  const floorOf = async (floorId: string): Promise<FloorRecord> => {
    const floor = await options.floors.get(floorId);
    if (floor === undefined) {
      throw new FloorError(
        floorErrorCodes.floorNotFound,
        `There is no Floor "${floorId}".`,
      );
    }
    return floor;
  };

  const list = async (floorId: string): Promise<GuidelineProposalList> => {
    const floor = await floorOf(floorId);
    const [waiting, agents] = await Promise.all([
      store.waiting(floor.id),
      options.agents.list(floor.id),
    ]);
    return { proposals: waiting.map((record) => shown(record, agents)) };
  };

  /** The Floor's proposal the Owner acts on, while it still waits. */
  const waitingOne = async (
    floor: FloorRecord,
    id: number,
  ): Promise<GuidelineProposalRecord> => {
    if (floor.archivedAt !== null) {
      throw new FloorError(
        floorErrorCodes.floorArchived,
        `The Floor "${floor.name}" is archived.`,
      );
    }
    const proposal = await store.get(floor.id, id);
    if (proposal === undefined) {
      throw new GuidelineProposalError(
        "not_found",
        `The Floor "${floor.name}" has no proposed Guideline ${String(id)}.`,
      );
    }
    if (proposal.status !== "proposed") {
      throw new GuidelineProposalError(
        "settled",
        proposal.status === "opened"
          ? `The proposed ${proposal.name} Guideline was opened as PR #${String(proposal.pullRequest?.number ?? 0)} already.`
          : `The proposed ${proposal.name} Guideline was rejected already.`,
      );
    }
    return proposal;
  };

  /** Runs a call to GitHub, turning its failure into a `FloorError`. */
  const onGitHub = async <Result>(
    call: () => Promise<Result>,
  ): Promise<Result> => {
    try {
      return await call();
    } catch (error) {
      if (error instanceof GuidelineProposalError) {
        throw error;
      }
      if (error instanceof GitHubNotConfiguredError) {
        throw new FloorError(
          floorErrorCodes.githubNotConfigured,
          error.message,
        );
      }
      if (isGitHubError(error)) {
        throw new FloorError(
          floorErrorCodes.githubUnavailable,
          `GitHub could not be asked: ${error.message}`,
          { cause: error },
        );
      }
      throw error;
    }
  };

  /** Who the commit's trailer names: the Agent that proposed it, or the Manager. */
  const trailerFor = async (
    floor: FloorRecord,
    agentId: string,
  ): Promise<{ readonly trailer: TrailerAgent; readonly name: string }> => {
    const agents = await options.agents.list(floor.id);
    const proposer = agents.find(({ id }) => id === agentId);
    const agent =
      proposer ?? agents.find(({ role }) => role === "manager") ?? undefined;
    if (agent === undefined) {
      throw new Error(`The Floor "${floor.name}" has no Agent to name.`);
    }
    return {
      trailer: {
        name: agent.name,
        role: agent.role,
        aiProvider: agent.aiProvider,
        model: modelOf(agent, await options.defaultModels?.()) ?? "",
      },
      name: proposer?.name ?? "An Agent no longer on this Floor",
    };
  };

  const open = async (
    floorId: string,
    id: number,
  ): Promise<OpenedGuidelineProposal> => {
    const floor = await floorOf(floorId);
    const proposal = await waitingOne(floor, id);
    const isNew = !(await options.guidelines.approvals(floor.id)).some(
      ({ name }) => name === proposal.name,
    );
    const { trailer, name: proposer } = await trailerFor(
      floor,
      proposal.agentId,
    );
    const path = pathOf(proposal.name);
    const branch = guidelineProposalBranch(proposal.name, proposal.id);
    const client = github.repository(floor.repository);
    const pullRequest = await onGitHub(async () => {
      const [repository, writable] = await Promise.all([
        client.get(),
        client.installationToken(),
      ]);
      // Only its one file, on a branch of its own from the default branch.
      const committed = await commitFiles({
        url: options.pushUrl?.(repository) ?? `${repository.htmlUrl}.git`,
        token: writable.token,
        from: floor.defaultBranch,
        to: branch,
        files: [{ path, content: proposal.content }],
        message: [
          `docs(guidelines): ${isNew ? "add" : "change"} the ${proposal.name} Guideline`,
          "",
          `Proposed by ${proposer} on #${String(proposal.issue)}, and opened as a pull request by the Owner.`,
        ].join("\n"),
        identity: await options.gitIdentity(floor.id),
        agent: trailer,
        scratchDir: options.scratchDir,
      });
      if (committed === undefined) {
        throw new GuidelineProposalError(
          "unchanged",
          `${floor.defaultBranch} already has ${path} as proposed: reject the proposal instead.`,
        );
      }
      const [found] = await client.listPullRequests({ head: branch });
      return (
        found ??
        (await client.createPullRequest({
          title: `docs(guidelines): ${isNew ? "add" : "change"} the ${proposal.name} Guideline`,
          body: [
            `${proposer} proposed ${isNew ? "a new Guideline" : "a change to the Guideline"} \`${proposal.name}\` (\`${path}\`) on #${String(proposal.issue)}, and you opened it as this pull request from the Floor admin.`,
            "",
            "Guidelines are your rules for this repository, which every Agent they apply to follows. No Agent gets this version until you merge this pull request: your merge approves it (ADR 0014). Review it as you would instructions to every Agent. Merging is yours: AI Office never merges it.",
            "",
            `Proposed by ${agentTrailer(trailer).replace(/^Agent: /, "")} in AI Office.`,
            "",
          ].join("\n"),
          head: branch,
          base: floor.defaultBranch,
        }))
      );
    });
    const opened = { number: pullRequest.number, url: pullRequest.htmlUrl };
    await store.open(floor.id, proposal.id, opened, now());
    return { pullRequest: opened, proposals: (await list(floor.id)).proposals };
  };

  const reject = async (
    floorId: string,
    id: number,
  ): Promise<GuidelineProposalList> => {
    const floor = await floorOf(floorId);
    const proposal = await waitingOne(floor, id);
    await store.reject(floor.id, proposal.id, now());
    return list(floor.id);
  };

  return {
    async propose({ floorId, issue, agentId, text, tag }) {
      const proposed = proposedGuideline(text, tag, { redactor });
      if (proposed.kind !== "proposed") {
        return undefined;
      }
      const contentHash = guidelineContentHash(proposed.content);
      const kept = await store.propose({
        floorId,
        name: proposed.name,
        contentHash,
        content: proposed.content,
        agentId,
        issue,
        createdAt: now(),
      });
      if (kept === undefined) {
        return undefined;
      }
      const isNew = !(await options.guidelines.approvals(floorId)).some(
        ({ name }) => name === proposed.name,
      );
      await events.publish({
        type: "guideline.proposed",
        version: 1,
        floorId,
        agentId,
        issue,
        name: proposed.name,
        contentHash,
        new: isNew,
      });
      return kept;
    },
    list,
    open: (floorId, id) => exclusive(() => open(floorId, id)),
    reject: (floorId, id) => exclusive(() => reject(floorId, id)),
  };
}

/**
 * Keeps the Guideline an Agent's Handoff (or QA's report) proposed, if
 * any; a failure is reported, never failing the Agent's work.
 */
export async function keepGuidelineProposal(
  proposals: Pick<GuidelineProposals, "propose"> | undefined,
  input: {
    readonly floorId: string;
    readonly issue: number;
    readonly agentId: string;
    /** The Agent's last text, with its block. */
    readonly text: string | null;
    readonly tag: ProposalTag;
  },
  report: (error: unknown) => void,
): Promise<void> {
  if (proposals === undefined) {
    return;
  }
  await proposals.propose(input).catch(report);
}
