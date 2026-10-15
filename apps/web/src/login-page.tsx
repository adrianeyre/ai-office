import {
  apiErrorCodes,
  apiKeyLoginRequestSchema,
  loginRequestSchema,
  loginResponseSchema,
} from "@ai-office/shared";
import { zodResolver } from "@hookform/resolvers/zod";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import type { z } from "zod";

import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Label } from "@/components/ui/label.tsx";

import { browser, postJson, readApiError } from "./api.ts";
import { CodeForm } from "./code-form.tsx";
import { sessionLength } from "./session-length.ts";
import { SignedOutFrame } from "./signed-out-frame.tsx";
import {
  forgetStillSignIn,
  readStillSignIn,
  type StillSignIn,
} from "./still-sign-in.ts";

type FormValues = z.infer<typeof loginRequestSchema>;

/**
 * The login page (PRD FR-2): the password, then, when TOTP is on (FR-3),
 * a code from the authenticator app or a recovery code. Or an API key
 * whose access is the AI proxy and UI, made in API Key Management. Just
 * signed out everywhere, it says once what still signs in (A1-3).
 */
export function LoginPage() {
  const [step, setStep] = useState<"password" | "code" | "api-key">("password");
  const [notice, setNotice] = useState<string>();
  const [stillSignIn] = useState(readStillSignIn);
  useEffect(() => {
    forgetStillSignIn();
  }, []);

  if (step === "code") {
    const submitCode = async (code: string) => {
      const response = await postJson("/api/login/totp", { code });
      if (response.ok) {
        browser.load("/");
        return undefined;
      }
      const error = await readApiError(response);
      if (error.error === apiErrorCodes.signInExpired) {
        setNotice("That took too long. Enter the password again.");
        setStep("password");
        return undefined;
      }
      return error.message ?? "Signing in failed.";
    };
    return (
      <SignedOutFrame
        title="Sign in"
        description="Enter the code from your authenticator app."
      >
        <CodeForm
          id="code"
          label="Code"
          hint="Six digits from the app, or one of your recovery codes."
          submitLabel="Sign in"
          submittingLabel="Signing in…"
          acceptsRecoveryCode
          autoFocus
          onSubmit={submitCode}
        />
      </SignedOutFrame>
    );
  }
  if (step === "api-key") {
    return (
      <ApiKeyStep
        onPassword={() => {
          setStep("password");
        }}
      />
    );
  }
  return (
    <PasswordStep
      notice={notice}
      stillSignIn={stillSignIn}
      onSecondFactor={() => {
        setNotice(undefined);
        setStep("code");
      }}
      onApiKey={() => {
        setNotice(undefined);
        setStep("api-key");
      }}
    />
  );
}

/** Signing in with an API key that has UI access. */
function ApiKeyStep({ onPassword }: { onPassword: () => void }) {
  const [problem, setProblem] = useState<string>();
  const {
    register,
    handleSubmit,
    resetField,
    setFocus,
    formState: { errors, isSubmitting },
  } = useForm<{ key: string }>({
    resolver: zodResolver(apiKeyLoginRequestSchema),
    defaultValues: { key: "" },
  });

  const onSubmit = async (values: { key: string }) => {
    setProblem(undefined);
    const response = await postJson("/api/login/api-key", values);
    if (response.ok) {
      browser.load("/");
      return;
    }
    const error = await readApiError(response);
    if (error.error === "setup_required") {
      browser.load("/setup");
      return;
    }
    setProblem(error.message ?? "Signing in failed.");
    resetField("key");
    setFocus("key");
  };

  return (
    <SignedOutFrame
      title="Sign in"
      description="Enter an API key with AI proxy and UI access."
    >
      <form
        noValidate
        aria-label="Sign in with an API key"
        className="space-y-4"
        onSubmit={(event) => void handleSubmit(onSubmit)(event)}
      >
        <div className="space-y-2">
          <Label htmlFor="api-key">API key</Label>
          <Input
            id="api-key"
            type="password"
            autoComplete="off"
            autoFocus
            aria-invalid={errors.key || problem ? true : undefined}
            {...register("key")}
          />
          {errors.key && (
            <p role="alert" className="text-sm text-destructive">
              Enter the API key.
            </p>
          )}
        </div>
        {problem !== undefined && (
          <p role="alert" className="text-sm text-destructive">
            {problem}
          </p>
        )}
        <Button
          pending={isSubmitting}
          type="submit"
          className="w-full"
          disabled={isSubmitting}
        >
          {isSubmitting ? "Signing in…" : "Sign in"}
        </Button>
        <Button
          type="button"
          variant="ghost"
          className="w-full"
          onClick={onPassword}
        >
          Use the password instead
        </Button>
      </form>
    </SignedOutFrame>
  );
}

/** What still signs in after signing out everywhere, by name. */
function StillSignInNotice({ stillSignIn }: { stillSignIn: StillSignIn }) {
  const groups = [
    ["still-sign-in-passwords", "Owner passwords", stillSignIn.passwords],
    ["still-sign-in-api-keys", "API keys with UI access", stillSignIn.apiKeys],
  ] as const;
  return (
    <div role="status" className="mb-4 space-y-2 rounded-md border p-3 text-sm">
      <p className="font-medium">You are signed out everywhere.</p>
      <p>
        Signing out removes no password and no API key. These still sign in:
      </p>
      {groups.map(([id, title, names]) => (
        <div key={id}>
          <p id={id} className="font-medium">
            {title}
          </p>
          {names.length === 0 ? (
            <p className="text-muted-foreground">None.</p>
          ) : (
            <ul aria-labelledby={id} className="list-disc pl-5">
              {names.map((name, index) => (
                <li key={`${String(index)}-${name}`}>{name}</li>
              ))}
            </ul>
          )}
        </div>
      ))}
      <p>Sign in and remove any you do not recognise in API Key Management.</p>
    </div>
  );
}

function PasswordStep({
  notice,
  stillSignIn,
  onSecondFactor,
  onApiKey,
}: {
  notice: string | undefined;
  stillSignIn: StillSignIn | undefined;
  onSecondFactor: () => void;
  onApiKey: () => void;
}) {
  const [problem, setProblem] = useState<string | undefined>(notice);
  const {
    register,
    handleSubmit,
    resetField,
    setFocus,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    resolver: zodResolver(loginRequestSchema),
    defaultValues: { password: "" },
  });

  const onSubmit = async (values: FormValues) => {
    setProblem(undefined);
    const response = await postJson("/api/login", values);
    if (response.ok) {
      const body = loginResponseSchema.parse(await response.json());
      if ("secondFactor" in body) {
        onSecondFactor();
        return;
      }
      browser.load("/");
      return;
    }
    const error = await readApiError(response);
    if (error.error === "setup_required") {
      browser.load("/setup");
      return;
    }
    setProblem(error.message ?? "Signing in failed.");
    resetField("password");
    setFocus("password");
  };

  return (
    <SignedOutFrame title="Sign in" description="Enter the AI Office password.">
      {stillSignIn !== undefined && (
        <StillSignInNotice stillSignIn={stillSignIn} />
      )}
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
            autoComplete="current-password"
            autoFocus
            aria-invalid={errors.password || problem ? true : undefined}
            {...register("password")}
          />
          {errors.password && (
            <p role="alert" className="text-sm text-destructive">
              Enter the password.
            </p>
          )}
        </div>
        {problem !== undefined && (
          <p role="alert" className="text-sm text-destructive">
            {problem}
          </p>
        )}
        <Button
          pending={isSubmitting}
          type="submit"
          className="w-full"
          disabled={isSubmitting}
        >
          {isSubmitting ? "Signing in…" : "Sign in"}
        </Button>
        <Button
          type="button"
          variant="ghost"
          className="w-full"
          onClick={onApiKey}
        >
          Use an API key instead
        </Button>
        <p className="text-center text-xs text-muted-foreground">
          You stay signed in for {sessionLength}.
        </p>
      </form>
    </SignedOutFrame>
  );
}
