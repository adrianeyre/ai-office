import {
  addAiAccountRequestSchema,
  aiAccountKindOf,
  aiAccountLimitReasonLabels,
  aiAccountKinds,
  aiAccountListSchema,
  aiAccountSchema,
  aiAccountUpdateSchema,
  aiProviders,
  analyticsSeriesSchema,
  completeOAuthLoginRequestSchema,
  maxAiAccountPriority,
  maxPauseThreshold,
  minAiAccountPriority,
  minPauseThreshold,
  oauthLoginSchema,
  importOAuthLoginRequestSchema,
  oauthLoginStatusSchema,
  platformOf,
  startOAuthLoginRequestSchema,
  subscriptionPlanOf,
  subscriptionPlans,
  subscriptionTermsWarnings,
  usageHistorySchema,
  usageWindowLabels,
  usageWindowLengthsMs,
  type AiAccount,
  type UsageWindow,
  type UsageWindowState,
  type OAuthLogin,
} from "@ai-office/shared";
import { queryOptions, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ExternalLink,
  Gauge,
  History,
  KeyRound,
  Pause,
  Pencil,
  Play,
  RotateCcw,
  Trash2,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useForm, useWatch } from "react-hook-form";

import { Badge, type BadgeTone } from "@/components/ui/badge.tsx";
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
import { selectClass } from "@/lib/utils.ts";

import { AccountUsageBars, balanceReadable } from "./account-usage-bars.tsx";
import { TimeChart, usageWindowSeries } from "./analytics-charts.tsx";
import {
  getJson,
  postJson,
  readApiError,
  sendDelete,
  sendJson,
} from "./api.ts";
import { useEventStream } from "./event-stream.ts";
import { sessionQuery } from "./session.ts";
import { isLocalhost, location } from "./totp-settings.tsx";

// The AI Accounts the AI Gateway serves Agents' model calls from (PRD
// FR-35, FR-36): add a key-based one, an AWS Bedrock or Google Vertex AI
// one for Claude (its region and its IAM credentials, profile or service
// account), an endpoint (the Owner's own Ollama, or any Anthropic- or
// OpenAI-compatible API at its URL, with a key only if it asks for one),
// or a subscription (Claude, Grok, ChatGPT, Gemini or Qwen) through its
// OAuth login (after a warning about its terms), or from a CLI login, or
// a coding plan's key (Z.ai's, MiniMax's, Kimi's or Qwen's), then
// rename, reprioritise,
// pause, resume, force a Model, turn extra usage on or off (FR-41), sign in
// again or delete it. A subscription's token health
// is shown live, and its usage windows (FR-36) as meters where its AI
// Provider reports them (Claude's and ChatGPT's). Every account's last
// week is charted on demand (FR-43): its tokens and requests from the
// Gateway's own history, and its usage windows where it has them. A key is typed in once; it is stored encrypted and never
// shown again, here or anywhere, and neither are a subscription's tokens.
// The accounts are listed under their AI Provider, each group in priority
// order, each account in a box whose left border says whether it is
// enabled (green), paused (orange) or failing (red).

/** The AI Accounts, in the order the Gateway uses them (`GET /api/ai-accounts`). */
export const aiAccountsQuery = queryOptions({
  queryKey: ["ai-accounts"],
  queryFn: async () =>
    (await getJson("/api/ai-accounts", aiAccountListSchema)).accounts,
});

const accountUrl = (account: AiAccount): string =>
  `/api/ai-accounts/${encodeURIComponent(account.id)}`;

/** What the API said was wrong, one line each. */
async function problemsOf(
  response: Response,
  fallback: string,
): Promise<string[]> {
  const error = await readApiError(response);
  return error.problems ?? [error.message ?? fallback];
}

function Problems({ problems }: { problems: readonly string[] }) {
  return problems.length === 0 ? null : (
    <div role="alert">
      <ul className="space-y-1 text-sm text-destructive">
        {problems.map((problem) => (
          <li key={problem}>{problem}</li>
        ))}
      </ul>
    </div>
  );
}

function Field({
  id,
  label,
  hint,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {hint !== undefined && (
        <p id={`${id}-hint`} className="text-xs text-muted-foreground">
          {hint}
        </p>
      )}
    </div>
  );
}

/** Whose sign-in page an AI Provider's subscription uses. */
const signInPageOf = (aiProvider: string): string =>
  aiProvider === "Grok"
    ? "xAI"
    : aiProvider === "ChatGPT"
      ? "OpenAI"
      : aiProvider === "Gemini"
        ? "Google"
        : aiProvider;

/**
 * Whether its sign-in ends on its CLI's local callback (ChatGPT's
 * `localhost:1455`). AI Office serves it while the sign-in waits, so a
 * browser on the same machine finishes it by itself; elsewhere the page
 * does not load, and the Owner pastes back its address, which holds the
 * code.
 */
const pastesAddress = (aiProvider: string): boolean => aiProvider === "ChatGPT";

/** How often a sign-in AI Office may finish itself is asked after. */
export const callbackPollMs = 2000;

/**
 * The second half of a subscription's sign-in: open the AI Provider's page,
 * sign in, and paste back the code it shows (or the address it ends on).
 */
function LoginSteps({
  login,
  label,
  aiProvider,
  csrfToken,
  onDone,
  onCancel,
}: {
  login: OAuthLogin;
  /** Whose sign-in page it is. */
  aiProvider: string;
  /** Names the form, such as "Sign in to Claude Max". */
  label: string;
  csrfToken: string | undefined;
  onDone: (account: AiAccount) => Promise<void>;
  onCancel: () => void;
}) {
  const [problems, setProblems] = useState<string[]>([]);
  const {
    register,
    handleSubmit,
    formState: { isSubmitting },
  } = useForm<{ code: string }>({ defaultValues: { code: "" } });
  const id = `oauth-${login.loginId}`;
  // A device login is approved on the AI Provider's page: nothing to paste.
  const device = login.userCode !== undefined;
  const page = signInPageOf(aiProvider);
  const address = pastesAddress(aiProvider);
  const hostname = location.hostname();
  // Served from another host, the callback page on localhost cannot load.
  const onThisComputer = isLocalhost(hostname);
  /** Whether a sign-in finished on its callback was handed on. */
  const handed = useRef(false);

  // A sign-in AI Office may finish on its own callback: asked after, until
  // it is done or the Owner pastes the address.
  const finished = useQuery({
    queryKey: ["ai-accounts", "oauth", login.loginId],
    queryFn: () =>
      getJson(
        `/api/ai-accounts/oauth/${encodeURIComponent(login.loginId)}`,
        oauthLoginStatusSchema,
      ),
    enabled: address && !device,
    refetchInterval: (query) =>
      query.state.data?.status === "done" || query.state.status === "error"
        ? false
        : callbackPollMs,
    retry: false,
  });
  const done = finished.data?.status === "done" ? finished.data : undefined;
  useEffect(() => {
    if (done !== undefined && !handed.current) {
      handed.current = true;
      void onDone(done.account);
    }
  }, [done, onDone]);

  const onSubmit = async (values: { code: string }) => {
    const parsed = completeOAuthLoginRequestSchema.safeParse(
      device ? {} : values,
    );
    if (!parsed.success) {
      setProblems(parsed.error.issues.map(({ message }) => message));
      return;
    }
    const response = await postJson(
      `/api/ai-accounts/oauth/${encodeURIComponent(login.loginId)}`,
      parsed.data,
      csrfToken,
    );
    if (!response.ok) {
      setProblems(await problemsOf(response, "The sign-in did not finish."));
      return;
    }
    await onDone(aiAccountSchema.parse(await response.json()));
  };

  return (
    <form
      noValidate
      aria-label={label}
      className="w-full space-y-3 rounded-md border p-3"
      onSubmit={(event) => void handleSubmit(onSubmit)(event)}
    >
      <ol className="list-decimal space-y-2 pl-5 text-sm">
        <li>
          <a
            href={login.authorizeUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex items-center gap-1 font-medium underline underline-offset-4"
          >
            Open {page}&apos;s sign-in page
            <ExternalLink aria-hidden className="size-3.5" />
          </a>
          , sign in to the account and allow access.
        </li>
        {device ? (
          <li>
            Check that the page shows the code{" "}
            <code className="font-mono font-medium">{login.userCode}</code>,
            approve it, then finish signing in here before it expires.
          </li>
        ) : address && onThisComputer ? (
          <li>
            Your browser then opens a page on <code>localhost:1455</code>. If AI
            Office runs on this computer, that page says you are signed in and
            this finishes by itself. If the page does not load (AI Office runs
            elsewhere), copy its whole address and paste it here, before the
            sign-in expires.
          </li>
        ) : address ? (
          <li>
            Your browser then opens a page on <code>localhost:1455</code> that
            does not load (&ldquo;This site can&apos;t be reached&rdquo;). That
            is expected: OpenAI only returns to <code>localhost</code>, and AI
            Office runs on <code>{hostname}</code>, not this computer. Copy the
            whole address from the browser&apos;s address bar (it starts{" "}
            <code>http://localhost:1455/auth/callback?code=</code>) and paste it
            here, before the sign-in expires.
          </li>
        ) : (
          <li>Paste the code the page shows, before it expires.</li>
        )}
      </ol>
      {!device && (
        <Field
          id={`${id}-code`}
          label={address ? "Address the sign-in ended on" : "Sign-in code"}
        >
          <Input
            id={`${id}-code`}
            type="password"
            autoComplete="off"
            spellCheck={false}
            {...register("code")}
          />
        </Field>
      )}
      <Problems problems={problems} />
      <div className="flex gap-2">
        <Button
          pending={isSubmitting}
          type="submit"
          size="sm"
          disabled={isSubmitting || csrfToken === undefined}
        >
          {isSubmitting ? "Signing in…" : "Finish signing in"}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/**
 * A subscription's token health (FR-36), as a short badge. Its lifetime is
 * the AI Provider's (Claude's about eight hours); it is renewed ahead of
 * expiry, so "valid until" is not when the account stops.
 */
function TokenHealthBadge({ account }: { account: AiAccount }) {
  if (account.tokenHealth === null) {
    return null;
  }
  const until =
    account.tokenExpiresAt === null
      ? ""
      : new Date(account.tokenExpiresAt).toLocaleString();
  const [text, tone]: [string, BadgeTone] = account.reauthenticationNeeded
    ? [
        account.tokenHealth === "expired"
          ? "Sign in again: token expired"
          : `Sign in again: token expires ${until}`,
        "danger",
      ]
    : account.tokenHealth === "valid"
      ? [
          // Renewed with its refresh token ahead of expiry, each time.
          `Token valid until ${until} · renews automatically`,
          "success",
        ]
      : account.tokenHealth === "expiring"
        ? [`Token expiring ${until} · renewing`, "warning"]
        : ["Token expired", "danger"];
  return <Badge tone={tone}>{text}</Badge>;
}

/**
 * Why the AI Gateway is holding an account back, and until when (FR-39):
 * rate-limited, overloaded or failing.
 */
function LimitBadge({ account }: { account: AiAccount }) {
  if (account.limitReason === null || account.limitedUntil === null) {
    return null;
  }
  return (
    <Badge tone="warning">
      {aiAccountLimitReasonLabels[account.limitReason]} until{" "}
      {new Date(account.limitedUntil).toLocaleString()}
    </Badge>
  );
}

/** Each usage window, with the account's state and threshold for it. */
const windowsOf = (
  account: AiAccount,
): {
  window: UsageWindow;
  state: UsageWindowState | null;
  threshold: number | null;
}[] => [
  {
    window: "five_hour",
    state: account.usage.fiveHour,
    threshold: account.fiveHourPauseThreshold,
  },
  {
    window: "weekly",
    state: account.usage.weekly,
    threshold: account.weeklyPauseThreshold,
  },
];

/**
 * Whether its AI Provider can be asked for its usage windows at any time:
 * a Claude subscription's, as Claude Code's `/usage` reads them, and a
 * ChatGPT subscription's, as Codex's `/status` does.
 */
const usageReadable = (account: AiAccount): boolean =>
  ["Claude", "ChatGPT"].includes(account.aiProvider) &&
  account.accountType === "oauth";

/** The time now, ticking each minute, for what moves with it. */
export function useNow(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const tick = setInterval(() => {
      setNow(new Date());
    }, 60 * 1000);
    return () => {
      clearInterval(tick);
    };
  }, []);
  return now;
}

/**
 * How far through a window `now` is, as a percentage: where an even pace
 * would have its usage. Undefined while none is running, or once the
 * window has reset unreported.
 */
const paceOf = (
  window: UsageWindow,
  state: UsageWindowState,
  now: Date,
): number | undefined => {
  if (state.resetsAt === null) {
    return undefined;
  }
  const length = usageWindowLengthsMs[window];
  const left = new Date(state.resetsAt).getTime() - now.getTime();
  if (left <= 0) {
    return undefined;
  }
  return Math.max(0, Math.min(100, ((length - left) / length) * 100));
};

/** A percentage as the summary shows it: "36.4%". */
const percent = (value: number): string =>
  `${String(Math.round(value * 10) / 10)}%`;

/**
 * One usage window as a full-width bar (FR-36): how much is used, a line
 * where an even pace from its start to its reset would be by now, and a
 * dashed one where the account pauses.
 */
export function UsageBar({
  window,
  state,
  threshold,
  now,
  label = `${usageWindowLabels[window]} window used`,
}: {
  window: UsageWindow;
  state: UsageWindowState;
  threshold: number | null;
  now: Date;
  /** The meter's name, where the window alone is not enough to tell it. */
  label?: string;
}) {
  const used = Math.min(100, state.utilization);
  const pace = paceOf(window, state, now);
  const ahead = pace !== undefined && state.utilization > pace;
  return (
    <div className="relative py-1">
      <span
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={used}
        aria-valuetext={
          pace === undefined
            ? `${percent(state.utilization)} used`
            : `${percent(state.utilization)} used; an even pace would be ${percent(pace)}`
        }
        className="block h-2 w-full overflow-hidden rounded-full bg-muted"
      >
        <span
          className={`block h-full rounded-full transition-[width] duration-300 motion-reduce:transition-none ${
            ahead ? "bg-tone-warning-foreground" : "bg-primary"
          }`}
          style={{ width: `${String(used)}%` }}
        />
      </span>
      {threshold !== null && (
        <span
          aria-hidden
          className="absolute inset-y-0 border-l border-dashed border-destructive"
          style={{ left: `${String(threshold)}%` }}
        />
      )}
      {pace !== undefined && (
        <span
          aria-hidden
          title={`Even pace: ${percent(pace)} by now`}
          className="absolute inset-y-0 w-0.5 -translate-x-1/2 rounded-full bg-foreground"
          style={{ left: `${String(pace)}%` }}
        />
      )}
    </div>
  );
}

/**
 * An account's usage windows as its AI Provider last reported them, and
 * where it pauses (FR-36): "5-hour: 82%, resets 14:00 · pauses at 80%",
 * over a full-width bar marking where an even pace would be by now.
 * A Claude or ChatGPT subscription always shows both.
 */
function UsageSummary({ account }: { account: AiAccount }) {
  const now = useNow();
  const shown = windowsOf(account).filter(
    ({ state, threshold }) =>
      state !== null || threshold !== null || usageReadable(account),
  );
  if (shown.length === 0) {
    return null;
  }
  return (
    <ul aria-label={`${account.name}'s usage`} className="space-y-2">
      {shown.map(({ window, state, threshold }) => {
        const pace = state === null ? undefined : paceOf(window, state, now);
        return (
          <li key={window} className="space-y-1">
            <p className="flex flex-wrap items-baseline justify-between gap-x-3">
              <span>
                <span className="font-medium text-foreground">
                  {usageWindowLabels[window]}:
                </span>
                {state === null ? (
                  <span className="ml-1">not reported</span>
                ) : (
                  <span className="ml-1 tabular-nums">
                    {percent(state.utilization)},{" "}
                    {state.resetsAt === null
                      ? "not started"
                      : `resets ${new Date(state.resetsAt).toLocaleString()}`}
                  </span>
                )}
              </span>
              <span className="tabular-nums">
                {[
                  pace === undefined ? undefined : `even pace ${percent(pace)}`,
                  threshold === null
                    ? undefined
                    : `pauses at ${String(threshold)}%`,
                ]
                  .filter((part) => part !== undefined)
                  .join(" · ")}
              </span>
            </p>
            {state !== null && (
              <UsageBar
                window={window}
                state={state}
                threshold={threshold}
                now={now}
              />
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** How far back an account's charts go, an hour at a time: a week. */
const chartHours = 7 * 24;

/**
 * The hours an account's charts cover, as of `now`: whole hours (UTC),
 * ending with the current one, as Analytics cuts them.
 */
export function chartRange(now: Date): { from: string; to: string } {
  const end = new Date(now);
  end.setUTCMinutes(60, 0, 0);
  return {
    from: new Date(end.getTime() - chartHours * 3_600_000).toISOString(),
    to: end.toISOString(),
  };
}

// Numbers as Analytics says them.
const compactFormat = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});
const compact = (value: number): string => compactFormat.format(value);

/** One of an account's charts, titled, as Analytics draws its own. */
function AccountChart({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section className="min-w-0 space-y-2 rounded-lg border p-3">
      <h4 className="text-sm font-medium text-foreground">{title}</h4>
      <p className="text-xs text-muted-foreground">{description}</p>
      {children}
    </section>
  );
}

/**
 * An account's usage over the last week (FR-43), as line charts in
 * Analytics' style, each with its table: what the AI Gateway sent through
 * it an hour at a time (from its own request history, so every account
 * has them, an API key's too), and, where its AI Provider reports them,
 * the share of each usage window used. Then each reported change of its
 * windows, as it was read.
 */
function UsageHistory({ account }: { account: AiAccount }) {
  const [range] = useState(() => chartRange(new Date()));
  const traffic = useQuery({
    queryKey: ["ai-accounts", account.id, "series", range.from, range.to],
    queryFn: () =>
      getJson(
        `/api/analytics/series?${new URLSearchParams({
          ...range,
          bucket: "hour",
          aiAccountId: account.id,
        }).toString()}`,
        analyticsSeriesSchema,
      ),
  });
  const history = useQuery({
    queryKey: ["ai-accounts", account.id, "usage"],
    queryFn: async () =>
      (await getJson(`${accountUrl(account)}/usage`, usageHistorySchema)).usage,
  });
  const points = traffic.data?.points ?? [];
  const times = points.map(({ at }) => at);
  return (
    <div className="space-y-3">
      {traffic.isError ? (
        <p role="alert" className="text-sm text-destructive">
          Its requests could not be charted.
        </p>
      ) : traffic.data === undefined ? null : (
        <div className="grid gap-3 xl:grid-cols-2">
          <AccountChart
            title="Tokens"
            description={`Through the Gateway each hour, the last week: input and output (what Token Caps count), and cache reads. ${compact(traffic.data.totals.tokens)} input and output in all.`}
          >
            <TimeChart
              label={`${account.name}'s tokens`}
              times={times}
              bucket="hour"
              kind="lines"
              format={compact}
              series={[
                {
                  key: "tokens",
                  label: "Input and output",
                  color: "var(--viz-series-1)",
                  values: points.map(({ tokens }) => tokens),
                },
                {
                  key: "cache-reads",
                  label: "Cache reads",
                  color: "var(--viz-series-2)",
                  values: points.map(({ cacheReadTokens }) => cacheReadTokens),
                },
              ]}
            />
          </AccountChart>
          <AccountChart
            title="Requests"
            description={`Through the Gateway each hour, the last week, and those that failed. ${compact(traffic.data.totals.requests)} in all.`}
          >
            <TimeChart
              label={`${account.name}'s requests`}
              times={times}
              bucket="hour"
              kind="lines"
              format={compact}
              series={[
                {
                  key: "requests",
                  label: "Requests",
                  color: "var(--viz-series-1)",
                  values: points.map(({ requests }) => requests),
                },
                {
                  key: "errors",
                  label: "Failed",
                  color: "var(--viz-series-2)",
                  values: points.map(({ errors }) => errors),
                },
              ]}
            />
          </AccountChart>
        </div>
      )}
      {history.isError ? (
        <p role="alert" className="text-sm text-destructive">
          The usage history could not be loaded.
        </p>
      ) : history.data === undefined ? null : history.data.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No usage window reported in the last week.
          {account.accountType === "oauth"
            ? ""
            : " Its AI Provider reports none for this kind of account; its tokens and requests are charted above."}
        </p>
      ) : (
        <>
          {times.length > 0 && (
            <AccountChart
              title="Usage windows"
              description={`The share of each window ${account.aiProvider} reported used, the highest reading each hour, the last week.`}
            >
              <TimeChart
                label={`${account.name}'s usage windows`}
                times={times}
                bucket="hour"
                kind="lines"
                connectGaps
                max={100}
                format={(value) => `${String(Math.round(value))}%`}
                series={usageWindowSeries(history.data, times)}
              />
            </AccountChart>
          )}
          <table
            aria-label={`${account.name}'s usage history`}
            className="w-full text-left text-sm"
          >
            <thead>
              <tr className="text-muted-foreground">
                <th className="font-normal">When</th>
                <th className="font-normal">Window</th>
                <th className="font-normal">Used</th>
                <th className="font-normal">Resets</th>
              </tr>
            </thead>
            <tbody>
              {history.data.map((reading) => (
                <tr key={`${reading.window}-${reading.observedAt}`}>
                  <td>{new Date(reading.observedAt).toLocaleString()}</td>
                  <td>{usageWindowLabels[reading.window]}</td>
                  <td>{reading.utilization}%</td>
                  <td>{new Date(reading.resetsAt).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}

interface EditValues {
  name: string;
  priority: string;
  fiveHourPauseThreshold: string;
  weeklyPauseThreshold: string;
  forcedModel: string;
  extraUsage: boolean;
}

/** A threshold field's value: a number, or null when left empty. */
const thresholdOf = (value: string): number | null =>
  value.trim() === "" ? null : Number(value);

/**
 * Renames and reprioritises one account, sets its pause thresholds, forces
 * a Model and, where its AI Provider offers it, turns extra usage on or
 * off (FR-41).
 */
function EditForm({
  account,
  csrfToken,
  onDone,
}: {
  account: AiAccount;
  csrfToken: string | undefined;
  onDone: () => Promise<void>;
}) {
  const [problems, setProblems] = useState<string[]>([]);
  const {
    register,
    handleSubmit,
    formState: { dirtyFields, isSubmitting },
  } = useForm<EditValues>({
    defaultValues: {
      name: account.name,
      priority: String(account.priority),
      fiveHourPauseThreshold:
        account.fiveHourPauseThreshold === null
          ? ""
          : String(account.fiveHourPauseThreshold),
      weeklyPauseThreshold:
        account.weeklyPauseThreshold === null
          ? ""
          : String(account.weeklyPauseThreshold),
      forcedModel: account.forcedModel ?? "",
      extraUsage: account.extraUsage === true,
    },
  });

  const onSubmit = async (values: EditValues) => {
    const parsed = aiAccountUpdateSchema.safeParse({
      ...(dirtyFields.name === true ? { name: values.name } : {}),
      ...(dirtyFields.priority === true
        ? { priority: Number(values.priority) }
        : {}),
      ...(dirtyFields.fiveHourPauseThreshold === true
        ? {
            fiveHourPauseThreshold: thresholdOf(values.fiveHourPauseThreshold),
          }
        : {}),
      ...(dirtyFields.weeklyPauseThreshold === true
        ? { weeklyPauseThreshold: thresholdOf(values.weeklyPauseThreshold) }
        : {}),
      ...(dirtyFields.forcedModel === true
        ? {
            forcedModel:
              values.forcedModel.trim() === "" ? null : values.forcedModel,
          }
        : {}),
      ...(dirtyFields.extraUsage === true
        ? { extraUsage: values.extraUsage }
        : {}),
    });
    if (!parsed.success) {
      setProblems(parsed.error.issues.map(({ message }) => message));
      return;
    }
    const response = await sendJson(
      "PATCH",
      accountUrl(account),
      parsed.data,
      csrfToken,
    );
    if (!response.ok) {
      setProblems(
        await problemsOf(response, "The AI Account was not changed."),
      );
      return;
    }
    aiAccountSchema.parse(await response.json());
    await onDone();
  };

  const id = `ai-account-${account.id}`;
  return (
    <form
      noValidate
      aria-label={`Edit ${account.name}`}
      className="w-full space-y-3"
      onSubmit={(event) => void handleSubmit(onSubmit)(event)}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field id={`${id}-name`} label="Name">
          <Input id={`${id}-name`} autoComplete="off" {...register("name")} />
        </Field>
        <Field
          id={`${id}-priority`}
          label="Priority"
          hint={`From ${String(minAiAccountPriority)} to ${String(maxAiAccountPriority)}; 1 is used first.`}
        >
          <Input
            id={`${id}-priority`}
            type="number"
            min={minAiAccountPriority}
            max={maxAiAccountPriority}
            aria-describedby={`${id}-priority-hint`}
            {...register("priority")}
          />
        </Field>
        {(
          [
            ["fiveHourPauseThreshold", "five_hour"],
            ["weeklyPauseThreshold", "weekly"],
          ] as const
        ).map(([field, window]) => (
          <Field
            key={field}
            id={`${id}-${field}`}
            label={`Pause at (% of the ${usageWindowLabels[window].toLowerCase()} window)`}
            hint={`From ${String(minPauseThreshold)} to ${String(maxPauseThreshold)}; empty never pauses. It applies where the AI Provider reports the window.`}
          >
            <Input
              id={`${id}-${field}`}
              type="number"
              min={minPauseThreshold}
              max={maxPauseThreshold}
              aria-describedby={`${id}-${field}-hint`}
              {...register(field)}
            />
          </Field>
        ))}
        <Field
          id={`${id}-forcedModel`}
          label="Forced Model"
          hint={`Every request it serves is sent this ${account.aiProvider} Model, whatever was asked for. Empty sends the Model asked for, or as the model mappings map it.`}
        >
          <Input
            id={`${id}-forcedModel`}
            autoComplete="off"
            spellCheck={false}
            placeholder="None"
            aria-describedby={`${id}-forcedModel-hint`}
            {...register("forcedModel")}
          />
        </Field>
      </div>
      {account.extraUsage !== null && (
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            className="mt-1"
            aria-describedby={`${id}-extraUsage-hint`}
            {...register("extraUsage")}
          />
          <span>
            <span className="font-medium">
              Extra usage: go on past the plan&apos;s limits
            </span>
            <span
              id={`${id}-extraUsage-hint`}
              className="block text-muted-foreground"
            >
              {account.aiProvider} bills extra usage on top of the plan, where
              it is turned on in your {account.aiProvider} account. Off, the AI
              Gateway stops using this account when a usage window is full, or
              it is served on extra usage, until the plan&apos;s limit resets.
            </span>
          </span>
        </label>
      )}
      <Problems problems={problems} />
      <div className="flex gap-2">
        <Button
          pending={isSubmitting}
          type="submit"
          size="sm"
          disabled={isSubmitting || csrfToken === undefined}
        >
          {isSubmitting ? "Saving…" : "Save"}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => void onDone()}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}

/**
 * Where an account stands, as its box's left border shows it: failing
 * (it must be signed in to again, its token has expired, or the AI
 * Gateway has stopped trying it), paused, or else enabled.
 */
export type AccountStatus = "enabled" | "paused" | "error";

export const accountStatusOf = (account: AiAccount): AccountStatus =>
  account.reauthenticationNeeded ||
  account.tokenHealth === "expired" ||
  account.limitReason === "circuit_open"
    ? "error"
    : account.paused
      ? "paused"
      : "enabled";

/** Each status's left border, in the theme's tones (dark mode included). */
const statusBorders: Record<AccountStatus, string> = {
  enabled: "border-l-tone-success-foreground",
  paused: "border-l-tone-warning-foreground",
  error: "border-l-tone-danger-foreground",
};

/**
 * The accounts grouped by AI Provider, each group in priority order (0
 * first). The groups go in the order of their first account, so the one
 * the AI Gateway tries first is at the top; a tie goes by the AI
 * Providers' own order.
 */
export function accountGroupsOf(
  accounts: readonly AiAccount[],
): { aiProvider: string; accounts: AiAccount[] }[] {
  const groups = new Map<string, AiAccount[]>();
  for (const account of [...accounts].sort((a, b) => a.priority - b.priority)) {
    groups.set(account.aiProvider, [
      ...(groups.get(account.aiProvider) ?? []),
      account,
    ]);
  }
  const rank = (aiProvider: string): number => {
    const at = (aiProviders as readonly string[]).indexOf(aiProvider);
    return at < 0 ? aiProviders.length : at;
  };
  return [...groups]
    .map(([aiProvider, each]) => ({ aiProvider, accounts: each }))
    .sort(
      (a, b) =>
        (a.accounts[0]?.priority ?? 0) - (b.accounts[0]?.priority ?? 0) ||
        rank(a.aiProvider) - rank(b.aiProvider),
    );
}

/** One account in the list, with its actions. */
function AccountRow({
  account,
  csrfToken,
  onChanged,
  reauthenticate,
  highlighted = false,
}: {
  account: AiAccount;
  csrfToken: string | undefined;
  onChanged: () => Promise<void>;
  /** Brought up to sign in again, as a Notice's action asks. */
  reauthenticate: boolean;
  /** Brought up as one of an AI Provider's accounts, as a Notice asks. */
  highlighted?: boolean;
}) {
  const [mode, setMode] = useState<"show" | "edit" | "delete">("show");
  const [showHistory, setShowHistory] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problems, setProblems] = useState<string[]>([]);
  const [login, setLogin] = useState<OAuthLogin>();
  const [signedIn, setSignedIn] = useState(false);
  const item = useRef<HTMLLIElement>(null);
  const kind = aiAccountKindOf(account);

  useEffect(() => {
    if (reauthenticate || highlighted) {
      item.current?.scrollIntoView({ block: "center" });
    }
  }, [reauthenticate, highlighted]);

  const startSignIn = async () => {
    setBusy(true);
    setProblems([]);
    setSignedIn(false);
    const response = await postJson(
      `${accountUrl(account)}/reauthenticate`,
      {},
      csrfToken,
    );
    if (response.ok) {
      setLogin(oauthLoginSchema.parse(await response.json()));
    } else {
      setProblems(await problemsOf(response, "The sign-in did not start."));
    }
    setBusy(false);
  };

  const act = async (send: () => Promise<Response>, fallback: string) => {
    setBusy(true);
    setProblems([]);
    const response = await send();
    if (response.ok) {
      await onChanged();
    } else {
      setProblems(await problemsOf(response, fallback));
    }
    setBusy(false);
  };

  const togglePause = () =>
    act(
      () =>
        sendJson(
          "PATCH",
          accountUrl(account),
          { paused: !account.paused },
          csrfToken,
        ),
      account.paused
        ? "The AI Account was not resumed."
        : "The AI Account was not paused.",
    );

  const remove = () =>
    act(
      () => sendDelete(accountUrl(account), csrfToken),
      "The AI Account was not deleted.",
    );

  // Its usage windows, read now from its AI Provider.
  const refreshUsage = () =>
    act(
      () => postJson(`${accountUrl(account)}/refresh-usage`, {}, csrfToken),
      "Its usage could not be read.",
    );

  // Force-reset (FR-36): the AI Gateway uses it again at once.
  const resetLimits = () =>
    act(
      () => postJson(`${accountUrl(account)}/reset-limits`, {}, csrfToken),
      "Its limits were not reset.",
    );
  const resettable =
    account.limitReason !== null ||
    (account.usage.fiveHour?.resetsAt ?? null) !== null ||
    (account.usage.weekly?.resetsAt ?? null) !== null;

  const status = accountStatusOf(account);

  return (
    <li
      ref={item}
      aria-label={account.name}
      aria-current={reauthenticate || highlighted ? "true" : undefined}
      data-status={status}
      className={`flex flex-wrap items-center gap-2 rounded-lg border border-l-4 p-3 ${statusBorders[status]}`}
    >
      {/* Full width, so its actions always sit directly below it. */}
      <div className="w-full space-y-0.5 text-sm">
        <p className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{account.name}</span>
          <Badge tone={account.paused ? "neutral" : "indigo"}>
            {account.paused ? "Paused" : "Active"}
          </Badge>
          <TokenHealthBadge account={account} />
          <LimitBadge account={account} />
        </p>
        <p className="text-muted-foreground">
          {subscriptionPlanOf(account)?.label ??
            kind?.label ??
            `${account.aiProvider} (${account.accountType})`}{" "}
          · Priority {account.priority}
          {account.endpointUrl !== null && (
            <>
              {" "}
              · <span className="font-mono">{account.endpointUrl}</span>
            </>
          )}
          {account.region !== null && (
            <>
              {" "}
              · Region <span className="font-mono">{account.region}</span>
            </>
          )}
          {account.projectId !== null && (
            <>
              {" "}
              · Project <span className="font-mono">{account.projectId}</span>
            </>
          )}
          {kind?.servesOnly != null && <> · Serves only {kind.servesOnly}</>}
          {account.forcedModel !== null && (
            <>
              {" "}
              · Always sent{" "}
              <span className="font-mono">{account.forcedModel}</span>
            </>
          )}
          {account.extraUsage !== null && (
            <> · Extra usage {account.extraUsage ? "on" : "off"}</>
          )}
        </p>
      </div>
      {mode === "show" && (
        <div className="flex flex-wrap gap-2">
          {account.accountType === "oauth" && (
            <Button
              size="sm"
              variant={
                account.reauthenticationNeeded || reauthenticate
                  ? "default"
                  : "outline"
              }
              disabled={busy || csrfToken === undefined}
              aria-label={`Sign in to ${account.name} again`}
              onClick={() => void startSignIn()}
            >
              <KeyRound aria-hidden />
              Re-authenticate
            </Button>
          )}
          {(usageReadable(account) || balanceReadable(account)) && (
            <Button
              size="sm"
              variant="outline"
              disabled={busy || csrfToken === undefined}
              aria-label={`Refresh ${account.name}'s usage`}
              onClick={() => void refreshUsage()}
            >
              <Gauge aria-hidden />
              Refresh usage
            </Button>
          )}
          {resettable && (
            <Button
              size="sm"
              variant="outline"
              disabled={busy || csrfToken === undefined}
              aria-label={`Reset ${account.name}'s limits`}
              onClick={() => void resetLimits()}
            >
              <RotateCcw aria-hidden />
              Reset limits
            </Button>
          )}
          <Button
            size="sm"
            variant="outline"
            aria-expanded={showHistory}
            aria-label={`${account.name}'s usage history`}
            onClick={() => {
              setShowHistory(!showHistory);
            }}
          >
            <History aria-hidden />
            Usage history
          </Button>
          <Button
            size="sm"
            variant="outline"
            aria-label={`Edit ${account.name}`}
            onClick={() => {
              setMode("edit");
            }}
          >
            <Pencil aria-hidden />
            Edit
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={busy || csrfToken === undefined}
            aria-label={`${account.paused ? "Resume" : "Pause"} ${account.name}`}
            onClick={() => void togglePause()}
          >
            {account.paused ? <Play aria-hidden /> : <Pause aria-hidden />}
            {account.paused ? "Resume" : "Pause"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            aria-label={`Delete ${account.name}`}
            onClick={() => {
              setMode("delete");
            }}
          >
            <Trash2 aria-hidden />
            Delete
          </Button>
        </div>
      )}
      {mode === "delete" && (
        <div className="flex w-full flex-wrap items-center gap-2">
          <p className="w-full text-sm font-medium">
            Delete {account.name}? The AI Gateway stops using it at once, and
            its key is gone for good.
          </p>
          <Button
            size="sm"
            variant="destructive"
            disabled={busy || csrfToken === undefined}
            onClick={() => void remove()}
          >
            Yes, delete {account.name}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setMode("show");
            }}
          >
            Cancel
          </Button>
        </div>
      )}
      {mode === "edit" && (
        <EditForm
          account={account}
          csrfToken={csrfToken}
          onDone={async () => {
            await onChanged();
            setMode("show");
          }}
        />
      )}
      {login !== undefined && (
        <LoginSteps
          login={login}
          label={`Sign in to ${account.name}`}
          aiProvider={account.aiProvider}
          csrfToken={csrfToken}
          onDone={async () => {
            setLogin(undefined);
            setSignedIn(true);
            await onChanged();
          }}
          onCancel={() => {
            setLogin(undefined);
          }}
        />
      )}
      <div className="w-full text-sm text-muted-foreground">
        <UsageSummary account={account} />
        <AccountUsageBars account={account} />
      </div>
      {showHistory && (
        <div className="w-full">
          <UsageHistory account={account} />
        </div>
      )}
      {signedIn && (
        <p role="status" className="w-full text-sm">
          Signed in to {account.name} again.
        </p>
      )}
      <div className="w-full">
        <Problems problems={problems} />
      </div>
    </li>
  );
}

interface AddValues {
  kind: string;
  name: string;
  credential: string;
  endpointUrl: string;
  /** A cloud platform's region: an AWS region, or a Vertex AI location. */
  region: string;
  /** AWS Bedrock: an IAM access key, or a profile in the server's files. */
  awsAuth: "keys" | "profile";
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  profile: string;
  /** Vertex AI: the key file's contents, and another project, if any. */
  serviceAccount: string;
  projectId: string;
  acceptedTerms: boolean;
  /** For a subscription that can be imported: sign in, or import. */
  how: "sign_in" | "import";
  /** Gemini's: Gemini CLI's Google OAuth client, which it signs in as. */
  clientId: string;
  clientSecret: string;
  /** An imported CLI login's file. */
  login: string;
}

const emptyAddValues: AddValues = {
  kind: "0",
  name: "",
  credential: "",
  endpointUrl: "",
  region: "",
  awsAuth: "keys",
  accessKeyId: "",
  secretAccessKey: "",
  sessionToken: "",
  profile: "",
  serviceAccount: "",
  projectId: "",
  acceptedTerms: false,
  how: "sign_in",
  login: "",
  clientId: "",
  clientSecret: "",
};

/**
 * Where the Owner copies Gemini CLI's Google OAuth client from, which a
 * Gemini subscription signs in as: AI Office's code does not hold it.
 */
const geminiClientSource =
  "https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/code_assist/oauth2.ts";

/** What the Owner is told about a kind's endpoint URL. */
const endpointHintOf = (kind: (typeof aiAccountKinds)[number]): string =>
  kind.defaultEndpointUrl === null
    ? kind.apiFormat === "anthropic"
      ? "Where /v1/messages goes after, as ANTHROPIC_BASE_URL is given. It is sent any Model asked of it."
      : "The API's root, /v1 included, as OPENAI_BASE_URL is given. It is sent any Model asked of it."
    : kind.accountType === "endpoint"
      ? `Optional. Empty uses ${kind.defaultEndpointUrl}, on the AI Office host; from the docker compose stack, Ollama on the host is http://host.docker.internal:11434.`
      : platformOf(kind) === undefined
        ? "Optional. Empty uses the AI Provider's own API."
        : "Optional. Empty uses the platform's own endpoint for the region.";

/** What the Owner is told before adding an AI Provider's subscription. */
const termsWarningOf = (aiProvider: string): string | undefined =>
  (subscriptionTermsWarnings as Readonly<Record<string, string>>)[aiProvider];

/** Where each AI Provider's CLI keeps its login, for an import. */
const importableLogins: Partial<Record<string, string>> = {
  Grok: "~/.grok/auth.json",
  Gemini: "~/.gemini/oauth_creds.json",
};

/** The form's value for a coding plan, beside the kinds' indexes. */
const planValue = (index: number): string => `plan:${String(index)}`;

/**
 * Adds a key-based account (the key is cleared once it is saved), or a
 * subscription through its OAuth login, once the Owner has read the
 * warning about its terms.
 */
function AddForm({
  csrfToken,
  onAdded,
}: {
  csrfToken: string | undefined;
  onAdded: () => Promise<void>;
}) {
  const [problems, setProblems] = useState<string[]>([]);
  const [added, setAdded] = useState<string>();
  const [login, setLogin] = useState<OAuthLogin>();
  const {
    register,
    handleSubmit,
    reset,
    control,
    formState: { isSubmitting },
  } = useForm<AddValues>({ defaultValues: emptyAddValues });
  const chosen = useWatch({ control, name: "kind" });
  // A coding plan is its AI Provider's API key, at the plan's API.
  const plan = chosen.startsWith("plan:")
    ? subscriptionPlans[Number(chosen.slice("plan:".length))]
    : undefined;
  const kind =
    (plan === undefined
      ? aiAccountKinds[Number(chosen)]
      : aiAccountKinds.find(
          (each) =>
            each.aiProvider === plan.aiProvider &&
            each.accountType === "api_key",
        )) ?? aiAccountKinds[0];
  const subscription = kind.accountType === "oauth";
  /** The Owner's own Ollama, or a compatible endpoint: a key only if asked. */
  const endpoint = kind.accountType === "endpoint";
  const platform = platformOf(kind);
  const awsAuth = useWatch({ control, name: "awsAuth" });
  const importable = subscription
    ? importableLogins[kind.aiProvider]
    : undefined;
  const how = useWatch({ control, name: "how" });
  const importing = importable !== undefined && how === "import";
  const signInTo = signInPageOf(kind.aiProvider);
  /** A Gemini subscription: the Owner gives Gemini CLI's Google client. */
  const needsClient = subscription && kind.aiProvider === "Gemini";
  const clientOf = (values: AddValues) =>
    needsClient
      ? {
          client: {
            clientId: values.clientId.trim(),
            clientSecret: values.clientSecret.trim(),
          },
        }
      : {};

  const onSubmit = async (values: AddValues) => {
    setAdded(undefined);
    if (importing) {
      const parsed = importOAuthLoginRequestSchema.safeParse({
        name: values.name,
        aiProvider: kind.aiProvider,
        acceptedTerms: values.acceptedTerms,
        login: values.login,
        ...clientOf(values),
      });
      if (!parsed.success) {
        setProblems(parsed.error.issues.map(({ message }) => message));
        return;
      }
      const response = await postJson(
        "/api/ai-accounts/import",
        parsed.data,
        csrfToken,
      );
      if (!response.ok) {
        setProblems(await problemsOf(response, "The login was not imported."));
        return;
      }
      const account = aiAccountSchema.parse(await response.json());
      setProblems([]);
      // The login leaves the page with the form's values.
      reset(emptyAddValues);
      setAdded(
        `Imported ${account.name}. It serves only ${kind.servesOnly ?? kind.aiProvider}; its tokens are stored encrypted and refreshed before they expire.`,
      );
      await onAdded();
      return;
    }
    if (subscription) {
      const parsed = startOAuthLoginRequestSchema.safeParse({
        name: values.name,
        aiProvider: kind.aiProvider,
        acceptedTerms: values.acceptedTerms,
        ...clientOf(values),
      });
      if (!parsed.success) {
        setProblems(parsed.error.issues.map(({ message }) => message));
        return;
      }
      const response = await postJson(
        "/api/ai-accounts/oauth",
        parsed.data,
        csrfToken,
      );
      if (!response.ok) {
        setProblems(await problemsOf(response, "The sign-in did not start."));
        return;
      }
      setProblems([]);
      setLogin(oauthLoginSchema.parse(await response.json()));
      return;
    }
    const endpointUrl =
      plan === undefined ? values.endpointUrl.trim() : (plan.endpointUrl ?? "");
    const optional = (value: string) =>
      value.trim() === "" ? null : value.trim();
    const common = {
      name: values.name,
      aiProvider: kind.aiProvider,
      accountType: kind.accountType,
      endpointUrl: endpointUrl === "" ? null : endpointUrl,
    };
    const request =
      platform === "bedrock"
        ? {
            ...common,
            region: values.region,
            awsCredentials:
              values.awsAuth === "profile"
                ? { profile: values.profile }
                : {
                    accessKeyId: values.accessKeyId,
                    secretAccessKey: values.secretAccessKey,
                    sessionToken: optional(values.sessionToken),
                  },
          }
        : platform === "vertex"
          ? {
              ...common,
              region: values.region,
              projectId: optional(values.projectId),
              serviceAccount: values.serviceAccount,
            }
          : endpoint
            ? { ...common, credential: optional(values.credential) }
            : { ...common, credential: values.credential };
    const parsed = addAiAccountRequestSchema.safeParse(request);
    if (!parsed.success) {
      setProblems(parsed.error.issues.map(({ message }) => message));
      return;
    }
    // A service account's key goes as the file's text, which the API reads.
    const response = await postJson(
      "/api/ai-accounts",
      platform === "vertex" ? request : parsed.data,
      csrfToken,
    );
    if (!response.ok) {
      setProblems(await problemsOf(response, "The AI Account was not added."));
      return;
    }
    const account = aiAccountSchema.parse(await response.json());
    setProblems([]);
    // The key leaves the page with the form's values.
    reset(emptyAddValues);
    setAdded(
      platform === "bedrock" && values.awsAuth === "profile"
        ? `Added ${account.name}. It signs with the profile's key, read from the server's AWS files each time.`
        : endpoint && optional(values.credential) === null
          ? `Added ${account.name}. It is sent no key.`
          : `Added ${account.name}. ${platform === undefined ? "Its key is" : "Its credentials are"} stored encrypted and will not be shown again.`,
    );
    await onAdded();
  };

  return (
    <div className="space-y-4">
      <form
        noValidate
        aria-label="Add an AI Account"
        className="space-y-4"
        onSubmit={(event) => void handleSubmit(onSubmit)(event)}
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Field id="ai-account-kind" label="Account type">
            <select
              id="ai-account-kind"
              className={selectClass}
              disabled={login !== undefined}
              {...register("kind")}
            >
              {aiAccountKinds.map((option, index) => (
                <option key={option.label} value={String(index)}>
                  {option.label}
                </option>
              ))}
              <optgroup label="Subscription plans, with the plan's key">
                {subscriptionPlans.map((option, index) => (
                  <option key={option.label} value={planValue(index)}>
                    {option.label}
                  </option>
                ))}
              </optgroup>
            </select>
          </Field>
          <Field id="ai-account-name" label="Name">
            <Input
              id="ai-account-name"
              autoComplete="off"
              disabled={login !== undefined}
              {...register("name")}
            />
          </Field>
          {platform !== undefined && (
            <Field
              id="ai-account-region"
              label={platform === "bedrock" ? "AWS region" : "Vertex AI region"}
              hint={
                platform === "bedrock"
                  ? "Where Claude in Amazon Bedrock serves, such as us-east-1."
                  : "global (recommended), us, eu, or a region such as us-east5."
              }
            >
              <Input
                id="ai-account-region"
                autoComplete="off"
                spellCheck={false}
                placeholder={platform === "bedrock" ? "us-east-1" : "global"}
                aria-describedby="ai-account-region-hint"
                {...register("region")}
              />
            </Field>
          )}
          {platform === "vertex" && (
            <Field
              id="ai-account-project"
              label="Google Cloud project ID"
              hint="Optional. Empty uses the service account's own project."
            >
              <Input
                id="ai-account-project"
                autoComplete="off"
                spellCheck={false}
                aria-describedby="ai-account-project-hint"
                {...register("projectId")}
              />
            </Field>
          )}
          {platform === undefined && !subscription && (
            <Field
              id="ai-account-credential"
              label="API key"
              hint={
                endpoint
                  ? "Optional: only if the endpoint asks for one. Stored encrypted, and never shown again, here or anywhere."
                  : plan !== undefined
                    ? `The plan's own key, from ${plan.keyFrom}. Stored encrypted; never shown again, here or anywhere.`
                    : "Stored encrypted. It is never shown again, here or anywhere."
              }
            >
              <Input
                id="ai-account-credential"
                type="password"
                autoComplete="off"
                spellCheck={false}
                aria-describedby="ai-account-credential-hint"
                {...register("credential")}
              />
            </Field>
          )}
          {!subscription && plan === undefined && (
            <Field
              id="ai-account-endpoint"
              label={
                kind.defaultEndpointUrl === null
                  ? "Endpoint URL"
                  : endpoint
                    ? "Server URL"
                    : "Custom endpoint URL"
              }
              hint={endpointHintOf(kind)}
            >
              <Input
                id="ai-account-endpoint"
                type="url"
                autoComplete="off"
                placeholder={
                  kind.defaultEndpointUrl ??
                  (kind.apiFormat === "anthropic"
                    ? "https://llm.example.com/anthropic"
                    : "https://llm.example.com/v1")
                }
                aria-describedby="ai-account-endpoint-hint"
                {...register("endpointUrl")}
              />
            </Field>
          )}
        </div>
        {platform === "bedrock" && (
          <fieldset className="space-y-3">
            <legend className="text-sm font-medium">AWS credentials</legend>
            <div className="space-y-1 text-sm">
              <label className="flex items-center gap-2">
                <input type="radio" value="keys" {...register("awsAuth")} />
                An IAM access key
              </label>
              <label className="flex items-center gap-2">
                <input type="radio" value="profile" {...register("awsAuth")} />A
                profile in the server&apos;s AWS files (~/.aws)
              </label>
            </div>
            {awsAuth === "profile" ? (
              <Field
                id="ai-account-profile"
                label="AWS profile"
                hint="Read from the server's AWS credentials or config file each time, so a rotated key is used at once. Only an access key is read from it: not single sign-on, roles or a credential process."
              >
                <Input
                  id="ai-account-profile"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="default"
                  aria-describedby="ai-account-profile-hint"
                  {...register("profile")}
                />
              </Field>
            ) : (
              <div className="grid gap-4 sm:grid-cols-2">
                <Field id="ai-account-access-key-id" label="Access key ID">
                  <Input
                    id="ai-account-access-key-id"
                    type="password"
                    autoComplete="off"
                    spellCheck={false}
                    {...register("accessKeyId")}
                  />
                </Field>
                <Field
                  id="ai-account-secret-access-key"
                  label="Secret access key"
                  hint="Stored encrypted. It is never shown again, here or anywhere."
                >
                  <Input
                    id="ai-account-secret-access-key"
                    type="password"
                    autoComplete="off"
                    spellCheck={false}
                    aria-describedby="ai-account-secret-access-key-hint"
                    {...register("secretAccessKey")}
                  />
                </Field>
                <Field
                  id="ai-account-session-token"
                  label="Session token"
                  hint="Only for temporary credentials, which stop working when they expire."
                >
                  <Input
                    id="ai-account-session-token"
                    type="password"
                    autoComplete="off"
                    spellCheck={false}
                    aria-describedby="ai-account-session-token-hint"
                    {...register("sessionToken")}
                  />
                </Field>
              </div>
            )}
          </fieldset>
        )}
        {platform === "vertex" && (
          <Field
            id="ai-account-service-account"
            label="Service account key (JSON)"
            hint="Paste the key file's contents from Google Cloud. The service account needs the Vertex AI User role. Stored encrypted; never shown again."
          >
            <textarea
              id="ai-account-service-account"
              rows={4}
              autoComplete="off"
              spellCheck={false}
              aria-describedby="ai-account-service-account-hint"
              className="w-full rounded-md border bg-transparent p-2 font-mono text-xs"
              {...register("serviceAccount")}
            />
          </Field>
        )}
        {plan !== undefined && (
          <p role="note" aria-label="The plan" className="text-sm">
            {plan.terms}
          </p>
        )}
        {subscription && (
          <div className="space-y-3">
            <div
              role="note"
              aria-label="The AI Provider's terms"
              className="rounded-md border border-tone-warning-foreground/40 bg-tone-warning p-3 text-sm text-tone-warning-foreground"
            >
              <p className="font-medium">About the AI Provider&apos;s terms</p>
              <p>{termsWarningOf(kind.aiProvider)}</p>
            </div>
            {importable !== undefined && (
              <fieldset
                className="space-y-1 text-sm"
                disabled={login !== undefined}
              >
                <legend className="font-medium">How to add it</legend>
                <label className="flex items-center gap-2">
                  <input type="radio" value="sign_in" {...register("how")} />
                  Sign in to {signInTo}
                </label>
                <label className="flex items-center gap-2">
                  <input type="radio" value="import" {...register("how")} />
                  Import an existing {kind.aiProvider} CLI login
                </label>
              </fieldset>
            )}
            {needsClient && (
              <div className="grid gap-4 sm:grid-cols-2">
                <p
                  id="ai-account-client-hint"
                  className="text-xs text-muted-foreground sm:col-span-2"
                >
                  A Gemini subscription signs in as Gemini CLI&apos;s Google
                  client. Copy its OAUTH_CLIENT_ID and OAUTH_CLIENT_SECRET from{" "}
                  <a
                    href={geminiClientSource}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="underline underline-offset-4"
                  >
                    Gemini CLI&apos;s source
                  </a>
                  . They are kept, encrypted, with this account only.
                </p>
                <Field id="ai-account-client-id" label="Gemini CLI client ID">
                  <Input
                    id="ai-account-client-id"
                    autoComplete="off"
                    spellCheck={false}
                    disabled={login !== undefined}
                    placeholder="….apps.googleusercontent.com"
                    aria-describedby="ai-account-client-hint"
                    {...register("clientId")}
                  />
                </Field>
                <Field
                  id="ai-account-client-secret"
                  label="Gemini CLI client secret"
                >
                  <Input
                    id="ai-account-client-secret"
                    type="password"
                    autoComplete="off"
                    spellCheck={false}
                    disabled={login !== undefined}
                    aria-describedby="ai-account-client-hint"
                    {...register("clientSecret")}
                  />
                </Field>
              </div>
            )}
            {importing && (
              <Field
                id="ai-account-login"
                label={`${kind.aiProvider} CLI login (${importable})`}
                hint="Paste the file's contents. Its tokens are stored encrypted and never shown again; the CLI's own copy stops working once AI Office refreshes them."
              >
                <textarea
                  id="ai-account-login"
                  rows={4}
                  autoComplete="off"
                  spellCheck={false}
                  aria-describedby="ai-account-login-hint"
                  className="w-full rounded-md border bg-transparent p-2 font-mono text-xs"
                  {...register("login")}
                />
              </Field>
            )}
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                disabled={login !== undefined}
                {...register("acceptedTerms")}
              />
              I have read this, and will use the subscription only through{" "}
              {kind.servesOnly}.
            </label>
          </div>
        )}
        <Problems problems={problems} />
        {added !== undefined && (
          <p role="status" className="text-sm">
            {added}
          </p>
        )}
        {login === undefined && (
          <Button
            type="submit"
            pending={isSubmitting}
            disabled={csrfToken === undefined}
          >
            {importing
              ? isSubmitting
                ? "Importing…"
                : "Import login"
              : subscription
                ? isSubmitting
                  ? "Starting…"
                  : `Sign in to ${signInTo}`
                : isSubmitting
                  ? "Adding…"
                  : "Add AI Account"}
          </Button>
        )}
      </form>
      {login !== undefined && (
        <LoginSteps
          login={login}
          label="Sign in to the subscription"
          aiProvider={kind.aiProvider}
          csrfToken={csrfToken}
          onDone={async (account) => {
            setLogin(undefined);
            reset(emptyAddValues);
            setAdded(
              `Added ${account.name}. It serves only ${kind.servesOnly ?? kind.aiProvider}; its tokens are stored encrypted and refreshed before they expire.`,
            );
            await onAdded();
          }}
          onCancel={() => {
            setLogin(undefined);
          }}
        />
      )}
    </div>
  );
}

/**
 * The AI Accounts section of the office admin (PRD FR-35, FR-36): the
 * accounts the AI Gateway uses, in order, and a form to add one.
 */
export function AiAccountsCard({
  reauthenticate,
  aiProvider,
}: {
  /** The account to bring up to sign in again, from a Notice's action. */
  reauthenticate?: string | undefined;
  /** The AI Provider whose accounts to bring up, from a Notice's action. */
  aiProvider?: string | undefined;
} = {}) {
  const queryClient = useQueryClient();
  // Read again each minute, for subscriptions' usage, which the server
  // reads from their AI Providers every five.
  const accounts = useQuery({ ...aiAccountsQuery, refetchInterval: 60_000 });
  const { data: session } = useQuery(sessionQuery);
  const refresh = () => queryClient.invalidateQueries(aiAccountsQuery);
  // Token health and limits, live: each change the Gateway tells
  // refetches the list.
  useEventStream(
    { types: ["ai_account.token_health", "ai_account.limit_changed"] },
    {
      onEvent: (_event, client) => {
        void client.invalidateQueries(aiAccountsQuery);
      },
    },
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>AI Accounts</h2>
        </CardTitle>
        <CardDescription>
          The AI Gateway serves every Agent&apos;s model calls from these: the
          active account with the lowest priority number first. Sandboxes never
          hold their keys. Each request goes to an account of its Model&apos;s
          AI Provider. A subscription serves only its AI Provider&apos;s agent
          tool (Claude Code for Claude, Codex for ChatGPT, opencode for Grok,
          Gemini and Qwen), and its token is refreshed before it expires. A
          coding plan (Z.ai&apos;s, MiniMax&apos;s, Kimi&apos;s or Qwen&apos;s)
          is added with the plan&apos;s own key. An AWS Bedrock or Google Vertex
          AI account serves Claude Models in its region, signed with its own
          credentials. An Anthropic- or OpenAI-compatible endpoint is sent any
          Model asked of it, and those no AI Provider claims before any other
          account. An account its AI Provider says is rate-limited or
          overloaded, or that keeps failing, is left alone until it can serve
          again.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <section aria-labelledby="ai-accounts-in-use" className="space-y-2">
          <h3 id="ai-accounts-in-use" className="text-sm font-medium">
            Accounts
          </h3>
          {accounts.isError && (
            <p role="alert" className="text-sm text-destructive">
              The AI Accounts could not be loaded.
            </p>
          )}
          {accounts.data?.length === 0 && (
            <p className="text-sm text-muted-foreground">
              No AI Accounts yet. Until one is added, the AI Gateway refuses
              every model call.
            </p>
          )}
          {accounts.data !== undefined && accounts.data.length > 0 && (
            <ul aria-label="AI Accounts" className="divide-y">
              {accountGroupsOf(accounts.data).map((group) => (
                // Unnamed, so an account's name finds the account alone.
                <li
                  key={group.aiProvider}
                  className="space-y-2 py-4 first:pt-0 last:pb-0"
                >
                  <h4 className="text-sm font-semibold">{group.aiProvider}</h4>
                  <ul
                    aria-label={`${group.aiProvider} accounts`}
                    className="space-y-3"
                  >
                    {group.accounts.map((account) => (
                      <AccountRow
                        key={account.id}
                        account={account}
                        csrfToken={session?.csrfToken}
                        onChanged={refresh}
                        reauthenticate={account.id === reauthenticate}
                        highlighted={
                          aiProvider !== undefined &&
                          account.aiProvider === aiProvider
                        }
                      />
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section aria-labelledby="add-an-ai-account" className="space-y-2">
          <h3 id="add-an-ai-account" className="text-sm font-medium">
            Add an AI Account
          </h3>
          <AddForm csrfToken={session?.csrfToken} onAdded={refresh} />
        </section>
      </CardContent>
    </Card>
  );
}
