import {
  apiErrorCodes,
  ownerPasswordSchema,
  passwordMinLength,
  passwordProblems,
  passphraseLength,
} from "@ai-office/shared";
import { zodResolver } from "@hookform/resolvers/zod";
import { useState } from "react";
import { useForm, useWatch } from "react-hook-form";
import { z } from "zod";

import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Label } from "@/components/ui/label.tsx";

import { browser, postJson, readApiError } from "./api.ts";
import { SignedOutFrame } from "./signed-out-frame.tsx";

const formSchema = z
  .object({
    password: ownerPasswordSchema,
    confirm: z.string(),
    token: z.string(),
  })
  .refine((values) => values.password === values.confirm, {
    path: ["confirm"],
    message: "The passwords do not match.",
  });

type FormValues = z.infer<typeof formSchema>;

/**
 * The first-run setup screen: the Owner sets AI Office's password (FR-1).
 * From another machine the server also asks for the one-time setup token
 * it wrote to a file as it started (A1-2); the field appears then, with
 * the server's word on where the token is.
 */
export function SetupPage() {
  const [serverProblems, setServerProblems] = useState<string[]>([]);
  const [tokenHelp, setTokenHelp] = useState<string>();
  const {
    register,
    handleSubmit,
    control,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: { password: "", confirm: "", token: "" },
  });

  const onSubmit = async (values: FormValues) => {
    setServerProblems([]);
    const token = values.token.trim();
    const response = await postJson("/api/setup", {
      password: values.password,
      ...(token === "" ? {} : { token }),
    });
    // Straight on to sign in with the new password: nothing of the app
    // shows before the Owner has signed in.
    if (response.ok) {
      browser.load("/login");
      return;
    }
    if (response.status === 404) {
      setServerProblems(["A password has already been set."]);
      return;
    }
    const error = await readApiError(response);
    if (error.error === apiErrorCodes.setupTokenRequired) {
      const first = tokenHelp === undefined;
      setTokenHelp(error.message ?? "Enter the setup token.");
      if (first) {
        return;
      }
      setServerProblems(["That setup token is not right."]);
      return;
    }
    setServerProblems(
      error.problems ?? [error.message ?? "The password was not set."],
    );
  };

  const password = useWatch({ control, name: "password" });
  const passwordHelp = errors.password ? passwordProblems(password) : [];

  return (
    <SignedOutFrame
      title="Welcome to AI Office"
      description="Set the password you will sign in with. There is no other way in, so keep it somewhere safe."
    >
      <form
        noValidate
        className="space-y-4"
        onSubmit={(event) => void handleSubmit(onSubmit)(event)}
      >
        <div className="space-y-2">
          <Label htmlFor="password">Password</Label>
          <Input
            id="password"
            type="password"
            autoComplete="new-password"
            aria-invalid={errors.password ? true : undefined}
            aria-describedby="password-rules"
            {...register("password")}
          />
          <p id="password-rules" className="text-xs text-muted-foreground">
            At least {passwordMinLength} characters mixing three of lower case,
            upper case, digits and symbols, or a passphrase of{" "}
            {passphraseLength} or more.
          </p>
          {passwordHelp.length > 0 && (
            <div role="alert">
              <ul className="space-y-1 text-sm text-destructive">
                {passwordHelp.map((problem) => (
                  <li key={problem}>{problem}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
        <div className="space-y-2">
          <Label htmlFor="confirm">Confirm password</Label>
          <Input
            id="confirm"
            type="password"
            autoComplete="new-password"
            aria-invalid={errors.confirm ? true : undefined}
            {...register("confirm")}
          />
          {errors.confirm?.message !== undefined && (
            <p role="alert" className="text-sm text-destructive">
              {errors.confirm.message}
            </p>
          )}
        </div>
        {tokenHelp !== undefined && (
          <div className="space-y-2">
            <Label htmlFor="token">Setup token</Label>
            <Input
              id="token"
              autoComplete="off"
              spellCheck={false}
              aria-describedby="token-help"
              autoFocus
              {...register("token")}
            />
            <p id="token-help" className="text-xs text-muted-foreground">
              {tokenHelp}
            </p>
          </div>
        )}
        {serverProblems.length > 0 && (
          <div role="alert">
            <ul className="space-y-1 text-sm text-destructive">
              {serverProblems.map((problem) => (
                <li key={problem}>{problem}</li>
              ))}
            </ul>
          </div>
        )}
        <Button
          pending={isSubmitting}
          type="submit"
          className="w-full"
          disabled={isSubmitting}
        >
          {isSubmitting ? "Setting the password…" : "Set password"}
        </Button>
      </form>
    </SignedOutFrame>
  );
}
