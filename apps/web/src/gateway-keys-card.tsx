import {
  createdGatewayKeySchema,
  createGatewayKeyRequestSchema,
  gatewayKeyAccessLevels,
  gatewayKeyAccessNames,
  gatewayKeyListSchema,
  type ApiError,
  type GatewayKey,
  type GatewayKeyAccess,
} from "@ai-office/shared";
import { queryOptions, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, KeyRound, Trash2 } from "lucide-react";
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
import { selectClass } from "@/lib/utils.ts";

import { getJson, postJson, readApiError, sendDelete } from "./api.ts";
import { useFloorNames } from "./floors.ts";
import { OwnerProofFields, useOwnerProof } from "./owner-proof.tsx";
import { sessionQuery } from "./session.ts";

// Gateway Keys (PRD FR-46): what callers of the AI Gateway present. The
// Owner makes named keys for their own tools here, each shown once, and
// revokes them. Agents' keys are listed too; they come and go with their
// Agents, and are rotated from their Floor's admin page.

/** The keys in use, newest first (`GET /api/gateway-keys`). */
export const gatewayKeysQuery = queryOptions({
  queryKey: ["gateway-keys"],
  queryFn: async () =>
    (await getJson("/api/gateway-keys", gatewayKeyListSchema)).keys,
});

/** When a key was last used, for people. */
export const lastUsed = (key: Pick<GatewayKey, "lastUsedAt">): string =>
  key.lastUsedAt === null
    ? "Never used"
    : `Last used ${new Date(key.lastUsedAt).toLocaleString()}`;

/** What the API said was wrong, one line each. */
export const problemsIn = (error: ApiError, fallback: string): string[] =>
  error.problems ?? [error.message ?? fallback];

/** What the API said was wrong, one line each, read from `response`. */
export async function problemsOf(
  response: Response,
  fallback: string,
): Promise<string[]> {
  return problemsIn(await readApiError(response), fallback);
}

export function Problems({ problems }: { problems: readonly string[] }) {
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

/** One Owner tool's key, with Revoke. */
function OwnerToolKeyRow({
  gatewayKey,
  csrfToken,
  onChanged,
}: {
  gatewayKey: GatewayKey;
  csrfToken: string | undefined;
  onChanged: () => Promise<void>;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problems, setProblems] = useState<string[]>([]);

  const revoke = async () => {
    setBusy(true);
    const response = await sendDelete(
      `/api/gateway-keys/${encodeURIComponent(gatewayKey.id)}`,
      csrfToken,
    );
    if (response.ok) {
      await onChanged();
    } else {
      setProblems(
        await problemsOf(response, "The Gateway Key was not revoked."),
      );
      setBusy(false);
    }
  };

  return (
    <li
      aria-label={gatewayKey.name}
      className="flex flex-wrap items-center justify-between gap-2 py-3"
    >
      <div className="space-y-0.5 text-sm">
        <p className="font-medium">{gatewayKey.name}</p>
        <p className="text-muted-foreground">
          <span className="font-mono">{gatewayKey.hint}…</span> · Made{" "}
          {new Date(gatewayKey.createdAt).toLocaleString()} ·{" "}
          {lastUsed(gatewayKey)}
        </p>
      </div>
      {confirming ? (
        <div className="flex w-full flex-wrap items-center gap-2">
          <p className="w-full text-sm font-medium">
            Revoke {gatewayKey.name}? The AI Gateway refuses it at once, for
            good.
          </p>
          <Button
            size="sm"
            variant="destructive"
            disabled={busy || csrfToken === undefined}
            onClick={() => void revoke()}
          >
            Yes, revoke {gatewayKey.name}
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
      )}
      <div className="w-full">
        <Problems problems={problems} />
      </div>
    </li>
  );
}

/** The key just made, shown this once. */
function NewKey({
  name,
  value,
  onDone,
}: {
  name: string;
  value: string;
  onDone: () => void;
}) {
  const [copied, setCopied] = useState(false);
  // One entry point: the address this page is served from serves the
  // Gateway's /v1 paths too.
  const origin = window.location.origin;
  return (
    <div
      role="status"
      className="space-y-2 rounded-md border border-primary/40 p-3 text-sm"
    >
      <p className="font-medium">
        Made {name}. Copy its key now: it is not shown again.
      </p>
      <div className="flex gap-2">
        <Input
          aria-label={`The key for ${name}`}
          readOnly
          value={value}
          className="font-mono"
          onFocus={(event) => {
            event.currentTarget.select();
          }}
        />
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            void navigator.clipboard
              .writeText(value)
              .then(() => {
                setCopied(true);
              })
              .catch(() => undefined);
          }}
        >
          <Copy aria-hidden />
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <p className="text-muted-foreground">
        Give it to the tool as its Anthropic key (<code>x-api-key</code>) or
        bearer token. The AI Gateway is at this same address: Claude Code takes{" "}
        <code>ANTHROPIC_BASE_URL={origin}</code>, and OpenAI clients such as
        Codex the base URL <code>{origin}/v1</code>.
      </p>
      <Button type="button" size="sm" variant="ghost" onClick={onDone}>
        Done
      </Button>
    </div>
  );
}

/**
 * Makes a key for one of the Owner's tools. A key with UI access signs in,
 * so making one needs a fresh proof of the Owner (A1-3); a proxy-only key
 * needs none.
 */
export function CreateForm({
  csrfToken,
  onCreated,
}: {
  csrfToken: string | undefined;
  onCreated: () => Promise<void>;
}) {
  const [problems, setProblems] = useState<string[]>([]);
  const [made, setMade] = useState<{ name: string; key: string }>();
  const proof = useOwnerProof();
  const {
    register,
    handleSubmit,
    reset,
    control,
    formState: { isSubmitting },
  } = useForm<{ name: string; access: GatewayKeyAccess }>({
    defaultValues: { name: "", access: "proxy" },
  });
  const signsIn = useWatch({ control, name: "access" }) === "proxy_and_ui";

  const onSubmit = async (values: {
    name: string;
    access: GatewayKeyAccess;
  }) => {
    setMade(undefined);
    const parsed = createGatewayKeyRequestSchema.safeParse(values);
    if (!parsed.success) {
      setProblems(parsed.error.issues.map(({ message }) => message));
      return;
    }
    const withUi = parsed.data.access === "proxy_and_ui";
    setProblems([]);
    if (withUi && !proof.ready()) {
      return;
    }
    const response = await postJson(
      "/api/gateway-keys",
      withUi ? { ...parsed.data, ...proof.proof } : parsed.data,
      csrfToken,
    );
    if (!response.ok) {
      const error = await readApiError(response);
      if (!proof.refused(error)) {
        setProblems(problemsIn(error, "The Gateway Key was not made."));
      }
      return;
    }
    const created = createdGatewayKeySchema.parse(await response.json());
    setProblems([]);
    proof.reset();
    reset({ name: "", access: "proxy" });
    setMade({ name: created.gatewayKey.name, key: created.key });
    await onCreated();
  };

  return (
    <form
      noValidate
      aria-label="Make a Gateway Key"
      className="space-y-3"
      onSubmit={(event) => void handleSubmit(onSubmit)(event)}
    >
      <div className="space-y-2">
        <Label htmlFor="gateway-key-name">Tool</Label>
        <Input
          id="gateway-key-name"
          autoComplete="off"
          placeholder="Claude Code on my laptop"
          {...register("name")}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="gateway-key-access">Access</Label>
        <select
          id="gateway-key-access"
          className={selectClass}
          aria-describedby="gateway-key-access-hint"
          {...register("access")}
        >
          {gatewayKeyAccessLevels.map((level) => (
            <option key={level} value={level}>
              {gatewayKeyAccessNames[level]}
            </option>
          ))}
        </select>
        <p
          id="gateway-key-access-hint"
          className="text-xs text-muted-foreground"
        >
          With UI, the key also signs in to AI Office, as the Owner&apos;s
          password does. Keep such a key as safe as the password.
        </p>
      </div>
      {signsIn && (
        <OwnerProofFields
          id="gateway-key-proof"
          reason="A key with UI access signs in, so confirm it with the password you sign in with."
          state={proof}
        />
      )}
      <Problems problems={problems} />
      {made !== undefined && (
        <NewKey
          name={made.name}
          value={made.key}
          onDone={() => {
            setMade(undefined);
          }}
        />
      )}
      <Button
        pending={isSubmitting}
        type="submit"
        disabled={
          isSubmitting ||
          csrfToken === undefined ||
          (signsIn && !proof.canProve)
        }
      >
        <KeyRound aria-hidden />
        {isSubmitting ? "Making…" : "Make Gateway Key"}
      </Button>
    </form>
  );
}

/**
 * The Gateway Keys section of the office admin (PRD FR-46): the Owner's
 * tools' keys, with a form to make one, and the Agents' keys.
 */
export function GatewayKeysCard() {
  const queryClient = useQueryClient();
  const floorName = useFloorNames();
  const keys = useQuery(gatewayKeysQuery);
  const { data: session } = useQuery(sessionQuery);
  const refresh = () => queryClient.invalidateQueries(gatewayKeysQuery);
  const ownerTools =
    keys.data?.filter(({ kind }) => kind === "owner_tool") ?? [];
  const agentKeys = keys.data?.filter(({ kind }) => kind === "agent") ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>Gateway Keys</h2>
        </CardTitle>
        <CardDescription>
          Every call to the AI Gateway presents one, so each request is
          attributed. Each Agent has its own; make one for each of your own
          tools. A key only calls models.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {keys.isError && (
          <p role="alert" className="text-sm text-destructive">
            The Gateway Keys could not be loaded.
          </p>
        )}
        <section aria-labelledby="owner-tool-keys" className="space-y-2">
          <h3 id="owner-tool-keys" className="text-sm font-medium">
            Your tools
          </h3>
          {keys.data !== undefined && ownerTools.length === 0 && (
            <p className="text-sm text-muted-foreground">
              No keys for your own tools yet.
            </p>
          )}
          {ownerTools.length > 0 && (
            <ul aria-label="Owner tools' Gateway Keys" className="divide-y">
              {ownerTools.map((key) => (
                <OwnerToolKeyRow
                  key={key.id}
                  gatewayKey={key}
                  csrfToken={session?.csrfToken}
                  onChanged={refresh}
                />
              ))}
            </ul>
          )}
          <CreateForm csrfToken={session?.csrfToken} onCreated={refresh} />
        </section>
        <section aria-labelledby="agent-keys" className="space-y-2">
          <h3 id="agent-keys" className="text-sm font-medium">
            Agents
          </h3>
          <p className="text-sm text-muted-foreground">
            Made with each Agent and given to its sandboxes; rotate one from its
            Floor&apos;s admin page.
          </p>
          {agentKeys.length > 0 && (
            <ul aria-label="Agents' Gateway Keys" className="divide-y text-sm">
              {agentKeys.map((key) => (
                <li
                  key={key.id}
                  aria-label={key.name}
                  className="flex flex-wrap justify-between gap-2 py-2"
                >
                  <span>
                    <span className="font-medium">{key.name}</span>{" "}
                    {key.floorId !== null && (
                      <span className="text-muted-foreground">
                        on {floorName(key.floorId)}
                      </span>
                    )}
                  </span>
                  <span className="text-muted-foreground">
                    <span className="font-mono">{key.hint}…</span> ·{" "}
                    {lastUsed(key)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </CardContent>
    </Card>
  );
}
