import type { EventType } from "@ai-office/events/schema";
import {
  maxShownMemoryLength,
  memoryPath,
  repositoryMemorySchema,
  inLibraryOrder,
  roleName,
  type RepositoryMemoryView,
} from "@ai-office/shared";
import { queryOptions, useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink } from "lucide-react";
import { useId, type ReactNode } from "react";

import { useAgentName } from "./agent-link.tsx";
import { getJson } from "./api.ts";
import { useEventStream } from "./event-stream.ts";
import { officeMemoryQuery } from "./office-memory-card.tsx";
import { roleMemoryQuery } from "./role-memory-card.tsx";
import { PageLink } from "./scene/page-link.tsx";

import { LoadingMessage } from "@/components/ui/spinner.tsx";

// A Floor's bookshelf (PRD FR-58, §6.10): the memory its Agents read. The
// repository's memory (`.agents/MEMORY.md` on the default branch, with the
// proposals waiting for the Manager's next curation), the Floor's Role
// memory and the office-wide memory, each with where to edit it: the
// repository's on GitHub, through a pull request; the Role memory in the
// Floor's admin; the office-wide memory in Admin. Memory is untrusted
// text, so it is shown as written, never rendered. It changes live, as its
// events arrive.

/** `GET /api/floors/:floorId/repository-memory`. */
export const repositoryMemoryQuery = (floorId: string) =>
  queryOptions({
    queryKey: ["floors", floorId, "repository-memory"],
    queryFn: () =>
      getJson(
        `/api/floors/${encodeURIComponent(floorId)}/repository-memory`,
        repositoryMemorySchema,
      ),
  });

/** Where the office-wide memory is edited: its card in Admin. */
export const officeMemoryHref = "/general-settings#office-wide-memory";

/** Where a Floor's Role memory is edited: its card in the Floor's Agent Settings. */
export const roleMemoryHref = (floorId: string): string =>
  `/agent-settings?floor=${encodeURIComponent(floorId)}#role-memory`;

/**
 * Where the repository's memory is edited on GitHub, at the default
 * branch: the file, or a new one when there is none. GitHub proposes the
 * change as a pull request where the branch is protected.
 */
export const repositoryMemoryEditUrl = ({
  repository,
  branch,
  content,
}: Pick<RepositoryMemoryView, "repository" | "branch" | "content">): string =>
  content === null
    ? `https://github.com/${repository}/new/${encodeURI(branch)}?filename=${encodeURIComponent(memoryPath)}`
    : `https://github.com/${repository}/edit/${encodeURI(branch)}/${memoryPath}`;

/** The events that change what the bookshelf shows. */
const memoryEventTypes: readonly EventType[] = [
  "memory.proposed",
  "memory.curated",
  "memory.role_proposed",
  "memory.role_changed",
  "memory.office_changed",
];

function GitHubLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1 font-medium underline-offset-4 hover:underline"
    >
      <ExternalLink aria-hidden className="size-4" />
      {children}
    </a>
  );
}

/** One of the bookshelf's three kinds of memory. */
function Shelf({
  title,
  description,
  children,
}: {
  title: string;
  description: ReactNode;
  children: ReactNode;
}) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="space-y-2">
      <h3 id={headingId} className="font-semibold">
        {title}
      </h3>
      <p className="text-xs text-muted-foreground">{description}</p>
      {children}
    </section>
  );
}

/** Memory as written, in a box that scrolls. */
function Written({ label, text }: { label: string; text: string }) {
  return (
    <pre
      aria-label={label}
      className="max-h-48 overflow-auto rounded bg-muted p-2 font-mono text-xs whitespace-pre-wrap"
    >
      {text}
    </pre>
  );
}

function Problem({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="text-destructive">
      {children}
    </p>
  );
}

function Proposal({
  floorId,
  proposal,
}: {
  floorId: string;
  proposal: RepositoryMemoryView["proposals"][number];
}) {
  const name = useAgentName(floorId, proposal.agentId);
  return (
    <li>
      {proposal.text}{" "}
      <span className="text-muted-foreground">
        ({name ?? "An Agent"}, on #{proposal.issue})
      </span>
    </li>
  );
}

function RepositoryShelf({ floorId }: { floorId: string }) {
  const { data: memory, error } = useQuery(repositoryMemoryQuery(floorId));
  return (
    <Shelf
      title="The repository's memory"
      description={
        <>
          <code>{memoryPath}</code>
          {memory !== undefined && <> on {memory.branch}</>}: every Agent reads
          it at the start of a task. It changes through pull requests the
          Manager curates.
        </>
      }
    >
      {error !== null && <Problem>{error.message}</Problem>}
      {memory === undefined && error === null && (
        <LoadingMessage>Reading the memory…</LoadingMessage>
      )}
      {memory !== undefined && (
        <>
          {memory.readError !== null && <Problem>{memory.readError}</Problem>}
          {memory.content === null && memory.readError === null && (
            <p className="text-muted-foreground">
              The repository keeps no memory yet.
            </p>
          )}
          {memory.content !== null && (
            <Written
              label="The repository's memory, as written"
              text={memory.content}
            />
          )}
          {memory.truncated && (
            <p className="text-xs text-muted-foreground">
              Only the first {maxShownMemoryLength.toLocaleString("en-GB")}{" "}
              characters are shown, as Agents read them.
            </p>
          )}
          {memory.proposals.length > 0 && (
            <>
              <h4 className="text-xs text-muted-foreground">
                Proposed, waiting for the Manager&apos;s next curation
              </h4>
              <ul
                aria-label="Proposed repository memory"
                className="list-disc space-y-1 pl-4 text-xs"
              >
                {memory.proposals.map((proposal) => (
                  <Proposal
                    key={proposal.id}
                    floorId={floorId}
                    proposal={proposal}
                  />
                ))}
              </ul>
            </>
          )}
          <div className="flex flex-col items-start gap-1">
            {memory.readError === null && (
              <GitHubLink href={repositoryMemoryEditUrl(memory)}>
                Edit the repository&apos;s memory on GitHub
              </GitHubLink>
            )}
            {memory.pullRequest !== null && (
              <GitHubLink
                href={`https://github.com/${memory.repository}/pull/${String(memory.pullRequest)}`}
              >
                The Manager&apos;s memory pull request #{memory.pullRequest}
              </GitHubLink>
            )}
          </div>
        </>
      )}
    </Shelf>
  );
}

function RoleShelf({
  floorId,
  navigate,
}: {
  floorId: string;
  navigate?: ((href: string) => void) | undefined;
}) {
  const { data: list, error } = useQuery(roleMemoryQuery(floorId));
  const accepted =
    list?.entries.filter(({ status }) => status === "accepted") ?? [];
  const proposed =
    list?.entries.filter(
      ({ status }) => status === "proposed" || status === "recommended",
    ).length ?? 0;
  const roles = inLibraryOrder(accepted.map(({ role }) => role));
  return (
    <Shelf
      title="Role memory"
      description="What Agents of each Role on this Floor have learned, mounted read-only into their sandboxes."
    >
      {error !== null && <Problem>{error.message}</Problem>}
      {list === undefined && error === null && (
        <LoadingMessage>Reading the Role memory…</LoadingMessage>
      )}
      {list !== undefined && roles.length === 0 && (
        <p className="text-muted-foreground">No Role has memory yet.</p>
      )}
      {roles.map((role) => (
        <div key={role}>
          <h4 className="text-xs font-medium">{roleName(role)}</h4>
          <ul
            aria-label={`${roleName(role)} memory`}
            className="list-disc space-y-1 pl-4 text-xs"
          >
            {accepted
              .filter((entry) => entry.role === role)
              .map((entry) => (
                <li key={entry.id}>{entry.text}</li>
              ))}
          </ul>
        </div>
      ))}
      {proposed > 0 && (
        <p className="text-xs">
          {proposed === 1
            ? "1 proposal waits"
            : `${String(proposed)} proposals wait`}{" "}
          for the Manager or you.
        </p>
      )}
      <PageLink href={roleMemoryHref(floorId)} navigate={navigate}>
        Edit the Role memory
      </PageLink>
    </Shelf>
  );
}

function OfficeShelf({
  navigate,
}: {
  navigate?: ((href: string) => void) | undefined;
}) {
  const { data: memory, error } = useQuery(officeMemoryQuery);
  return (
    <Shelf
      title="Office-wide memory"
      description="Your coding standards, preferred libraries and review rules, for every Floor."
    >
      {error !== null && <Problem>{error.message}</Problem>}
      {memory === undefined && error === null && (
        <LoadingMessage>Reading the office-wide memory…</LoadingMessage>
      )}
      {memory?.content === "" && (
        <p className="text-muted-foreground">
          There is no office-wide memory yet.
        </p>
      )}
      {memory !== undefined && memory.content !== "" && (
        <Written
          label="The office-wide memory, as written"
          text={memory.content}
        />
      )}
      <PageLink href={officeMemoryHref} navigate={navigate}>
        Edit the office-wide memory
      </PageLink>
    </Shelf>
  );
}

/**
 * A Floor's bookshelf: its repository memory, Role memory and the
 * office-wide memory, each with a link to edit it.
 */
export function Bookshelf({
  floorId,
  navigate,
}: {
  floorId: string;
  /** Opens a page of AI Office without a reload. */
  navigate?: ((href: string) => void) | undefined;
}) {
  const queryClient = useQueryClient();
  useEventStream(
    { types: memoryEventTypes },
    {
      onEvent: ({ event }) => {
        // The office-wide memory's events are for every Floor; the rest name theirs.
        if ("floorId" in event && event.floorId !== floorId) {
          return;
        }
        const queryKey =
          event.type === "memory.office_changed"
            ? officeMemoryQuery.queryKey
            : event.type === "memory.proposed" ||
                event.type === "memory.curated"
              ? repositoryMemoryQuery(floorId).queryKey
              : roleMemoryQuery(floorId).queryKey;
        void queryClient.invalidateQueries({ queryKey });
      },
    },
  );
  return (
    <div className="space-y-5">
      <RepositoryShelf floorId={floorId} />
      <RoleShelf floorId={floorId} navigate={navigate} />
      <OfficeShelf navigate={navigate} />
    </div>
  );
}
