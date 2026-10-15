import {
  gitIdentitySchema,
  officeGitIdentitySchema,
  type OfficeGitIdentity,
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

/** The office's Git identity (`GET /api/office/git-identity`). */
export const gitIdentityQuery = queryOptions({
  queryKey: ["office", "git-identity"],
  queryFn: () => getJson("/api/office/git-identity", officeGitIdentitySchema),
});

interface FormValues {
  name: string;
  email: string;
}

function GitIdentityForm({ identity }: { identity: OfficeGitIdentity }) {
  const queryClient = useQueryClient();
  const { data: session } = useQuery(sessionQuery);
  const [problems, setProblems] = useState<string[]>([]);
  const [saved, setSaved] = useState(false);
  const {
    register,
    handleSubmit,
    reset,
    formState: { isDirty, isSubmitting },
  } = useForm<FormValues>({
    defaultValues: { name: identity.name, email: identity.email },
  });

  const onSubmit = async (values: FormValues) => {
    setSaved(false);
    const parsed = gitIdentitySchema.safeParse(values);
    if (!parsed.success) {
      setProblems(parsed.error.issues.map(({ message }) => message));
      return;
    }
    const response = await sendJson(
      "PUT",
      "/api/office/git-identity",
      parsed.data,
      session?.csrfToken,
    );
    if (!response.ok) {
      const error = await readApiError(response);
      setProblems(
        error.problems ?? [error.message ?? "The Git identity was not saved."],
      );
      return;
    }
    const updated = officeGitIdentitySchema.parse(await response.json());
    setProblems([]);
    setSaved(true);
    reset({ name: updated.name, email: updated.email });
    queryClient.setQueryData(gitIdentityQuery.queryKey, updated);
  };

  return (
    <form
      noValidate
      aria-label="Git identity"
      className="space-y-4"
      onSubmit={(event) => void handleSubmit(onSubmit)(event)}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="git-name">Name</Label>
          <Input id="git-name" autoComplete="off" {...register("name")} />
        </div>
        <div className="space-y-2">
          <Label htmlFor="git-email">Email</Label>
          <Input
            id="git-email"
            type="email"
            autoComplete="off"
            {...register("email")}
          />
        </div>
      </div>
      {identity.isDefault && !isDirty && (
        <p className="text-sm text-muted-foreground">
          This is the default: GitHub user adrianeyre, with their GitHub noreply
          address.
        </p>
      )}
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
        {isSubmitting ? "Saving…" : "Save Git identity"}
      </Button>
    </form>
  );
}

/**
 * Who agent commits are by (PRD FR-68): the author and committer of every
 * commit an Agent makes, unless its Floor sets its own.
 */
export function GitIdentityCard() {
  const { data: identity, isError } = useQuery(gitIdentityQuery);
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>Git identity</h2>
        </CardTitle>
        <CardDescription>
          Every commit an Agent makes is authored and committed as this
          identity, with an Agent: line naming the Agent. A Floor can set its
          own.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isError && (
          <p role="alert" className="text-sm text-destructive">
            The Git identity could not be loaded.
          </p>
        )}
        {identity !== undefined && <GitIdentityForm identity={identity} />}
      </CardContent>
    </Card>
  );
}
