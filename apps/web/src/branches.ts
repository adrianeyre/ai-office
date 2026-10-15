import type { EventType } from "@ai-office/events/schema";
import {
  floorBranchesSchema,
  type BranchCommit,
  type BranchLane,
} from "@ai-office/shared";
import { queryOptions } from "@tanstack/react-query";

import { getJson } from "./api.ts";

// The Branches page's data and drawing, apart from React: each Floor's AI
// Office branches as a query, what a lane's ahead/behind badge says, and
// where the lane view puts the trunk, each lane and each commit.

/**
 * How often the page reads a Floor's branches without being told they
 * changed: once a minute, the most often anything asks GitHub on a timer.
 * The server keeps what GitHub said for as long.
 */
export const branchesRefetchMs = 60_000;

/** A Floor's AI Office branches (`GET /api/floors/:floorId/branches`). */
export const branchesQuery = (floorId: string) =>
  queryOptions({
    queryKey: ["floors", floorId, "branches"],
    queryFn: () =>
      getJson(
        `/api/floors/${encodeURIComponent(floorId)}/branches`,
        floorBranchesSchema,
      ),
    refetchInterval: branchesRefetchMs,
    refetchIntervalInBackground: false,
  });

/**
 * The events on a Floor after which its branches are read again: GitHub's
 * webhooks, AI Office's own pushes and pull requests, and an Agent
 * starting or stopping work, or an issue moving stage.
 */
export const branchEventTypes: readonly EventType[] = [
  "repository.changed",
  "branch.pushed",
  "pull_request.opened",
  "pull_request.merged",
  "sandbox.started",
  "sandbox.stopped",
  "agent.status_changed",
  "issue.label_changed",
  "batch.started",
  "batch.finished",
  "grilling.session_changed",
  "grilling.documents_written",
  "grilling.pull_request_opened",
];

/** How long the page waits after an event for more before reading again. */
export const branchEventDebounceMs = 1000;

/** The ahead/behind badge, as it shows: `↑3 ↓12`. */
export const aheadBehindBadge = (
  lane: Pick<BranchLane, "aheadBy" | "behindBy">,
): string => `↑${String(lane.aheadBy)} ↓${String(lane.behindBy)}`;

const commits = (count: number): string =>
  `${String(count)} ${count === 1 ? "commit" : "commits"}`;

/** What the badge says, in words: "3 commits ahead of main, 12 behind". */
export const aheadBehindText = (
  lane: Pick<BranchLane, "aheadBy" | "behindBy">,
  defaultBranch: string,
): string =>
  `${commits(lane.aheadBy)} ahead of ${defaultBranch}, ${String(lane.behindBy)} behind`;

/** A commit's sha as people quote it. */
export const shortSha = (sha: string): string => sha.slice(0, 7);

/** What a commit's dot says when hovered or focused. */
export const commitText = (commit: BranchCommit, at: string): string =>
  `${shortSha(commit.sha)} ${commit.message}, by ${commit.author}${
    commit.agent === null ? "" : ` (Agent: ${commit.agent})`
  }, ${at}`;

/** How far apart things are drawn, in SVG units (CSS pixels). */
export const laneGeometry = {
  /** Where the trunk starts, from the left. */
  left: 24,
  /** The trunk's height from the top: room for its name above it. */
  trunkY: 32,
  /** Between two lanes, and between the trunk and the first. */
  row: 44,
  /** Between two merge bases on the trunk. */
  base: 36,
  /** Between two commits on a lane. */
  commit: 28,
  /** How far a lane runs from where it leaves the trunk to its first commit. */
  bend: 24,
  /** Room for a lane's name after its last commit, per character. */
  character: 7.5,
  /** Room below the last lane and right of the longest name. */
  margin: 24,
} as const;

export interface LaidOutCommit {
  readonly x: number;
  readonly commit: BranchCommit;
}

export interface LaidOutLane {
  readonly lane: BranchLane;
  readonly y: number;
  /** Where it leaves the trunk: its merge base's place on it. */
  readonly splitX: number;
  /** Its line: down from the trunk, then along to its last commit. */
  readonly path: string;
  /** Its commits, oldest first. */
  readonly commits: readonly LaidOutCommit[];
  /** How many older commits of its own are not drawn; 0 when none. */
  readonly hidden: number;
  /** Where the "…" for them goes, if any. */
  readonly hiddenX: number;
  /** Where its name starts. */
  readonly labelX: number;
}

export interface LaneLayout {
  readonly width: number;
  readonly height: number;
  readonly trunkY: number;
  /** The trunk runs from here to `width`. */
  readonly trunkX: number;
  /** Each merge base on the trunk, oldest first. */
  readonly bases: readonly {
    readonly x: number;
    readonly commit: BranchCommit;
  }[];
  /** Top to bottom: the newest merge base first, so no lane crosses another. */
  readonly lanes: readonly LaidOutLane[];
}

const byTime = (a: BranchCommit, b: BranchCommit): number =>
  Date.parse(a.authoredAt) - Date.parse(b.authoredAt) ||
  (a.sha < b.sha ? -1 : a.sha > b.sha ? 1 : 0);

/**
 * Where the lane view draws each lane: the default branch as a trunk
 * across the top, each merge base a point on it in time order, and each
 * lane leaving the trunk at its merge base, one row each, its commits
 * along it oldest first, its name after them.
 */
export function layoutLanes(
  lanes: readonly BranchLane[],
  geometry: typeof laneGeometry = laneGeometry,
): LaneLayout {
  const bases = [
    ...new Map(
      lanes.map(({ mergeBase }) => [mergeBase.sha, mergeBase]),
    ).values(),
  ].sort(byTime);
  const baseX = new Map(
    bases.map((base, index) => [
      base.sha,
      geometry.left + index * geometry.base,
    ]),
  );
  const rows = [...lanes].sort(
    (a, b) =>
      byTime(b.mergeBase, a.mergeBase) ||
      (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
  );
  const laidOut = rows.map((lane, index): LaidOutLane => {
    const y = geometry.trunkY + (index + 1) * geometry.row;
    const splitX = baseX.get(lane.mergeBase.sha) ?? geometry.left;
    const hidden = Math.max(0, lane.aheadBy - lane.commits.length);
    const hiddenX = splitX + geometry.bend + geometry.commit / 2;
    const first = hiddenX + (hidden > 0 ? geometry.commit : 0);
    const commits = lane.commits.map((commit, at) => ({
      x: first + at * geometry.commit,
      commit,
    }));
    const end = commits.at(-1)?.x ?? splitX + geometry.bend;
    return {
      lane,
      y,
      splitX,
      // Down from the trunk, bending into its row, then along it.
      path: `M ${String(splitX)} ${String(geometry.trunkY)} V ${String(y - geometry.bend / 2)} Q ${String(splitX)} ${String(y)} ${String(splitX + geometry.bend / 2)} ${String(y)} H ${String(end)}`,
      commits,
      hidden,
      hiddenX,
      labelX: end + geometry.commit / 2,
    };
  });
  const right = Math.max(
    geometry.left + bases.length * geometry.base,
    ...laidOut.map(
      ({ labelX, lane }) => labelX + lane.name.length * geometry.character,
    ),
  );
  return {
    width: Math.ceil(right + geometry.margin),
    height: geometry.trunkY + rows.length * geometry.row + geometry.margin,
    trunkY: geometry.trunkY,
    trunkX: geometry.left - geometry.base / 2,
    bases: bases.map((commit) => ({
      x: baseX.get(commit.sha) ?? geometry.left,
      commit,
    })),
    lanes: laidOut,
  };
}

/** Where the Floor last picked on the Branches page is kept, in this browser. */
const lastFloorKey = "ai-office:branches-floor";

/** The Floor last picked on the Branches page, if one was. */
export function lastBranchesFloor(): string | undefined {
  try {
    return globalThis.localStorage.getItem(lastFloorKey) ?? undefined;
  } catch {
    return undefined;
  }
}

/** Remembers the Floor picked, for the next time the page opens. */
export function rememberBranchesFloor(floorId: string): void {
  try {
    globalThis.localStorage.setItem(lastFloorKey, floorId);
  } catch {
    // Not kept: the page opens on the first Floor next time.
  }
}

const relative = new Intl.RelativeTimeFormat("en-GB", { numeric: "auto" });
const steps: readonly [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 365 * 86_400_000],
  ["month", 30 * 86_400_000],
  ["week", 7 * 86_400_000],
  ["day", 86_400_000],
  ["hour", 3_600_000],
  ["minute", 60_000],
];

/** How long ago `time` was, as of `now`: "3 hours ago", "yesterday". */
export function timeAgo(time: string, now: Date): string {
  const ago = now.getTime() - Date.parse(time);
  for (const [unit, size] of steps) {
    if (Math.abs(ago) >= size) {
      return relative.format(-Math.round(ago / size), unit);
    }
  }
  return "just now";
}
