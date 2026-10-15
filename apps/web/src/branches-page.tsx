import {
  stageNames,
  type Avatar,
  type BranchCiStatus,
  type BranchLane,
  type FloorBranches,
} from "@ai-office/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  CircleCheck,
  CircleDashed,
  CircleX,
  ExternalLink,
  Loader,
  RotateCcw,
} from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";

import { Badge, type BadgeTone } from "@/components/ui/badge.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Label } from "@/components/ui/label.tsx";
import { PageHeader } from "@/components/ui/page-header.tsx";
import { TableFrame } from "@/components/ui/table-frame.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { cn, selectClass } from "@/lib/utils.ts";

import { AgentLink } from "./agent-link.tsx";
import {
  aheadBehindBadge,
  aheadBehindText,
  branchEventDebounceMs,
  branchEventTypes,
  branchesQuery,
  commitText,
  lastBranchesFloor,
  layoutLanes,
  rememberBranchesFloor,
  shortSha,
  timeAgo,
  type LaidOutCommit,
  type LaidOutLane,
} from "./branches.ts";
import { useEventStream } from "./event-stream.ts";
import { floorsQuery } from "./floors.ts";

// The Branches page: a Floor's AI Office branches as a lane view, the
// default branch the trunk and each branch AI Office pushed a lane off it
// at its merge base, with its commits as dots. Each lane says how far it is
// ahead of and behind the default branch, the issue it is for, its pull
// request and CI, and the Agent on it or the stage it waits in; one far
// behind is marked as likely to conflict. The same is in a table below,
// for a screen reader and the keyboard. It only reads, and it keeps itself
// up to date from the event stream: GitHub's webhooks for the Floor's
// repository, and Agents starting and stopping work.

export interface BranchesPageProps {
  /** The Floor in the address; the last one picked, or the first, when absent. */
  readonly floorId?: string | undefined;
  /** Puts `floorId` in the address; `replace` when the page chose it itself. */
  readonly onFloorChange: (
    floorId: string,
    options?: { readonly replace?: boolean },
  ) => void;
}

/** A small, flat likeness of an Agent's Avatar: its outfit, skin and hair. */
function AvatarBadge({ avatar }: { avatar: Avatar }) {
  return (
    <svg
      aria-hidden
      viewBox="0 0 24 24"
      className="size-6 shrink-0 rounded-full border"
    >
      <circle cx="12" cy="12" r="12" fill={avatar.outfit.primaryColour} />
      <circle cx="12" cy="11" r="6" fill={avatar.skinTone} />
      <path d="M6 10 a6 6 0 0 1 12 0 z" fill={avatar.hairColour} />
    </svg>
  );
}

const ciBadges: Readonly<
  Record<BranchCiStatus, { label: string; tone: BadgeTone; icon: ReactNode }>
> = {
  none: {
    label: "No CI",
    tone: "neutral",
    icon: <CircleDashed aria-hidden />,
  },
  pending: {
    label: "CI running",
    tone: "info",
    icon: <Loader aria-hidden />,
  },
  success: {
    label: "CI passed",
    tone: "success",
    icon: <CircleCheck aria-hidden />,
  },
  failure: {
    label: "CI failed",
    tone: "danger",
    icon: <CircleX aria-hidden />,
  },
};

function CiBadge({ ci }: { ci: BranchCiStatus }) {
  const { label, tone, icon } = ciBadges[ci];
  return (
    <Badge tone={tone}>
      {icon}
      {label}
    </Badge>
  );
}

/** `↑3 ↓12`, said in words to a screen reader. */
function AheadBehind({
  lane,
  defaultBranch,
}: {
  lane: BranchLane;
  defaultBranch: string;
}) {
  const text = aheadBehindText(lane, defaultBranch);
  return (
    <Badge
      tone={lane.likelyToConflict ? "warning" : "neutral"}
      title={text}
      className="font-mono"
    >
      <span aria-hidden>{aheadBehindBadge(lane)}</span>
      <span className="sr-only">{text}</span>
    </Badge>
  );
}

function BehindWarning() {
  return (
    <Badge tone="warning">
      <AlertTriangle aria-hidden />
      Likely to conflict
    </Badge>
  );
}

function ExternalAnchor({
  href,
  children,
}: {
  href: string;
  children: ReactNode;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1 hover:underline"
    >
      {children}
      <ExternalLink aria-hidden className="size-3 shrink-0" />
    </a>
  );
}

/** Where one of a Batch's issues stands, as its badge says it. */
function batchIssueLabel(
  stage: NonNullable<BranchLane["batch"]>["issues"][number]["stage"],
): string {
  if (stage === null) {
    return "to start";
  }
  return stage === "closed" ? "closed" : stageNames[stage];
}

const batchIssueTone = (
  stage: NonNullable<BranchLane["batch"]>["issues"][number]["stage"],
): BadgeTone =>
  stage === "closed" || stage === "ready-to-merge"
    ? "success"
    : stage === null
      ? "neutral"
      : "info";

/**
 * What a lane is for: its issue, a one-pull-request Batch's issues (the
 * one at work now first, then each with where it stands), or its Grilling
 * Session.
 */
function LaneSubject({ lane }: { lane: BranchLane }) {
  if (lane.batch !== null) {
    const { id, issues } = lane.batch;
    return (
      <span className="block space-y-1">
        <span className="block">
          Batch {id}, one pull request
          {lane.issue !== null && (
            <>
              : now{" "}
              <ExternalAnchor href={lane.issue.url}>
                #{lane.issue.number} {lane.issue.title}
              </ExternalAnchor>
            </>
          )}
        </span>
        <ol
          aria-label={`Batch ${String(id)}'s issues, in order`}
          className="flex flex-wrap gap-1"
        >
          {issues.map(({ number, stage }) => (
            <li key={number}>
              <Badge tone={batchIssueTone(stage)}>
                #{number} {batchIssueLabel(stage)}
              </Badge>
            </li>
          ))}
        </ol>
      </span>
    );
  }
  if (lane.issue !== null) {
    return (
      <ExternalAnchor href={lane.issue.url}>
        #{lane.issue.number} {lane.issue.title}
      </ExternalAnchor>
    );
  }
  if (lane.grillingSession !== null) {
    return (
      <span>
        Grilling Session {lane.grillingSession.id}: {lane.grillingSession.topic}
      </span>
    );
  }
  return <span className="text-muted-foreground">No issue found</span>;
}

/** The Agent working on a lane, or the stage it waits in. */
function LaneWork({ lane, floorId }: { lane: BranchLane; floorId: string }) {
  const { work } = lane;
  if (work === null) {
    return <span className="text-muted-foreground">Not in the pipeline</span>;
  }
  if (work.kind === "stage") {
    return <span>Waiting in {stageNames[work.stage]}</span>;
  }
  return (
    <span className="inline-flex items-center gap-2">
      <AvatarBadge avatar={work.avatar} />
      <span>
        <AgentLink floorId={floorId} agentId={work.agentId}>
          {() => work.name}
        </AgentLink>
        <span className="text-muted-foreground"> · {work.roleName}</span>
      </span>
    </span>
  );
}

/** The commit a dot stands for, shown beside it while hovered or focused. */
interface Shown {
  readonly lane: LaidOutLane;
  readonly dot: LaidOutCommit;
}

/** The lane view: the trunk, and each lane off it, drawn in SVG. */
function LaneView({ branches }: { branches: FloorBranches }) {
  const layout = layoutLanes(branches.lanes);
  const [shown, setShown] = useState<Shown>();
  const tooltipId = useId();
  const now = new Date();
  const show = (lane: LaidOutLane, dot: LaidOutCommit) => () => {
    setShown({ lane, dot });
  };
  const hide = () => {
    setShown(undefined);
  };
  return (
    <figure className="space-y-2">
      <figcaption className="text-sm text-muted-foreground">
        Each AI Office branch leaves {branches.defaultBranch.name} where it
        split off, with its own commits, newest last. Hover over or tab to a
        commit to see it; the table below has the same.
      </figcaption>
      <div
        role="region"
        aria-label="Lane view, scrollable"
        tabIndex={0}
        className="relative overflow-x-auto rounded-lg border bg-card p-2"
      >
        <svg
          role="group"
          aria-label={`Lanes off ${branches.defaultBranch.name}`}
          width={layout.width}
          height={layout.height}
          viewBox={`0 0 ${String(layout.width)} ${String(layout.height)}`}
          className="block text-foreground"
          onMouseLeave={hide}
        >
          <text
            x={layout.trunkX}
            y={layout.trunkY - 12}
            className="fill-foreground text-xs font-semibold"
          >
            {branches.defaultBranch.name}
          </text>
          <line
            x1={layout.trunkX}
            x2={layout.width}
            y1={layout.trunkY}
            y2={layout.trunkY}
            strokeWidth={2}
            className="stroke-foreground"
          />
          {layout.lanes.map((laid) => (
            <path
              key={`${laid.lane.name}-line`}
              d={laid.path}
              fill="none"
              // A Batch's shared branch is drawn heavier, as it carries
              // several issues; a Grilling Session's is dashed.
              strokeWidth={laid.lane.batch === null ? 2 : 4}
              strokeDasharray={
                laid.lane.grillingSession === null ? undefined : "6 4"
              }
              className={cn(
                laid.lane.likelyToConflict
                  ? "stroke-tone-warning-foreground"
                  : "stroke-primary",
              )}
            />
          ))}
          {layout.bases.map(({ x, commit }) => (
            <circle
              key={commit.sha}
              cx={x}
              cy={layout.trunkY}
              r={4}
              strokeWidth={2}
              className="fill-foreground stroke-card"
            />
          ))}
          {layout.lanes.map((laid) => (
            <g key={laid.lane.name}>
              {laid.hidden > 0 && (
                <text
                  x={laid.hiddenX}
                  y={laid.y + 4}
                  textAnchor="middle"
                  className="fill-muted-foreground text-xs"
                >
                  …<title>{`${String(laid.hidden)} older commits`}</title>
                </text>
              )}
              {laid.commits.map((dot) => (
                <a
                  key={dot.commit.sha}
                  href={dot.commit.url}
                  target="_blank"
                  rel="noreferrer"
                  aria-label={`${laid.lane.name}: ${commitText(dot.commit, timeAgo(dot.commit.authoredAt, now))}`}
                  aria-describedby={
                    shown?.lane.lane.name === laid.lane.name &&
                    shown.dot.commit.sha === dot.commit.sha
                      ? tooltipId
                      : undefined
                  }
                  className="outline-none [&:focus-visible>circle]:stroke-[var(--focus-ring)]"
                  onMouseEnter={show(laid, dot)}
                  onFocus={show(laid, dot)}
                  onBlur={hide}
                >
                  {/* A hit target bigger than the dot. */}
                  <circle cx={dot.x} cy={laid.y} r={12} fill="transparent" />
                  <circle
                    cx={dot.x}
                    cy={laid.y}
                    r={5}
                    strokeWidth={2}
                    className={cn(
                      "stroke-card",
                      laid.lane.likelyToConflict
                        ? "fill-tone-warning-foreground"
                        : "fill-primary",
                    )}
                  />
                </a>
              ))}
              <text
                x={laid.labelX}
                y={laid.y + 4}
                className="fill-foreground font-mono text-xs"
              >
                {laid.lane.name}
              </text>
            </g>
          ))}
        </svg>
        {shown !== undefined && (
          <div
            id={tooltipId}
            role="tooltip"
            className="pointer-events-none absolute z-10 w-max max-w-72 rounded-md border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-md"
            style={{
              left: shown.dot.x + 16,
              top: shown.lane.y + 16,
            }}
          >
            <p className="font-mono">{shortSha(shown.dot.commit.sha)}</p>
            <p className="font-medium">{shown.dot.commit.message}</p>
            <p className="text-muted-foreground">
              {shown.dot.commit.author}
              {shown.dot.commit.agent === null
                ? ""
                : ` · Agent: ${shown.dot.commit.agent}`}
            </p>
            <p className="text-muted-foreground">
              <time dateTime={shown.dot.commit.authoredAt}>
                {new Date(shown.dot.commit.authoredAt).toLocaleString()}
              </time>
            </p>
          </div>
        )}
      </div>
    </figure>
  );
}

/** The same as the lane view, a lane to a row. */
function LaneTable({ branches }: { branches: FloorBranches }) {
  const now = new Date();
  const lanes = layoutLanes(branches.lanes).lanes.map(({ lane }) => lane);
  return (
    <TableFrame label="Branches, scrollable">
      <table className="w-full text-sm">
        <caption className="sr-only">
          {branches.repository}'s AI Office branches
        </caption>
        <thead className="text-left">
          <tr className="border-b">
            <th scope="col" className="py-2 font-medium">
              Branch
            </th>
            <th scope="col" className="py-2 font-medium">
              Ahead / behind {branches.defaultBranch.name}
            </th>
            <th scope="col" className="py-2 font-medium">
              For
            </th>
            <th scope="col" className="py-2 font-medium">
              Pull request
            </th>
            <th scope="col" className="py-2 font-medium">
              CI
            </th>
            <th scope="col" className="py-2 font-medium">
              Agent or stage
            </th>
            <th scope="col" className="py-2 font-medium">
              Last commit
            </th>
          </tr>
        </thead>
        <tbody>
          {lanes.map((lane) => (
            <tr key={lane.name} className="border-b align-top">
              <th scope="row" className="py-2 pr-4 text-left font-normal">
                <div className="flex flex-col items-start gap-1">
                  <ExternalAnchor href={lane.url}>
                    <span className="font-mono">{lane.name}</span>
                  </ExternalAnchor>
                  {lane.likelyToConflict && <BehindWarning />}
                </div>
              </th>
              <td className="py-2 pr-4">
                <AheadBehind
                  lane={lane}
                  defaultBranch={branches.defaultBranch.name}
                />
              </td>
              <td className="py-2 pr-4">
                <LaneSubject lane={lane} />
              </td>
              <td className="py-2 pr-4">
                {lane.pullRequest === null ? (
                  <span className="text-muted-foreground">None open</span>
                ) : (
                  <ExternalAnchor href={lane.pullRequest.url}>
                    #{lane.pullRequest.number}
                    {lane.pullRequest.draft ? " (draft)" : ""}
                  </ExternalAnchor>
                )}
              </td>
              <td className="py-2 pr-4">
                <CiBadge ci={lane.ci} />
              </td>
              <td className="py-2 pr-4">
                <LaneWork lane={lane} floorId={branches.floorId} />
              </td>
              <td className="py-2">
                <time
                  dateTime={lane.lastCommitAt}
                  title={new Date(lane.lastCommitAt).toLocaleString()}
                >
                  {timeAgo(lane.lastCommitAt, now)}
                </time>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableFrame>
  );
}

/** Reads the Floor's branches again after its events, once a burst ends. */
function useLiveBranches(floorId: string | undefined): void {
  const queryClient = useQueryClient();
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const { status } = useEventStream(
    { floorId, types: [...branchEventTypes] },
    {
      enabled: floorId !== undefined,
      onEvent: (_event, client) => {
        if (floorId === undefined) {
          return;
        }
        clearTimeout(timer.current);
        timer.current = setTimeout(() => {
          void client.invalidateQueries({
            queryKey: branchesQuery(floorId).queryKey,
          });
        }, branchEventDebounceMs);
      },
    },
  );
  useEffect(
    () => () => {
      clearTimeout(timer.current);
    },
    [],
  );
  // Reconnected: what was missed meanwhile is read once.
  useEffect(() => {
    if (status === "open" && floorId !== undefined) {
      void queryClient.invalidateQueries({
        queryKey: branchesQuery(floorId).queryKey,
      });
    }
  }, [status, floorId, queryClient]);
}

export function BranchesPage({ floorId, onFloorChange }: BranchesPageProps) {
  const { data: floors, isError: floorsFailed } = useQuery(floorsQuery);
  const remembered = lastBranchesFloor();
  const chosen =
    floorId ??
    (floors?.some(({ id }) => id === remembered) === true
      ? remembered
      : floors?.[0]?.id);
  const branches = useQuery({
    ...branchesQuery(chosen ?? ""),
    enabled: chosen !== undefined,
  });
  useLiveBranches(chosen);

  // The address always names the Floor shown, so a link opens it again.
  useEffect(() => {
    if (floorId === undefined && chosen !== undefined) {
      onFloorChange(chosen, { replace: true });
    }
  }, [floorId, chosen, onFloorChange]);
  useEffect(() => {
    if (chosen !== undefined) {
      rememberBranchesFloor(chosen);
    }
  }, [chosen]);

  const unlisted =
    chosen !== undefined &&
    floors !== undefined &&
    !floors.some(({ id }) => id === chosen);
  const floorName =
    floors?.find(({ id }) => id === chosen)?.name ?? chosen ?? "";

  return (
    <section className="space-y-6">
      <PageHeader
        title="Branches"
        description={
          <>
            Which branch each Agent works on, and how far it is ahead of and
            behind its Floor's default branch.
          </>
        }
      />
      <div className="space-y-2 sm:max-w-xs">
        <Label htmlFor="branches-floor">Floor</Label>
        <select
          id="branches-floor"
          className={selectClass}
          value={chosen ?? ""}
          disabled={floors === undefined || floors.length === 0}
          onChange={(event) => {
            onFloorChange(event.target.value);
          }}
        >
          {floors?.map((floor) => (
            <option key={floor.id} value={floor.id}>
              {floor.name}
            </option>
          ))}
          {unlisted && <option value={chosen}>{chosen}</option>}
        </select>
      </div>
      {floorsFailed && (
        <p role="alert" className="text-sm text-destructive">
          The Floors could not be loaded.
        </p>
      )}
      {floors?.length === 0 && (
        <p className="text-muted-foreground">
          No Floors yet. Add one in Floor Settings to see its branches here.
        </p>
      )}
      {branches.isPending && chosen !== undefined && (
        <p
          role="status"
          className="flex items-center gap-2 text-sm text-muted-foreground"
        >
          <Spinner className="size-3.5" />
          Reading {floorName}'s branches from GitHub…
        </p>
      )}
      {branches.isError && (
        <div
          role="alert"
          className="space-y-2 rounded-lg border border-destructive/50 p-4 text-sm"
        >
          <p className="font-medium text-destructive">
            {floorName}'s branches could not be read.
          </p>
          <p>{branches.error.message}</p>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void branches.refetch()}
          >
            <RotateCcw aria-hidden />
            Try again
          </Button>
        </div>
      )}
      {branches.data !== undefined && branches.data.floorId === chosen && (
        <BranchesView branches={branches.data} floorName={floorName} />
      )}
    </section>
  );
}

function BranchesView({
  branches,
  floorName,
}: {
  branches: FloorBranches;
  floorName: string;
}) {
  const conflicting = branches.lanes.filter(
    ({ likelyToConflict }) => likelyToConflict,
  ).length;
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        <ExternalAnchor href={branches.defaultBranch.url}>
          {branches.repository}
        </ExternalAnchor>{" "}
        at {branches.defaultBranch.name}{" "}
        <span className="font-mono">
          {shortSha(branches.defaultBranch.sha)}
        </span>
        , read from GitHub at{" "}
        <time dateTime={branches.fetchedAt}>
          {new Date(branches.fetchedAt).toLocaleTimeString()}
        </time>
        .
      </p>
      {branches.lanes.length === 0 ? (
        <p className="text-muted-foreground">
          {floorName} has no AI Office branches. Each issue an Agent works gets
          one, named ai-office/&lt;issue&gt;-&lt;title&gt;.
        </p>
      ) : (
        <>
          {conflicting > 0 && (
            <p className="flex items-center gap-2 text-sm">
              <AlertTriangle
                aria-hidden
                className="size-4 text-tone-warning-foreground"
              />
              {conflicting === 1
                ? "1 branch is"
                : `${String(conflicting)} branches are`}{" "}
              likely to conflict: more than 20 commits behind{" "}
              {branches.defaultBranch.name}, or split off it more than 7 days
              ago.
            </p>
          )}
          <LaneView branches={branches} />
          <LaneTable branches={branches} />
        </>
      )}
    </div>
  );
}
