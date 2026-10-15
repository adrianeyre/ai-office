import {
  githubWebhookPath,
  webhookSettingsSchema,
  webhookSettingsUpdateSchema,
  type WebhookSettings,
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

/** The GitHub App's webhook settings (`GET /api/office/webhooks`). */
export const webhooksQuery = queryOptions({
  queryKey: ["office", "webhooks"],
  queryFn: () => getJson("/api/office/webhooks", webhookSettingsSchema),
});

/** The events the GitHub App's webhook should send. */
export const webhookEvents = [
  "Issues",
  "Label",
  "Pull request",
  "Check run",
  "Check suite",
] as const;

interface FormValues {
  enabled: boolean;
  secret: string;
}

const formValues = (settings: WebhookSettings): FormValues => ({
  enabled: settings.enabled,
  secret: "",
});

function WebhooksForm({ settings }: { settings: WebhookSettings }) {
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
    const parsed = webhookSettingsUpdateSchema.safeParse({
      enabled: values.enabled,
      ...(values.secret.trim() === "" ? {} : { secret: values.secret }),
    });
    if (!parsed.success) {
      setProblems(parsed.error.issues.map(({ message }) => message));
      return;
    }
    const response = await sendJson(
      "PUT",
      "/api/office/webhooks",
      parsed.data,
      session?.csrfToken,
    );
    if (!response.ok) {
      const error = await readApiError(response);
      setProblems(
        error.problems ?? [
          error.message ?? "The webhook settings were not saved.",
        ],
      );
      return;
    }
    const updated = webhookSettingsSchema.parse(await response.json());
    setProblems([]);
    setSaved(true);
    reset(formValues(updated));
    queryClient.setQueryData(webhooksQuery.queryKey, updated);
  };

  return (
    <form
      noValidate
      aria-label="GitHub webhooks"
      className="space-y-4"
      onSubmit={(event) => void handleSubmit(onSubmit)(event)}
    >
      <div className="flex items-center gap-2">
        <input
          id="webhooks-enabled"
          type="checkbox"
          className="size-4"
          {...register("enabled")}
        />
        <Label htmlFor="webhooks-enabled">Take the GitHub App's webhooks</Label>
      </div>
      <div className="space-y-2">
        <Label htmlFor="webhooks-secret">Webhook secret</Label>
        <Input
          id="webhooks-secret"
          type="password"
          autoComplete="off"
          aria-describedby="webhooks-secret-hint"
          {...register("secret")}
        />
        <p id="webhooks-secret-hint" className="text-sm text-muted-foreground">
          {settings.secretSet
            ? "A secret is kept. Leave this empty to keep it, or give a new one."
            : "The same secret as the GitHub App's, at least 20 characters."}
        </p>
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
          Saved.
        </p>
      )}
      <Button
        pending={isSubmitting}
        type="submit"
        disabled={!isDirty || isSubmitting || session === undefined}
      >
        {isSubmitting ? "Saving…" : "Save webhooks"}
      </Button>
    </form>
  );
}

/**
 * The GitHub App's webhooks (PRD FR-8): when GitHub can reach AI Office,
 * issues, labels, pull requests and checks are acted on at once rather
 * than at the next poll, which carries on in case a delivery is lost.
 */
export function WebhooksCard() {
  const { data: settings, isError } = useQuery(webhooksQuery);
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>GitHub webhooks</h2>
        </CardTitle>
        <CardDescription>
          Optional, and only for an AI Office GitHub can reach. Set the GitHub
          App&apos;s webhook URL to{" "}
          <code className="break-all">
            {window.location.origin}
            {githubWebhookPath}
          </code>{" "}
          (content type application/json), give it a secret, and subscribe to
          these events: {webhookEvents.join(", ")}. Intake still checks every
          interval, in case a delivery is lost.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isError && (
          <p role="alert" className="text-sm text-destructive">
            The webhook settings could not be loaded.
          </p>
        )}
        {settings !== undefined && <WebhooksForm settings={settings} />}
      </CardContent>
    </Card>
  );
}
