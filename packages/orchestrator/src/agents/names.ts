import type { Avatar, Random } from "@ai-office/shared";

// Names for new Agents: first names of people who shaped computing. Each
// Agent on a Floor has its own.

export const agentNames = [
  "Ada",
  "Alan",
  "Grace",
  "Linus",
  "Margaret",
  "Ken",
  "Barbara",
  "Edsger",
  "Frances",
  "Hedy",
  "Katherine",
  "Radia",
  "Dennis",
  "Guido",
  "Anita",
  "Bjarne",
  "Yukihiro",
  "Sophie",
  "Donald",
  "Leslie",
  "Ivan",
  "Adele",
  "Jean",
  "Karen",
  "Evelyn",
  "Joan",
  "Niklaus",
  "Shafi",
  "Lynn",
  "Tim",
  "Annie",
  "Brian",
  "Carol",
  "Dorothy",
  "Fran",
  "Gordon",
  "Hal",
  "Irene",
  "John",
  "Kathleen",
  "Lois",
  "Mary",
  "Noam",
  "Ole-Johan",
  "Peter",
  "Ruth",
  "Satoshi",
  "Tony",
] as const;

/** The name a Role's Agent is given first, while no Agent has it. */
export const roleNames: Partial<Record<string, string>> = {
  coder: "Adrian",
};

/**
 * How an Agent given its Role's own name looks (FR-13), the same on every
 * Floor: the coder Adrian is bald, with stubble and a blue hoodie. Never
 * changed to look unlike the others on the Floor: they are made to look
 * unlike it. An Agent copied from its Role's first (`copyOfFirst`) gets a
 * random Avatar, whatever its name; the Owner may change either in the
 * Avatar Editor.
 */
export const roleAvatars: Partial<Record<string, Avatar>> = {
  coder: {
    version: 1,
    presentation: "male",
    bodyShape: "average",
    face: "oval",
    hairstyle: "bald",
    hairColour: "#4a3021",
    skinTone: "#e0ac69",
    facialHair: "stubble",
    glasses: "none",
    accessories: [],
    outfit: {
      style: "hoodie",
      primaryColour: "#3f88c5",
      secondaryColour: "#2b2b2b",
    },
    deskMascot: "rubber-duck",
    deskItems: [],
  },
};

/**
 * The Avatar an Agent named `name` in `role` has for having its Role's
 * own name, as a copy of its own; undefined for any other name or Role.
 */
export function roleAvatar(role: string, name: string): Avatar | undefined {
  const avatar = roleAvatars[role];
  return avatar === undefined || roleNames[role] !== name
    ? undefined
    : structuredClone(avatar);
}

/**
 * A name that no Agent in `taken` has: its Role's own while it is free,
 * or a random one.
 */
export function agentName(
  random: Random,
  taken: readonly string[],
  role?: string,
): string {
  const used = new Set(taken);
  const own = role === undefined ? undefined : roleNames[role];
  if (own !== undefined && !used.has(own)) {
    return own;
  }
  const pick = (names: readonly string[]): string =>
    names[Math.floor(random() * names.length)] ?? "Agent";
  const free = agentNames.filter((name) => !used.has(name));
  if (free.length > 0) {
    return pick(free);
  }
  // Every name is used: number one. `used` is finite, so this ends.
  const name = pick(agentNames);
  for (let number = 2; ; number += 1) {
    const numbered = `${name} ${String(number)}`;
    if (!used.has(numbered)) {
      return numbered;
    }
  }
}

/** The longest name an Agent may have. */
const maxNameLength = 40;

/**
 * A Contractor's name (ADR 0004): its Role's, such as "Migration writer",
 * or, while an Agent on the Floor has that, "Migration writer 2" and on.
 */
export function contractorName(
  roleName: string,
  taken: readonly string[],
): string {
  const used = new Set(taken);
  const base =
    roleName
      .trim()
      .slice(0, maxNameLength - 4)
      .trim() || "Contractor";
  const name = `${base[0]?.toUpperCase() ?? ""}${base.slice(1)}`;
  if (!used.has(name)) {
    return name;
  }
  for (let number = 2; ; number += 1) {
    const numbered = `${name} ${String(number)}`;
    if (!used.has(numbered)) {
      return numbered;
    }
  }
}
