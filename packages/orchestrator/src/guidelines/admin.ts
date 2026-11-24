import { GitHubNotConfiguredError, isGitHubError } from "@ai-office/github";
import {
  floorErrorCodes,
  parseGuideline,
  type FloorGuideline,
  type FloorGuidelineList,
  type Redactor,
} from "@ai-office/shared";

import { FloorError } from "../floors/errors.ts";
import type { FloorRecord, FloorStore } from "../floors/store.ts";
import {
  awaitingCount,
  GuidelineVersionError,
  type FloorGuidelineApprovals,
  type GuidelineApprovals,
} from "./approval.ts";
import type { GuidelineStore } from "./store.ts";

// The Floor admin's Guidelines card (Guidelines, Specs and Hooks PRD,
// FR-103, FR-111; ADR 0014): each Guideline on the Floor's default branch,
// read afresh, with the version the Owner approved (what Agents get), any
// version awaiting approval, beside it in full so the card can show the
// difference, or why the file reaches no Agent. The Owner approves or
// dismisses exactly the version seen, named by its hash: a version that
// changed meanwhile is refused with a `GuidelineVersionError`.

export interface GuidelinesAdminOptions {
  readonly floors: Pick<FloorStore, "get">;
  readonly approvals: Pick<GuidelineApprovals, "sync" | "approve" | "dismiss">;
  readonly store: Pick<GuidelineStore, "changeContent">;
  readonly redactor?: Redactor;
}

export interface GuidelinesAdmin {
  /** The Floor's Guidelines, read from its default branch now. */
  list(floorId: string): Promise<FloorGuidelineList>;
  /** The Owner approves the version with `contentHash`; then the list. */
  approve(
    floorId: string,
    name: string,
    contentHash: string,
  ): Promise<FloorGuidelineList>;
  /** The Owner dismisses the version with `contentHash`; then the list. */
  dismiss(
    floorId: string,
    name: string,
    contentHash: string,
  ): Promise<FloorGuidelineList>;
}

const byName = (a: FloorGuideline, b: FloorGuideline): number =>
  a.name < b.name ? -1 : a.name > b.name ? 1 : 0;

export function createGuidelinesAdmin(
  options: GuidelinesAdminOptions,
): GuidelinesAdmin {
  const { floors, approvals, store } = options;

  const floorOf = async (floorId: string): Promise<FloorRecord> => {
    const floor = await floors.get(floorId);
    if (floor === undefined) {
      throw new FloorError(
        floorErrorCodes.floorNotFound,
        `There is no Floor "${floorId}".`,
      );
    }
    return floor;
  };

  /** Runs a read of GitHub, turning its failure into a `FloorError`. */
  const onGitHub = async <Result>(
    call: () => Promise<Result>,
  ): Promise<Result> => {
    try {
      return await call();
    } catch (error) {
      if (error instanceof GuidelineVersionError) {
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

  /** One row per Guideline: approved, awaiting and refused, by name. */
  const describe = async (
    floor: FloorRecord,
    state: FloorGuidelineApprovals,
  ): Promise<FloorGuidelineList> => {
    const rows = new Map<string, FloorGuideline>();
    const row = (name: string, path: string): FloorGuideline =>
      rows.get(name) ?? {
        name,
        path,
        inclusion: null,
        fileMatchPatterns: [],
        description: null,
        approved: null,
        awaiting: null,
        error: null,
      };
    // As Agents get it.
    for (const guideline of state.approved) {
      rows.set(guideline.name, {
        ...row(guideline.name, guideline.path),
        inclusion: guideline.inclusion,
        fileMatchPatterns: [...guideline.fileMatchPatterns],
        description: guideline.description,
        approved: {
          contentHash: guideline.contentHash,
          approval: guideline.approval,
          content: guideline.content,
          current: guideline.current,
        },
      });
    }
    for (const version of state.unapproved) {
      const content = await store.changeContent(
        floor.id,
        version.name,
        version.contentHash,
      );
      if (content === undefined) {
        continue;
      }
      const before = row(version.name, version.path);
      const parsed = parseGuideline(`${version.name}.md`, content, {
        ...(options.redactor === undefined
          ? {}
          : { redactor: options.redactor }),
      });
      // With none approved, as the version awaiting approval says.
      const fields =
        before.approved === null && parsed.ok
          ? {
              inclusion: parsed.guideline.inclusion,
              fileMatchPatterns: [...parsed.guideline.fileMatchPatterns],
              description: parsed.guideline.description,
            }
          : {};
      rows.set(version.name, {
        ...before,
        ...fields,
        path: version.path,
        awaiting: {
          contentHash: version.contentHash,
          status: version.status,
          content,
          commitSha: version.commitSha,
        },
      });
    }
    for (const refused of state.refused) {
      rows.set(refused.name, {
        ...row(refused.name, refused.path),
        path: refused.path,
        error: {
          refusal: refused.refusal,
          reason: refused.reason,
          secretLines: [...refused.secretLines],
        },
      });
    }
    return {
      guidelines: [...rows.values()].sort(byName),
      awaitingCount: awaitingCount(state),
    };
  };

  return {
    async list(floorId) {
      const floor = await floorOf(floorId);
      return describe(floor, await onGitHub(() => approvals.sync(floor)));
    },

    async approve(floorId, name, contentHash) {
      const floor = await floorOf(floorId);
      return describe(
        floor,
        await onGitHub(() => approvals.approve(floor.id, name, contentHash)),
      );
    },

    async dismiss(floorId, name, contentHash) {
      const floor = await floorOf(floorId);
      return describe(
        floor,
        await onGitHub(() => approvals.dismiss(floor.id, name, contentHash)),
      );
    },
  };
}
