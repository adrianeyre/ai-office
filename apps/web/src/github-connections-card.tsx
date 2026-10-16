import {
  githubAccessTokenConnectionCreateSchema,
  githubAppConnectionCreateSchema,
  githubConnectionKindNames,
  githubConnectionListSchema,
  githubConnectionSchema,
  type GitHubConnection,
} from "@ai-office/shared";
import { queryOptions, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { useForm } from "react-hook-form";

import { Badge } from "@/components/ui/badge.tsx";
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

import { getJson, postJson, sendDelete, sendJson } from "./api.ts";
import { installedRepositoriesQuery } from "./floors.ts";
import { Problems, problemsOf } from "./gateway-keys-card.tsx";
import { sessionQuery } from "./session.ts";

// GitHub connections (ADR 0011): the GitHub Apps and access tokens AI
// Office reaches GitHub through, added here and kept in the database, the
// private key and tokens sealed and never shown again. Each repository is
// worked through the first that reaches it, Apps first. A change is used
// at once, with no restart.

/** The GitHub connections, in the order they are tried (`GET /api/github/connections`). */
export const githubConnectionsQuery = queryOptions({
  queryKey: ["github", "connections"],
  queryFn: async () =>
    (await getJson("/api/github/connections", githubConnectionListSchema))
      .connections,
});

/** What tells a connection apart, without giving it away. */
const identifies = (connection: GitHubConnection): string =>
  connection.kind === "app"
    ? `App ID ${connection.appId ?? ""} · key …${connection.hint}`
    : `Token …${connection.hint}`;

/** One connection, with Disable (or Enable) and Remove. */
function ConnectionRow({
  connection,
  csrfToken,
  onChanged,
}: {
  connection: GitHubConnection;
  csrfToken: string | undefined;
  onChanged: () => Promise<void>;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problems, setProblems] = useState<string[]>([]);
  const path = `/api/github/connections/${encodeURIComponent(connection.id)}`;

  const toggle = async () => {
    setBusy(true);
    const response = await sendJson(
      "PATCH",
      path,
      { enabled: !connection.enabled },
      csrfToken,
    );
    if (response.ok) {
      githubConnectionSchema.parse(await response.json());
      setProblems([]);
      await onChanged();
    } else {
      setProblems(
        await problemsOf(response, "The GitHub connection was not changed."),
      );
    }
    setBusy(false);
  };

  const remove = async () => {
    setBusy(true);
    const response = await sendDelete(path, csrfToken);
    if (response.ok) {
      await onChanged();
    } else {
      setProblems(
        await problemsOf(response, "The GitHub connection was not removed."),
      );
      setBusy(false);
    }
  };

  return (
    <li
      aria-label={connection.name}
      className="flex flex-wrap items-center justify-between gap-2 py-3"
    >
      <div className="space-y-0.5 text-sm">
        <p className="flex flex-wrap items-center gap-2 font-medium">
          {connection.name}
          <Badge tone={connection.kind === "app" ? "indigo" : "violet"}>
            {githubConnectionKindNames[connection.kind]}
          </Badge>
          {!connection.enabled && <Badge tone="warning">Disabled</Badge>}
        </p>
        <p className="text-muted-foreground">
          <span className="font-mono">{identifies(connection)}</span> · Added{" "}
          {new Date(connection.createdAt).toLocaleString()}
        </p>
      </div>
      {confirming ? (
        <div className="flex w-full flex-wrap items-center gap-2">
          <p className="w-full text-sm font-medium">
            Remove {connection.name}? AI Office stops using it at once, and
            forgets its credentials.
          </p>
          <Button
            size="sm"
            variant="destructive"
            disabled={busy || csrfToken === undefined}
            onClick={() => void remove()}
          >
            Yes, remove {connection.name}
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
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="outline"
            aria-label={`${connection.enabled ? "Disable" : "Enable"} ${connection.name}`}
            disabled={busy || csrfToken === undefined}
            onClick={() => void toggle()}
          >
            {connection.enabled ? "Disable" : "Enable"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            aria-label={`Remove ${connection.name}`}
            onClick={() => {
              setConfirming(true);
            }}
          >
            <Trash2 aria-hidden />
            Remove
          </Button>
        </div>
      )}
      <div className="w-full">
        <Problems problems={problems} />
      </div>
    </li>
  );
}

interface AppValues {
  name: string;
  appId: string;
  privateKey: string;
}

/** Adds a GitHub App: its ID and PEM private key. */
function AddAppForm({
  csrfToken,
  onAdded,
}: {
  csrfToken: string | undefined;
  onAdded: () => Promise<void>;
}) {
  const [problems, setProblems] = useState<string[]>([]);
  const [added, setAdded] = useState<string>();
  const {
    register,
    handleSubmit,
    reset,
    formState: { isSubmitting },
  } = useForm<AppValues>({
    defaultValues: { name: "", appId: "", privateKey: "" },
  });

  const onSubmit = async (values: AppValues) => {
    setAdded(undefined);
    const parsed = githubAppConnectionCreateSchema.safeParse({
      ...(values.name.trim() === "" ? {} : { name: values.name }),
      appId: values.appId,
      privateKey: values.privateKey,
    });
    if (!parsed.success) {
      setProblems(parsed.error.issues.map(({ message }) => message));
      return;
    }
    const response = await postJson(
      "/api/github/connections/apps",
      parsed.data,
      csrfToken,
    );
    if (!response.ok) {
      setProblems(await problemsOf(response, "The GitHub App was not added."));
      return;
    }
    const connection = githubConnectionSchema.parse(await response.json());
    setProblems([]);
    reset();
    setAdded(connection.name);
    await onAdded();
  };

  return (
    <form
      noValidate
      aria-label="Add a GitHub App"
      className="space-y-3"
      onSubmit={(event) => void handleSubmit(onSubmit)(event)}
    >
      <h3 className="text-sm font-medium">Add a GitHub App</h3>
      <div className="space-y-2">
        <Label htmlFor="github-app-name">Name (optional)</Label>
        <Input
          id="github-app-name"
          autoComplete="off"
          placeholder="Acme's App"
          {...register("name")}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="github-app-id">App ID</Label>
        <Input
          id="github-app-id"
          autoComplete="off"
          inputMode="numeric"
          placeholder="123456"
          {...register("appId")}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="github-app-private-key">Private key</Label>
        <textarea
          id="github-app-private-key"
          rows={4}
          autoComplete="off"
          spellCheck={false}
          aria-describedby="github-app-private-key-hint"
          placeholder="-----BEGIN RSA PRIVATE KEY-----"
          className="w-full rounded-md border bg-transparent p-2 font-mono text-xs"
          {...register("privateKey")}
        />
        <p
          id="github-app-private-key-hint"
          className="text-xs text-muted-foreground"
        >
          The whole .pem file the App&apos;s settings gave you. It is kept
          encrypted and never shown again.
        </p>
      </div>
      <Problems problems={problems} />
      {added !== undefined && (
        <p role="status" className="text-sm">
          Added {added}.
        </p>
      )}
      <Button
        pending={isSubmitting}
        type="submit"
        disabled={isSubmitting || csrfToken === undefined}
      >
        <Plus aria-hidden />
        {isSubmitting ? "Adding…" : "Add GitHub App"}
      </Button>
    </form>
  );
}

interface TokenValues {
  name: string;
  token: string;
  readOnlyToken: string;
}

/** Adds an access token and the read-only one sandboxes get. */
function AddAccessTokenForm({
  csrfToken,
  onAdded,
}: {
  csrfToken: string | undefined;
  onAdded: () => Promise<void>;
}) {
  const [problems, setProblems] = useState<string[]>([]);
  const [added, setAdded] = useState<string>();
  const {
    register,
    handleSubmit,
    reset,
    formState: { isSubmitting },
  } = useForm<TokenValues>({
    defaultValues: { name: "", token: "", readOnlyToken: "" },
  });

  const onSubmit = async (values: TokenValues) => {
    setAdded(undefined);
    const parsed = githubAccessTokenConnectionCreateSchema.safeParse({
      ...(values.name.trim() === "" ? {} : { name: values.name }),
      token: values.token,
      readOnlyToken: values.readOnlyToken,
    });
    if (!parsed.success) {
      setProblems(parsed.error.issues.map(({ message }) => message));
      return;
    }
    const response = await postJson(
      "/api/github/connections/access-tokens",
      parsed.data,
      csrfToken,
    );
    if (!response.ok) {
      setProblems(
        await problemsOf(response, "The access token was not added."),
      );
      return;
    }
    const connection = githubConnectionSchema.parse(await response.json());
    setProblems([]);
    reset();
    setAdded(connection.name);
    await onAdded();
  };

  return (
    <form
      noValidate
      aria-label="Add an access token"
      className="space-y-3"
      onSubmit={(event) => void handleSubmit(onSubmit)(event)}
    >
      <h3 className="text-sm font-medium">Add an access token</h3>
      <div className="space-y-2">
        <Label htmlFor="github-token-name">Name (optional)</Label>
        <Input
          id="github-token-name"
          autoComplete="off"
          placeholder="My account"
          {...register("name")}
        />
      </div>
      <div className="space-y-2">
        <Label htmlFor="github-token">Access token</Label>
        <Input
          id="github-token"
          type="password"
          autoComplete="off"
          aria-describedby="github-token-hint"
          {...register("token")}
        />
        <p id="github-token-hint" className="text-xs text-muted-foreground">
          A fine-grained or classic personal access token. Reads and writes the
          repositories&apos; contents, issues and pull requests, and reads their
          checks.
        </p>
      </div>
      <div className="space-y-2">
        <Label htmlFor="github-read-only-token">Read-only access token</Label>
        <Input
          id="github-read-only-token"
          type="password"
          autoComplete="off"
          aria-describedby="github-read-only-token-hint"
          {...register("readOnlyToken")}
        />
        <p
          id="github-read-only-token-hint"
          className="text-xs text-muted-foreground"
        >
          Required: another token, one that can only read them, such as a
          fine-grained token with read-only Contents. It is all the Agents&apos;
          sandboxes get. Both are kept encrypted and never shown again.
        </p>
      </div>
      <Problems problems={problems} />
      {added !== undefined && (
        <p role="status" className="text-sm">
          Added {added}.
        </p>
      )}
      <Button
        pending={isSubmitting}
        type="submit"
        disabled={isSubmitting || csrfToken === undefined}
      >
        <Plus aria-hidden />
        {isSubmitting ? "Adding…" : "Add access token"}
      </Button>
    </form>
  );
}

/**
 * The GitHub card of Floor Settings (ADR 0011): the GitHub Apps and
 * access tokens AI Office reaches GitHub through, with forms to add one,
 * and Disable and Remove on each.
 */
export function GitHubConnectionsCard() {
  const queryClient = useQueryClient();
  const connections = useQuery(githubConnectionsQuery);
  const { data: session } = useQuery(sessionQuery);
  // The repositories a Floor can be added for change with them.
  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries(githubConnectionsQuery),
      queryClient.invalidateQueries(installedRepositoriesQuery),
    ]);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>GitHub</h2>
        </CardTitle>
        <CardDescription>
          The GitHub Apps and access tokens AI Office works through. Each
          repository is worked through the first that reaches it, GitHub Apps
          first; a change is used at once.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {connections.isError && (
          <p role="alert" className="text-sm text-destructive">
            The GitHub connections could not be loaded.
          </p>
        )}
        {connections.data?.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No GitHub App or access token yet: add one to add Floors.
          </p>
        )}
        {connections.data !== undefined && connections.data.length > 0 && (
          <ul aria-label="GitHub connections" className="divide-y">
            {connections.data.map((connection) => (
              <ConnectionRow
                key={connection.id}
                connection={connection}
                csrfToken={session?.csrfToken}
                onChanged={refresh}
              />
            ))}
          </ul>
        )}
        <div className="grid gap-6 md:grid-cols-2">
          <AddAppForm csrfToken={session?.csrfToken} onAdded={refresh} />
          <AddAccessTokenForm
            csrfToken={session?.csrfToken}
            onAdded={refresh}
          />
        </div>
      </CardContent>
    </Card>
  );
}
