import {
  defaultTimeZone,
  gatewayKeyAccessLevels,
  gatewayKeyAccessNames,
  gatewayKeySchema,
  gatewayKeyUpdateRequestSchema,
  gatewayKeyUsageListSchema,
  keyProfileSchema,
  type GatewayKey,
  type GatewayKeyAccess,
  type GatewayKeyUsage,
} from "@ai-office/shared";
import { queryOptions, useQuery, useQueryClient } from "@tanstack/react-query";
import { Power, PowerOff, Trash2 } from "lucide-react";
import { useState } from "react";
import { useForm, useWatch } from "react-hook-form";

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
import { PageHeader } from "@/components/ui/page-header.tsx";
import { Badge } from "@/components/ui/badge.tsx";
import { selectClass } from "@/lib/utils.ts";

import { getJson, readApiError, sendDelete, sendJson } from "./api.ts";
import {
  CreateForm,
  gatewayKeysQuery,
  lastUsed,
  Problems,
  problemsIn,
  problemsOf,
} from "./gateway-keys-card.tsx";
import { OwnerPasswords } from "./owner-passwords.tsx";
import { OwnerProofFields, useOwnerProof } from "./owner-proof.tsx";
import { timeZoneLabel, timeZones } from "./time-zones.ts";
import { sessionQuery } from "./session.ts";

// API Key Management: the keys that reach AI Office's AI Gateway (Gateway
// Keys, PRD FR-46), with how many there are and are used, a form to make
// one for a tool, and each key's card: what it is, what its requests have
// used, its name, who uses it (nickname and time zone, British time until
// set) and its access: the AI proxy only, or the AI proxy and the web app
// (UI). One of the Owner's tools' keys can be renamed, disabled, enabled
// again and revoked here; an Agent's goes with its Agent. A change after
// which a key signs in where it did not (UI access given to an enabled
// key, or a key with UI access enabled again) asks for a fresh proof of
// the Owner first (A1-3).

/** What each key's requests added up to (`GET /api/gateway-keys/usage`). */
export const gatewayKeyUsageQuery = queryOptions({
  queryKey: ["gateway-keys", "usage"],
  queryFn: async () =>
    (await getJson("/api/gateway-keys/usage", gatewayKeyUsageListSchema)).usage,
});

const kindNames: Record<GatewayKey["kind"], string> = {
  agent: "Agent",
  communications: "Communications Agent",
  owner_tool: "Your tool",
  terminal: "Terminal",
};

const dayMs = 24 * 60 * 60 * 1000;

/** The keys' counts at a glance. */
function KeyStats({ keys }: { keys: readonly GatewayKey[] }) {
  const [now] = useState(() => Date.now());
  const stats = [
    ["Total keys", keys.length],
    ["Enabled keys", keys.filter(({ enabled }) => enabled).length],
    [
      "Used in the last day",
      keys.filter(
        ({ lastUsedAt }) =>
          lastUsedAt !== null && now - new Date(lastUsedAt).getTime() < dayMs,
      ).length,
    ],
  ] as const;
  return (
    <dl className="grid gap-4 sm:grid-cols-3" aria-label="API keys at a glance">
      {stats.map(([term, value]) => (
        // As compact as the analytics' stat tiles.
        <div key={term} className="rounded-xl border bg-card p-4 shadow-sm">
          <dt className="text-sm text-muted-foreground">{term}</dt>
          <dd className="mt-1 text-2xl font-semibold tabular-nums">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

interface KeyFormValues {
  name: string;
  nickname: string;
  timeZone: string;
  access: GatewayKeyAccess;
}

/**
 * One key's name, who uses it (nickname and time zone) and, for one of the
 * Owner's tools, its access. An Agent's key keeps its Agent's name and
 * only calls models. Giving an enabled key UI access asks for a proof.
 */
function KeyForm({ gatewayKey }: { gatewayKey: GatewayKey }) {
  const queryClient = useQueryClient();
  const { data: session } = useQuery(sessionQuery);
  const proof = useOwnerProof();
  const [problems, setProblems] = useState<string[]>([]);
  const [saved, setSaved] = useState(false);
  const ownerTool = gatewayKey.kind === "owner_tool";
  const valuesOf = (key: GatewayKey): KeyFormValues => ({
    name: key.name,
    nickname: key.profile.nickname,
    timeZone: key.profile.timeZone,
    access: key.access,
  });
  const {
    register,
    handleSubmit,
    reset,
    control,
    formState: { isDirty, isSubmitting, dirtyFields },
  } = useForm<KeyFormValues>({ defaultValues: valuesOf(gatewayKey) });
  const id = (field: string) => `api-key-${gatewayKey.id}-${field}`;
  const access = useWatch({ control, name: "access" });
  // After the change the key signs in, where before it did not.
  const givesUi =
    ownerTool &&
    gatewayKey.enabled &&
    gatewayKey.access !== "proxy_and_ui" &&
    access === "proxy_and_ui";
  const zones = timeZones();
  if (!zones.includes(gatewayKey.profile.timeZone)) {
    zones.push(gatewayKey.profile.timeZone);
  }

  const onSubmit = async (values: KeyFormValues) => {
    setSaved(false);
    const profile = keyProfileSchema.safeParse({
      nickname: values.nickname,
      timeZone: values.timeZone,
    });
    const changes = gatewayKeyUpdateRequestSchema.safeParse({
      ...(dirtyFields.name === true ? { name: values.name } : {}),
      ...(dirtyFields.access === true ? { access: values.access } : {}),
    });
    const issues = [
      ...(profile.error?.issues ?? []),
      ...(ownerTool &&
      (dirtyFields.name === true || dirtyFields.access === true)
        ? (changes.error?.issues ?? [])
        : []),
    ];
    if (!profile.success || issues.length > 0) {
      setProblems(issues.map(({ message }) => message));
      return;
    }
    setProblems([]);
    if (givesUi && !proof.ready()) {
      return;
    }
    const keyUrl = `/api/gateway-keys/${encodeURIComponent(gatewayKey.id)}`;
    let updated = gatewayKey;
    if (ownerTool && changes.success) {
      const response = await sendJson(
        "PATCH",
        keyUrl,
        givesUi ? { ...changes.data, ...proof.proof } : changes.data,
        session?.csrfToken,
      );
      if (!response.ok) {
        const error = await readApiError(response);
        if (!proof.refused(error)) {
          setProblems(problemsIn(error, "The key was not saved."));
        }
        return;
      }
      updated = gatewayKeySchema.parse(await response.json());
      proof.reset();
    }
    if (dirtyFields.nickname === true || dirtyFields.timeZone === true) {
      const response = await sendJson(
        "PUT",
        `${keyUrl}/profile`,
        profile.data,
        session?.csrfToken,
      );
      if (!response.ok) {
        setProblems(await problemsOf(response, "The key was not saved."));
        return;
      }
      updated = gatewayKeySchema.parse(await response.json());
    }
    setProblems([]);
    setSaved(true);
    reset(valuesOf(updated));
    queryClient.setQueryData(gatewayKeysQuery.queryKey, (keys) =>
      keys?.map((each) => (each.id === updated.id ? updated : each)),
    );
  };

  return (
    <form
      noValidate
      aria-label={`${gatewayKey.name}'s settings`}
      className="space-y-3"
      onSubmit={(event) => void handleSubmit(onSubmit)(event)}
    >
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="space-y-2">
          <Label htmlFor={id("name")}>Name</Label>
          <Input
            id={id("name")}
            autoComplete="off"
            readOnly={!ownerTool}
            aria-describedby={ownerTool ? undefined : id("name-hint")}
            {...register("name")}
          />
          {!ownerTool && (
            <p id={id("name-hint")} className="text-xs text-muted-foreground">
              An Agent&apos;s key keeps its Agent&apos;s name.
            </p>
          )}
        </div>
        <div className="space-y-2">
          <Label htmlFor={id("nickname")}>Nickname</Label>
          <Input
            id={id("nickname")}
            autoComplete="off"
            {...register("nickname")}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor={id("time-zone")}>Time zone</Label>
          <select
            id={id("time-zone")}
            className={selectClass}
            {...register("timeZone")}
          >
            {zones.map((zone) => (
              <option key={zone} value={zone}>
                {timeZoneLabel(zone)}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-2">
          <Label htmlFor={id("access")}>Access</Label>
          <select
            id={id("access")}
            className={selectClass}
            disabled={!ownerTool}
            aria-describedby={id("access-hint")}
            {...register("access")}
          >
            {gatewayKeyAccessLevels.map((level) => (
              <option key={level} value={level}>
                {gatewayKeyAccessNames[level]}
              </option>
            ))}
          </select>
          <p id={id("access-hint")} className="text-xs text-muted-foreground">
            {ownerTool
              ? "With UI, the key also signs in to AI Office."
              : "An Agent's key only calls models."}
          </p>
        </div>
      </div>
      {givesUi && (
        <OwnerProofFields
          id={id("proof")}
          reason="With UI access, the key signs in, so confirm it with the password you sign in with."
          state={proof}
        />
      )}
      <Problems problems={problems} />
      {saved && !isDirty && (
        <p role="status" className="text-sm">
          Saved.
        </p>
      )}
      <Button
        pending={isSubmitting}
        type="submit"
        size="sm"
        disabled={
          !isDirty ||
          isSubmitting ||
          session === undefined ||
          (givesUi && !proof.canProve)
        }
      >
        {isSubmitting ? "Saving…" : `Save ${gatewayKey.name}`}
      </Button>
    </form>
  );
}

/**
 * Enables or disables one of the Owner's tools' keys. Enabled again, a key
 * with UI access signs in, so that asks for a proof first.
 */
function EnableKey({ gatewayKey }: { gatewayKey: GatewayKey }) {
  const queryClient = useQueryClient();
  const { data: session } = useQuery(sessionQuery);
  const proof = useOwnerProof();
  const [problems, setProblems] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const signsIn = !gatewayKey.enabled && gatewayKey.access === "proxy_and_ui";
  const toggle = async () => {
    setProblems([]);
    if (signsIn && !proof.ready()) {
      return;
    }
    setBusy(true);
    const response = await sendJson(
      "PATCH",
      `/api/gateway-keys/${encodeURIComponent(gatewayKey.id)}`,
      {
        enabled: !gatewayKey.enabled,
        ...(signsIn ? proof.proof : {}),
      },
      session?.csrfToken,
    );
    setBusy(false);
    if (!response.ok) {
      const error = await readApiError(response);
      if (!proof.refused(error)) {
        setProblems(problemsIn(error, "The key was not changed."));
      }
      return;
    }
    const updated = gatewayKeySchema.parse(await response.json());
    setProblems([]);
    setConfirming(false);
    proof.reset();
    queryClient.setQueryData(gatewayKeysQuery.queryKey, (keys) =>
      keys?.map((each) => (each.id === updated.id ? updated : each)),
    );
    // Disabling the key this session signed in with ends the session.
    await queryClient.invalidateQueries(sessionQuery);
  };
  if (confirming && signsIn) {
    return (
      <form
        noValidate
        aria-label={`Enable ${gatewayKey.name}`}
        className="w-full space-y-3"
        onSubmit={(event) => {
          event.preventDefault();
          void toggle();
        }}
      >
        <p className="text-sm font-medium">
          Enabled, {gatewayKey.name} signs in to AI Office again.
        </p>
        <OwnerProofFields
          id={`api-key-${gatewayKey.id}-enable-proof`}
          reason="The key signs in again, so confirm it with the password you sign in with."
          state={proof}
        />
        <Problems problems={problems} />
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="submit"
            size="sm"
            disabled={busy || session === undefined || !proof.canProve}
          >
            <Power aria-hidden />
            Yes, enable {gatewayKey.name}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => {
              setConfirming(false);
              setProblems([]);
              proof.reset();
            }}
          >
            Cancel
          </Button>
        </div>
      </form>
    );
  }
  return (
    <>
      <Button
        size="sm"
        variant="outline"
        disabled={busy || session === undefined}
        onClick={() => {
          if (signsIn) {
            setConfirming(true);
          } else {
            void toggle();
          }
        }}
      >
        {gatewayKey.enabled ? <PowerOff aria-hidden /> : <Power aria-hidden />}
        {gatewayKey.enabled
          ? `Disable ${gatewayKey.name}`
          : `Enable ${gatewayKey.name}`}
      </Button>
      <Problems problems={problems} />
    </>
  );
}

/** Revokes an Owner tool's key, once the Owner confirms. */
function RevokeKey({ gatewayKey }: { gatewayKey: GatewayKey }) {
  const queryClient = useQueryClient();
  const { data: session } = useQuery(sessionQuery);
  const [confirming, setConfirming] = useState(false);
  const [problems, setProblems] = useState<string[]>([]);
  const revoke = async () => {
    const response = await sendDelete(
      `/api/gateway-keys/${encodeURIComponent(gatewayKey.id)}`,
      session?.csrfToken,
    );
    if (!response.ok) {
      setProblems(await problemsOf(response, "The key was not revoked."));
      return;
    }
    await queryClient.invalidateQueries(gatewayKeysQuery);
  };
  return confirming ? (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        size="sm"
        variant="destructive"
        disabled={session === undefined}
        onClick={() => void revoke()}
      >
        Revoke {gatewayKey.name}
      </Button>
      <Button
        size="sm"
        variant="ghost"
        onClick={() => {
          setConfirming(false);
        }}
      >
        Cancel
      </Button>
      <Problems problems={problems} />
    </div>
  ) : (
    <Button
      size="sm"
      variant="outline"
      aria-label={`Revoke ${gatewayKey.name}`}
      onClick={() => {
        setConfirming(true);
      }}
    >
      <Trash2 aria-hidden />
      Revoke
    </Button>
  );
}

const integer = new Intl.NumberFormat("en-GB");
const dollars = new Intl.NumberFormat("en-GB", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 2,
});

/** What a key's requests added up to. */
function KeyUsageFacts({ usage }: { usage: GatewayKeyUsage | undefined }) {
  const facts = [
    ["Requests", integer.format(usage?.requests ?? 0)],
    ["Input tokens", integer.format(usage?.inputTokens ?? 0)],
    ["Output tokens", integer.format(usage?.outputTokens ?? 0)],
    ["Estimated cost", dollars.format(usage?.estimatedCostUsd ?? 0)],
  ] as const;
  return (
    <dl
      aria-label="Usage"
      className="grid grid-cols-2 gap-3 rounded-md border p-3 text-sm sm:grid-cols-4"
    >
      {facts.map(([term, value]) => (
        <div key={term}>
          <dt className="text-muted-foreground">{term}</dt>
          <dd className="font-medium">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function KeyCard({
  gatewayKey,
  usage,
}: {
  gatewayKey: GatewayKey;
  usage: GatewayKeyUsage | undefined;
}) {
  const { timeZone } = gatewayKey.profile;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          <h3>{gatewayKey.name}</h3>
          <Badge>{kindNames[gatewayKey.kind]}</Badge>
          <Badge tone="primary">
            {gatewayKeyAccessNames[gatewayKey.access]}
          </Badge>
          {!gatewayKey.enabled && <Badge tone="destructive">Disabled</Badge>}
        </CardTitle>
        <CardDescription>
          <span className="font-mono">{gatewayKey.hint}…</span> · Made{" "}
          {new Date(gatewayKey.createdAt).toLocaleDateString()} ·{" "}
          {lastUsed(gatewayKey)} ·{" "}
          {timeZone === defaultTimeZone ? "British time" : timeZone}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <KeyUsageFacts usage={usage} />
        <KeyForm gatewayKey={gatewayKey} />
        {gatewayKey.kind === "owner_tool" && (
          <div className="flex flex-wrap items-start gap-2">
            <EnableKey gatewayKey={gatewayKey} />
            <RevokeKey gatewayKey={gatewayKey} />
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/** API Key Management (`/api-keys`). */
export function ApiKeysPage() {
  const queryClient = useQueryClient();
  const keys = useQuery(gatewayKeysQuery);
  const usage = useQuery(gatewayKeyUsageQuery);
  const { data: session } = useQuery(sessionQuery);
  return (
    <section className="space-y-6">
      <PageHeader
        title="API Key Management"
        description={
          <>
            The keys that reach the AI Gateway: what each may do, what it has
            used, and who uses it, by nickname and time zone.
          </>
        }
      />
      {keys.isError && (
        <p role="alert" className="text-sm text-destructive">
          The API keys could not be loaded.
        </p>
      )}
      {keys.data !== undefined && <KeyStats keys={keys.data} />}
      <Card>
        <CardHeader>
          <CardTitle>
            <h2>Make an API key</h2>
          </CardTitle>
          <CardDescription>
            For one of your own tools. It is shown once, when it is made.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <CreateForm
            csrfToken={session?.csrfToken}
            onCreated={() => queryClient.invalidateQueries(gatewayKeysQuery)}
          />
        </CardContent>
      </Card>
      <OwnerPasswords />
      <section aria-labelledby="your-api-keys" className="space-y-4">
        <h2 id="your-api-keys" className="text-lg font-semibold">
          Your API keys
        </h2>
        {keys.data?.map((key) => (
          <KeyCard
            key={key.id}
            gatewayKey={key}
            usage={usage.data?.find(
              ({ gatewayKeyId }) => gatewayKeyId === key.id,
            )}
          />
        ))}
      </section>
    </section>
  );
}
