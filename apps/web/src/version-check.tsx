import {
  changelogUrl,
  compareVersions,
  latestVersionSchema,
  releasePageOf,
  releaseRepository,
} from "@ai-office/shared";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";

import { Button } from "@/components/ui/button.tsx";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card.tsx";
import { Dialog } from "@/components/ui/dialog.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";

import { ApiRequestError, getJson } from "./api.ts";
import { sessionQuery } from "./session.ts";

// The version check: whether the AI Office running (the version the footer
// shows) is the latest, from the root package.json on GitHub's `main`,
// which the server asks for (`GET /api/version/latest`), so the browser
// loads nothing from other sites. Admin's "Check for latest version" asks
// on demand; the app asks once as it opens, and says so only when a newer
// version is out. An answer that is not a version number is shown as a
// check that failed, never as a version.

export type VersionCheck =
  | { kind: "current"; running: string; latest: string }
  | { kind: "outOfDate"; running: string; latest: string }
  | { kind: "failed"; running: string; problem: string };

/** Whether `running` is the latest version, as the server finds out. */
export async function checkLatestVersion(
  running: string = __APP_VERSION__,
): Promise<VersionCheck> {
  try {
    const { version: latest } = await getJson(
      "/api/version/latest",
      latestVersionSchema,
    );
    return {
      kind: compareVersions(running, latest) < 0 ? "outOfDate" : "current",
      running,
      latest,
    };
  } catch (error) {
    return {
      kind: "failed",
      running,
      problem:
        error instanceof ApiRequestError
          ? error.message
          : error instanceof z.ZodError
            ? "The answer was not a version number."
            : "The server could not be reached.",
    };
  }
}

/** Links out of the dialog, which open in a new tab. */
function ExternalLink({ href, children }: { href: string; children: string }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
      <span className="sr-only">, opens in a new tab</span>
    </a>
  );
}

/** What a newer version is, and how to update to it. */
function OutOfDate({ running, latest }: { running: string; latest: string }) {
  return (
    <>
      <p role="status">
        <strong>AI Office {running} is out of date.</strong> The latest version
        is {latest}.
      </p>
      <h3>How to update</h3>
      <p>
        Back up the database first: migrations only go forward. Then, where AI
        Office runs, pull the new version and rebuild it; it applies any new
        migrations as it starts.
      </p>
      <pre className="version-check-commands">
        <code>{"git pull\ndocker compose up --build --detach --wait"}</code>
      </pre>
      <ul>
        <li>
          <ExternalLink href={releasePageOf(latest)}>
            {`What's new in AI Office ${latest}, its release on GitHub`}
          </ExternalLink>
        </li>
        <li>
          <ExternalLink href={changelogUrl}>The full changelog</ExternalLink>
        </li>
      </ul>
    </>
  );
}

/** Where the answer comes from, and what is sent. */
function Source() {
  return (
    <p className="policy-updated">
      AI Office&apos;s server asks GitHub for <code>{releaseRepository}</code>
      &apos;s <code>package.json</code>, and sends nothing else.
    </p>
  );
}

/**
 * Admin's "Check for latest version": asks each time it opens, and Check
 * again asks again. Says whether the version running is the latest, how to
 * update when it is not, and why it could not tell when GitHub could not
 * be reached.
 */
export function VersionCheckDialog({
  open,
  onClose,
  running = __APP_VERSION__,
}: {
  open: boolean;
  onClose: () => void;
  running?: string;
}) {
  const [check, setCheck] = useState<VersionCheck | null>(null);
  // Counts the questions asked, so only the last one's answer is shown.
  const asked = useRef(0);
  const ask = useCallback(() => {
    asked.current += 1;
    const mine = asked.current;
    void checkLatestVersion(running).then((result) => {
      if (asked.current === mine) {
        setCheck(result);
      }
    });
  }, [running]);

  useEffect(() => {
    if (!open) {
      return;
    }
    const questions = asked;
    ask();
    // Closed, whatever answer comes is for no one.
    return () => {
      questions.current += 1;
    };
  }, [open, ask]);

  const close = () => {
    setCheck(null);
    onClose();
  };

  return (
    <Dialog
      open={open}
      onClose={close}
      title="Check for latest version"
      closeLabel="Close version check"
      footer={
        <>
          <Button
            variant="outline"
            disabled={check === null}
            onClick={() => {
              setCheck(null);
              ask();
            }}
          >
            Check again
          </Button>
          <Button className="ml-auto" onClick={close}>
            Close
          </Button>
        </>
      }
    >
      {check === null ? (
        <p role="status" className="flex items-center gap-2">
          <Spinner />
          Asking GitHub for the latest version…
        </p>
      ) : check.kind === "current" ? (
        <p role="status">
          <strong>AI Office {check.running} is up to date.</strong> The latest
          version is {check.latest}.
        </p>
      ) : check.kind === "outOfDate" ? (
        <OutOfDate running={check.running} latest={check.latest} />
      ) : (
        <p role="alert">
          <strong>AI Office couldn&apos;t find out the latest version.</strong>{" "}
          {check.problem}
        </p>
      )}
      <Source />
    </Dialog>
  );
}

// Once per page load, however often the layout is drawn.
let askedAtStart = false;

/** Lets tests ask at start again, as a new page load would. */
export function forgetStartupVersionCheck(): void {
  askedAtStart = false;
}

/**
 * Asks once, as the app opens and once signed in, whether the version
 * running is the latest, and says so in a dialog only if a newer one is
 * out. Says nothing if it is the latest, or if GitHub could not be asked.
 */
export function StartupVersionCheck({
  running = __APP_VERSION__,
}: {
  running?: string;
}) {
  const { data: session } = useQuery(sessionQuery);
  const signedIn = session !== undefined;
  const [outOfDate, setOutOfDate] = useState<{
    running: string;
    latest: string;
  } | null>(null);

  useEffect(() => {
    if (!signedIn || askedAtStart) {
      return;
    }
    askedAtStart = true;
    let live = true;
    void checkLatestVersion(running).then((check) => {
      if (live && check.kind === "outOfDate") {
        setOutOfDate({ running: check.running, latest: check.latest });
      }
    });
    return () => {
      live = false;
    };
  }, [signedIn, running]);

  const close = () => {
    setOutOfDate(null);
  };
  return (
    <Dialog
      open={outOfDate !== null}
      onClose={close}
      title="A newer version of AI Office is out"
      closeLabel="Close newer version notice"
      footer={
        <Button className="ml-auto" onClick={close}>
          Close
        </Button>
      }
    >
      {outOfDate !== null && (
        <>
          <OutOfDate running={outOfDate.running} latest={outOfDate.latest} />
          <Source />
        </>
      )}
    </Dialog>
  );
}

/** Admin's last section: the version running, and the check. */
export function VersionCard() {
  const [open, setOpen] = useState(false);
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>Version</h2>
        </CardTitle>
        <CardDescription>
          Which version of AI Office this is, and whether a newer one is out.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm">
          You are on AI Office{" "}
          <strong className="tabular-nums">{__APP_VERSION__}</strong>.
        </p>
        <Button
          variant="outline"
          aria-haspopup="dialog"
          onClick={() => {
            setOpen(true);
          }}
        >
          Check for latest version
        </Button>
        <VersionCheckDialog
          open={open}
          onClose={() => {
            setOpen(false);
          }}
        />
      </CardContent>
    </Card>
  );
}
