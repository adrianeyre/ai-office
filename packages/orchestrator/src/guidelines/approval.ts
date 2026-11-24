import { createHash } from "node:crypto";

import type { EventBus } from "@ai-office/events";
import type { Commit, GitHubApp } from "@ai-office/github";
import {
  floorGuidelinesPath,
  parseGuideline,
  type Guideline,
  type GuidelineApproval,
  type RefusedGuideline,
  type Redactor,
} from "@ai-office/shared";

import type { FloorRecord, FloorStore } from "../floors/store.ts";
import type { Notices } from "../notices/notices.ts";
import type { NoticeRecord } from "../notices/store.ts";
import type { ExecuteWork } from "../work/queue.ts";
import { readFloorGuidelines } from "./read.ts";
import type {
  GuidelineApprovalRecord,
  GuidelineChangeRecord,
  GuidelineChangeStatus,
  GuidelineStore,
} from "./store.ts";

// Only the Guideline versions the Owner approved (Guidelines, Specs and
// Hooks PRD, FR-103, FR-111; ADR 0014). At intake and before each task, a
// Floor's Guidelines are read from its default branch through the GitHub
// App, and each file's version is settled:
//
// - **approved** when its content's hash was approved before (a later read
//   of the same content needs no new approval, and a file put back as it
//   was approved is approved again); or when the last commit that changed
//   it reached the default branch through a pull request the Owner merged
//   (on GitHub, or with "Approve and merge" in AI Office; never the Merge
//   Policy's automatic merge), or was pushed by the Owner. Who merged or
//   pushed is GitHub's record, never a commit's author, which anyone can
//   write and AI Office writes as the Owner (ADR 0002). The Owner is the
//   GitHub login of General Settings' Intake card.
// - **awaiting approval** otherwise: Agents keep the last version the
//   Owner approved, or get nothing for a new file, until the Owner
//   approves it in the Floor admin or dismisses it. A file that breaks
//   FR-102's rules, or holds a line like a credential (FR-112), is never
//   approved, and Agents keep the last approved version of it too.
// - A file deleted from the default branch, by anyone, reaches no Agent
//   from that read on: Agents follow only what is there.
//
// Each version is approved, or seen awaiting, once: `guideline.approved`
// and `guideline.awaiting` are raised then, and `guideline.dismissed` when
// the Owner dismisses one. While any wait, the Floor has one action
// Notice, "Guidelines changed on <floor>: N awaiting approval", taken off
// the Notice Board once none does.

/** The action of the Notice: it opens the Floor admin's Guidelines. */
export const openGuidelinesAction = "open_guidelines";

/** The SHA-256 of a Guideline's whole file, by which a version is known. */
export const guidelineContentHash = (content: string): string =>
  createHash("sha256").update(content, "utf8").digest("hex");

/** A Guideline as Agents get it: in the version the Owner approved. */
export interface ApprovedGuideline extends Guideline {
  readonly contentHash: string;
  readonly approval: GuidelineApproval;
  /**
   * Whether it is the version on the default branch: false while Agents
   * keep an earlier one, a later version waiting or refused.
   */
  readonly current: boolean;
}

/** A Guideline whose version on the default branch the Owner has not approved. */
export interface UnapprovedGuideline {
  readonly name: string;
  readonly path: string;
  readonly contentHash: string;
  /** `awaiting` the Owner's approval, or `dismissed` by the Owner. */
  readonly status: GuidelineChangeStatus;
  /** The last commit that changed it. */
  readonly commitSha: string | null;
  /** The version Agents keep meanwhile; null when there is none. */
  readonly approvedHash: string | null;
}

/** A Floor's Guidelines, as settled from its default branch. */
export interface FloorGuidelineApprovals {
  /** What Agents get: each Guideline in the version approved, by name. */
  readonly approved: readonly ApprovedGuideline[];
  /** The Guidelines whose version on the default branch is not approved. */
  readonly unapproved: readonly UnapprovedGuideline[];
  /** The files that break the rules, each with its reason (FR-102). */
  readonly refused: readonly RefusedGuideline[];
}

/** How many of a Floor's Guidelines await the Owner's approval. */
export const awaitingCount = (state: FloorGuidelineApprovals): number =>
  state.unapproved.filter(({ status }) => status === "awaiting").length;

/** The Notice's title: how many of the Floor's Guidelines wait. */
export const guidelinesNoticeTitle = (floorName: string, count: number) =>
  `Guidelines changed on ${floorName}: ${String(count)} awaiting approval`;

/** Why the Owner's approval or dismissal of a version was refused. */
export class GuidelineVersionError extends Error {
  /**
   * `not_found`: the Floor has no such Guideline on its default branch;
   * `changed`: its version there is not the one named (it changed
   * meanwhile, or is approved, or was dismissed already).
   */
  readonly code: "not_found" | "changed";

  constructor(code: "not_found" | "changed", message: string) {
    super(message);
    this.name = "GuidelineVersionError";
    this.code = code;
  }
}

export interface GuidelineApprovalsOptions {
  readonly github: GitHubApp;
  readonly store: GuidelineStore;
  readonly floors: Pick<FloorStore, "get">;
  readonly notices: Notices;
  readonly events: EventBus;
  /** The Owner's GitHub login (General Settings' Intake card), read afresh. */
  readonly ownerLogin: () => Promise<string>;
  /**
   * Whether the Owner merged the Floor's pull request with "Approve and
   * merge" in AI Office, which GitHub records as the App's merge. By the
   * `pull_request.merged` events otherwise.
   */
  readonly ownerMerged?: (
    floorId: string,
    pullRequest: number,
  ) => Promise<boolean>;
  /** Finds lines that look like a credential (FR-112). */
  readonly redactor?: Redactor;
  readonly now?: () => Date;
}

export interface GuidelineApprovals {
  /**
   * Reads the Floor's Guidelines from its default branch, settles which
   * versions the Owner approved, raises their events once, and keeps the
   * Floor's Notice: at intake and before each task. Resolves with what
   * Agents get.
   */
  sync(floor: FloorRecord): Promise<FloorGuidelineApprovals>;
  /**
   * The Owner approves, in the Floor admin, the version of a Guideline on
   * the default branch with `contentHash`, for exactly the content seen.
   * A `GuidelineVersionError` when that is not its version there, or it is
   * approved already.
   */
  approve(
    floorId: string,
    name: string,
    contentHash: string,
  ): Promise<FloorGuidelineApprovals>;
  /**
   * The Owner dismisses the version awaiting approval: Agents keep the
   * last approved one, and it waits no more. A `GuidelineVersionError`
   * when that is not the version awaiting approval.
   */
  dismiss(
    floorId: string,
    name: string,
    contentHash: string,
  ): Promise<FloorGuidelineApprovals>;
  /** Removes the Notice's action handler. */
  stop(): void;
}

const sameLogin = (a: string, b: string): boolean =>
  a !== "" && a.toLowerCase() === b.toLowerCase();

/** The Floor a Guidelines Notice is about, if it is one. */
const isGuidelinesNotice = (notice: NoticeRecord): boolean =>
  notice.actions.some(({ id }) => id === openGuidelinesAction);

/** How the Owner approved a commit's change, if the Owner did. */
interface OwnerApproval {
  readonly approval: Extract<GuidelineApproval, "owner_merge" | "owner_push">;
  readonly pullRequest?: number;
  readonly url: string;
}

export function createGuidelineApprovals(
  options: GuidelineApprovalsOptions,
): GuidelineApprovals {
  const { github, store, notices, events } = options;
  const now = options.now ?? (() => new Date());

  /** By the `pull_request.merged` events: the Owner's "Approve and merge". */
  const ownerMergedByEvents = async (
    floorId: string,
    pullRequest: number,
  ): Promise<boolean> => {
    const limit = 500;
    let beforeId: number | undefined;
    for (;;) {
      const page = await events.history({
        filter: { floorId, types: ["pull_request.merged"] },
        beforeId,
        limit,
      });
      if (
        page.some(
          ({ event }) =>
            event.type === "pull_request.merged" &&
            event.pullRequest === pullRequest &&
            event.by === "owner",
        )
      ) {
        return true;
      }
      if (page.length < limit) {
        return false;
      }
      beforeId = page.at(-1)?.id;
    }
  };
  const ownerMerged = options.ownerMerged ?? ownerMergedByEvents;

  /** Whether the Owner merged or pushed the commit, by GitHub's record. */
  const ownerApprovalOf = async (
    floor: FloorRecord,
    commit: Commit,
    owner: string,
  ): Promise<OwnerApproval | undefined> => {
    const repository = github.repository(floor.repository);
    const merged = await repository.mergedPullRequestOf(commit.sha);
    if (
      merged?.base === floor.defaultBranch &&
      (sameLogin(merged.mergedBy ?? "", owner) ||
        (await ownerMerged(floor.id, merged.number)))
    ) {
      return {
        approval: "owner_merge",
        pullRequest: merged.number,
        url: merged.htmlUrl,
      };
    }
    const pusher = await repository.pusherOf(commit.sha, floor.defaultBranch);
    if (pusher !== undefined && sameLogin(pusher, owner)) {
      return { approval: "owner_push", url: commit.htmlUrl };
    }
    return undefined;
  };

  /** The Guideline in its newest approved version other than the current. */
  const lastApproved = async (
    floorId: string,
    name: string,
    approvals: readonly GuidelineApprovalRecord[],
  ): Promise<ApprovedGuideline | undefined> => {
    const latest = approvals.filter((each) => each.name === name).at(-1);
    if (latest === undefined) {
      return undefined;
    }
    const content = await store.approvedContent(
      floorId,
      name,
      latest.contentHash,
    );
    if (content === undefined) {
      return undefined;
    }
    const parsed = parseGuideline(`${name}.md`, content, {
      ...(options.redactor === undefined ? {} : { redactor: options.redactor }),
    });
    return parsed.ok
      ? {
          ...parsed.guideline,
          contentHash: latest.contentHash,
          approval: latest.approval,
          current: false,
        }
      : undefined;
  };

  /**
   * Reads and settles the Floor's Guidelines: each version is approved or
   * recorded, and its event raised, once (the store says which was first),
   * so two reads at once raise nothing twice.
   */
  const settle = async (
    floor: FloorRecord,
  ): Promise<FloorGuidelineApprovals> => {
    const read = await readFloorGuidelines(github, floor, {
      ...(options.redactor === undefined ? {} : { redactor: options.redactor }),
    });
    if (read.guidelines.length === 0 && read.refused.length === 0) {
      return { approved: [], unapproved: [], refused: [] };
    }
    const owner = await options.ownerLogin();
    const repository = github.repository(floor.repository);
    let approvals = await store.approvals(floor.id);
    const changes = new Map<string, GuidelineChangeRecord>(
      (await store.changes(floor.id)).map((change) => [
        JSON.stringify([change.name, change.contentHash]),
        change,
      ]),
    );
    const approvalOf = (name: string, contentHash: string) =>
      approvals.find(
        (each) => each.name === name && each.contentHash === contentHash,
      );

    const approved: ApprovedGuideline[] = [];
    const unapproved: UnapprovedGuideline[] = [];
    for (const guideline of read.guidelines) {
      const contentHash = guidelineContentHash(guideline.content);
      const known = approvalOf(guideline.name, contentHash);
      if (known !== undefined) {
        approved.push({
          ...guideline,
          contentHash,
          approval: known.approval,
          current: true,
        });
        continue;
      }
      const commit = await repository.lastCommitChanging(
        guideline.path,
        floor.defaultBranch,
      );
      const change = changes.get(JSON.stringify([guideline.name, contentHash]));
      // The same commit as last time: GitHub's record of it stands.
      const byOwner =
        commit === undefined || change?.commitSha === commit.sha
          ? undefined
          : await ownerApprovalOf(floor, commit, owner);
      if (byOwner !== undefined) {
        const at = now();
        if (
          await store.approve(
            floor.id,
            {
              name: guideline.name,
              contentHash,
              content: guideline.content,
              approval: byOwner.approval,
            },
            at,
          )
        ) {
          await events.publish({
            type: "guideline.approved",
            version: 1,
            floorId: floor.id,
            name: guideline.name,
            contentHash,
            approval: byOwner.approval,
            ...(commit === undefined ? {} : { sha: commit.sha }),
            ...(byOwner.pullRequest === undefined
              ? {}
              : { pullRequest: byOwner.pullRequest }),
            url: byOwner.url,
          });
        }
        approvals = [
          ...approvals,
          {
            name: guideline.name,
            contentHash,
            approval: byOwner.approval,
            approvedAt: at,
          },
        ];
        approved.push({
          ...guideline,
          contentHash,
          approval: byOwner.approval,
          current: true,
        });
        continue;
      }
      const commitSha = commit?.sha ?? change?.commitSha ?? null;
      if (change?.commitSha !== commitSha) {
        const first = await store.recordChange(
          floor.id,
          {
            name: guideline.name,
            contentHash,
            content: guideline.content,
            commitSha,
          },
          now(),
        );
        if (first) {
          await events.publish({
            type: "guideline.awaiting",
            version: 1,
            floorId: floor.id,
            name: guideline.name,
            contentHash,
            ...(commit === undefined
              ? {}
              : { sha: commit.sha, url: commit.htmlUrl }),
          });
        }
      }
      // Agents keep the last version the Owner approved meanwhile.
      const kept = await lastApproved(floor.id, guideline.name, approvals);
      if (kept !== undefined) {
        approved.push(kept);
      }
      unapproved.push({
        name: guideline.name,
        path: guideline.path,
        contentHash,
        status: change?.status ?? "awaiting",
        commitSha,
        approvedHash: kept?.contentHash ?? null,
      });
    }
    // A file that breaks the rules is never approved: Agents keep the last
    // version that was.
    for (const refused of read.refused) {
      if (approved.some(({ name }) => name === refused.name)) {
        continue;
      }
      const kept = await lastApproved(floor.id, refused.name, approvals);
      if (kept !== undefined) {
        approved.push(kept);
      }
    }
    return {
      approved: approved.sort((a, b) =>
        a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
      ),
      unapproved,
      refused: read.refused,
    };
  };

  /** Notices being taken off the board because none waits. */
  const resolving = new Set<string>();
  /** How many waited on each Floor at its last read. */
  const waiting = new Map<string, number>();
  /** The title of each Floor's Notice raised last, while any waits. */
  const raised = new Map<string, string>();

  const unregister = notices.registerAction(
    openGuidelinesAction,
    async (notice) => {
      if (resolving.has(notice.id) || notice.floorId === null) {
        return;
      }
      const floor = await options.floors.get(notice.floorId);
      const count =
        floor === undefined ? 0 : awaitingCount(await settle(floor));
      if (count > 0) {
        throw new Error(
          `${count === 1 ? "A Guideline still awaits" : `${String(count)} Guidelines still await`} your approval: approve or dismiss ${count === 1 ? "it" : "them"} in the Floor admin.`,
        );
      }
    },
  );

  /** One Floor's Notice is kept at a time. */
  const locks = new Map<string, Promise<unknown>>();
  const exclusive = <Value>(
    floorId: string,
    work: () => Promise<Value>,
  ): Promise<Value> => {
    const next = (locks.get(floorId) ?? Promise.resolve()).then(work, work);
    const settled = next.catch(() => undefined);
    locks.set(floorId, settled);
    void settled.then(() => {
      if (locks.get(floorId) === settled) {
        locks.delete(floorId);
      }
    });
    return next;
  };

  /**
   * One action Notice per Floor while any Guideline waits, its title
   * saying how many: raised afresh (the old one dismissed) when that
   * changes, and taken off the board, as acted on, once none waits.
   */
  const keepNotice = (floor: FloorRecord, count: number): Promise<void> =>
    exclusive(floor.id, async () => {
      waiting.set(floor.id, count);
      const open = (await notices.open({ floorId: floor.id })).filter(
        isGuidelinesNotice,
      );
      if (count === 0) {
        raised.delete(floor.id);
        for (const notice of open) {
          resolving.add(notice.id);
          try {
            await notices.act(notice.id, openGuidelinesAction);
          } finally {
            resolving.delete(notice.id);
          }
        }
        return;
      }
      const title = guidelinesNoticeTitle(floor.name, count);
      const kept = open.find((notice) => notice.title === title);
      // One the Owner dismissed, with as many waiting, is not raised again.
      if (kept === undefined && raised.get(floor.id) !== title) {
        await notices.raise({
          kind: "action",
          title,
          floorId: floor.id,
          actions: [
            {
              id: openGuidelinesAction,
              label: "Open Guidelines",
              href: floorGuidelinesPath(floor.id),
            },
          ],
        });
      }
      raised.set(floor.id, title);
      for (const notice of open) {
        if (notice !== kept) {
          await notices.dismiss(notice.id);
        }
      }
    });

  const sync = async (floor: FloorRecord): Promise<FloorGuidelineApprovals> => {
    const state = await settle(floor);
    const count = awaitingCount(state);
    // Nothing to raise, and nothing raised before: no Notice to look for.
    if (count > 0 || (waiting.get(floor.id) ?? -1) !== 0) {
      await keepNotice(floor, count);
    }
    return state;
  };

  const floorOf = async (floorId: string): Promise<FloorRecord> => {
    const floor = await options.floors.get(floorId);
    if (floor === undefined) {
      throw new GuidelineVersionError(
        "not_found",
        `There is no Floor "${floorId}".`,
      );
    }
    return floor;
  };

  /** The Guideline's version on the default branch, if it is `contentHash`. */
  const unapprovedVersion = async (
    floor: FloorRecord,
    name: string,
    contentHash: string,
  ): Promise<UnapprovedGuideline> => {
    const state = await settle(floor);
    const version = state.unapproved.find((each) => each.name === name);
    if (version === undefined) {
      const there =
        state.approved.some((each) => each.name === name && each.current) ||
        state.refused.some((each) => each.name === name);
      throw there
        ? new GuidelineVersionError(
            "changed",
            `Guideline "${name}" on ${floor.name} has no version awaiting approval: it is approved already, or breaks the rules.`,
          )
        : new GuidelineVersionError(
            "not_found",
            `${floor.name} has no Guideline "${name}" on its default branch.`,
          );
    }
    if (version.contentHash !== contentHash) {
      throw new GuidelineVersionError(
        "changed",
        `Guideline "${name}" on ${floor.name} has changed since: look at its version now.`,
      );
    }
    return version;
  };

  return {
    sync,

    async approve(floorId, name, contentHash) {
      const floor = await floorOf(floorId);
      const version = await unapprovedVersion(floor, name, contentHash);
      const content = await store.changeContent(floorId, name, contentHash);
      if (content === undefined) {
        throw new GuidelineVersionError(
          "changed",
          `Guideline "${name}" on ${floor.name} has changed since: look at its version now.`,
        );
      }
      if (
        await store.approve(
          floorId,
          { name, contentHash, content, approval: "owner_admin" },
          now(),
        )
      ) {
        await events.publish({
          type: "guideline.approved",
          version: 1,
          floorId,
          name: version.name,
          contentHash,
          approval: "owner_admin",
        });
      }
      return sync(floor);
    },

    async dismiss(floorId, name, contentHash) {
      const floor = await floorOf(floorId);
      const version = await unapprovedVersion(floor, name, contentHash);
      if (
        version.status !== "awaiting" ||
        !(await store.dismiss(floorId, name, contentHash, now()))
      ) {
        throw new GuidelineVersionError(
          "changed",
          `That version of Guideline "${name}" on ${floor.name} was dismissed already.`,
        );
      }
      await events.publish({
        type: "guideline.dismissed",
        version: 1,
        floorId,
        name,
        contentHash,
      });
      return sync(floor);
    },

    stop() {
      unregister();
    },
  };
}

/**
 * Does each piece of work by `execute`, once its Floor's Guidelines are
 * read and settled: before each task (FR-103). A failed read is told to
 * `onError`, and the work goes on with what was approved before.
 */
export function withGuidelines(
  execute: ExecuteWork,
  using: {
    readonly floors: Pick<FloorStore, "get">;
    readonly guidelines: Pick<GuidelineApprovals, "sync">;
    readonly onError?: (error: unknown) => void;
  },
): ExecuteWork {
  return async (work, signal) => {
    try {
      const floor = await using.floors.get(work.floorId);
      if (floor !== undefined) {
        await using.guidelines.sync(floor);
      }
    } catch (error) {
      using.onError?.(error);
    }
    return execute(work, signal);
  };
}
