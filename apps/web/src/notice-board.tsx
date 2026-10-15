import type { Floor, Notice } from "@ai-office/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { ExternalLink } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button.tsx";
import { Label } from "@/components/ui/label.tsx";
import { PageHeader } from "@/components/ui/page-header.tsx";
import { Badge } from "@/components/ui/badge.tsx";
import { cn, selectClass } from "@/lib/utils.ts";

import { postJson, readApiError } from "./api.ts";
import { AgentLink } from "./agent-link.tsx";
import { floorQuery, floorsQuery } from "./floors.ts";
import { noticesKey, noticesQuery, useLiveNotices } from "./notices.ts";
import { sessionQuery } from "./session.ts";

// The 2D Notice Board (PRD FR-48, FR-50): every Floor's open Notices, or
// one Floor's, kept live by the event stream. Each can be dismissed, and
// an action Notice's actions taken, in one click. An action taken on a
// page of AI Office (its `href`), such as signing in to an AI Account
// again, links there instead. A conflict between Roles (FR-30) shows its
// two positions side by side, wherever the Notice has the room.

function ExternalAnchor({ href, label }: { href: string; label: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1 hover:underline"
    >
      {label}
      <ExternalLink aria-hidden className="size-3" />
    </a>
  );
}

/** One Notice, with its links, its actions and Dismiss. */
export function NoticeItem({
  notice,
  floorName,
  highlighted,
}: {
  notice: Notice;
  floorName: string;
  highlighted: boolean;
}) {
  const queryClient = useQueryClient();
  const router = useRouter();
  const { data: session } = useQuery(sessionQuery);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string>();
  const item = useRef<HTMLLIElement>(null);
  const titleId = `${notice.id}-title`;

  useEffect(() => {
    if (highlighted) {
      item.current?.scrollIntoView({ block: "center" });
      item.current?.focus();
    }
  }, [highlighted]);

  const send = async (path: "dismiss" | "act", body: object) => {
    setBusy(true);
    setProblem(undefined);
    const response = await postJson(
      `/api/notices/${encodeURIComponent(notice.id)}/${path}`,
      body,
      session?.csrfToken,
    );
    if (!response.ok) {
      const error = await readApiError(response);
      setProblem(error.message ?? "That did not work.");
      setBusy(false);
    }
    // On success the Notice leaves the board, so this item goes too.
    await queryClient.invalidateQueries({ queryKey: noticesKey });
  };

  return (
    <li
      ref={item}
      id={notice.id}
      tabIndex={-1}
      aria-labelledby={titleId}
      aria-current={highlighted ? "true" : undefined}
      className={cn(
        "space-y-3 rounded-xl border bg-card p-4 shadow-sm outline-none",
        notice.kind === "action" &&
          "border-l-4 border-l-tone-warning-foreground",
        highlighted && "ring-[3px] ring-ring/50",
      )}
    >
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <Badge tone={notice.kind === "action" ? "warning" : "neutral"}>
          {notice.kind === "action" ? "Action" : "Info"}
        </Badge>
        <span>{floorName}</span>
        <time dateTime={notice.createdAt}>
          {new Date(notice.createdAt).toLocaleString()}
        </time>
      </div>
      <h2 id={titleId} className="font-medium">
        {notice.title}
      </h2>
      <ul aria-label="Links" className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
        {notice.issue !== null && (
          <li>
            <ExternalAnchor
              href={notice.issue.url}
              label={`Issue #${String(notice.issue.number)}`}
            />
          </li>
        )}
        {notice.pullRequest !== null && (
          <li>
            <ExternalAnchor
              href={notice.pullRequest.url}
              label={`PR #${String(notice.pullRequest.number)}`}
            />
          </li>
        )}
        {notice.ciRunUrl !== null && (
          <li>
            <ExternalAnchor href={notice.ciRunUrl} label="CI run" />
          </li>
        )}
        {notice.links.map(({ label, url }) => (
          <li key={url}>
            <ExternalAnchor href={url} label={label} />
          </li>
        ))}
        {notice.agentId !== null && notice.floorId !== null && (
          <li>
            <AgentLink floorId={notice.floorId} agentId={notice.agentId}>
              {(name) => (name === undefined ? "Agent" : `Agent: ${name}`)}
            </AgentLink>
          </li>
        )}
      </ul>
      {notice.positions.length > 0 && (
        <div className="@container">
          <ul aria-label="Positions" className="grid gap-3 @md:grid-cols-2">
            {notice.positions.map(({ label, text, url }) => (
              <li
                key={label}
                className="space-y-1 rounded-lg border bg-muted/40 p-3 text-sm"
              >
                <h3 className="font-medium">
                  {url === undefined ? (
                    label
                  ) : (
                    <ExternalAnchor href={url} label={label} />
                  )}
                </h3>
                <p className="whitespace-pre-line break-words text-muted-foreground">
                  {text}
                </p>
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        {notice.actions.map(({ id, label, href }) =>
          href === undefined ? (
            <Button
              key={id}
              size="sm"
              disabled={busy || session === undefined}
              onClick={() => void send("act", { action: id })}
            >
              {label}
            </Button>
          ) : (
            <Button key={id} size="sm" asChild>
              <a
                href={href}
                onClick={(event) => {
                  event.preventDefault();
                  router.history.push(href);
                }}
              >
                {label}
              </a>
            </Button>
          ),
        )}
        <Button
          size="sm"
          variant="outline"
          disabled={busy || session === undefined}
          onClick={() => void send("dismiss", {})}
        >
          Dismiss
        </Button>
      </div>
      {problem !== undefined && (
        <p role="alert" className="text-sm text-destructive">
          {problem}
        </p>
      )}
    </li>
  );
}

/** The name of a Notice's Floor; "Office" for the whole Office. */
export const floorNameOf = (
  floors: readonly Floor[] | undefined,
  notice: Notice,
) =>
  notice.floorId === null
    ? "Office"
    : (floors?.find(({ id }) => id === notice.floorId)?.name ?? notice.floorId);

export interface NoticeBoardPageProps {
  /** Only this Floor's Notices; every Floor's when absent. */
  readonly floorId?: string | undefined;
  /** A Notice to bring into view, such as one a notification named. */
  readonly highlight?: string | undefined;
  readonly onFloorChange: (floorId: string | undefined) => void;
}

/** The lobby Notice Board, in 2D: every Floor's Notices (FR-50). */
export function NoticeBoardPage({
  floorId,
  highlight,
  onFloorChange,
}: NoticeBoardPageProps) {
  useLiveNotices();
  const { data: floors } = useQuery(floorsQuery);
  const { data: notices, isError } = useQuery(noticesQuery(floorId));
  // A Floor no longer in use, such as an archived one, is named too.
  const unlisted =
    floorId !== undefined &&
    floors !== undefined &&
    !floors.some(({ id }) => id === floorId);
  const { data: unlistedFloor } = useQuery({
    ...floorQuery(floorId ?? ""),
    enabled: unlisted,
  });

  return (
    <section className="space-y-6">
      <PageHeader
        title="Notice Board"
        description={
          <>
            What needs your attention, from every Floor. Each Notice stays until
            you dismiss it or take its action.
          </>
        }
      />
      <div className="space-y-2 sm:max-w-xs">
        <Label htmlFor="notice-board-floor">Floor</Label>
        <select
          id="notice-board-floor"
          className={selectClass}
          value={floorId ?? ""}
          onChange={(event) => {
            onFloorChange(
              event.target.value === "" ? undefined : event.target.value,
            );
          }}
        >
          <option value="">All Floors</option>
          {floors?.map((floor) => (
            <option key={floor.id} value={floor.id}>
              {floor.name}
            </option>
          ))}
          {unlisted && (
            <option value={floorId}>{unlistedFloor?.name ?? floorId}</option>
          )}
        </select>
      </div>
      {isError && (
        <p role="alert" className="text-sm text-destructive">
          The Notices could not be loaded.
        </p>
      )}
      {notices?.length === 0 && (
        <p className="text-muted-foreground">
          No Notices. Nothing needs you right now.
        </p>
      )}
      {notices !== undefined && notices.length > 0 && (
        <ul aria-label="Notices" className="space-y-3">
          {notices.map((notice) => (
            <NoticeItem
              key={notice.id}
              notice={notice}
              floorName={floorNameOf(floors, notice)}
              highlighted={notice.id === highlight}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
