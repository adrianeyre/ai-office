import {
  floorNameSchema,
  floorSchema,
  maxFloorNameLength,
  type Floor,
  type FloorTemplateIcon,
  type FloorTemplateSummary,
  type InstalledRepository,
} from "@ai-office/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  BookOpen,
  ChartColumn,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Code,
  Lock,
  Megaphone,
  MessageSquare,
  Palette,
  Pencil,
  PenLine,
  Search,
  Server,
  ShoppingBag,
  Smartphone,
  Square,
  Trash2,
  type LucideIcon,
} from "lucide-react";
import { useId, useRef, useState } from "react";

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
import { LoadingMessage } from "@/components/ui/spinner.tsx";
import { cn, selectClass } from "@/lib/utils.ts";

import { postJson, readApiError, sendJson } from "./api.ts";
import {
  floorQuery,
  floorsQuery,
  floorTemplatesQuery,
  installedRepositoriesQuery,
} from "./floors.ts";
import {
  browse,
  ownersOf,
  pageNumbers,
  pageSizes,
  type PageSize,
} from "./repository-browser.ts";
import { sessionQuery } from "./session.ts";

/** How each Floor Template's icon is drawn. */
export const floorTemplateIcons: Record<FloorTemplateIcon, LucideIcon> = {
  code: Code,
  square: Square,
  "shopping-bag": ShoppingBag,
  megaphone: Megaphone,
  "pen-line": PenLine,
  "book-open": BookOpen,
  palette: Palette,
  "chart-column": ChartColumn,
  server: Server,
  smartphone: Smartphone,
};

/** A template's starting team in words: "Manager, 2 × coder, reviewer". */
export const startingTeamText = (team: FloorTemplateSummary["team"]): string =>
  team
    .map(({ name, count }) =>
      count === 1 ? name : `${String(count)} × ${name}`,
    )
    .join(", ");

const optionClass =
  "flex cursor-pointer items-start gap-3 rounded-md border p-3 text-sm has-[:checked]:border-primary has-[:checked]:ring-1 has-[:checked]:ring-primary";

/** One Floor Template in the picker. */
function TemplateOption({
  template,
  checked,
  onChoose,
}: {
  template: FloorTemplateSummary;
  checked: boolean;
  onChoose: () => void;
}) {
  const id = useId();
  const Icon = floorTemplateIcons[template.icon];
  return (
    <label className={optionClass}>
      <input
        type="radio"
        name="floor-template"
        value={template.id}
        className="mt-0.5 size-4 shrink-0 accent-primary"
        checked={checked}
        onChange={onChoose}
        aria-labelledby={`${id}-name`}
        aria-describedby={`${id}-description ${id}-team`}
      />
      <Icon aria-hidden className="mt-0.5 size-4 shrink-0" />
      <span className="space-y-1">
        <span id={`${id}-name`} className="block font-medium">
          {template.name}
        </span>
        <span id={`${id}-description`} className="block text-muted-foreground">
          {template.description}
        </span>
        <span id={`${id}-team`} className="block text-muted-foreground">
          Starting team: {startingTeamText(template.team)}
        </span>
      </span>
    </label>
  );
}

/**
 * The Floor Template a new Floor starts from (PRD FR-97): each one's name,
 * description, icon and starting team. Development is chosen at first.
 */
function TemplatePicker({
  chosen,
  onChoose,
}: {
  chosen: string | undefined;
  onChoose: (id: string) => void;
}) {
  const templates = useQuery(floorTemplatesQuery);
  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-medium">Floor Template</legend>
      <p className="text-sm text-muted-foreground">
        A new Floor starts with its template&apos;s team, settings and labels,
        and its Roles join the Role library. Everything stays editable.
      </p>
      {templates.isError && (
        <p role="alert" className="text-sm text-destructive">
          The Floor Templates could not be loaded, so a new Floor starts from
          Development.
        </p>
      )}
      {templates.data !== undefined && (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {templates.data.templates
            // One imported and not yet reviewed waits (FR-101).
            .filter(({ enabled }) => enabled)
            .map((template) => (
              <TemplateOption
                key={template.id}
                template={template}
                checked={
                  (chosen ?? templates.data.defaultTemplate) === template.id
                }
                onChoose={() => {
                  onChoose(template.id);
                }}
              />
            ))}
        </div>
      )}
    </fieldset>
  );
}

/** One repository the App is installed on, which can become a Floor. */
function RepositoryRow({
  repository,
  template,
  ready,
  csrfToken,
  onAdded,
}: {
  repository: InstalledRepository;
  /** The Floor Template chosen; Development when undefined. */
  template: string | undefined;
  /** Whether the templates are loaded (or failed to be), so it can be added. */
  ready: boolean;
  csrfToken: string | undefined;
  onAdded: () => Promise<void>;
}) {
  const [adding, setAdding] = useState(false);
  const [problem, setProblem] = useState<string>();

  const add = async () => {
    setAdding(true);
    setProblem(undefined);
    const response = await postJson(
      "/api/floors",
      {
        repository: repository.fullName,
        ...(template === undefined ? {} : { template }),
      },
      csrfToken,
    );
    if (response.ok) {
      floorSchema.parse(await response.json());
      await onAdded();
    } else {
      setProblem(
        (await readApiError(response)).message ?? "The Floor was not added.",
      );
    }
    setAdding(false);
  };

  return (
    <li className="flex flex-wrap items-center justify-between gap-2 py-2">
      <span className="flex items-center gap-2 text-sm">
        <a
          href={repository.htmlUrl}
          target="_blank"
          rel="noreferrer"
          className="font-mono hover:underline"
        >
          {repository.fullName}
        </a>
        {repository.private && (
          <Lock
            aria-label="Private"
            className="size-3.5 text-muted-foreground"
          />
        )}
      </span>
      {repository.floorId === null ? (
        <Button
          pending={adding}
          size="sm"
          disabled={!ready || csrfToken === undefined || adding}
          aria-label={`Add ${repository.fullName} as a Floor`}
          onClick={() => void add()}
        >
          {adding ? "Adding…" : "Add Floor"}
        </Button>
      ) : (
        <span className="text-sm text-muted-foreground">Already a Floor</span>
      )}
      {problem !== undefined && (
        <p role="alert" className="w-full text-sm text-destructive">
          {problem}
        </p>
      )}
    </li>
  );
}

/**
 * The pages of a list of repositories: first, previous, the page numbers
 * near the one shown, next and last, and how many a page shows.
 */
function Pagination({
  page,
  pageCount,
  pageSize,
  showPageSize,
  onPage,
  onPageSize,
}: {
  page: number;
  pageCount: number;
  pageSize: PageSize;
  /** Whether there are enough to choose how many a page shows. */
  showPageSize: boolean;
  onPage: (page: number) => void;
  onPageSize: (pageSize: PageSize) => void;
}) {
  const pageSizeId = useId();
  const first = page === 1;
  const last = page === pageCount;
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      {pageCount > 1 ? (
        <nav aria-label="Repository pages">
          <ul className="flex flex-wrap items-center gap-1">
            <li>
              <Button
                size="icon"
                variant="ghost"
                aria-label="First page"
                title="First page"
                disabled={first}
                onClick={() => {
                  onPage(1);
                }}
              >
                <ChevronsLeft aria-hidden />
              </Button>
            </li>
            <li>
              <Button
                size="icon"
                variant="ghost"
                aria-label="Previous page"
                title="Previous page"
                disabled={first}
                onClick={() => {
                  onPage(page - 1);
                }}
              >
                <ChevronLeft aria-hidden />
              </Button>
            </li>
            {pageNumbers(page, pageCount).map((number, index) =>
              number === "gap" ? (
                <li
                  // Gaps have no number of their own; where they are does.
                  key={`gap-${String(index)}`}
                  aria-hidden
                  className="hidden px-1 text-sm text-muted-foreground sm:block"
                >
                  …
                </li>
              ) : (
                <li
                  key={number}
                  className={number === page ? undefined : "hidden sm:block"}
                >
                  <Button
                    size="icon"
                    variant={number === page ? "outline" : "ghost"}
                    aria-label={`Page ${String(number)}`}
                    aria-current={number === page ? "page" : undefined}
                    onClick={() => {
                      onPage(number);
                    }}
                  >
                    {number}
                  </Button>
                </li>
              ),
            )}
            <li>
              <Button
                size="icon"
                variant="ghost"
                aria-label="Next page"
                title="Next page"
                disabled={last}
                onClick={() => {
                  onPage(page + 1);
                }}
              >
                <ChevronRight aria-hidden />
              </Button>
            </li>
            <li>
              <Button
                size="icon"
                variant="ghost"
                aria-label="Last page"
                title="Last page"
                disabled={last}
                onClick={() => {
                  onPage(pageCount);
                }}
              >
                <ChevronsRight aria-hidden />
              </Button>
            </li>
            <li className="px-1 text-sm text-muted-foreground sm:hidden">
              of {pageCount}
            </li>
          </ul>
        </nav>
      ) : (
        <span />
      )}
      {showPageSize && (
        <div className="flex items-center gap-2 text-sm">
          <Label htmlFor={pageSizeId} className="font-normal">
            Per page
          </Label>
          <select
            id={pageSizeId}
            className={cn(selectClass, "w-20")}
            value={pageSize}
            onChange={(event) => {
              onPageSize(Number(event.target.value) as PageSize);
            }}
          >
            {pageSizes.map((size) => (
              <option key={size} value={size}>
                {size}
              </option>
            ))}
          </select>
        </div>
      )}
    </div>
  );
}

/**
 * The repositories that can become Floors, a page at a time: found by
 * typing any part of a name, and narrowed to one GitHub organisation or
 * user when they belong to several. An access token can reach hundreds.
 */
function RepositoryBrowser({
  repositories,
  template,
  ready,
  csrfToken,
  onAdded,
}: {
  repositories: InstalledRepository[];
  template: string | undefined;
  ready: boolean;
  csrfToken: string | undefined;
  onAdded: () => Promise<void>;
}) {
  const [query, setQuery] = useState("");
  const [owner, setOwner] = useState<string>();
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<PageSize>(pageSizes[0]);
  const searchId = useId();
  const ownerId = useId();
  const top = useRef<HTMLDivElement>(null);

  const owners = ownersOf(repositories);
  // An owner no longer among them, its last one gone, is every owner.
  const chosenOwner = owners.some((each) => each.owner === owner)
    ? owner
    : undefined;
  const shown = browse(repositories, {
    query,
    owner: chosenOwner,
    page,
    pageSize,
  });
  const filtered = query.trim() !== "" || chosenOwner !== undefined;

  const clear = () => {
    setQuery("");
    setOwner(undefined);
    setPage(1);
  };
  const toPage = (next: number) => {
    setPage(next);
    // The new page starts where the old one did, the controls in view.
    top.current?.scrollIntoView({ block: "nearest" });
  };

  return (
    <div ref={top} className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
        <div className="space-y-1">
          <Label htmlFor={searchId}>Find a repository</Label>
          <div className="relative">
            <Search
              aria-hidden
              className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              id={searchId}
              type="search"
              autoComplete="off"
              spellCheck={false}
              placeholder="Start typing its name"
              className="pl-9"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setPage(1);
              }}
              onKeyDown={(event) => {
                if (event.key === "Escape" && query !== "") {
                  event.preventDefault();
                  setQuery("");
                  setPage(1);
                }
              }}
            />
          </div>
        </div>
        {owners.length > 1 && (
          <div className="space-y-1">
            <Label htmlFor={ownerId}>GitHub organisation</Label>
            <select
              id={ownerId}
              className={cn(selectClass, "sm:w-56")}
              value={chosenOwner ?? ""}
              onChange={(event) => {
                setOwner(
                  event.target.value === "" ? undefined : event.target.value,
                );
                setPage(1);
              }}
            >
              <option value="">
                Every organisation ({repositories.length})
              </option>
              {owners.map(({ owner: each, count }) => (
                <option key={each} value={each}>
                  {each} ({count})
                </option>
              ))}
            </select>
          </div>
        )}
      </div>

      <p role="status" className="text-sm text-muted-foreground">
        {shown.total === 0
          ? "No repository matches."
          : `Showing ${String(shown.from)}–${String(shown.to)} of ${String(shown.total)} ${shown.total === 1 ? "repository" : "repositories"}${filtered ? ` (of ${String(repositories.length)})` : ""}.`}
      </p>

      {shown.total === 0 ? (
        <div className="space-y-2 rounded-md border border-dashed p-4 text-sm">
          <p>
            {/* Only a search finds none: every owner offered has some. */}
            No repository
            {chosenOwner === undefined ? "" : ` of ${chosenOwner}`} has “
            {query.trim()}” in its name. Check the spelling
            {chosenOwner === undefined
              ? "."
              : ", or look through every organisation’s."}
          </p>
          <Button size="sm" variant="outline" onClick={clear}>
            Clear the search
          </Button>
        </div>
      ) : (
        <ul
          aria-label="Repositories the App is installed on"
          className="divide-y"
        >
          {shown.items.map((repository) => (
            <RepositoryRow
              key={repository.fullName}
              repository={repository}
              template={template}
              ready={ready}
              csrfToken={csrfToken}
              onAdded={onAdded}
            />
          ))}
        </ul>
      )}

      <Pagination
        page={shown.page}
        pageCount={shown.pageCount}
        pageSize={pageSize}
        showPageSize={shown.total > pageSizes[0]}
        onPage={toPage}
        onPageSize={(size) => {
          setPageSize(size);
          setPage(1);
        }}
      />
    </div>
  );
}

/**
 * Removes a Floor from use, once the Owner confirms: it is archived, so
 * its work stops and it is hidden, and its history is kept. Its
 * repository can be added as a Floor again.
 */
function RemoveFloor({ floor }: { floor: Floor }) {
  const queryClient = useQueryClient();
  const { data: session } = useQuery(sessionQuery);
  const [confirming, setConfirming] = useState(false);
  const [problem, setProblem] = useState<string>();
  const remove = async () => {
    setProblem(undefined);
    const response = await postJson(
      `/api/floors/${encodeURIComponent(floor.id)}/archive`,
      {},
      session?.csrfToken,
    );
    if (!response.ok) {
      setProblem(
        (await readApiError(response)).message ?? "The Floor was not removed.",
      );
      return;
    }
    floorSchema.parse(await response.json());
    await Promise.all([
      queryClient.invalidateQueries(floorsQuery),
      queryClient.invalidateQueries(installedRepositoriesQuery),
    ]);
  };
  return confirming ? (
    <span className="flex flex-wrap items-center gap-2">
      <span className="text-muted-foreground">
        Its work stops; its history is kept.
      </span>
      <Button
        size="sm"
        variant="destructive"
        disabled={session === undefined}
        onClick={() => void remove()}
      >
        Remove {floor.name}
      </Button>
      <Button
        size="sm"
        variant="ghost"
        onClick={() => {
          setConfirming(false);
          setProblem(undefined);
        }}
      >
        Cancel
      </Button>
      {problem !== undefined && (
        <span role="alert" className="text-destructive">
          {problem}
        </span>
      )}
    </span>
  ) : (
    <Button
      size="sm"
      variant="outline"
      aria-label={`Remove Floor ${floor.name}`}
      onClick={() => {
        setConfirming(true);
      }}
    >
      <Trash2 aria-hidden />
      Remove Floor
    </Button>
  );
}

/**
 * Renames a Floor (FR-7): the name the Office shows for it everywhere,
 * while its address keeps its id. Refused, with the reason, when another
 * Floor in use has the name, whatever its case.
 */
function RenameFloor({ floor, onDone }: { floor: Floor; onDone: () => void }) {
  const queryClient = useQueryClient();
  const { data: session } = useQuery(sessionQuery);
  const [name, setName] = useState(floor.name);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string>();
  const inputId = useId();
  const problemId = useId();
  const save = async () => {
    const parsed = floorNameSchema.safeParse(name);
    if (!parsed.success) {
      setProblem(parsed.error.issues[0]?.message ?? "Choose another name.");
      return;
    }
    if (parsed.data === floor.name) {
      onDone();
      return;
    }
    setSaving(true);
    setProblem(undefined);
    try {
      const response = await sendJson(
        "PATCH",
        `/api/floors/${encodeURIComponent(floor.id)}`,
        { name: parsed.data },
        session?.csrfToken,
      );
      if (!response.ok) {
        const error = await readApiError(response);
        setProblem(
          error.problems?.join(" ") ??
            error.message ??
            "The Floor was not renamed.",
        );
        return;
      }
      const renamed = floorSchema.parse(await response.json());
      queryClient.setQueryData(floorsQuery.queryKey, (all) =>
        all?.map((each) => (each.id === renamed.id ? renamed : each)),
      );
      queryClient.setQueryData(floorQuery(renamed.id).queryKey, renamed);
      onDone();
    } catch {
      setProblem("AI Office could not be reached. Try again.");
    } finally {
      setSaving(false);
    }
  };
  return (
    <form
      className="flex flex-wrap items-center gap-2"
      aria-label={`Rename ${floor.name}`}
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          onDone();
        }
      }}
    >
      <label htmlFor={inputId} className="sr-only">
        New name for {floor.name}
      </label>
      <Input
        id={inputId}
        value={name}
        maxLength={maxFloorNameLength}
        autoFocus
        className="w-56"
        aria-invalid={problem !== undefined}
        aria-describedby={problem === undefined ? undefined : problemId}
        onChange={(event) => {
          setName(event.target.value);
          setProblem(undefined);
        }}
      />
      <Button
        size="sm"
        type="submit"
        disabled={saving || session === undefined}
      >
        Save
      </Button>
      <Button size="sm" type="button" variant="ghost" onClick={onDone}>
        Cancel
      </Button>
      {problem !== undefined && (
        <span id={problemId} role="alert" className="text-destructive">
          {problem}
        </span>
      )}
    </form>
  );
}

/**
 * One Floor in use: its name (which the Owner may rename), its repository
 * and template, and what can be done with it.
 */
function FloorRow({ floor }: { floor: Floor }) {
  const [renaming, setRenaming] = useState(false);
  const rename = useRef<HTMLButtonElement>(null);
  return (
    <li className="flex flex-wrap items-center gap-x-2 gap-y-1 py-2 text-sm">
      {renaming ? (
        <RenameFloor
          floor={floor}
          onDone={() => {
            setRenaming(false);
            // Back to the button that opened it.
            requestAnimationFrame(() => rename.current?.focus());
          }}
        />
      ) : (
        <>
          <Link
            to="/floor-settings/$floorId"
            params={{ floorId: floor.id }}
            className="font-medium hover:underline"
          >
            {floor.name}
          </Link>
          <Button
            ref={rename}
            size="sm"
            variant="ghost"
            className="px-2"
            aria-label={`Rename ${floor.name}`}
            title="Rename"
            onClick={() => {
              setRenaming(true);
            }}
          >
            <Pencil aria-hidden />
          </Button>
        </>
      )}{" "}
      <span className="font-mono text-muted-foreground">
        {floor.repository}
      </span>{" "}
      <span className="text-muted-foreground">
        · started from {floor.template.name}
      </span>
      <span className="ml-auto flex flex-wrap items-center gap-2">
        <Button asChild size="sm" variant="outline">
          <Link to="/floors/$floorId/manager" params={{ floorId: floor.id }}>
            <MessageSquare aria-hidden />
            Chat with the Manager{" "}
            <span className="sr-only">of {floor.name}</span>
          </Link>
        </Button>
        <RemoveFloor floor={floor} />
      </span>
    </li>
  );
}

/**
 * The Floors section of the office admin (PRD FR-6, FR-7, FR-97): the
 * Floors in use, each linking to its Floor admin with its repository and
 * the template it started from, and renamed in place; and the repositories
 * the App is installed on, any of which can be added as a Floor from the
 * Floor Template chosen.
 */
export function FloorsCard() {
  const queryClient = useQueryClient();
  const floors = useQuery(floorsQuery);
  const repositories = useQuery(installedRepositoriesQuery);
  const { data: session } = useQuery(sessionQuery);
  const templates = useQuery(floorTemplatesQuery);
  const [chosen, setChosen] = useState<string>();

  const onAdded = async () => {
    await Promise.all([
      queryClient.invalidateQueries(floorsQuery),
      queryClient.invalidateQueries(installedRepositoriesQuery),
    ]);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>Floors</h2>
        </CardTitle>
        <CardDescription>
          Each Floor is one GitHub repository the AI Office GitHub App is
          installed on, with its own Agents and settings.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <section aria-labelledby="floors-in-use" className="space-y-2">
          <h3 id="floors-in-use" className="text-sm font-medium">
            Floors in use
          </h3>
          {floors.isError && (
            <p role="alert" className="text-sm text-destructive">
              The Floors could not be loaded.
            </p>
          )}
          {floors.data?.length === 0 && (
            <p className="text-sm text-muted-foreground">No Floors yet.</p>
          )}
          {floors.data !== undefined && floors.data.length > 0 && (
            <ul className="divide-y">
              {floors.data.map((floor) => (
                <FloorRow key={floor.id} floor={floor} />
              ))}
            </ul>
          )}
        </section>

        <section aria-labelledby="add-a-floor" className="space-y-2">
          <h3 id="add-a-floor" className="text-sm font-medium">
            Add a Floor
          </h3>
          <TemplatePicker chosen={chosen} onChoose={setChosen} />
          {repositories.isPending && (
            <LoadingMessage className="text-sm">
              Asking GitHub for the App's repositories…
            </LoadingMessage>
          )}
          {repositories.isError && (
            <p role="alert" className="text-sm text-destructive">
              {repositories.error.message}
            </p>
          )}
          {repositories.data?.length === 0 && (
            <p className="text-sm text-muted-foreground">
              The GitHub App is not installed on any repository yet. Install it
              on the repositories you want as Floors.
            </p>
          )}
          {repositories.data !== undefined && repositories.data.length > 0 && (
            <RepositoryBrowser
              repositories={repositories.data}
              template={chosen ?? templates.data?.defaultTemplate}
              ready={!templates.isPending}
              csrfToken={session?.csrfToken}
              onAdded={onAdded}
            />
          )}
        </section>
      </CardContent>
    </Card>
  );
}
