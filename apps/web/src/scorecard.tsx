import {
  agentScorecardListSchema,
  scorecardDimensionLabels,
  scorecardDimensions,
  scorecardSchema,
  type AgentScorecard,
  type ScorecardDimension,
} from "@ai-office/shared";
import {
  keepPreviousData,
  queryOptions,
  useQuery,
} from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button.tsx";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card.tsx";
import { LoadingMessage } from "@/components/ui/spinner.tsx";
import { cn, selectClass } from "@/lib/utils.ts";

import { BarList, ChartTable } from "./analytics-charts.tsx";
import { getJson } from "./api.ts";
import { formatTotal, useMoney, type Money } from "./money.ts";
import type { Widget } from "./widget-grid.tsx";

// The Scorecard (Scorecards PRD, FR-128 to FR-131, FR-135): how the work of
// each Agent, Role, Model, Floor or Size turned out, over the Analytics
// range. Two widgets on the Analytics page's grid, each a chart and its
// table view: work, QA and docs (issues merged, mean Review Loop rounds
// until approval, QA rounds failed, stalls and failures, issues handed to
// the Owner, and tokens and cost per merged issue), and reviewers (rounds
// reviewed and blocking comments per round). And each Agent's one line,
// on its card, over the last 30 days, linking to the Scorecard filtered
// to it.

const search = (fields: Record<string, string>) =>
  new URLSearchParams(fields).toString();

/** `GET /api/analytics/scorecard`, for the range, by a dimension. */
export const scorecardQuery = (
  from: string,
  to: string,
  by: ScorecardDimension,
  agentId?: string,
) =>
  queryOptions({
    queryKey: ["analytics", "scorecard", from, to, by, agentId ?? null],
    queryFn: () =>
      getJson(
        `/api/analytics/scorecard?${search({
          from,
          to,
          by,
          ...(agentId === undefined ? {} : { agentId }),
        })}`,
        scorecardSchema,
      ),
    placeholderData: keepPreviousData,
  });

/** `GET /api/floors/:floorId/scorecards`: each Agent's one line. */
export const agentScorecardsQuery = (floorId: string) =>
  queryOptions({
    queryKey: ["floors", floorId, "scorecards"],
    queryFn: () =>
      getJson(
        `/api/floors/${encodeURIComponent(floorId)}/scorecards`,
        agentScorecardListSchema,
      ),
  });

const wholeFormat = new Intl.NumberFormat("en-US");
const compactFormat = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});
const compact = (value: number): string => compactFormat.format(value);
const dash = "–";
/** Rounds and means, to a tenth. */
const tenths = (value: number | null): string =>
  value === null ? dash : value.toFixed(1);

/** Money per merged issue, or a dash with none merged. */
const perIssue = (usd: number | null, money: Money): string =>
  usd === null ? dash : formatTotal(usd, money);

/** What chooses the Scorecard's "by", and says whose it shows. */
function ScorecardControls({
  by,
  onByChange,
  agentName,
  onShowEveryone,
}: {
  by: ScorecardDimension;
  onByChange: (by: ScorecardDimension) => void;
  agentName: string | undefined;
  onShowEveryone: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <select
        aria-label="Scorecard by"
        className={cn(selectClass, "w-auto")}
        value={by}
        onChange={(event) => {
          onByChange(event.target.value as ScorecardDimension);
        }}
      >
        {scorecardDimensions.map((dimension) => (
          <option key={dimension} value={dimension}>
            By {scorecardDimensionLabels[dimension]}
          </option>
        ))}
      </select>
      {agentName === undefined ? null : (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          Only {agentName}&apos;s work.
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={onShowEveryone}
          >
            Show everyone
          </Button>
        </p>
      )}
    </div>
  );
}

function ScorecardCard({
  title,
  description,
  controls,
  fetching,
  children,
}: {
  title: string;
  description: string;
  controls: ReactNode;
  fetching: boolean;
  children: ReactNode;
}) {
  return (
    <Card className={cn("h-full gap-4", fetching && "opacity-60")}>
      <CardHeader className="pr-12">
        <CardTitle>
          <h2>{title}</h2>
        </CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {controls}
        {children}
      </CardContent>
    </Card>
  );
}

interface ScorecardWidgetsInput {
  readonly from: string;
  readonly to: string;
  readonly by: ScorecardDimension;
  /** Only this Agent's work, from its card's link. */
  readonly agentId?: string | undefined;
  readonly onByChange: (by: ScorecardDimension) => void;
  readonly onShowEveryone: () => void;
}

/** Work, QA and docs (FR-128): a chart of issues merged, and its table. */
function WorkScorecard(input: ScorecardWidgetsInput) {
  const { from, to, by, agentId } = input;
  const { data, isFetching, isError } = useQuery(
    scorecardQuery(from, to, by, agentId),
  );
  const money = useMoney();
  const name = scorecardDimensionLabels[by];
  const agentName =
    agentId === undefined
      ? undefined
      : ([...(data?.work ?? []), ...(data?.review ?? [])].find(
          ({ key }) => key === agentId,
        )?.label ?? "this Agent");
  return (
    <ScorecardCard
      title="Scorecard: work, QA and docs"
      description="How the work that ended in this range turned out: issues merged, Review Loop rounds until approval, QA rounds failed, stalls and failures, hand-offs to you, and what each merged issue cost. Work counts toward the Model that served it."
      fetching={isFetching}
      controls={
        <ScorecardControls
          by={by}
          onByChange={input.onByChange}
          agentName={agentName}
          onShowEveryone={input.onShowEveryone}
        />
      }
    >
      {isError ? (
        <p role="alert" className="text-sm text-destructive">
          The Scorecard could not be read.
        </p>
      ) : data === undefined ? (
        <LoadingMessage className="text-sm">Loading…</LoadingMessage>
      ) : data.work.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No work, QA or docs work ended in this range.
        </p>
      ) : (
        <>
          <BarList
            label={`Issues merged by ${name}`}
            format={(value) => wholeFormat.format(value)}
            items={data.work.map((item) => ({
              key: JSON.stringify([item.key, item.floorId]),
              label: item.label,
              value: item.issuesMerged,
              details: [
                {
                  label: "merged",
                  value: wholeFormat.format(item.issuesMerged),
                },
                {
                  label: "rounds",
                  value: tenths(item.meanRoundsToApproval),
                },
                {
                  label: "an issue",
                  value: perIssue(item.costPerMergedIssue, money),
                },
              ],
            }))}
          />
          <ChartTable
            caption={`The Scorecard by ${name}: work, QA and docs`}
            columns={[
              name,
              "Issues",
              "Merged",
              "Mean rounds",
              "QA rounds failed",
              "Stalls",
              "Failures",
              "Handed to you",
              "Tokens an issue",
              "Cost an issue",
            ]}
            rows={data.work.map((item) => [
              item.label,
              wholeFormat.format(item.issues),
              wholeFormat.format(item.issuesMerged),
              tenths(item.meanRoundsToApproval),
              wholeFormat.format(item.qaRoundsFailed),
              wholeFormat.format(item.stalls),
              wholeFormat.format(item.failures),
              wholeFormat.format(item.handedToOwner),
              item.tokensPerMergedIssue === null
                ? dash
                : compact(item.tokensPerMergedIssue),
              perIssue(item.costPerMergedIssue, money),
            ])}
          />
        </>
      )}
    </ScorecardCard>
  );
}

/** Reviewers (FR-129): a chart of rounds reviewed, and its table. */
function ReviewScorecard(input: ScorecardWidgetsInput) {
  const { from, to, by, agentId } = input;
  const { data, isFetching, isError } = useQuery(
    scorecardQuery(from, to, by, agentId),
  );
  const money = useMoney();
  const name = scorecardDimensionLabels[by];
  return (
    <ScorecardCard
      title="Scorecard: reviewers"
      description="The rounds each reviewed in the work that ended in this range, and its blocking comments per round."
      fetching={isFetching}
      controls={null}
    >
      {isError ? (
        <p role="alert" className="text-sm text-destructive">
          The Scorecard could not be read.
        </p>
      ) : data === undefined ? (
        <LoadingMessage className="text-sm">Loading…</LoadingMessage>
      ) : data.review.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No reviewed work ended in this range.
        </p>
      ) : (
        <>
          <BarList
            label={`Rounds reviewed by ${name}`}
            format={(value) => wholeFormat.format(value)}
            items={data.review.map((item) => ({
              key: JSON.stringify([item.key, item.floorId]),
              label: item.label,
              value: item.roundsReviewed,
              details: [
                {
                  label: "rounds",
                  value: wholeFormat.format(item.roundsReviewed),
                },
                {
                  label: "blocking a round",
                  value: tenths(item.blockingPerRound),
                },
              ],
            }))}
          />
          <ChartTable
            caption={`The Scorecard by ${name}: reviewers`}
            columns={[
              name,
              "Issues",
              "Rounds reviewed",
              "Blocking comments",
              "Blocking a round",
              "Tokens",
              "Estimated cost",
            ]}
            rows={data.review.map((item) => [
              item.label,
              wholeFormat.format(item.issues),
              wholeFormat.format(item.roundsReviewed),
              wholeFormat.format(item.blockingComments),
              tenths(item.blockingPerRound),
              compact(item.tokens),
              formatTotal(item.estimatedCostUsd, money),
            ])}
          />
        </>
      )}
    </ScorecardCard>
  );
}

/** The Scorecard's widgets for the Analytics page's grid (FR-130). */
export const scorecardWidgets = (input: ScorecardWidgetsInput): Widget[] => [
  {
    id: "scorecard-work",
    title: "Scorecard: work, QA and docs",
    content: <WorkScorecard {...input} />,
  },
  {
    id: "scorecard-review",
    title: "Scorecard: reviewers",
    content: <ReviewScorecard {...input} />,
  },
];

/**
 * An Agent's one-line Scorecard (FR-131): "12 merged · 1.4 rounds · $0.38
 * an issue" for work, QA and docs; "9 rounds · 0.6 blocking a round" for a
 * reviewer; or that it has finished no work in the last 30 days.
 */
export function scorecardLine(scorecard: AgentScorecard, money: Money): string {
  if (scorecard.issues === 0) {
    return `No finished work in the last ${String(scorecard.days)} days`;
  }
  if (scorecard.stage === "review") {
    return [
      `${wholeFormat.format(scorecard.roundsReviewed)} ${scorecard.roundsReviewed === 1 ? "round" : "rounds"} reviewed`,
      `${tenths(scorecard.blockingPerRound)} blocking a round`,
    ].join(" · ");
  }
  return [
    `${wholeFormat.format(scorecard.issuesMerged)} merged`,
    `${tenths(scorecard.meanRoundsToApproval)} rounds`,
    `${perIssue(scorecard.costPerMergedIssue, money)} an issue`,
  ].join(" · ");
}

/**
 * An Agent's one line on its card (FR-131), linking to the Scorecard on
 * Analytics, last 30 days, filtered to it.
 */
export function AgentScorecardLine({
  floorId,
  agentId,
  agentName,
}: {
  floorId: string;
  agentId: string;
  agentName: string;
}) {
  const { data } = useQuery(agentScorecardsQuery(floorId));
  const money = useMoney();
  const scorecard = data?.scorecards.find((each) => each.agentId === agentId);
  if (scorecard === undefined) {
    return null;
  }
  return (
    <p className="text-xs text-muted-foreground">
      <Link
        to="/analytics"
        search={{
          range: "30d",
          scorecard: "agent",
          agent: agentId,
        }}
        className="underline-offset-2 hover:underline"
        aria-label={`${agentName}'s Scorecard, last ${String(scorecard.days)} days: ${scorecardLine(scorecard, money)}`}
      >
        {scorecardLine(scorecard, money)}
      </Link>
    </p>
  );
}
