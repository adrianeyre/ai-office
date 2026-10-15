import {
  rateLimitKindLabels,
  type AiAccount,
  type CreditBalance,
  type RateLimitKind,
  type RateLimitState,
} from "@ai-office/shared";

// The usage bars an AI Account shows beyond a subscription's 5-hour and
// weekly windows (PRD FR-36), the best its AI Provider honestly reports:
// - an API key whose answers carry rate-limit headers (Anthropic, OpenAI,
//   xAI): what is left this minute of its requests and tokens;
// - a prepaid key whose AI Provider gives its balance (OpenRouter,
//   DeepSeek, Kimi): its credit used of its limit, or what is left;
// - anything else (Ollama, compatible endpoints, Bedrock, Vertex AI, and
//   AI Providers that report nothing): its share of the AI Gateway's tokens
//   today, labelled as such so it is never taken for a limit.

/**
 * The AI Providers whose API key's balance AI Office reads (the server's
 * `limits/balances.ts`): its usage can be refreshed now.
 */
export const balanceReadable = (account: AiAccount): boolean =>
  account.accountType === "api_key" &&
  ["OpenRouter", "DeepSeek", "Kimi"].includes(account.aiProvider);

const numbers = new Intl.NumberFormat("en-GB");
const compact = new Intl.NumberFormat("en-GB", {
  notation: "compact",
  maximumFractionDigits: 1,
});

const money = (amount: number, currency: string): string => {
  try {
    return new Intl.NumberFormat("en-GB", {
      style: "currency",
      currency,
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
};

/** A percentage, never over 100 or under 0. */
const share = (part: number, whole: number): number =>
  whole <= 0 ? 0 : Math.max(0, Math.min(100, (part / whole) * 100));

/** One labelled full-width bar, as the usage windows draw theirs. */
function Bar({
  label,
  detail,
  percent,
  valueText,
}: {
  label: string;
  detail: string;
  percent: number;
  valueText: string;
}) {
  return (
    <li className="space-y-1">
      <p className="flex flex-wrap items-baseline justify-between gap-x-3">
        <span className="font-medium text-foreground">{label}:</span>
        <span className="tabular-nums">{detail}</span>
      </p>
      <span
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(percent)}
        aria-valuetext={valueText}
        className="block h-2 w-full overflow-hidden rounded-full bg-muted"
      >
        <span
          className="block h-full rounded-full bg-primary"
          style={{ width: `${String(percent)}%` }}
        />
      </span>
    </li>
  );
}

const leftLabels: Record<RateLimitKind, string> = {
  requests: "Requests left this minute",
  tokens: "Tokens left this minute",
  inputTokens: "Input tokens left this minute",
  outputTokens: "Output tokens left this minute",
};

/** One rate limit: what is left of it, until its reset. */
function RateLimitBar({
  kind,
  state,
}: {
  kind: RateLimitKind;
  state: RateLimitState;
}) {
  const left = `${numbers.format(state.remaining)} of ${numbers.format(state.limit)} ${rateLimitKindLabels[kind].toLowerCase()}`;
  return (
    <Bar
      label={leftLabels[kind]}
      detail={
        state.resetsAt === null
          ? left
          : `${left}, full by ${new Date(state.resetsAt).toLocaleTimeString()}`
      }
      percent={share(state.remaining, state.limit)}
      valueText={`${left} left`}
    />
  );
}

/** A prepaid account's credit: used of its limit, or what is left. */
function CreditBar({ balance }: { balance: CreditBalance }) {
  const read = `read ${new Date(balance.observedAt).toLocaleString()}`;
  if (balance.used !== null && balance.limit !== null && balance.limit > 0) {
    const text = `${money(balance.used, balance.currency)} of ${money(balance.limit, balance.currency)} used`;
    return (
      <Bar
        label="Credit used"
        detail={`${text}, ${read}`}
        percent={share(balance.used, balance.limit)}
        valueText={text}
      />
    );
  }
  return (
    <li>
      <span className="font-medium text-foreground">Credit:</span>{" "}
      <span className="tabular-nums">
        {balance.remaining === null
          ? `${money(balance.used ?? 0, balance.currency)} used, no limit`
          : `${money(balance.remaining, balance.currency)} left`}
        , {read}
      </span>
    </li>
  );
}

/** Its share of the AI Gateway's tokens today: not a provider's limit. */
function ShareBar({
  tokensToday,
}: {
  tokensToday: NonNullable<AiAccount["tokensToday"]>;
}) {
  const { tokens, gatewayTokens } = tokensToday;
  const percent = share(tokens, gatewayTokens);
  const text = `${compact.format(tokens)} of the AI Gateway's ${compact.format(gatewayTokens)} tokens today`;
  return (
    <Bar
      label="Share of the AI Gateway's tokens today"
      detail={`${String(Math.round(percent))}% · ${text} (not a limit from its AI Provider)`}
      percent={percent}
      valueText={`${String(Math.round(percent))}%: ${text}`}
    />
  );
}

/** Whether an account reports 5-hour or weekly windows (or always can). */
const hasWindows = (account: AiAccount): boolean =>
  account.usage.fiveHour !== null ||
  account.usage.weekly !== null ||
  account.fiveHourPauseThreshold !== null ||
  account.weeklyPauseThreshold !== null ||
  (account.accountType === "oauth" &&
    ["Claude", "ChatGPT"].includes(account.aiProvider));

/**
 * The bars an account shows beyond its usage windows: its rate limits and
 * its credit where its AI Provider reports them, and otherwise, when it has
 * nothing at all to show, its share of the AI Gateway's tokens today.
 */
export function AccountUsageBars({ account }: { account: AiAccount }) {
  const limits = account.rateLimits;
  const rateLimits =
    limits == null
      ? []
      : (
          ["requests", "tokens", "inputTokens", "outputTokens"] as const
        ).flatMap((kind) => {
          const state = limits[kind];
          return state === null ? [] : [{ kind, state }];
        });
  const balance = account.balance ?? null;
  const fallback =
    rateLimits.length === 0 &&
    balance?.limit == null &&
    !hasWindows(account) &&
    account.tokensToday !== undefined
      ? account.tokensToday
      : undefined;
  if (rateLimits.length === 0 && balance === null && fallback === undefined) {
    return null;
  }
  return (
    <ul
      aria-label={`${account.name}'s limits and credit`}
      className="mt-2 space-y-2"
    >
      {rateLimits.map(({ kind, state }) => (
        <RateLimitBar key={kind} kind={kind} state={state} />
      ))}
      {balance !== null && <CreditBar balance={balance} />}
      {fallback !== undefined && <ShareBar tokensToday={fallback} />}
    </ul>
  );
}
