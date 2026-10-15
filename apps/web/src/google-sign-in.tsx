import {
  googleClientRequestSchema,
  googleServiceNames,
  googleSignInSchema,
  googleSignInStartSchema,
  type GoogleSignIn,
} from "@ai-office/shared";
import { queryOptions, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { LogIn, LogOut } from "lucide-react";
import { useEffect, useRef, useState } from "react";
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
import { PageHeader } from "@/components/ui/page-header.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";

import { browser, getJson, readApiError, sendDelete, sendJson } from "./api.ts";
import { sessionQuery } from "./session.ts";

// Google sign-in in the office admin (PRD FR-91, FR-93): the OAuth client
// the Owner registers in Google Cloud (its secret typed in once, never
// shown again), and the one Google account the Google Connections publish
// through. Signing in asks only for the scopes of the services the Google
// Connections use. Google sends the Owner back to `GoogleRedirectPage`,
// which hands what it brought to the API.

/** Google sign-in (`GET /api/google`). */
export const googleSignInQuery = queryOptions({
  queryKey: ["google"],
  queryFn: () => getJson("/api/google", googleSignInSchema),
});

const servicesText = (services: GoogleSignIn["services"]): string =>
  services.map((service) => googleServiceNames[service]).join(", ");

/** Where Google sign-in is, in a sentence. */
export function googleStatusText(google: GoogleSignIn): string {
  switch (google.status) {
    case "not_configured":
      return "Not set up: enter the OAuth client you registered in Google Cloud.";
    case "signed_out":
      return "No Google account is signed in: the Google Connections publish nothing.";
    case "revoked":
      return "Google refused AI Office's sign-in: the grant was revoked or has expired. The Google Connections are failing until you sign in again.";
    case "signed_in":
      return `Signed in${
        google.signedInAt === null
          ? ""
          : ` ${new Date(google.signedInAt).toLocaleString()}`
      }${
        google.missingServices.length > 0
          ? `, but ${servicesText(google.missingServices)} was not allowed: sign in again to allow it.`
          : google.services.length > 0
            ? `, allowing ${servicesText(google.services)}.`
            : "."
      }`;
  }
}

interface ClientValues {
  clientId: string;
  clientSecret: string;
}

/** The OAuth client, Google sign-in's status, and signing in and out. */
export function GoogleSignInCard() {
  const queryClient = useQueryClient();
  const google = useQuery(googleSignInQuery);
  const { data: session } = useQuery(sessionQuery);
  const [problems, setProblems] = useState<string[]>([]);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const {
    register,
    handleSubmit,
    reset,
    formState: { isSubmitting },
  } = useForm<ClientValues>({
    defaultValues: { clientId: "", clientSecret: "" },
  });

  useEffect(() => {
    if (google.data?.clientId != null) {
      reset({ clientId: google.data.clientId, clientSecret: "" });
    }
  }, [google.data?.clientId, reset]);

  const refresh = async (data?: unknown) => {
    if (data !== undefined) {
      queryClient.setQueryData(
        googleSignInQuery.queryKey,
        googleSignInSchema.parse(data),
      );
    }
    await queryClient.invalidateQueries({ queryKey: ["google"] });
  };

  const onSave = async (values: ClientValues) => {
    setSaved(false);
    const parsed = googleClientRequestSchema.safeParse(values);
    if (!parsed.success) {
      setProblems(parsed.error.issues.map(({ message }) => message));
      return;
    }
    const response = await sendJson(
      "PUT",
      "/api/google/client",
      parsed.data,
      session?.csrfToken,
    );
    if (!response.ok) {
      const error = await readApiError(response);
      setProblems(error.problems ?? [error.message ?? "It was not saved."]);
      return;
    }
    setProblems([]);
    setSaved(true);
    // The secret is not kept here either.
    reset({ clientId: parsed.data.clientId, clientSecret: "" });
    await refresh(await response.json());
  };

  const signIn = async () => {
    setBusy(true);
    try {
      const response = await sendJson(
        "POST",
        "/api/google/sign-in",
        {},
        session?.csrfToken,
      );
      if (!response.ok) {
        const error = await readApiError(response);
        setProblems([error.message ?? "Google sign-in could not begin."]);
        return;
      }
      const { url } = googleSignInStartSchema.parse(await response.json());
      browser.load(url);
    } finally {
      setBusy(false);
    }
  };

  const signOut = async () => {
    setBusy(true);
    try {
      const response = await sendDelete(
        "/api/google/sign-in",
        session?.csrfToken,
      );
      if (response.ok) {
        await refresh(await response.json());
      }
    } finally {
      setBusy(false);
    }
  };

  const data = google.data;
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>Google sign-in</h2>
        </CardTitle>
        <CardDescription>
          The Google Connections (Google Sheets, Docs, Slides, Drive and
          Calendar) publish through one Google account, signed in through an
          OAuth client you register in Google Cloud. Signing in asks only for
          what the Google Connections need.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {google.isError && (
          <p role="alert" className="text-sm text-destructive">
            Google sign-in could not be loaded.
          </p>
        )}
        {data !== undefined && (
          <>
            <p
              role={data.status === "revoked" ? "alert" : "status"}
              className={
                data.status === "revoked"
                  ? "text-sm text-destructive"
                  : "text-sm"
              }
            >
              {googleStatusText(data)}
            </p>
            <dl className="grid gap-1 text-sm sm:grid-cols-[auto_1fr] sm:gap-x-4">
              <dt className="text-muted-foreground">Redirect URI</dt>
              <dd>
                <code className="break-all">{data.redirectUri}</code>
              </dd>
              <dt className="text-muted-foreground">Asks for</dt>
              <dd>
                {data.scopes.length === 0 ? (
                  "Nothing yet: add a Google Connection first."
                ) : (
                  <ul>
                    {data.scopes.map((scope) => (
                      <li key={scope}>
                        <code className="break-all">{scope}</code>
                      </li>
                    ))}
                  </ul>
                )}
              </dd>
            </dl>
            <div className="flex flex-wrap gap-2">
              {data.status !== "not_configured" && (
                <Button
                  type="button"
                  onClick={() => void signIn()}
                  disabled={
                    busy || session === undefined || data.scopes.length === 0
                  }
                >
                  <LogIn aria-hidden />
                  {data.status === "signed_in"
                    ? "Sign in to Google again"
                    : "Sign in to Google"}
                </Button>
              )}
              {data.status === "signed_in" && (
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => void signOut()}
                  disabled={busy || session === undefined}
                >
                  <LogOut aria-hidden />
                  Sign out of Google
                </Button>
              )}
            </div>
          </>
        )}
        <form
          noValidate
          aria-label="OAuth client"
          className="space-y-4"
          onSubmit={(event) => void handleSubmit(onSave)(event)}
        >
          <h3 className="text-sm font-medium">OAuth client</h3>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="google-client-id">Client ID</Label>
              <Input
                id="google-client-id"
                autoComplete="off"
                placeholder="….apps.googleusercontent.com"
                {...register("clientId")}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="google-client-secret">Client secret</Label>
              <Input
                id="google-client-secret"
                type="password"
                autoComplete="off"
                placeholder={data?.clientId == null ? "GOCSPX-…" : "Unchanged"}
                aria-describedby="google-client-hint"
                {...register("clientSecret")}
              />
            </div>
          </div>
          <p id="google-client-hint" className="text-xs text-muted-foreground">
            In Google Cloud, enable the APIs of the Google Connections you use
            (Google Sheets; Google Drive, with Docs and Slides for theirs;
            Google Calendar), then create an OAuth client ID of type Web
            application with the redirect URI above. The secret is stored
            encrypted and never shown again; a new client ID signs the Google
            account out.
          </p>
          {problems.length > 0 && (
            <div role="alert">
              <ul className="space-y-1 text-sm text-destructive">
                {problems.map((problem) => (
                  <li key={problem}>{problem}</li>
                ))}
              </ul>
            </div>
          )}
          {saved && (
            <p role="status" className="text-sm">
              The OAuth client was saved.
            </p>
          )}
          <Button
            pending={isSubmitting}
            type="submit"
            variant="outline"
            disabled={isSubmitting || session === undefined}
          >
            {isSubmitting ? "Saving…" : "Save the OAuth client"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}

/**
 * `/admin/connections/google`: where Google sends the Owner back after the
 * consent screen. It hands the code (or why there is none) and the state
 * to the API once, then says how it went.
 */
export function GoogleRedirectPage({
  code,
  state,
  error,
}: {
  code?: string | undefined;
  state?: string | undefined;
  error?: string | undefined;
}) {
  const queryClient = useQueryClient();
  const { data: session } = useQuery(sessionQuery);
  const [outcome, setOutcome] = useState<
    | { readonly signedIn: GoogleSignIn }
    | { readonly problem: string }
    | undefined
  >(
    state === undefined || (code === undefined && error === undefined)
      ? { problem: "Google sent nothing back to finish the sign-in with." }
      : undefined,
  );
  // Each code is handed over once, however often this renders.
  const sent = useRef(false);

  useEffect(() => {
    if (sent.current || session === undefined || state === undefined) {
      return;
    }
    const body =
      code !== undefined
        ? { code, state }
        : error === undefined
          ? undefined
          : { error, state };
    if (body === undefined) {
      return;
    }
    sent.current = true;
    void (async () => {
      const response = await sendJson(
        "POST",
        "/api/google/sign-in/complete",
        body,
        session.csrfToken,
      );
      if (!response.ok) {
        const problem = await readApiError(response);
        setOutcome({
          problem: problem.message ?? "Google sign-in did not finish.",
        });
        return;
      }
      const signedIn = googleSignInSchema.parse(await response.json());
      queryClient.setQueryData(googleSignInQuery.queryKey, signedIn);
      setOutcome({ signedIn });
    })();
  }, [code, error, queryClient, session, state]);

  return (
    <section className="space-y-6">
      <PageHeader
        title="Google sign-in"
        eyebrow={<Link to="/general-settings/connections">Connections</Link>}
      />
      {outcome === undefined && (
        <p role="status" className="flex items-center gap-2">
          <Spinner />
          Signing in to Google…
        </p>
      )}
      {outcome !== undefined && "signedIn" in outcome && (
        <p role="status">{googleStatusText(outcome.signedIn)}</p>
      )}
      {outcome !== undefined && "problem" in outcome && (
        <p role="alert" className="text-destructive">
          {outcome.problem}
        </p>
      )}
      {outcome !== undefined && (
        <p>
          <Link
            to="/general-settings/connections"
            className="font-medium underline underline-offset-4"
          >
            Back to Connections
          </Link>
        </p>
      )}
    </section>
  );
}
