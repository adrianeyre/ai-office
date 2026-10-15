import { requestBodiesSettingsSchema } from "@ai-office/shared";
import { queryOptions, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card.tsx";

import { getJson, readApiError, sendJson } from "./api.ts";
import { sessionQuery } from "./session.ts";

// Request history's body storage (PRD FR-44, §7): whether the AI Gateway
// keeps each request's and response's bodies, encrypted. On unless the
// Owner turns it off; turning it off keeps no more from then on.

/** Whether bodies are kept (`GET /api/office/request-bodies`). */
export const requestBodiesQuery = queryOptions({
  queryKey: ["office", "request-bodies"],
  queryFn: () =>
    getJson("/api/office/request-bodies", requestBodiesSettingsSchema),
});

export function RequestBodiesCard() {
  const queryClient = useQueryClient();
  const { data: settings, isError } = useQuery(requestBodiesQuery);
  const { data: session } = useQuery(sessionQuery);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string>();

  // The box shows the change at once, and goes back if it is not saved.
  const change = async (store: boolean) => {
    setBusy(true);
    setProblem(undefined);
    queryClient.setQueryData(requestBodiesQuery.queryKey, { store });
    const response = await sendJson(
      "PUT",
      "/api/office/request-bodies",
      { store },
      session?.csrfToken,
    );
    if (response.ok) {
      queryClient.setQueryData(
        requestBodiesQuery.queryKey,
        requestBodiesSettingsSchema.parse(await response.json()),
      );
    } else {
      queryClient.setQueryData(requestBodiesQuery.queryKey, { store: !store });
      const error = await readApiError(response);
      setProblem(error.message ?? "The setting was not saved.");
    }
    setBusy(false);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>Request history</h2>
        </CardTitle>
        <CardDescription>
          Every request through the AI Gateway is listed in{" "}
          <Link to="/gateway" className="underline">
            Gateway requests
          </Link>
          , with its tokens, cost and timings. Its bodies can be kept too,
          encrypted.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        {isError && (
          <p role="alert" className="text-sm text-destructive">
            The setting could not be loaded.
          </p>
        )}
        {settings !== undefined && (
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={settings.store}
              disabled={busy || session === undefined}
              onChange={(event) => void change(event.target.checked)}
            />
            Keep request and response bodies (encrypted)
          </label>
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
