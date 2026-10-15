import {
  avatarLook,
  avatarSchema,
  builtInRoles,
  lookDistinct,
  randomAvatar,
  seededRandom,
  type Random,
} from "@ai-office/shared";
import { describe, expect, it } from "vitest";

import {
  copyOfFirst,
  defaultTeam,
  newAgentRecord,
  templateTeam,
} from "./agents.ts";
import { agentName, roleAvatar, roleAvatars, roleNames } from "./names.ts";

// Adrian, each Floor's coder, always looks the same (#337): bald, with
// stubble and a blue hoodie. The others on his Floor are made to look
// unlike him, whatever order they join in; any other Agent's Avatar, and a
// copy's, is random as before.

const now = new Date("2026-10-12T09:00:00.000Z");

const adrian = roleAvatars["coder"];
if (adrian === undefined) {
  throw new Error("The coder has no Avatar of its own.");
}

/** `values` in turn, then `rest`'s. */
const scripted = (values: readonly number[], rest: Random): Random => {
  let next = 0;
  return () => values[next++] ?? rest();
};

/**
 * What `randomAvatar` reads to draw an Avatar that looks like Adrian's:
 * blue (7 of 10) and male, average and oval, bald (9 of 10), dark brown
 * hair (1 of 10) on the fifth skin tone of 8, no facial hair, no glasses,
 * no accessories, and a hoodie.
 */
const adrianLookalike = [
  0.75, 0.1, 0.05, 0.05, 0.95, 0.15, 0.6875, 0.9, 0.1, 0.9, 0.9, 0.9, 0.9, 0.9,
  0.05, 0.05, 0.05,
];

describe("Adrian's Avatar", () => {
  it("is a valid Avatar: male, bald, stubble and a blue hoodie", () => {
    expect(avatarSchema.parse(adrian)).toEqual(adrian);
    expect(adrian).toMatchObject({
      presentation: "male",
      hairstyle: "bald",
      facialHair: "stubble",
      outfit: { style: "hoodie", primaryColour: "#3f88c5" },
    });
  });

  it("is the coder's, for the coder's own name alone", () => {
    expect(roleNames["coder"]).toBe("Adrian");
    expect(roleAvatar("coder", "Adrian")).toEqual(adrian);
    // A copy: changing it changes no other Agent's.
    expect(roleAvatar("coder", "Adrian")).not.toBe(adrian);
    expect(roleAvatar("coder", "Ada")).toBeUndefined();
    expect(roleAvatar("reviewer", "Adrian")).toBeUndefined();
  });
});

describe("a new Floor's team", () => {
  it("has Adrian the coder, with exactly his Avatar, on every Floor", () => {
    for (const seed of ["web-shop", "blog", 1, 2, 3]) {
      const team = defaultTeam({
        floorId: String(seed),
        random: seededRandom(seed),
        now,
      });
      const coder = team.find(({ role }) => role === "coder");
      expect(coder?.name).toBe("Adrian");
      expect(coder?.avatar).toEqual(adrian);
      for (const other of team.filter((agent) => agent !== coder)) {
        expect(lookDistinct(other.avatar, adrian)).toBe(true);
      }
    }
  });

  it("makes an Agent that joins before Adrian look unlike him", () => {
    // The premise: drawn first, these would give Adrian's look.
    expect(
      avatarLook(randomAvatar(scripted(adrianLookalike, seededRandom(0)))),
    ).toEqual(avatarLook(adrian));

    // The Manager joins first: its name, then the lookalike.
    const team = defaultTeam({
      floorId: "web-shop",
      random: scripted([0, ...adrianLookalike], seededRandom(0)),
      now,
    });
    const [manager, coder] = team;
    expect(manager?.role).toBe("manager");
    expect(coder?.avatar).toEqual(adrian);
    expect(lookDistinct(manager?.avatar ?? adrian, adrian)).toBe(true);
  });

  it("gives a template's second coder a random Avatar unlike Adrian's", () => {
    const coderRole = builtInRoles.find(({ id }) => id === "coder");
    const reviewerRole = builtInRoles.find(({ id }) => id === "reviewer");
    if (coderRole === undefined || reviewerRole === undefined) {
      throw new Error("The built-in Roles have no coder or reviewer.");
    }
    const team = templateTeam({
      floorId: "web-shop",
      template: {
        roles: [
          { role: reviewerRole, count: 1 },
          { role: coderRole, count: 2 },
        ],
        manager: { planningGuidance: "", firstIssue: null },
      },
      random: seededRandom("template"),
      now,
      library: builtInRoles,
    });
    const coders = team.filter(({ role }) => role === "coder");
    expect(coders.map(({ name }) => name)[0]).toBe("Adrian");
    expect(coders[0]?.avatar).toEqual(adrian);
    expect(coders[1]?.name).not.toBe("Adrian");
    expect(coders[1]?.avatar).not.toEqual(adrian);
    for (const other of team.filter((agent) => agent !== coders[0])) {
      expect(lookDistinct(other.avatar, adrian)).toBe(true);
    }
  });
});

describe("any other new Agent", () => {
  it("has a random Avatar, as before", () => {
    const random = seededRandom("reviewer");
    agentName(random, [], "reviewer");
    const expected = randomAvatar(random, []);

    const reviewer = newAgentRecord({
      floorId: "web-shop",
      agent: { role: "reviewer" },
      others: [],
      random: seededRandom("reviewer"),
      createdAt: now,
      library: builtInRoles,
    });
    expect(reviewer.avatar).toEqual(expected);
    // A coder by another name too.
    const ada = newAgentRecord({
      floorId: "web-shop",
      agent: { role: "coder", name: "Ada" },
      others: [],
      random: seededRandom("ada"),
      createdAt: now,
      library: builtInRoles,
    });
    expect(ada.avatar).toEqual(randomAvatar(seededRandom("ada"), []));
  });

  it("copied from its Role's first is random even when named Adrian", () => {
    const copy = newAgentRecord({
      floorId: "web-shop",
      agent: copyOfFirst("coder", [], "Adrian"),
      others: [],
      random: seededRandom("copy"),
      createdAt: now,
      library: builtInRoles,
    });
    expect(copy.name).toBe("Adrian");
    expect(copy.avatar).toEqual(randomAvatar(seededRandom("copy"), []));
  });

  it("joining Adrian's Floor looks unlike him", () => {
    const team = defaultTeam({
      floorId: "web-shop",
      random: seededRandom("joining"),
      now,
    });
    // Drawn now, these would give Adrian's look; the newcomer's name
    // takes the first.
    const newcomer = newAgentRecord({
      floorId: "web-shop",
      agent: { role: "reviewer" },
      others: team,
      random: scripted([0, ...adrianLookalike], seededRandom(1)),
      createdAt: now,
      library: builtInRoles,
    });
    expect(lookDistinct(newcomer.avatar, adrian)).toBe(true);
  });
});
