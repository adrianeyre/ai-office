import { intakeSettingsSchema, type IntakeSettings } from "@ai-office/shared";
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

/** Intake's settings (`GET /api/office/intake`). */
export const intakeQuery = queryOptions({
  queryKey: ["office", "intake"],
  queryFn: () => getJson("/api/office/intake", intakeSettingsSchema),
});

interface FormValues {
  ownerLogin: string;
  intervalSeconds: string;
}

const formValues = (settings: IntakeSettings): FormValues => ({
  ownerLogin: settings.ownerLogin,
  intervalSeconds: String(settings.intervalSeconds),
});

function IntakeForm({ settings }: { settings: IntakeSettings }) {
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
    const parsed = intakeSettingsSchema.safeParse({
      ownerLogin: values.ownerLogin,
      intervalSeconds:
        values.intervalSeconds.trim() === ""
          ? undefined
          : Number(values.intervalSeconds),
    });
    if (!parsed.success) {
      setProblems(parsed.error.issues.map(({ message }) => message));
      return;
    }
    const response = await sendJson(
      "PUT",
      "/api/office/intake",
      parsed.data,
      session?.csrfToken,
    );
    if (!response.ok) {
      const error = await readApiError(response);
      setProblems(
        error.problems ?? [
          error.message ?? "Intake's settings were not saved.",
        ],
      );
      return;
    }
    const updated = intakeSettingsSchema.parse(await response.json());
    setProblems([]);
    setSaved(true);
    reset(formValues(updated));
    queryClient.setQueryData(intakeQuery.queryKey, updated);
  };

  return (
    <form
      noValidate
      aria-label="Intake"
      className="space-y-4"
      onSubmit={(event) => void handleSubmit(onSubmit)(event)}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="intake-owner-login">Your GitHub login</Label>
          <Input
            id="intake-owner-login"
            autoComplete="off"
            {...register("ownerLogin")}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="intake-interval">Check every (seconds)</Label>
          <Input
            id="intake-interval"
            type="number"
            inputMode="numeric"
            min={10}
            max={3600}
            {...register("intervalSeconds")}
          />
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
          Saved.
        </p>
      )}
      <Button
        pending={isSubmitting}
        type="submit"
        disabled={!isDirty || isSubmitting || session === undefined}
      >
        {isSubmitting ? "Saving…" : "Save intake"}
      </Button>
    </form>
  );
}

/**
 * Which issues AI Office takes in, and how often it looks (PRD FR-8): open
 * issues labelled ai-office, opened by the Owner or labelled by them.
 */
export function IntakeCard() {
  const { data: settings, isError } = useQuery(intakeQuery);
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>Intake</h2>
        </CardTitle>
        <CardDescription>
          AI Office works the open issues labelled ai-office on each Floor. It
          takes in only issues you opened, or that you labelled ai-office
          yourself: anyone else&apos;s are ignored.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isError && (
          <p role="alert" className="text-sm text-destructive">
            Intake&apos;s settings could not be loaded.
          </p>
        )}
        {settings !== undefined && <IntakeForm settings={settings} />}
      </CardContent>
    </Card>
  );
}
