import type { Agent } from "@ai-office/shared";
import { useQuery } from "@tanstack/react-query";
import { MessageSquare, MonitorPlay, Shirt } from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";

import {
  agentRoleLabel,
  ContractorBadge,
  KeepOnTeam,
} from "../agents-card.tsx";
import { floorTokenUsageQuery } from "../token-caps.tsx";
import {
  currentIssueOf,
  tokenRefreshMs,
  useLiveWallBoard,
  wallBoardQuery,
} from "../wall-board.ts";
import { PageLink } from "./page-link.tsx";
import { CapMeter, GitHubLink, StageBadge } from "./wall-board-panel.tsx";

// An Agent's card (PRD FR-63), what clicking an Agent in the Office opens:
// who it is (its name is the panel's heading), its Role, AI Provider and
// Model, the issue it is on, and its tokens against its caps, kept live by
// its Floor's events; with the way to chat with it, its monitor, its
// config and its Avatar Editor. A Contractor (ADR 0004) says so, and the
// Owner can keep it on the team from here.

/** The address of an Agent's config: Agent Settings, with its editor open. */
export const agentConfigHref = ({
  floorId,
  id,
}: Pick<Agent, "floorId" | "id">): string =>
  `/agent-settings?floor=${encodeURIComponent(floorId)}&agent=${encodeURIComponent(id)}`;

/** One fact on the card. */
function Fact({ term, children }: { term: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{term}</dt>
      <dd className="min-w-0">{children}</dd>
    </>
  );
}

/** The issue the Agent is on, from its Floor's wall board. */
function CurrentIssue({ agent }: { agent: Agent }) {
  const board = useQuery(wallBoardQuery(agent.floorId));
  if (board.isError) {
    return <span className="text-muted-foreground">Could not be read</span>;
  }
  if (board.data === undefined) {
    return (
      <span className="inline-flex items-center gap-1.5 text-muted-foreground">
        <Spinner className="size-3" />
        Reading…
      </span>
    );
  }
  const current = currentIssueOf(board.data, agent.id);
  if (current === undefined) {
    return <span>None</span>;
  }
  return (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <GitHubLink href={current.url}>#{current.issue}</GitHubLink>
      <StageBadge stage={current.stage} />
      <span className="text-xs text-muted-foreground">
        {current.status === "working" ? "Working" : "Waiting"}
      </span>
      {current.pullRequest !== null && (
        <GitHubLink href={current.pullRequest.url}>
          PR #{current.pullRequest.number}
        </GitHubLink>
      )}
    </span>
  );
}

/** The Agent's tokens today and this month, against the caps in force for it. */
function Tokens({ agent }: { agent: Agent }) {
  const usage = useQuery({
    ...floorTokenUsageQuery(agent.floorId),
    refetchInterval: tokenRefreshMs,
  });
  const caps = usage.data?.agents.find(
    ({ agentId }) => agentId === agent.id,
  )?.caps;
  if (usage.isError) {
    return (
      <p className="text-muted-foreground">Its tokens could not be read.</p>
    );
  }
  if (caps === undefined) {
    return (
      <p className="text-muted-foreground">
        {usage.data === undefined ? "Reading its tokens…" : "No tokens yet."}
      </p>
    );
  }
  return (
    <div className="grid grid-cols-2 gap-2">
      <div>
        <span className="text-xs text-muted-foreground">Today</span>
        <CapMeter use={caps.daily} label={`${agent.name}'s tokens today`} />
      </div>
      <div>
        <span className="text-xs text-muted-foreground">This month</span>
        <CapMeter
          use={caps.monthly}
          label={`${agent.name}'s tokens this month`}
        />
      </div>
    </div>
  );
}

export function AgentCard({
  agent,
  navigate,
  onOpenMonitor,
  onOpenAvatarEditor,
  onOpenChat,
}: {
  agent: Agent;
  /** Opens a page of AI Office without a reload. */
  navigate?: ((href: string) => void) | undefined;
  /** Flies to the Agent's monitor and opens it; undefined while it cannot. */
  onOpenMonitor?: (() => void) | undefined;
  onOpenAvatarEditor: () => void;
  /** Opens the chat with the Agent in the card's place. */
  onOpenChat?: (() => void) | undefined;
}) {
  useLiveWallBoard(agent.floorId);
  return (
    <div className="space-y-3">
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5">
        <Fact term="Role">
          {agentRoleLabel(agent)}
          <ContractorBadge agent={agent} />
        </Fact>
        <Fact term="AI Provider">{agent.aiProvider}</Fact>
        <Fact term="Model">
          <span className="font-mono break-all">{agent.model}</span>
          {agent.modelOverride === null && (
            <span className="text-muted-foreground"> (default)</span>
          )}
        </Fact>
        <Fact term="Current issue">
          <CurrentIssue agent={agent} />
        </Fact>
      </dl>
      <section aria-label="Tokens against caps" className="space-y-1.5">
        <h3 className="font-medium">Tokens against caps</h3>
        <Tokens agent={agent} />
      </section>
      <div className="flex flex-col items-start gap-2">
        {onOpenChat !== undefined && (
          <Button size="sm" onClick={onOpenChat}>
            <MessageSquare aria-hidden />
            Chat with {agent.name}
          </Button>
        )}
        <Button
          size="sm"
          variant="outline"
          disabled={onOpenMonitor === undefined}
          onClick={onOpenMonitor}
        >
          <MonitorPlay aria-hidden />
          Open {agent.name}&apos;s monitor
        </Button>
        <Button size="sm" variant="outline" onClick={onOpenAvatarEditor}>
          <Shirt aria-hidden />
          Open {agent.name}&apos;s Avatar Editor
        </Button>
        <KeepOnTeam agent={agent} />
        <PageLink href={agentConfigHref(agent)} navigate={navigate}>
          Open {agent.name}&apos;s config
        </PageLink>
      </div>
    </div>
  );
}
