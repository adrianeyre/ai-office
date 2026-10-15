import {
  floorTokenUsageSchema,
  officeTokenCapsSchema,
  officeTokenUsageSchema,
  tokenCapsSchema,
  type CapLevel,
  type CapUse,
  type Floor,
  type FloorTokenUsage,
  type OfficeTokenUsage,
  type PeriodTotals,
  type TokenTotals,
} from "@ai-office/shared";
import { queryOptions, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useForm } from "react-hook-form";

import { Button } from "@/components/ui/button.tsx";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Label } from "@/components/ui/label.tsx";
import { TableFrame } from "@/components/ui/table-frame.tsx";

import { AgentLink } from "./agent-link.tsx";
import { getJson, readApiError, sendJson } from "./api.ts";
import { floorsQuery } from "./floors.ts";
import { sessionQuery } from "./session.ts";

// Token accounting and Token Caps (PRD FR-31, FR-32): tokens (input plus
// output, cache reads apart) per day and month, against the caps set at
// the office, Floor, Agent and issue levels. The most specific cap set
// applies. The office admin sets the office's defaults; the Floor admin
// its issues' caps (its own are in its settings); the Agent editor the
// Agent's.

/** The office's caps and the Office's use (`GET /api/office/token-caps`). */
export const officeTokenUsageQuery = queryOptions({
  queryKey: ["office", "token-caps"],
  queryFn: () => getJson("/api/office/token-caps", officeTokenUsageSchema),
});

/** A Floor's caps and use (`GET /api/floors/:floorId/token-usage`). */
export const floorTokenUsageQuery = (floorId: string) =>
  queryOptions({
    queryKey: ["floors", floorId, "token-usage"],
    queryFn: () =>
      getJson(
        `/api/floors/${encodeURIComponent(floorId)}/token-usage`,
        floorTokenUsageSchema,
      ),
  });

const numbers = new Intl.NumberFormat("en-US");
const dollars = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 2,
});

/** A count of tokens: `1,234,567`. */
export const formatTokens = (tokens: number): string => numbers.format(tokens);

/** Where a cap in force was set, as a phrase: "the Floor's". */
export const levelLabels: Record<CapLevel, string> = {
  office: "the office's",
  floor: "the Floor's",
  agent: "the Agent's own",
  issue: "the issue's",
};

/** A cap and its use: "1,234 of 5,000,000". */
export const capUseText = (use: Pick<CapUse, "cap" | "used">): string =>
  `${formatTokens(use.used)} of ${formatTokens(use.cap)}`;

/** What a period used, in a line: tokens, cache reads and the estimate. */
const totalsText = (totals: TokenTotals): string =>
  `${formatTokens(totals.tokens)} tokens (cache reads ${formatTokens(totals.cacheReadTokens)}) · about ${dollars.format(totals.estimatedCostUsd)}`;

/** A text field holding a cap: empty for none. */
export const capValue = (cap: number | null): string =>
  cap === null ? "" : String(cap);

/** A text field's cap: null when empty, a number otherwise (checked later). */
export const capOf = (value: string): number | null =>
  value.trim() === "" ? null : Number(value);

/** Today's and this month's totals, as a definition list. */
function PeriodTotalsList({
  label,
  usage,
}: {
  label: string;
  usage: PeriodTotals;
}) {
  return (
    <dl
      aria-label={label}
      className="grid gap-1 text-sm sm:grid-cols-[auto_1fr]"
    >
      <dt className="text-muted-foreground">Today</dt>
      <dd>{totalsText(usage.daily)}</dd>
      <dt className="text-muted-foreground">This month</dt>
      <dd>{totalsText(usage.monthly)}</dd>
    </dl>
  );
}

function OfficeCapsForm({ usage }: { usage: OfficeTokenUsage }) {
  const queryClient = useQueryClient();
  const { data: session } = useQuery(sessionQuery);
  const [problems, setProblems] = useState<string[]>([]);
  const [saved, setSaved] = useState(false);
  const values = {
    daily: String(usage.caps.daily),
    monthly: String(usage.caps.monthly),
  };
  const {
    register,
    handleSubmit,
    reset,
    formState: { isDirty, isSubmitting },
  } = useForm<{ daily: string; monthly: string }>({ defaultValues: values });

  const onSubmit = async (form: { daily: string; monthly: string }) => {
    setSaved(false);
    const parsed = officeTokenCapsSchema.safeParse({
      daily: Number(form.daily),
      monthly: Number(form.monthly),
    });
    if (!parsed.success) {
      setProblems(parsed.error.issues.map(({ message }) => message));
      return;
    }
    const response = await sendJson(
      "PUT",
      "/api/office/token-caps",
      parsed.data,
      session?.csrfToken,
    );
    if (!response.ok) {
      const error = await readApiError(response);
      setProblems(
        error.problems ?? [error.message ?? "The Token Caps were not saved."],
      );
      return;
    }
    const updated = officeTokenUsageSchema.parse(await response.json());
    setProblems([]);
    setSaved(true);
    reset({
      daily: String(updated.caps.daily),
      monthly: String(updated.caps.monthly),
    });
    queryClient.setQueryData(officeTokenUsageQuery.queryKey, updated);
  };

  const nearest = (period: "daily" | "monthly", text: string) => {
    const busiest = usage.busiestAgents[period];
    return (
      <p className="text-xs text-muted-foreground">
        {busiest === null ? (
          `No Agent has used any ${text}.`
        ) : (
          <>
            Nearest its cap {text}:{" "}
            <AgentLink floorId={busiest.floorId} agentId={busiest.agentId} />,{" "}
            {capUseText(busiest.use)} ({levelLabels[busiest.use.level]}).
          </>
        )}
      </p>
    );
  };

  return (
    <form
      noValidate
      aria-label="Office Token Caps"
      className="space-y-4"
      onSubmit={(event) => void handleSubmit(onSubmit)(event)}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="office-daily-token-cap">Daily Token Cap</Label>
          <Input
            id="office-daily-token-cap"
            type="number"
            inputMode="numeric"
            min={1}
            {...register("daily")}
          />
          {nearest("daily", "today")}
        </div>
        <div className="space-y-2">
          <Label htmlFor="office-monthly-token-cap">Monthly Token Cap</Label>
          <Input
            id="office-monthly-token-cap"
            type="number"
            inputMode="numeric"
            min={1}
            {...register("monthly")}
          />
          {nearest("monthly", "this month")}
        </div>
      </div>
      {problems.length > 0 && (
        <div role="alert">
          <ul className="space-y-1 text-sm text-destructive">
            {problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        </div>
      )}
      {saved && !isDirty && (
        <p role="status" className="text-sm">
          Saved. Every Agent without a cap of its own, its Floor&apos;s or its
          issue&apos;s is held to these.
        </p>
      )}
      <Button
        pending={isSubmitting}
        type="submit"
        disabled={!isDirty || isSubmitting || session === undefined}
      >
        {isSubmitting ? "Saving…" : "Save Token Caps"}
      </Button>
    </form>
  );
}

/** Rows of a day's and a month's tokens, by Floor or by Owner tool. */
function UsageTable({
  caption,
  heading,
  rows,
}: {
  caption: string;
  heading: string;
  rows: readonly { key: string; name: string; usage: PeriodTotals }[];
}) {
  return (
    <TableFrame label={`${caption}, scrollable`}>
      <table className="w-full text-left text-sm">
        <caption className="text-left font-medium">{caption}</caption>
        <thead className="text-muted-foreground">
          <tr className="border-b">
            <th scope="col" className="py-2 pr-4 font-medium">
              {heading}
            </th>
            <th scope="col" className="py-2 pr-4 font-medium">
              Today
            </th>
            <th scope="col" className="py-2 font-medium">
              This month
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ key, name, usage }) => (
            <tr key={key} className="border-b last:border-0">
              <th scope="row" className="py-2 pr-4 font-medium">
                {name}
              </th>
              <td className="py-2 pr-4">{formatTokens(usage.daily.tokens)}</td>
              <td className="py-2">{formatTokens(usage.monthly.tokens)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableFrame>
  );
}

/**
 * The office's Token Caps in the office admin (PRD FR-32): the daily and
 * monthly defaults for every Agent, with the Office's use, per Floor and
 * per Owner tool, and the Agent nearest its cap.
 */
export function TokenCapsCard() {
  const { data: usage, isError } = useQuery(officeTokenUsageQuery);
  const { data: floors } = useQuery(floorsQuery);
  const floorName = (floorId: string) =>
    floors?.find(({ id }) => id === floorId)?.name ?? floorId;
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>Token Caps</h2>
        </CardTitle>
        <CardDescription>
          The tokens (input plus output) each Agent may use a day and a month,
          unless its Floor, it or its issue has its own cap: the most specific
          applies. Cache reads are shown apart, and costs are estimates. Days
          and months are in UTC.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {isError && (
          <p role="alert" className="text-sm text-destructive">
            The Token Caps could not be loaded.
          </p>
        )}
        {usage !== undefined && (
          <>
            <OfficeCapsForm usage={usage} />
            <PeriodTotalsList label="The Office's use" usage={usage.usage} />
            {usage.floors.length > 0 && (
              <UsageTable
                caption="By Floor"
                heading="Floor"
                rows={usage.floors.map(({ floorId, usage: used }) => ({
                  key: floorId,
                  name: floorName(floorId),
                  usage: used,
                }))}
              />
            )}
            {usage.ownerTools.length > 0 && (
              <UsageTable
                caption="By Owner tool"
                heading="Owner tool"
                rows={usage.ownerTools.map(({ ownerTool, usage: used }) => ({
                  key: ownerTool,
                  name: ownerTool,
                  usage: used,
                }))}
              />
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

interface IssueCapValues {
  issue: string;
  daily: string;
  monthly: string;
}

/** Sets one issue's caps; empty in both removes them. */
function IssueCapsForm({ floor }: { floor: Floor }) {
  const queryClient = useQueryClient();
  const { data: session } = useQuery(sessionQuery);
  const [problems, setProblems] = useState<string[]>([]);
  const [saved, setSaved] = useState<string>();
  const {
    register,
    handleSubmit,
    reset,
    formState: { isSubmitting },
  } = useForm<IssueCapValues>({
    defaultValues: { issue: "", daily: "", monthly: "" },
  });

  const onSubmit = async (values: IssueCapValues) => {
    setSaved(undefined);
    const issue = Number(values.issue);
    if (!Number.isInteger(issue) || issue < 1) {
      setProblems(["Name the issue by its number."]);
      return;
    }
    const parsed = tokenCapsSchema.safeParse({
      daily: capOf(values.daily),
      monthly: capOf(values.monthly),
    });
    if (!parsed.success) {
      setProblems(parsed.error.issues.map(({ message }) => message));
      return;
    }
    const response = await sendJson(
      "PUT",
      `/api/floors/${encodeURIComponent(floor.id)}/issues/${String(issue)}/token-caps`,
      parsed.data,
      session?.csrfToken,
    );
    if (!response.ok) {
      const error = await readApiError(response);
      setProblems(
        error.problems ?? [error.message ?? "The issue's caps were not saved."],
      );
      return;
    }
    setProblems([]);
    setSaved(
      parsed.data.daily === null && parsed.data.monthly === null
        ? `#${String(issue)} has no caps of its own now.`
        : `Saved #${String(issue)}'s caps.`,
    );
    reset();
    await queryClient.invalidateQueries(floorTokenUsageQuery(floor.id));
  };

  return (
    <form
      noValidate
      aria-label="Issue Token Caps"
      className="space-y-3"
      onSubmit={(event) => void handleSubmit(onSubmit)(event)}
    >
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="space-y-2">
          <Label htmlFor="issue-cap-issue">Issue</Label>
          <Input
            id="issue-cap-issue"
            type="number"
            inputMode="numeric"
            min={1}
            placeholder="#"
            {...register("issue")}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="issue-cap-daily">Issue daily cap</Label>
          <Input
            id="issue-cap-daily"
            type="number"
            inputMode="numeric"
            min={1}
            {...register("daily")}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="issue-cap-monthly">Issue monthly cap</Label>
          <Input
            id="issue-cap-monthly"
            type="number"
            inputMode="numeric"
            min={1}
            {...register("monthly")}
          />
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        An issue&apos;s cap counts every Agent&apos;s tokens on it, and applies
        in place of the Agent&apos;s while it works the issue. Leave both empty
        to remove them.
      </p>
      {problems.length > 0 && (
        <div role="alert">
          <ul className="space-y-1 text-sm text-destructive">
            {problems.map((problem) => (
              <li key={problem}>{problem}</li>
            ))}
          </ul>
        </div>
      )}
      {saved !== undefined && (
        <p role="status" className="text-sm">
          {saved}
        </p>
      )}
      <Button
        pending={isSubmitting}
        type="submit"
        size="sm"
        disabled={isSubmitting || session === undefined}
      >
        {isSubmitting ? "Saving…" : "Save issue caps"}
      </Button>
    </form>
  );
}

/** An issue's cap and its use, or just its use in a period with none. */
const issueCapText = (cap: number | null, used: number): string =>
  cap === null ? `${formatTokens(used)} (no cap)` : capUseText({ cap, used });

/**
 * A Floor's token use and caps in the Floor admin (PRD FR-32, FR-66): its
 * Agents' default caps (its own, or the office's), its use, and its
 * issues' caps against their use. Each Agent's use against its cap is in
 * the Agents table.
 */
export function FloorTokenUsageCard({ floor }: { floor: Floor }) {
  const { data: usage, isError } = useQuery(floorTokenUsageQuery(floor.id));
  const archived = floor.archivedAt !== null;
  const defaults = (period: keyof FloorTokenUsage["agentDefaults"]) => {
    const resolved = usage?.agentDefaults[period];
    return resolved === undefined
      ? ""
      : `${formatTokens(resolved.cap)} (${levelLabels[resolved.level]})`;
  };
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>Token usage</h2>
        </CardTitle>
        <CardDescription>
          This Floor&apos;s tokens (input plus output) today and this month. Its
          own caps are in its settings; each Agent&apos;s are in its editor.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {isError && (
          <p role="alert" className="text-sm text-destructive">
            The token usage could not be loaded.
          </p>
        )}
        {usage !== undefined && (
          <>
            <PeriodTotalsList label="This Floor's use" usage={usage.usage} />
            <p className="text-sm">
              Each Agent here may use {defaults("daily")} a day and{" "}
              {defaults("monthly")} a month, unless it has its own cap.
            </p>
            {usage.issues.length > 0 && (
              <TableFrame label="Issues, scrollable">
                <table className="w-full text-left text-sm">
                  <caption className="text-left font-medium">Issues</caption>
                  <thead className="text-muted-foreground">
                    <tr className="border-b">
                      <th scope="col" className="py-2 pr-4 font-medium">
                        Issue
                      </th>
                      <th scope="col" className="py-2 pr-4 font-medium">
                        Today
                      </th>
                      <th scope="col" className="py-2 font-medium">
                        This month
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {usage.issues.map(({ issue, caps, usage: used }) => (
                      <tr key={issue} className="border-b last:border-0">
                        <th scope="row" className="py-2 pr-4 font-medium">
                          <a
                            href={`https://github.com/${floor.repository}/issues/${String(issue)}`}
                            target="_blank"
                            rel="noreferrer"
                            className="hover:underline"
                          >
                            #{issue}
                          </a>
                        </th>
                        <td className="py-2 pr-4">
                          {issueCapText(caps.daily, used.daily.tokens)}
                        </td>
                        <td className="py-2">
                          {issueCapText(caps.monthly, used.monthly.tokens)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableFrame>
            )}
            {!archived && <IssueCapsForm floor={floor} />}
          </>
        )}
      </CardContent>
    </Card>
  );
}
