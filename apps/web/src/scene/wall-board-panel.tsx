import {
  stageNames,
  type Agent,
  type CapUse,
  type Notice,
  type PipelineStage,
  type WallBoardIssue,
} from "@ai-office/shared";
import { useQuery } from "@tanstack/react-query";
import { ExternalLink } from "lucide-react";
import { useId, type ReactNode } from "react";

import { cn } from "@/lib/utils.ts";

import { agentsQuery } from "../floors.ts";
import { noticesQuery } from "../notices.ts";
import { capUseText, floorTokenUsageQuery } from "../token-caps.tsx";
import {
  capState,
  capStateTokens,
  floorHealth,
  healthTokens,
  tokenRefreshMs,
  useLiveWallBoard,
  wallBoardQuery,
} from "../wall-board.ts";
import { floorInspectables } from "./inspectable.ts";
import { openInspectable } from "./inspection.ts";
import { PageLink } from "./page-link.tsx";
import { backgroundOf, stageTokens } from "./stage-colours.ts";

import { LoadingMessage } from "@/components/ui/spinner.tsx";

// A Floor's wall board, inspected (PRD FR-50, FR-57, FR-58): the Floor's
// health, its Notices, every issue in progress with the Agent working it,
// its stage and its links, its queues, the rounds its issues have used,
// and its Agents' tokens against their caps, all kept live. Every entry
// links to GitHub, and every Agent's name flies to it in the Office (FR-63).

/** A link to GitHub, opened in a new tab. */
export function GitHubLink({
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
      className="inline-flex items-center gap-0.5 underline-offset-4 hover:underline"
    >
      {children}
      <ExternalLink aria-hidden className="size-3" />
    </a>
  );
}

/** One of the board's parts, with its heading. */
function Part({ title, children }: { title: string; children: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="space-y-1.5">
      <h3 id={id} className="font-medium">
        {title}
      </h3>
      {children}
    </section>
  );
}

const plural = (count: number, one: string) =>
  `${String(count)} ${one}${count === 1 ? "" : "s"}`;

interface Team {
  readonly name: (agentId: string) => string;
  /** Flies to the Agent and opens its card; undefined until the Floor's Agents are known. */
  readonly inspect: ((agentId: string) => void) | undefined;
}

/** An Agent's name, which flies to the Agent in the Office and opens its card. */
function AgentButton({ agentId, team }: { agentId: string; team: Team }) {
  const name = team.name(agentId);
  return team.inspect === undefined ? (
    <span>{name}</span>
  ) : (
    <button
      type="button"
      className="font-medium underline-offset-4 hover:underline"
      title={`Fly to ${name}`}
      onClick={() => {
        team.inspect?.(agentId);
      }}
    >
      {name}
    </button>
  );
}

function NoticeEntry({ notice, team }: { notice: Notice; team: Team }) {
  return (
    <li
      className={cn(
        "space-y-1 rounded-md border bg-card p-2",
        notice.kind === "action" && "border-l-4 border-l-office-state-critical",
      )}
    >
      <p>
        <span className="mr-1 text-xs font-medium text-muted-foreground">
          {notice.kind === "action" ? "Action" : "Info"}
        </span>
        {notice.title}
      </p>
      <ul
        aria-label="Links"
        className="flex flex-wrap gap-x-3 text-xs text-muted-foreground"
      >
        {notice.issue !== null && (
          <li>
            <GitHubLink href={notice.issue.url}>
              Issue #{notice.issue.number}
            </GitHubLink>
          </li>
        )}
        {notice.pullRequest !== null && (
          <li>
            <GitHubLink href={notice.pullRequest.url}>
              PR #{notice.pullRequest.number}
            </GitHubLink>
          </li>
        )}
        {notice.ciRunUrl !== null && (
          <li>
            <GitHubLink href={notice.ciRunUrl}>CI run</GitHubLink>
          </li>
        )}
        {notice.links.map(({ label, url }) => (
          <li key={url}>
            <GitHubLink href={url}>{label}</GitHubLink>
          </li>
        ))}
        {notice.agentId !== null && (
          <li>
            <AgentButton agentId={notice.agentId} team={team} />
          </li>
        )}
      </ul>
    </li>
  );
}

function IssueEntry({
  entry,
  roundCap,
  qaRoundCap,
  team,
}: {
  entry: WallBoardIssue;
  roundCap: number;
  qaRoundCap: number;
  team: Team;
}) {
  const { issue, url, stage, status, agentIds, pullRequest } = entry;
  return (
    <li className="space-y-1 rounded-md border bg-card p-2">
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <GitHubLink href={url}>#{issue}</GitHubLink>
        <StageBadge stage={stage} />
        <span className="text-xs text-muted-foreground">
          {status === "working" ? "Working" : "Waiting"}
        </span>
        {pullRequest !== null && (
          <GitHubLink href={pullRequest.url}>
            PR #{pullRequest.number}
          </GitHubLink>
        )}
      </p>
      <p className="text-xs">
        {agentIds.length === 0 ? (
          "No Agent to work it"
        ) : (
          <>
            {status === "working" ? "By " : "For "}
            {agentIds.map((agentId, index) => (
              <span key={agentId}>
                {index > 0 && ", "}
                <AgentButton agentId={agentId} team={team} />
              </span>
            ))}
          </>
        )}
      </p>
      <p className="text-xs text-muted-foreground">
        Review rounds {entry.reviewRounds} of {roundCap}
        {entry.qaRounds > 0 &&
          ` · QA rounds ${String(entry.qaRounds)} of ${String(qaRoundCap)}`}
      </p>
    </li>
  );
}

/** A stage's name, on its Stage's colour. */
export function StageBadge({ stage }: { stage: PipelineStage }) {
  return (
    <span
      className={cn(
        "rounded-full px-1.5 text-xs font-medium",
        backgroundOf(stageTokens[stage]),
      )}
    >
      {stageNames[stage]}
    </span>
  );
}

/** A cap and its use, as text and a bar coloured by how much is used. */
export function CapMeter({ use, label }: { use: CapUse; label: string }) {
  const share = Math.min(1, use.cap === 0 ? 1 : use.used / use.cap);
  const state = capState(use);
  return (
    <div className="space-y-0.5" data-state={state}>
      <div className="text-xs">
        {capUseText(use)}
        {state === "reached" && " (reached)"}
      </div>
      <div
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={use.cap}
        aria-valuenow={Math.min(use.used, use.cap)}
        aria-valuetext={capUseText(use)}
        className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
      >
        <div
          className={cn("h-full", backgroundOf(capStateTokens[state]))}
          style={{ width: `${String(share * 100)}%` }}
        />
      </div>
    </div>
  );
}

export function FloorWallBoardPanel({
  floorId,
  navigate,
}: {
  floorId: string;
  navigate?: ((href: string) => void) | undefined;
}) {
  useLiveWallBoard(floorId);
  const notices = useQuery(noticesQuery(floorId));
  const board = useQuery(wallBoardQuery(floorId));
  const usage = useQuery({
    ...floorTokenUsageQuery(floorId),
    refetchInterval: tokenRefreshMs,
  });
  const { data: agents } = useQuery(agentsQuery(floorId));

  const name = (agentId: string) =>
    agents?.find(({ id }) => id === agentId)?.name ?? agentId;
  const team: Team = {
    name,
    inspect:
      agents === undefined
        ? undefined
        : (agentId) => {
            const agent = floorInspectables(floorId, agents).find(
              ({ kind, id }) => kind === "agent" && id === agentId,
            );
            if (agent !== undefined) {
              openInspectable(agent);
            }
          },
  };
  const roleOf = (agentId: string): Agent["role"] | undefined =>
    agents?.find(({ id }) => id === agentId)?.role;

  const failed = notices.isError || board.isError || usage.isError;
  const health =
    notices.data === undefined ||
    board.data === undefined ||
    usage.data === undefined
      ? undefined
      : floorHealth({
          notices: notices.data,
          board: board.data,
          usage: usage.data,
          agentName: name,
        });

  return (
    <div className="-mr-2 max-h-[min(30rem,60vh)] space-y-4 overflow-y-auto pr-2 group-data-sized/inspector:max-h-none group-data-sized/inspector:min-h-48 group-data-sized/inspector:flex-1">
      {failed && (
        <p role="alert" className="text-destructive">
          Some of this Floor&apos;s wall board could not be loaded.
        </p>
      )}
      <Part title="Health">
        {health === undefined ? (
          <LoadingMessage>Reading the Floor…</LoadingMessage>
        ) : (
          <>
            <p
              className="flex items-center gap-2 font-medium"
              data-health={health.level}
            >
              <span
                aria-hidden
                className={cn(
                  "size-3 rounded-full",
                  backgroundOf(healthTokens[health.level]),
                )}
              />
              {health.label}
            </p>
            {health.reasons.length > 0 && (
              <ul aria-label="Why" className="list-disc space-y-0.5 pl-5">
                {health.reasons.map((reason) => (
                  <li key={reason}>{reason}</li>
                ))}
              </ul>
            )}
          </>
        )}
      </Part>

      <Part
        title={
          notices.data === undefined
            ? "Notices"
            : `Notices (${String(notices.data.length)})`
        }
      >
        {notices.data?.length === 0 && (
          <p className="text-muted-foreground">
            No Notices: nothing on this Floor needs you.
          </p>
        )}
        {notices.data !== undefined && notices.data.length > 0 && (
          <ul aria-label="This Floor's Notices" className="space-y-1.5">
            {notices.data.map((notice) => (
              <NoticeEntry key={notice.id} notice={notice} team={team} />
            ))}
          </ul>
        )}
        <PageLink
          href={`/notices?floorId=${encodeURIComponent(floorId)}`}
          navigate={navigate}
        >
          Open this Floor&apos;s Notices
        </PageLink>
      </Part>

      <Part
        title={
          board.data === undefined
            ? "In progress"
            : `In progress (${String(board.data.issues.length)})`
        }
      >
        {board.data?.issues.length === 0 && (
          <p className="text-muted-foreground">No issue is in progress.</p>
        )}
        {board.data !== undefined && board.data.issues.length > 0 && (
          <ul aria-label="Issues in progress" className="space-y-1.5">
            {board.data.issues.map((entry) => (
              <IssueEntry
                key={`${String(entry.issue)}:${entry.stage}`}
                entry={entry}
                roundCap={board.data.roundCap}
                qaRoundCap={board.data.qaRoundCap}
                team={team}
              />
            ))}
          </ul>
        )}
      </Part>

      {board.data !== undefined && (
        <Part title="Queues">
          <table className="w-full text-left text-xs">
            <caption className="sr-only">Work by stage</caption>
            <thead className="text-muted-foreground">
              <tr className="border-b">
                <th scope="col" className="py-1 pr-2 font-medium">
                  Stage
                </th>
                <th scope="col" className="py-1 pr-2 font-medium">
                  Waiting
                </th>
                <th scope="col" className="py-1 font-medium">
                  Working
                </th>
              </tr>
            </thead>
            <tbody>
              {board.data.queues.map(({ stage, waiting, working }) => (
                <tr key={stage} className="border-b last:border-0">
                  <th scope="row" className="py-1 pr-2 font-medium">
                    {stageNames[stage]}
                  </th>
                  <td className="py-1 pr-2">{waiting}</td>
                  <td className="py-1">{working}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <ul aria-label="Waiting for each Agent" className="text-xs">
            {board.data.agents
              .filter(({ waiting }) => waiting > 0)
              .map(({ agentId, waiting }) => (
                <li key={agentId}>
                  <AgentButton agentId={agentId} team={team} />:{" "}
                  {plural(waiting, "task")} waiting
                </li>
              ))}
          </ul>
        </Part>
      )}

      {usage.data !== undefined && (
        <Part title="Tokens against caps">
          {usage.data.agents.length === 0 ? (
            <p className="text-muted-foreground">This Floor has no Agents.</p>
          ) : (
            <ul aria-label="Each Agent's tokens" className="space-y-2">
              {usage.data.agents.map(({ agentId, caps }) => {
                const agentName = name(agentId);
                const role = roleOf(agentId);
                return (
                  <li key={agentId} className="space-y-1">
                    <p className="text-xs">
                      <AgentButton agentId={agentId} team={team} />
                      {role !== undefined && (
                        <span className="text-muted-foreground"> ({role})</span>
                      )}
                    </p>
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <span className="text-xs text-muted-foreground">
                          Today
                        </span>
                        <CapMeter
                          use={caps.daily}
                          label={`${agentName}'s tokens today`}
                        />
                      </div>
                      <div>
                        <span className="text-xs text-muted-foreground">
                          This month
                        </span>
                        <CapMeter
                          use={caps.monthly}
                          label={`${agentName}'s tokens this month`}
                        />
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </Part>
      )}
    </div>
  );
}
