// What of the repositories GitHub gives is shown in Floor Settings' Add a
// Floor: those of one organisation, or whose name holds what was typed,
// a page at a time. An access token can reach hundreds, so all of them in
// one list is too many to find one in.

/** How many repositories a page shows, the first being the default. */
export const pageSizes = [25, 50, 100] as const;
export type PageSize = (typeof pageSizes)[number];

/** The owner, user or organisation, of `owner/name`. */
export const ownerOf = (fullName: string): string =>
  fullName.slice(0, Math.max(fullName.indexOf("/"), 0)) || fullName;

/** Each owner of the repositories, A to Z, with how many it has. */
export function ownersOf(
  repositories: readonly { fullName: string }[],
): { owner: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const { fullName } of repositories) {
    const owner = ownerOf(fullName);
    counts.set(owner, (counts.get(owner) ?? 0) + 1);
  }
  return [...counts]
    .map(([owner, count]) => ({ owner, count }))
    .sort((a, b) =>
      a.owner.localeCompare(b.owner, undefined, { sensitivity: "base" }),
    );
}

export interface Browsing {
  /** Typed to find a repository: matched anywhere in `owner/name`, in any case. */
  readonly query: string;
  /** Only this owner's; every owner's when undefined. */
  readonly owner: string | undefined;
  /** From 1; one past the last page shows the last. */
  readonly page: number;
  readonly pageSize: PageSize;
}

export interface Browsed<T> {
  /** The page's repositories. */
  readonly items: T[];
  /** How many match, on every page. */
  readonly total: number;
  /** The page shown, from 1: kept within the pages there are. */
  readonly page: number;
  /** At least 1, even with none matching. */
  readonly pageCount: number;
  /** The first shown, counting from 1, and the last: 0 and 0 with none. */
  readonly from: number;
  readonly to: number;
}

/** The repositories matching `browsing`, and the page of them shown. */
export function browse<T extends { fullName: string }>(
  repositories: readonly T[],
  { query, owner, page, pageSize }: Browsing,
): Browsed<T> {
  const needle = query.trim().toLowerCase();
  const matching = repositories.filter(
    ({ fullName }) =>
      (owner === undefined || ownerOf(fullName) === owner) &&
      fullName.toLowerCase().includes(needle),
  );
  const total = matching.length;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const shown = Math.min(Math.max(1, Math.floor(page)), pageCount);
  const start = (shown - 1) * pageSize;
  const items = matching.slice(start, start + pageSize);
  return {
    items,
    total,
    page: shown,
    pageCount,
    from: total === 0 ? 0 : start + 1,
    to: start + items.length,
  };
}

/**
 * The page numbers to offer: the first and last, and those beside the
 * one shown, with a gap for each run left out, so the buttons stay few:
 * `[1, "gap", 4, 5, 6, "gap", 12]`. A gap of one page shows that page.
 */
export function pageNumbers(
  page: number,
  pageCount: number,
): (number | "gap")[] {
  const wanted = new Set(
    [1, page - 1, page, page + 1, pageCount].filter(
      (each) => each >= 1 && each <= pageCount,
    ),
  );
  const sorted = [...wanted].sort((a, b) => a - b);
  const numbers: (number | "gap")[] = [];
  let previous = 0;
  for (const each of sorted) {
    if (each - previous === 2) {
      numbers.push(each - 1);
    } else if (each - previous > 2) {
      numbers.push("gap");
    }
    numbers.push(each);
    previous = each;
  }
  return numbers;
}
