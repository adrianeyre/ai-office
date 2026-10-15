import { totpCodeRequestSchema } from "@ai-office/shared";
import { zodResolver } from "@hookform/resolvers/zod";
import { useState } from "react";
import { useForm } from "react-hook-form";
import type { z } from "zod";

import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Label } from "@/components/ui/label.tsx";

type FormValues = z.input<typeof totpCodeRequestSchema>;

/**
 * A form for one code: a TOTP code, or (where `acceptsRecoveryCode`) a
 * recovery code. `onSubmit` resolves with a problem to show, or nothing.
 */
export function CodeForm({
  id,
  label,
  hint,
  submitLabel,
  submittingLabel,
  acceptsRecoveryCode = false,
  autoFocus = false,
  onSubmit,
}: {
  id: string;
  label: string;
  hint: string;
  submitLabel: string;
  submittingLabel: string;
  acceptsRecoveryCode?: boolean;
  autoFocus?: boolean;
  onSubmit: (code: string) => Promise<string | undefined>;
}) {
  const [problem, setProblem] = useState<string>();
  const {
    register,
    handleSubmit,
    resetField,
    setFocus,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    resolver: zodResolver(totpCodeRequestSchema),
    defaultValues: { code: "" },
  });

  const submit = async ({ code }: FormValues) => {
    setProblem(undefined);
    const found = await onSubmit(code.trim());
    if (found !== undefined) {
      setProblem(found);
      resetField("code");
      setFocus("code");
    }
  };

  return (
    <form
      noValidate
      className="space-y-4"
      onSubmit={(event) => void handleSubmit(submit)(event)}
    >
      <div className="space-y-2">
        <Label htmlFor={id}>{label}</Label>
        <Input
          id={id}
          autoComplete="one-time-code"
          inputMode={acceptsRecoveryCode ? "text" : "numeric"}
          spellCheck={false}
          autoFocus={autoFocus}
          aria-invalid={errors.code || problem ? true : undefined}
          aria-describedby={`${id}-hint`}
          {...register("code")}
        />
        <p id={`${id}-hint`} className="text-xs text-muted-foreground">
          {hint}
        </p>
        {errors.code && (
          <p role="alert" className="text-sm text-destructive">
            Enter the code.
          </p>
        )}
      </div>
      {problem !== undefined && (
        <p role="alert" className="text-sm text-destructive">
          {problem}
        </p>
      )}
      <Button pending={isSubmitting} type="submit" disabled={isSubmitting}>
        {isSubmitting ? submittingLabel : submitLabel}
      </Button>
    </form>
  );
}
