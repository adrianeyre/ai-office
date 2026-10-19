import {
  terminalKeyName,
  usageWindowLabels,
  type AgentContextUsage,
  type AiAccount,
  type CapUse,
  type UsageWindow,
  type UsageWindowState,
} from "@ai-office/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { ReactNode } from "react";

import { cn } from "@/lib/utils.ts";

import { aiAccountsQuery, UsageBar, useNow } from "./ai-accounts-card.tsx";
import { ContextUsageGauge } from "./context-usage.tsx";
import type { EventStreamOptions } from "./event-stream.ts";
import { useServerSentData } from "./gateway-requests.tsx";
import { CapMeter } from "./scene/wall-board-panel.tsx";
import {
  floorTokenUsageQuery,
  formatTokens,
  levelLabels,
  officeTokenUsageQuery,
} from "./token-caps.tsx";
import { tokenRefreshMs, useLiveWallBoard } from "./wall-board.ts";

// A chat's status line (PRD FR-24, FR-85, FR-32, FR-36): what Claude
// Code's status line shows a session, wherever the Owner chats: the
// Manager chat (and a Grilling Session in it), an Agent's direct chat, and
// the Terminal. Its caller says whose:
// - Context Usage: given by the caller, from the Floor's Context Usage for
//   the Manager, or from the chat's own latest reply for a direct chat or
//   the Terminal, which are conversations of their own.
// - Tokens: an Agent's today and this month against the Token Caps in
//   force for it, from the Floor's token usage; the Terminal's key has no
//   caps, so its tokens today and this month, from the office's.
// - Plan usage: the 5-hour and weekly windows of the AI Account that served
//   the latest request, as the caller names it; without one, those of its
//   AI Provider's accounts that report windows.
// Each of the caller's requests the AI Gateway records (its live request
// stream, by Agent or by the Terminal's Owner tool) reads the tokens, the
// accounts and the caller's own figures again; the accounts are read each
// minute too, as their AI Providers report windows only to the server.

/** Whose chat: one of a Floor's Agents, or the Terminal's key. */
export type ChatCaller =
  | {
      readonly kind: "agent";
      readonly floorId: string;
      readonly agentId: string;
    }
  | { readonly kind: "terminal" };

/** What the status line shows of a Context Usage. */
export type ContextUsageFigures = Pick<
  AgentContextUsage,
  "model" | "inputTokens" | "contextWindow" | "contextUsage"
>;

/** A share as a whole percentage, never more than 999. */
const percentOf = (used: number, of: number): number =>
  of <= 0 ? 100 : Math.min(999, Math.round((used / of) * 100));

/** One labelled figure of the status line. */
function Figure({
  label,
  children,
  compact,
}: {
  label: ReactNode;
  children: ReactNode;
  compact: boolean;
}) {
  return (
    <div className={cn("space-y-0.5", compact ? "min-w-20" : "min-w-28")}>
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      <dd className={compact ? "text-xs" : "text-sm"}>{children}</dd>
    </div>
  );
}

const periodNames = { daily: "Today", monthly: "This month" } as const;

/** Tokens in a period against the cap in force, as a percentage and a bar. */
function TokenFigure({
  period,
  use,
  compact,
}: {
  period: "daily" | "monthly";
  use: CapUse;
  compact: boolean;
}) {
  return (
    <Figure
      compact={compact}
      label={
        <>
          {periodNames[period]}{" "}
          <span className="text-foreground tabular-nums">
            {String(percentOf(use.used, use.cap))}%
          </span>
        </>
      }
    >
      <span title={`Against ${levelLabels[use.level]} ${period} Token Cap`}>
        <CapMeter
          use={use}
          label={`Tokens ${periodNames[period].toLowerCase()} against ${levelLabels[use.level]} ${period} Token Cap`}
        />
      </span>
    </Figure>
  );
}

/** One usage window of a subscription, as a percentage and its meter. */
function WindowFigure({
  window,
  state,
  threshold,
  account,
  now,
  compact,
}: {
  window: UsageWindow;
  state: UsageWindowState | null;
  threshold: number | null;
  account: string;
  now: Date;
  compact: boolean;
}) {
  return (
    <Figure
      compact={compact}
      label={
        <>
          {usageWindowLabels[window]}{" "}
          <span className="text-foreground tabular-nums">
            {state === null
              ? "not reported"
              : `${String(Math.round(state.utilization))}%`}
          </span>
        </>
      }
    >
      {state === null ? (
        <span className="text-xs text-muted-foreground">{account}</span>
      ) : (
        <span
          title={
            state.resetsAt === null
              ? `${account}: not started`
              : `${account}: resets ${new Date(state.resetsAt).toLocaleString()}`
          }
          className="block"
        >
          <UsageBar
            window={window}
            state={state}
            threshold={threshold}
            now={now}
            label={`${usageWindowLabels[window]} window used, ${account}`}
          />
          {!compact && (
            <span className="block truncate text-xs text-muted-foreground">
              {account}
            </span>
          )}
        </span>
      )}
    </Figure>
  );
}

/** Whether an account reports usage windows to show. */
const reportsWindows = (account: AiAccount): boolean =>
  account.usage.fiveHour !== null ||
  account.usage.weekly !== null ||
  (account.accountType === "oauth" && account.aiProvider === "Claude");

/**
 * The accounts whose windows the status line shows: the one that served
 * the caller's latest request, if it reports windows; else its AI
 * Provider's that do.
 */
export function servingAccounts(
  accounts: readonly AiAccount[],
  latestAccountId: string | null | undefined,
  aiProvider: string | null,
): { readonly accounts: readonly AiAccount[]; readonly served: boolean } {
  const served = accounts.find(({ id }) => id === latestAccountId);
  if (served !== undefined) {
    return { accounts: reportsWindows(served) ? [served] : [], served: true };
  }
  return {
    accounts: accounts.filter(
      (account) => account.aiProvider === aiProvider && reportsWindows(account),
    ),
    served: false,
  };
}

/** The caller's requests on the AI Gateway's live request stream. */
const requestStreamUrl = (caller: ChatCaller): string =>
  `/api/gateway/requests/stream?${new URLSearchParams(
    caller.kind === "agent"
      ? { floorId: caller.floorId, agentId: caller.agentId }
      : { ownerTool: terminalKeyName },
  ).toString()}`;

/** An Agent's tokens against its Token Caps, kept live by its Floor. */
function AgentTokens({
  floorId,
  agentId,
  compact,
}: {
  floorId: string;
  agentId: string;
  compact: boolean;
}) {
  const { data: tokenUsage } = useQuery({
    ...floorTokenUsageQuery(floorId),
    refetchInterval: tokenRefreshMs,
  });
  const listed = tokenUsage?.agents.find((agent) => agent.agentId === agentId);
  const caps =
    listed?.caps ??
    (tokenUsage === undefined
      ? undefined
      : {
          daily: { ...tokenUsage.agentDefaults.daily, used: 0 },
          monthly: { ...tokenUsage.agentDefaults.monthly, used: 0 },
        });
  if (caps === undefined) {
    return null;
  }
  return (
    <>
      <TokenFigure period="daily" use={caps.daily} compact={compact} />
      <TokenFigure period="monthly" use={caps.monthly} compact={compact} />
    </>
  );
}

/** The Terminal's tokens today and this month: its key has no caps. */
function TerminalTokens({ compact }: { compact: boolean }) {
  const { data } = useQuery({
    ...officeTokenUsageQuery,
    refetchInterval: tokenRefreshMs,
  });
  if (data === undefined) {
    return null;
  }
  const usage = data.ownerTools.find(
    ({ ownerTool }) => ownerTool === terminalKeyName,
  )?.usage;
  return (
    <>
      {(["daily", "monthly"] as const).map((period) => (
        <Figure
          key={period}
          compact={compact}
          label={`Tokens ${periodNames[period].toLowerCase()}`}
        >
          <span className="tabular-nums" title="The Terminal has no Token Caps">
            {formatTokens(usage?.[period].tokens ?? 0)}
          </span>
        </Figure>
      ))}
    </>
  );
}

/** Keeps an Agent's Floor's token usage live, as the wall board does. */
function FloorLive({
  floorId,
  onEvent,
}: {
  floorId: string;
  onEvent: EventStreamOptions["onEvent"] | undefined;
}) {
  useLiveWallBoard(floorId, onEvent === undefined ? {} : { onEvent });
  return null;
}

/**
 * A chat's Context Usage, its caller's tokens (against its Token Caps
 * where it has them), and its serving subscription's plan usage, as one
 * wrapping row of labelled meters; compact, smaller, for a panel.
 */
export function ChatStatusLine({
  caller,
  aiProvider,
  label,
  contextUsage,
  latestAccountId,
  onRequest,
  onFloorEvent,
  compact = false,
  children,
}: {
  caller: ChatCaller;
  /** The caller's AI Provider, for its accounts' windows before any request. */
  aiProvider: string | null;
  /** What the figures are called, such as "The Manager's usage". */
  label: string;
  contextUsage: ContextUsageFigures | undefined;
  /** The AI Account that served the caller's latest request, if known. */
  latestAccountId: string | null | undefined;
  /** Told of each of the caller's requests the AI Gateway records. */
  onRequest?: () => void;
  /** Told of each of an Agent's Floor's wall-board events. */
  onFloorEvent?: EventStreamOptions["onEvent"];
  compact?: boolean;
  /** The Model and effort, first in the line. */
  children?: ReactNode;
}) {
  const now = useNow();
  const queryClient = useQueryClient();
  const { data: accounts = [] } = useQuery({
    ...aiAccountsQuery,
    refetchInterval: 60_000,
  });
  // Each of the caller's requests reads the tokens, the accounts and the
  // caller's own figures again.
  useServerSentData(requestStreamUrl(caller), () => {
    void queryClient.invalidateQueries({
      queryKey:
        caller.kind === "agent"
          ? floorTokenUsageQuery(caller.floorId).queryKey
          : officeTokenUsageQuery.queryKey,
    });
    void queryClient.invalidateQueries(aiAccountsQuery);
    onRequest?.();
  });
  const serving = servingAccounts(accounts, latestAccountId, aiProvider);

  return (
    <div
      className={cn(
        "flex flex-wrap items-end rounded-md border",
        compact ? "gap-x-3 gap-y-2 px-2 py-1.5" : "gap-x-6 gap-y-3 px-3 py-2",
      )}
    >
      {caller.kind === "agent" && (
        <FloorLive floorId={caller.floorId} onEvent={onFloorEvent} />
      )}
      {children}
      <dl
        aria-label={label}
        className={cn(
          "flex flex-wrap items-end",
          compact ? "gap-x-3 gap-y-2" : "gap-x-6 gap-y-3",
        )}
      >
        <Figure label="Context Usage" compact={compact}>
          <ContextUsageGauge usage={contextUsage} />
        </Figure>
        {caller.kind === "agent" ? (
          <AgentTokens
            floorId={caller.floorId}
            agentId={caller.agentId}
            compact={compact}
          />
        ) : (
          <TerminalTokens compact={compact} />
        )}
        {serving.accounts.flatMap((account) =>
          (
            [
              [
                "five_hour",
                account.usage.fiveHour,
                account.fiveHourPauseThreshold,
              ],
              ["weekly", account.usage.weekly, account.weeklyPauseThreshold],
            ] as const
          ).map(([window, state, threshold]) => (
            <WindowFigure
              key={`${account.id}:${window}`}
              window={window}
              state={state}
              threshold={threshold}
              account={
                serving.served ? `Served by ${account.name}` : account.name
              }
              now={now}
              compact={compact}
            />
          )),
        )}
      </dl>
    </div>
  );
}
