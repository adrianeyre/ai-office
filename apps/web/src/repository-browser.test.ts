import { describe, expect, it } from "vitest";

import {
  browse,
  ownerOf,
  ownersOf,
  pageNumbers,
  type Browsing,
} from "./repository-browser.ts";

// Which of an access token's many repositories Add a Floor shows.

const named = (...fullNames: string[]) =>
  fullNames.map((fullName) => ({ fullName }));

const every: Browsing = {
  query: "",
  owner: undefined,
  page: 1,
  pageSize: 25,
};

const many = named(
  ...Array.from(
    { length: 60 },
    (_, index) =>
      `${index % 2 === 0 ? "acme" : "adrianeyre"}/repo-${String(index + 1)}`,
  ),
);

describe("the owners of the repositories", () => {
  it("are each owner once, A to Z in any case, with how many it has", () => {
    expect(ownerOf("acme/web-shop")).toBe("acme");
    expect(ownersOf(named("zeta/a", "Acme/b", "beta/c", "zeta/d"))).toEqual([
      { owner: "Acme", count: 1 },
      { owner: "beta", count: 1 },
      { owner: "zeta", count: 2 },
    ]);
  });
});

describe("browsing the repositories", () => {
  it("shows a page at a time, saying which", () => {
    const first = browse(many, every);
    expect(first.items.map(({ fullName }) => fullName).slice(0, 2)).toEqual([
      "acme/repo-1",
      "adrianeyre/repo-2",
    ]);
    expect(first).toMatchObject({
      total: 60,
      page: 1,
      pageCount: 3,
      from: 1,
      to: 25,
    });
    expect(browse(many, { ...every, page: 3 })).toMatchObject({
      page: 3,
      from: 51,
      to: 60,
    });
    expect(browse(many, { ...every, page: 2, pageSize: 50 })).toMatchObject({
      pageCount: 2,
      from: 51,
      to: 60,
    });
  });

  it("keeps the page within those there are", () => {
    expect(browse(many, { ...every, page: 9 }).page).toBe(3);
    expect(browse(many, { ...every, page: 0 }).page).toBe(1);
    expect(browse([], every)).toEqual({
      items: [],
      total: 0,
      page: 1,
      pageCount: 1,
      from: 0,
      to: 0,
    });
  });

  it("finds a repository by any part of its name, in any case", () => {
    const found = browse(many, { ...every, query: " REPO-1 " });
    // In the order GitHub gave them.
    expect(found.items.map(({ fullName }) => fullName)).toEqual([
      "acme/repo-1",
      "adrianeyre/repo-10",
      "acme/repo-11",
      "adrianeyre/repo-12",
      "acme/repo-13",
      "adrianeyre/repo-14",
      "acme/repo-15",
      "adrianeyre/repo-16",
      "acme/repo-17",
      "adrianeyre/repo-18",
      "acme/repo-19",
    ]);
    expect(browse(many, { ...every, query: "acme/" }).total).toBe(30);
  });

  it("shows only one owner's, and searches within them", () => {
    expect(browse(many, { ...every, owner: "adrianeyre" }).total).toBe(30);
    expect(
      browse(many, {
        ...every,
        owner: "adrianeyre",
        query: "repo-1",
      }).items.map(({ fullName }) => fullName),
    ).toEqual([
      "adrianeyre/repo-10",
      "adrianeyre/repo-12",
      "adrianeyre/repo-14",
      "adrianeyre/repo-16",
      "adrianeyre/repo-18",
    ]);
    // An owner's name is not part of another's.
    expect(
      browse(named("acme/a", "acme-labs/b"), { ...every, owner: "acme" }).total,
    ).toBe(1);
  });
});

describe("the page numbers offered", () => {
  it("are every page when there are few", () => {
    expect(pageNumbers(1, 1)).toEqual([1]);
    expect(pageNumbers(2, 5)).toEqual([1, 2, 3, 4, 5]);
  });

  it("are the first, last and those beside the page shown, with gaps", () => {
    expect(pageNumbers(1, 12)).toEqual([1, 2, "gap", 12]);
    expect(pageNumbers(6, 12)).toEqual([1, "gap", 5, 6, 7, "gap", 12]);
    expect(pageNumbers(12, 12)).toEqual([1, "gap", 11, 12]);
    // A gap of one page shows the page instead.
    expect(pageNumbers(4, 12)).toEqual([1, 2, 3, 4, 5, "gap", 12]);
  });
});
