import {
  totpEnableResponseSchema,
  totpSetupResponseSchema,
  type TotpSetupRequest,
  type TotpSetupResponse,
} from "@ai-office/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ShieldAlert } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button.tsx";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card.tsx";

import { postJson, readApiError } from "./api.ts";
import { CodeForm } from "./code-form.tsx";
import { OwnerProofFields, useOwnerProof } from "./owner-proof.tsx";
import { sessionQuery, totpQuery } from "./session.ts";

/**
 * Whether the page is served from this machine. Anything else crosses a
 * network, so TOTP is recommended (PRD FR-3).
 */
export function isLocalhost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[(.*)\]$/, "$1");
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "::1" ||
    /^127(?:\.\d{1,3}){3}$/.test(host)
  );
}

/** Where the page is served from; tests replace it. */
export const location = {
  hostname: (): string => window.location.hostname,
};

type Step =
  | { readonly name: "status" }
  | { readonly name: "prove" }
  | { readonly name: "confirm"; readonly setup: TotpSetupResponse }
  | { readonly name: "recovery-codes"; readonly codes: readonly string[] }
  | { readonly name: "disable" };

/**
 * The TOTP section of the office admin (PRD FR-3, FR-65). Turning TOTP on
 * first asks for the current password (A1-3), so a stolen session cannot
 * lock the Owner out with a secret of its own.
 */
export function TotpSettings() {
  const queryClient = useQueryClient();
  const { data: status, isError } = useQuery(totpQuery);
  const { data: session } = useQuery(sessionQuery);
  const proof = useOwnerProof();
  const [step, setStep] = useState<Step>({ name: "status" });
  const [problem, setProblem] = useState<string>();
  const [settingUp, setSettingUp] = useState(false);
  const csrfToken = session?.csrfToken;

  const setUp = async () => {
    setProblem(undefined);
    if (!proof.ready()) {
      return;
    }
    // TOTP is off, so the password is the whole proof.
    const body: TotpSetupRequest = {
      currentPassword: proof.proof.currentPassword,
    };
    setSettingUp(true);
    const response = await postJson("/api/totp/setup", body, csrfToken);
    setSettingUp(false);
    if (!response.ok) {
      const error = await readApiError(response);
      if (!proof.refused(error)) {
        setProblem(error.message ?? "TOTP could not be set up.");
      }
      return;
    }
    proof.reset();
    setStep({
      name: "confirm",
      setup: totpSetupResponseSchema.parse(await response.json()),
    });
  };

  const enable = async (code: string) => {
    const response = await postJson("/api/totp/enable", { code }, csrfToken);
    if (!response.ok) {
      return (
        (await readApiError(response)).message ?? "TOTP was not turned on."
      );
    }
    const { recoveryCodes } = totpEnableResponseSchema.parse(
      await response.json(),
    );
    setStep({ name: "recovery-codes", codes: recoveryCodes });
    await queryClient.invalidateQueries(totpQuery);
    return undefined;
  };

  const disable = async (code: string) => {
    const response = await postJson("/api/totp/disable", { code }, csrfToken);
    if (!response.ok) {
      return (
        (await readApiError(response)).message ?? "TOTP was not turned off."
      );
    }
    setStep({ name: "status" });
    await queryClient.invalidateQueries(totpQuery);
    return undefined;
  };

  const recommend =
    status?.enabled === false && !isLocalhost(location.hostname());

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>Two-step sign-in (TOTP)</h2>
        </CardTitle>
        <CardDescription>
          After the password, signing in also asks for a code from an
          authenticator app, or one of ten single-use recovery codes.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {isError && (
          <p role="alert" className="text-sm text-destructive">
            The TOTP status could not be loaded.
          </p>
        )}
        {recommend && (
          <p
            role="note"
            className="flex items-start gap-2 rounded-md border border-tone-warning-foreground/40 bg-tone-warning p-3 text-sm text-tone-warning-foreground"
          >
            <ShieldAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
            You are reaching AI Office over a network, not from this machine.
            Turning on TOTP is recommended.
          </p>
        )}

        {step.name === "status" && status !== undefined && (
          <>
            <p className="text-sm">
              {status.enabled
                ? `TOTP is on. ${String(status.recoveryCodesLeft)} of 10 recovery codes are left.`
                : "TOTP is off."}
            </p>
            {status.enabled ? (
              <Button
                variant="outline"
                onClick={() => {
                  setProblem(undefined);
                  setStep({ name: "disable" });
                }}
              >
                Turn off TOTP
              </Button>
            ) : (
              <Button
                disabled={csrfToken === undefined}
                onClick={() => {
                  setProblem(undefined);
                  proof.reset();
                  setStep({ name: "prove" });
                }}
              >
                Turn on TOTP
              </Button>
            )}
          </>
        )}

        {step.name === "prove" && (
          <form
            noValidate
            aria-label="Turn on TOTP"
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              void setUp();
            }}
          >
            <OwnerProofFields
              id="totp-proof"
              reason="Turning on TOTP changes how you sign in, so confirm it with the password you sign in with."
              state={proof}
            />
            <div className="flex flex-wrap gap-2">
              <Button
                pending={settingUp}
                type="submit"
                disabled={
                  settingUp || csrfToken === undefined || !proof.canProve
                }
              >
                {settingUp ? "Checking…" : "Continue"}
              </Button>
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  proof.reset();
                  setStep({ name: "status" });
                }}
              >
                Cancel
              </Button>
            </div>
          </form>
        )}

        {step.name === "confirm" && (
          <div className="space-y-4">
            <p className="text-sm">
              Scan this QR code with your authenticator app, or type in the
              secret. Then enter the code the app shows.
            </p>
            <img
              src={step.setup.qrCode}
              alt="QR code to add AI Office to an authenticator app"
              className="size-48 rounded-md bg-white p-2"
            />
            <p className="text-sm">
              Secret:{" "}
              <code className="rounded bg-muted px-1 py-0.5 font-mono break-all">
                {step.setup.secret}
              </code>
            </p>
            <CodeForm
              id="totp-confirm"
              label="Code from the app"
              hint="Six digits."
              submitLabel="Turn on TOTP"
              submittingLabel="Checking…"
              onSubmit={enable}
            />
            <Button
              variant="ghost"
              onClick={() => {
                setStep({ name: "status" });
              }}
            >
              Cancel
            </Button>
          </div>
        )}

        {step.name === "recovery-codes" && (
          <div className="space-y-4">
            <p className="text-sm font-medium">
              TOTP is on. Save these recovery codes somewhere safe: each one
              signs you in once without the app, and they will not be shown
              again.
            </p>
            <ul
              aria-label="Recovery codes"
              className="grid grid-cols-2 gap-2 font-mono text-sm"
            >
              {step.codes.map((code) => (
                <li key={code} className="rounded bg-muted px-2 py-1">
                  {code}
                </li>
              ))}
            </ul>
            <Button
              onClick={() => {
                setStep({ name: "status" });
              }}
            >
              I have saved them
            </Button>
          </div>
        )}

        {step.name === "disable" && (
          <div className="space-y-4">
            <CodeForm
              id="totp-disable"
              label="Code from the app, or a recovery code"
              hint="Turning TOTP off needs a current code."
              submitLabel="Turn off TOTP"
              submittingLabel="Checking…"
              acceptsRecoveryCode
              onSubmit={disable}
            />
            <Button
              variant="ghost"
              onClick={() => {
                setStep({ name: "status" });
              }}
            >
              Cancel
            </Button>
          </div>
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
