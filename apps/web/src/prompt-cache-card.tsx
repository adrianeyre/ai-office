import {
  promptCacheSettingsSchema,
  promptCacheTtlLabels,
  promptCacheTtls,
  type PromptCacheTtl,
} from "@ai-office/shared";
import { queryOptions, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { Button } from "@/components/ui/button.tsx";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card.tsx";

import { getJson, readApiError, sendJson } from "./api.ts";
import { sessionQuery } from "./session.ts";

// The prompt-cache TTL (PRD §6.8): the TTL the AI Gateway gives every
// prompt-cache breakpoint of a request to Anthropic's API, one button
// each. It applies from the next request.

/** The prompt-cache TTL (`GET /api/office/prompt-cache`). */
export const promptCacheQuery = queryOptions({
  queryKey: ["office", "prompt-cache"],
  queryFn: () => getJson("/api/office/prompt-cache", promptCacheSettingsSchema),
});

const hints: Record<PromptCacheTtl, string> = {
  as_sent: "Each request keeps the TTL its agent tool asked for.",
  "5m": "Anthropic's default: the cheapest cache writes.",
  "1h": "Writes cost more, but the cache stays warm through longer pauses.",
};

export function PromptCacheCard() {
  const queryClient = useQueryClient();
  const { data: settings, isError } = useQuery(promptCacheQuery);
  const { data: session } = useQuery(sessionQuery);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string>();
  const [saved, setSaved] = useState(false);

  const choose = async (ttl: PromptCacheTtl) => {
    setBusy(true);
    setProblem(undefined);
    setSaved(false);
    const response = await sendJson(
      "PUT",
      "/api/office/prompt-cache",
      { ttl },
      session?.csrfToken,
    );
    if (response.ok) {
      queryClient.setQueryData(
        promptCacheQuery.queryKey,
        promptCacheSettingsSchema.parse(await response.json()),
      );
      setSaved(true);
    } else {
      const error = await readApiError(response);
      setProblem(
        error.problems?.[0] ?? error.message ?? "The TTL was not saved.",
      );
    }
    setBusy(false);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>Prompt cache TTL</h2>
        </CardTitle>
        <CardDescription>
          How long Anthropic keeps each prompt-cache breakpoint of a request the
          AI Gateway sends to Claude. It applies from the next request.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {isError && (
          <p role="alert" className="text-sm text-destructive">
            The prompt-cache TTL could not be loaded.
          </p>
        )}
        {settings !== undefined && (
          <>
            <div
              role="group"
              aria-label="Prompt cache TTL"
              className="flex flex-wrap gap-2"
            >
              {promptCacheTtls.map((ttl) => (
                <Button
                  key={ttl}
                  type="button"
                  size="sm"
                  variant={settings.ttl === ttl ? "default" : "outline"}
                  aria-pressed={settings.ttl === ttl}
                  disabled={busy || session === undefined}
                  onClick={() => void choose(ttl)}
                >
                  {promptCacheTtlLabels[ttl]}
                </Button>
              ))}
            </div>
            <p className="text-sm text-muted-foreground">
              {hints[settings.ttl]}
            </p>
          </>
        )}
        {saved && (
          <p role="status" className="text-sm">
            Saved: {settings && promptCacheTtlLabels[settings.ttl]}.
          </p>
        )}
        {problem !== undefined && (
          <p role="alert" className="text-sm text-destructive">
            {problem}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
