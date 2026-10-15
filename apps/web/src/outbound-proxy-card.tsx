import {
  outboundProxySettingsSchema,
  outboundProxyUpdateSchema,
  type OutboundProxySettings,
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

import { getJson, readApiError, sendJson } from "./api.ts";
import { sessionQuery } from "./session.ts";

// The outbound HTTP proxy (PRD FR-35): optional; while it is set, every
// request the AI Gateway makes upstream goes through it. Its password is
// typed in once: it is stored encrypted and never shown again, and left
// empty it stays as it is. Changes apply from the next request.

/** The proxy, without its password (`GET /api/office/outbound-proxy`). */
export const outboundProxyQuery = queryOptions({
  queryKey: ["office", "outbound-proxy"],
  queryFn: () =>
    getJson("/api/office/outbound-proxy", outboundProxySettingsSchema),
});

interface FormValues {
  url: string;
  username: string;
  /** Empty keeps the stored one. */
  password: string;
  removePassword: boolean;
  /** Hosts to reach directly, one per line or separated by commas. */
  noProxy: string;
}

const formValues = (settings: OutboundProxySettings): FormValues => ({
  url: settings.url ?? "",
  username: settings.username ?? "",
  password: "",
  removePassword: false,
  noProxy: settings.noProxy.join("\n"),
});

const optional = (value: string): string | null =>
  value.trim() === "" ? null : value.trim();

function OutboundProxyForm({ settings }: { settings: OutboundProxySettings }) {
  const queryClient = useQueryClient();
  const { data: session } = useQuery(sessionQuery);
  const [problems, setProblems] = useState<string[]>([]);
  const [saved, setSaved] = useState(false);
  const {
    register,
    handleSubmit,
    reset,
    formState: { isDirty, isSubmitting },
  } = useForm<FormValues>({ defaultValues: formValues(settings) });

  const onSubmit = async (values: FormValues) => {
    setSaved(false);
    const url = optional(values.url);
    const username = optional(values.username);
    const parsed = outboundProxyUpdateSchema.safeParse(
      url === null
        ? { url: null }
        : {
            url,
            username,
            // Empty keeps the stored password, unless it is removed.
            ...(values.removePassword
              ? { password: null }
              : values.password === ""
                ? {}
                : { password: values.password }),
            noProxy: values.noProxy
              .split(/[\s,]+/)
              .filter((host) => host !== ""),
          },
    );
    if (!parsed.success) {
      setProblems(parsed.error.issues.map(({ message }) => message));
      return;
    }
    const response = await sendJson(
      "PUT",
      "/api/office/outbound-proxy",
      parsed.data,
      session?.csrfToken,
    );
    if (!response.ok) {
      const error = await readApiError(response);
      setProblems(
        error.problems ?? [error.message ?? "The proxy was not saved."],
      );
      return;
    }
    const updated = outboundProxySettingsSchema.parse(await response.json());
    setProblems([]);
    setSaved(true);
    // The password leaves the page with the form's values.
    reset(formValues(updated));
    queryClient.setQueryData(outboundProxyQuery.queryKey, updated);
  };

  return (
    <form
      noValidate
      aria-label="Outbound proxy"
      className="space-y-4"
      onSubmit={(event) => void handleSubmit(onSubmit)(event)}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2 sm:col-span-2">
          <Label htmlFor="outbound-proxy-url">Proxy URL</Label>
          <Input
            id="outbound-proxy-url"
            type="url"
            autoComplete="off"
            spellCheck={false}
            placeholder="http://proxy.example.com:3128"
            aria-describedby="outbound-proxy-url-hint"
            {...register("url")}
          />
          <p
            id="outbound-proxy-url-hint"
            className="text-xs text-muted-foreground"
          >
            An http:// or https:// proxy, its host and port. Empty sends every
            request directly.
          </p>
        </div>
        <div className="space-y-2">
          <Label htmlFor="outbound-proxy-username">Username</Label>
          <Input
            id="outbound-proxy-username"
            autoComplete="off"
            spellCheck={false}
            aria-describedby="outbound-proxy-username-hint"
            {...register("username")}
          />
          <p
            id="outbound-proxy-username-hint"
            className="text-xs text-muted-foreground"
          >
            Optional: only for a proxy that asks for one.
          </p>
        </div>
        <div className="space-y-2">
          <Label htmlFor="outbound-proxy-password">Password</Label>
          <Input
            id="outbound-proxy-password"
            type="password"
            autoComplete="new-password"
            spellCheck={false}
            aria-describedby="outbound-proxy-password-hint"
            {...register("password")}
          />
          <p
            id="outbound-proxy-password-hint"
            className="text-xs text-muted-foreground"
          >
            {settings.hasPassword
              ? "A password is stored. Empty keeps it; it is never shown again."
              : "Stored encrypted, and never shown again, here or anywhere."}
          </p>
          {settings.hasPassword && (
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" {...register("removePassword")} />
              Remove the stored password
            </label>
          )}
        </div>
        <div className="space-y-2 sm:col-span-2">
          <Label htmlFor="outbound-proxy-no-proxy">Reach directly</Label>
          <textarea
            id="outbound-proxy-no-proxy"
            rows={3}
            autoComplete="off"
            spellCheck={false}
            placeholder={"ollama.lan\n.internal"}
            aria-describedby="outbound-proxy-no-proxy-hint"
            className="w-full rounded-md border bg-transparent p-2 font-mono text-xs"
            {...register("noProxy")}
          />
          <p
            id="outbound-proxy-no-proxy-hint"
            className="text-xs text-muted-foreground"
          >
            Hosts the proxy is bypassed for, one per line: a name (with its
            subdomains), a .domain or an address. The AI Office host itself
            (localhost) is always reached directly.
          </p>
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
          Saved. It applies from the next request.
        </p>
      )}
      <Button
        pending={isSubmitting}
        type="submit"
        disabled={!isDirty || isSubmitting || session === undefined}
      >
        {isSubmitting ? "Saving…" : "Save proxy"}
      </Button>
    </form>
  );
}

/**
 * The proxy every request the AI Gateway makes upstream goes through, if
 * the Owner sets one (PRD FR-35).
 */
export function OutboundProxyCard() {
  const { data: settings, isError } = useQuery(outboundProxyQuery);
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>Outbound proxy</h2>
        </CardTitle>
        <CardDescription>
          While a proxy is set, everything the AI Gateway sends to AI Providers
          goes through it: model calls, model lists and prices, sign-ins and
          token refreshes. Requests from Agents&apos; sandboxes to the Gateway,
          and AI Office&apos;s own GitHub requests, do not.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isError && (
          <p role="alert" className="text-sm text-destructive">
            The outbound proxy could not be loaded.
          </p>
        )}
        {settings !== undefined && <OutboundProxyForm settings={settings} />}
      </CardContent>
    </Card>
  );
}
