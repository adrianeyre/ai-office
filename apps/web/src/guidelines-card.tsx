import {
  floorGuidelineListSchema,
  guidelineErrorCodes,
  guidelineProposalListSchema,
  guidelinesCardId,
  openedGuidelineProposalSchema,
  type Floor,
  type FloorGuideline,
  type GuidelineApproval,
  type GuidelineProposal,
} from "@ai-office/shared";
import { queryOptions, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { Badge } from "@/components/ui/badge.tsx";
import { Button } from "@/components/ui/button.tsx";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card.tsx";
import { LoadingMessage } from "@/components/ui/spinner.tsx";
import { cn } from "@/lib/utils.ts";

import { useAnchor } from "./anchor.ts";
import { getJson, readApiError, sendJson } from "./api.ts";
import { lineDiff } from "./line-diff.ts";
import { sessionQuery } from "./session.ts";

// A Floor's Guidelines in its admin (Guidelines, Specs and Hooks PRD,
// FR-103, FR-111; ADR 0014): each Guideline on the Floor's default branch,
// when it applies, the version the Owner approved (which is what Agents
// get), and any version awaiting approval, shown as its difference from
// the approved one with Approve and Dismiss, or why the file reaches no
// Agent. The Owner approves or dismisses exactly the version shown; one
// that changed meanwhile is refused, and the card shows it as it is now.
// The Notice "Guidelines changed on …" links here, by `#guidelines`.
//
// Below them wait the Guidelines Agents proposed in their Handoffs and QA
// reports (FR-110, FR-111), each shown as its difference from the version
// Agents get (whole, for a new one). No model accepts one: the Owner opens
// it as a pull request, which the GitHub App opens for the Owner to merge,
// or rejects it. No Agent gets it until the Owner merges it.

/** `GET /api/floors/:floorId/guidelines`. */
export const floorGuidelinesQuery = (floorId: string) =>
  queryOptions({
    queryKey: ["floors", floorId, "guidelines"],
    queryFn: () =>
      getJson(
        `/api/floors/${encodeURIComponent(floorId)}/guidelines`,
        floorGuidelineListSchema,
      ),
  });

/** `GET /api/floors/:floorId/guideline-proposals`. */
export const floorGuidelineProposalsQuery = (floorId: string) =>
  queryOptions({
    queryKey: ["floors", floorId, "guideline-proposals"],
    queryFn: () =>
      getJson(
        `/api/floors/${encodeURIComponent(floorId)}/guideline-proposals`,
        guidelineProposalListSchema,
      ),
  });

const approvalText: Record<GuidelineApproval, string> = {
  owner_merge: "in a pull request you merged",
  owner_push: "pushed by you",
  owner_admin: "approved by you here",
};

const shortHash = (hash: string): string => hash.slice(0, 7);

function Inclusion({ guideline }: { guideline: FloorGuideline }) {
  switch (guideline.inclusion) {
    case "always":
      return <Badge tone="info">Always</Badge>;
    case "fileMatch":
      return (
        <>
          <Badge tone="violet">File match</Badge>{" "}
          {guideline.fileMatchPatterns.map((pattern) => (
            <code key={pattern} className="mr-1 font-mono text-xs">
              {pattern}
            </code>
          ))}
        </>
      );
    case "manual":
      return (
        <>
          <Badge tone="neutral">Manual</Badge>{" "}
          <span className="text-xs text-muted-foreground">
            for issues labelled{" "}
            <code className="font-mono">guideline:{guideline.name}</code>
          </span>
        </>
      );
    case null:
      return null;
  }
}

/** `after` against `before`, line by line. */
function Lines({
  label,
  before,
  after,
}: {
  label: string;
  before: string;
  after: string;
}) {
  const lines = lineDiff(before, after);
  return (
    <pre
      aria-label={label}
      className="max-h-96 overflow-auto rounded bg-muted p-3 font-mono text-xs whitespace-pre"
    >
      {lines.map(({ kind, text }, index) => {
        const Line =
          kind === "added" ? "ins" : kind === "removed" ? "del" : "span";
        return (
          <Line
            key={index}
            className={cn(
              "block no-underline",
              kind === "added" &&
                "bg-tone-success text-tone-success-foreground",
              kind === "removed" &&
                "bg-tone-danger text-tone-danger-foreground",
            )}
          >
            {kind === "added" ? "+ " : kind === "removed" ? "- " : "  "}
            {text}
          </Line>
        );
      })}
    </pre>
  );
}

/** The version awaiting approval against the approved one, line by line. */
function Difference({ guideline }: { guideline: FloorGuideline }) {
  return (
    <Lines
      label={`Changes to ${guideline.name}`}
      before={guideline.approved?.content ?? ""}
      after={guideline.awaiting?.content ?? ""}
    />
  );
}

function ProposalItem({
  floor,
  proposal,
  current,
  busy,
  onAnswer,
}: {
  floor: Floor;
  proposal: GuidelineProposal;
  /** The Floor's Guideline of that name; undefined for a new one. */
  current: FloorGuideline | undefined;
  /** What is being sent, such as `open:3`; null when nothing. */
  busy: string | null;
  onAnswer: (action: "open" | "reject", proposal: GuidelineProposal) => void;
}) {
  const disabled = busy !== null || floor.archivedAt !== null;
  const label = `${proposal.name}, proposed on #${String(proposal.issue)}`;
  return (
    <li aria-label={label} className="space-y-2 rounded-md border p-3">
      <p className="flex flex-wrap items-center gap-2">
        <span className="font-mono font-medium">{proposal.name}</span>
        {current === undefined ? (
          <Badge tone="info">New Guideline</Badge>
        ) : (
          <Badge tone="warning">Change</Badge>
        )}
      </p>
      <p className="text-sm text-muted-foreground">
        Proposed by {proposal.agentName ?? "an Agent no longer on this Floor"}{" "}
        on #{proposal.issue}, for{" "}
        <code className="font-mono">{proposal.path}</code>
        {current?.approved === null || current === undefined
          ? "."
          : ", against the version Agents get:"}
      </p>
      <Lines
        label={`Proposed ${proposal.name}`}
        before={current?.approved?.content ?? ""}
        after={proposal.content}
      />
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          disabled={disabled}
          pending={busy === `open:${String(proposal.id)}`}
          onClick={() => {
            onAnswer("open", proposal);
          }}
        >
          Open {proposal.name} as pull request
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={disabled}
          pending={busy === `reject:${String(proposal.id)}`}
          onClick={() => {
            onAnswer("reject", proposal);
          }}
        >
          Reject {proposal.name}
        </Button>
      </div>
    </li>
  );
}

function GuidelineItem({
  floor,
  guideline,
  busy,
  onAnswer,
}: {
  floor: Floor;
  guideline: FloorGuideline;
  /** What is being sent, `approve:<name>` or `dismiss:<name>`; null when nothing. */
  busy: string | null;
  onAnswer: (action: "approve" | "dismiss", guideline: FloorGuideline) => void;
}) {
  const { approved, awaiting, error } = guideline;
  const disabled = busy !== null || floor.archivedAt !== null;
  return (
    <li
      aria-labelledby={`guideline-${guideline.name}`}
      className="space-y-2 rounded-md border p-3"
    >
      <p className="flex flex-wrap items-center gap-2">
        <span
          id={`guideline-${guideline.name}`}
          className="font-mono font-medium"
        >
          {guideline.name}
        </span>
        <Inclusion guideline={guideline} />
        {awaiting?.status === "awaiting" && (
          <Badge tone="warning">Awaiting approval</Badge>
        )}
        {error !== null && <Badge tone="danger">Invalid</Badge>}
      </p>
      {guideline.description !== null && <p>{guideline.description}</p>}
      <p className="text-xs text-muted-foreground">
        <code className="font-mono">{guideline.path}</code> on{" "}
        {floor.defaultBranch}
      </p>
      <p className="text-sm">
        {approved === null
          ? "No version approved: Agents get nothing from it."
          : `Agents get version ${shortHash(approved.contentHash)}, ${approvalText[approved.approval]}${approved.current ? "." : ", until you approve the one on the default branch."}`}
      </p>
      {error !== null && (
        <p className="text-sm text-destructive">
          It breaks the rules, so this version reaches no Agent: {error.reason}
        </p>
      )}
      {awaiting !== null && (
        <div className="space-y-2">
          <p className="text-sm">
            {awaiting.status === "awaiting"
              ? approved === null
                ? "A new Guideline awaits your approval"
                : "A change awaits your approval"
              : "You dismissed this version"}
            {awaiting.commitSha !== null &&
              ` (commit ${awaiting.commitSha.slice(0, 7)})`}
            {awaiting.status === "dismissed" &&
              (approved === null
                ? ": Agents get nothing from it."
                : ": Agents keep the approved one.")}
            {awaiting.status === "awaiting" && ":"}
          </p>
          <Difference guideline={guideline} />
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              disabled={disabled}
              pending={busy === `approve:${guideline.name}`}
              onClick={() => {
                onAnswer("approve", guideline);
              }}
            >
              Approve {guideline.name}
            </Button>
            {awaiting.status === "awaiting" && (
              <Button
                size="sm"
                variant="outline"
                disabled={disabled}
                pending={busy === `dismiss:${guideline.name}`}
                onClick={() => {
                  onAnswer("dismiss", guideline);
                }}
              >
                Dismiss {guideline.name}
              </Button>
            )}
          </div>
        </div>
      )}
    </li>
  );
}

export function GuidelinesCard({ floor }: { floor: Floor }) {
  const anchor = useAnchor<HTMLDivElement>(guidelinesCardId);
  const queryClient = useQueryClient();
  const { data: session } = useQuery(sessionQuery);
  const query = floorGuidelinesQuery(floor.id);
  const { data: list, error } = useQuery(query);
  const proposalsQuery = floorGuidelineProposalsQuery(floor.id);
  const { data: proposed, error: proposalsError } = useQuery(proposalsQuery);
  const [busy, setBusy] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [opened, setOpened] = useState<{
    readonly name: string;
    readonly number: number;
    readonly url: string;
  } | null>(null);

  const settle = async (
    action: "open" | "reject",
    proposal: GuidelineProposal,
  ) => {
    setBusy(`${action}:${String(proposal.id)}`);
    setProblem(null);
    setOpened(null);
    const response = await sendJson(
      "POST",
      `/api/floors/${encodeURIComponent(floor.id)}/guideline-proposals/${String(proposal.id)}/${action}`,
      {},
      session?.csrfToken,
    );
    setBusy(null);
    if (!response.ok) {
      const refused = await readApiError(response);
      setProblem(
        refused.message ??
          `The proposed ${proposal.name} was not ${action === "open" ? "opened as a pull request" : "rejected"}.`,
      );
      // Settled or gone meanwhile: show those still waiting.
      if (
        refused.error === guidelineErrorCodes.proposalSettled ||
        refused.error === guidelineErrorCodes.proposalNotFound
      ) {
        await queryClient.invalidateQueries({
          queryKey: proposalsQuery.queryKey,
        });
      }
      return;
    }
    if (action === "open") {
      const answer = openedGuidelineProposalSchema.parse(await response.json());
      setOpened({ name: proposal.name, ...answer.pullRequest });
      queryClient.setQueryData(proposalsQuery.queryKey, {
        proposals: answer.proposals,
      });
      return;
    }
    queryClient.setQueryData(
      proposalsQuery.queryKey,
      guidelineProposalListSchema.parse(await response.json()),
    );
  };

  const answer = async (
    action: "approve" | "dismiss",
    guideline: FloorGuideline,
  ) => {
    if (guideline.awaiting === null) {
      return;
    }
    setBusy(`${action}:${guideline.name}`);
    setProblem(null);
    const response = await sendJson(
      "POST",
      `/api/floors/${encodeURIComponent(floor.id)}/guidelines/${encodeURIComponent(guideline.name)}/${action}`,
      { contentHash: guideline.awaiting.contentHash },
      session?.csrfToken,
    );
    setBusy(null);
    if (!response.ok) {
      const refused = await readApiError(response);
      setProblem(
        refused.message ??
          `${guideline.name} was not ${action === "approve" ? "approved" : "dismissed"}.`,
      );
      // It changed meanwhile: show it as it is now.
      if (refused.error === guidelineErrorCodes.guidelineChanged) {
        await queryClient.invalidateQueries({ queryKey: query.queryKey });
      }
      return;
    }
    queryClient.setQueryData(
      query.queryKey,
      floorGuidelineListSchema.parse(await response.json()),
    );
  };

  return (
    <Card id={guidelinesCardId} ref={anchor} className="scroll-mt-4">
      <CardHeader>
        <CardTitle>
          <h2>Guidelines</h2>
        </CardTitle>
        <CardDescription>
          Your rules for this repository, one Markdown file each in{" "}
          <code className="font-mono">.agents/guidelines/</code> on its default
          branch. Agents follow each only in the version you approved: one you
          merged or pushed yourself, or approved here. Any other change waits
          here for you, and Agents keep the approved version meanwhile.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {error !== null && (
          <p role="alert" className="text-destructive">
            {error.message}
          </p>
        )}
        {list === undefined && error === null && (
          <LoadingMessage>Loading the Guidelines…</LoadingMessage>
        )}
        {list?.guidelines.length === 0 && (
          <p className="text-muted-foreground">
            This Floor has no Guidelines. Add Markdown files to{" "}
            <code className="font-mono">.agents/guidelines/</code> on{" "}
            {floor.defaultBranch} to give its Agents rules.
          </p>
        )}
        {list !== undefined && list.awaitingCount > 0 && (
          <p role="status" className="font-medium">
            {list.awaitingCount === 1
              ? "1 Guideline awaits your approval."
              : `${String(list.awaitingCount)} Guidelines await your approval.`}
          </p>
        )}
        {problem !== null && (
          <p role="alert" className="text-destructive">
            {problem}
          </p>
        )}
        {list !== undefined && list.guidelines.length > 0 && (
          <ul aria-label="Guidelines" className="space-y-3">
            {list.guidelines.map((guideline) => (
              <GuidelineItem
                key={guideline.name}
                floor={floor}
                guideline={guideline}
                busy={busy}
                onAnswer={(action, chosen) => void answer(action, chosen)}
              />
            ))}
          </ul>
        )}
        {opened !== null && (
          <p role="status">
            Opened{" "}
            <a
              href={opened.url}
              target="_blank"
              rel="noreferrer"
              className="underline"
            >
              PR #{opened.number}
            </a>{" "}
            for {opened.name}. No Agent gets it until you merge it.
          </p>
        )}
        {proposalsError !== null && (
          <p role="alert" className="text-destructive">
            {proposalsError.message}
          </p>
        )}
        {proposed !== undefined && proposed.proposals.length > 0 && (
          <section aria-labelledby="guideline-proposals" className="space-y-3">
            <h3 id="guideline-proposals" className="font-medium">
              Proposed by Agents
            </h3>
            <p className="text-sm text-muted-foreground">
              Agents may propose a new or changed Guideline in a Handoff or QA
              report. No Agent follows one until you open it as a pull request
              and merge it: your merge approves it.
            </p>
            <ul aria-label="Proposed Guidelines" className="space-y-3">
              {proposed.proposals.map((proposal) => (
                <ProposalItem
                  key={proposal.id}
                  floor={floor}
                  proposal={proposal}
                  current={list?.guidelines.find(
                    ({ name }) => name === proposal.name,
                  )}
                  busy={busy}
                  onAnswer={(action, chosen) => void settle(action, chosen)}
                />
              ))}
            </ul>
          </section>
        )}
      </CardContent>
    </Card>
  );
}
