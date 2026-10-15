import {
  apiErrorCodes,
  type ApiError,
  type OwnerProof,
} from "@ai-office/shared";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { Input } from "@/components/ui/input.tsx";
import { Label } from "@/components/ui/label.tsx";

import { sessionQuery, totpQuery } from "./session.ts";

// A fresh proof of the Owner (A1-3). A change that adds a way to sign in
// (adding an Owner password, making or widening an API key with UI access,
// turning TOTP on) asks for one of the Owner's passwords, and a code from
// the authenticator app (or a recovery code) when TOTP is on. A session
// begun with an API key cannot give one: it must sign in with a password.

/** What was wrong with the proof, by the field it was in, if one. */
interface ProofProblem {
  readonly field?: "currentPassword" | "code";
  readonly message: string;
}

/** The proof's fields, as `useOwnerProof` keeps them. */
export interface OwnerProofFieldsState {
  /** False in a session begun with an API key, which cannot give one. */
  readonly canProve: boolean;
  /** Whether TOTP is on, so a code is asked for too. */
  readonly needsCode: boolean;
  readonly currentPassword: string;
  readonly code: string;
  readonly setCurrentPassword: (value: string) => void;
  readonly setCode: (value: string) => void;
  readonly problem: ProofProblem | undefined;
  /** The proof to send with the change. */
  readonly proof: OwnerProof;
  /** Whether every field asked for is filled in; says which is not. */
  readonly ready: () => boolean;
  /** Shows `error` by the fields when it is about the proof; whether it was. */
  readonly refused: (error: ApiError) => boolean;
  /** Forgets what was typed, and any problem. */
  readonly reset: () => void;
}

/** The state of a proof's fields, for `OwnerProofFields`. */
export function useOwnerProof(): OwnerProofFieldsState {
  const { data: session } = useQuery(sessionQuery);
  const { data: totp } = useQuery(totpQuery);
  const [currentPassword, setCurrentPassword] = useState("");
  const [code, setCode] = useState("");
  const [problem, setProblem] = useState<ProofProblem>();
  const needsCode = totp?.enabled === true;

  return {
    canProve: (session?.gatewayKeyId ?? null) === null,
    needsCode,
    currentPassword,
    code,
    setCurrentPassword,
    setCode,
    problem,
    proof: {
      currentPassword,
      ...(needsCode ? { code: code.trim() } : {}),
    },
    ready: () => {
      if (currentPassword === "") {
        setProblem({
          field: "currentPassword",
          message: "Enter your current password.",
        });
        return false;
      }
      if (needsCode && code.trim() === "") {
        setProblem({ field: "code", message: "Enter the code." });
        return false;
      }
      setProblem(undefined);
      return true;
    },
    refused: (error) => {
      switch (error.error) {
        case apiErrorCodes.wrongPassword:
          setCurrentPassword("");
          setProblem({
            field: "currentPassword",
            message: "That is not your current password.",
          });
          return true;
        case apiErrorCodes.wrongCode:
          setCode("");
          setProblem({
            field: "code",
            message:
              error.message ?? "That code is not right, or was already used.",
          });
          return true;
        case apiErrorCodes.proofRequired:
        case apiErrorCodes.tooManyAttempts:
          setProblem({
            message: error.message ?? "The change needs your password.",
          });
          return true;
        default:
          return false;
      }
    },
    reset: () => {
      setCurrentPassword("");
      setCode("");
      setProblem(undefined);
    },
  };
}

/**
 * "Your current password" and, when TOTP is on, a code from the
 * authenticator app, saying first why (`reason`). In a session begun with
 * an API key, it says instead that the change needs a sign-in with a
 * password; the caller disables the change (`canProve`).
 */
export function OwnerProofFields({
  id,
  reason,
  state,
}: {
  id: string;
  reason: string;
  state: OwnerProofFieldsState;
}) {
  const { problem } = state;
  if (!state.canProve) {
    return (
      <p
        id={`${id}-api-key`}
        role="note"
        className="rounded-md border border-amber-500/50 bg-amber-500/10 p-3 text-sm"
      >
        You signed in with an API key, so you cannot do this here: it needs one
        of the Owner&apos;s passwords. Sign out, then sign in with a password.
      </p>
    );
  }
  const describedBy = (field: "currentPassword" | "code", hint: string) =>
    problem?.field === field ? `${hint} ${id}-${field}-problem` : hint;
  return (
    <fieldset className="space-y-3 rounded-md border p-3">
      <legend className="px-1 text-sm font-medium">Confirm it is you</legend>
      <div className="space-y-2">
        <Label htmlFor={`${id}-current-password`}>Your current password</Label>
        <Input
          id={`${id}-current-password`}
          type="password"
          autoComplete="current-password"
          aria-invalid={problem?.field === "currentPassword" ? true : undefined}
          aria-describedby={describedBy(
            "currentPassword",
            `${id}-current-password-hint`,
          )}
          value={state.currentPassword}
          onChange={(event) => {
            state.setCurrentPassword(event.target.value);
          }}
        />
        <p
          id={`${id}-current-password-hint`}
          className="text-xs text-muted-foreground"
        >
          {reason}
        </p>
        {problem?.field === "currentPassword" && (
          <p
            id={`${id}-currentPassword-problem`}
            role="alert"
            className="text-sm text-destructive"
          >
            {problem.message}
          </p>
        )}
      </div>
      {state.needsCode && (
        <div className="space-y-2">
          <Label htmlFor={`${id}-code`}>Code from your authenticator app</Label>
          <Input
            id={`${id}-code`}
            autoComplete="one-time-code"
            inputMode="text"
            spellCheck={false}
            aria-invalid={problem?.field === "code" ? true : undefined}
            aria-describedby={describedBy("code", `${id}-code-hint`)}
            value={state.code}
            onChange={(event) => {
              state.setCode(event.target.value);
            }}
          />
          <p id={`${id}-code-hint`} className="text-xs text-muted-foreground">
            Six digits from the app, or one of your recovery codes.
          </p>
          {problem?.field === "code" && (
            <p
              id={`${id}-code-problem`}
              role="alert"
              className="text-sm text-destructive"
            >
              {problem.message}
            </p>
          )}
        </div>
      )}
      {problem !== undefined && problem.field === undefined && (
        <p role="alert" className="text-sm text-destructive">
          {problem.message}
        </p>
      )}
    </fieldset>
  );
}
