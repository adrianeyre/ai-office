import { describe, expect, it, vi } from "vitest";

import { floorChatSkills } from "./chat-skills.ts";

// The Floor's Skills as the Manager chat runs them (PRD FR-74): each with
// its SKILL.md's instructions, kept for a short while.

const skillMd = `---\nname: pdf\ndescription: PDFs.\n---\n\n# PDFs\n\nRead every page.\n`;

const available = vi.fn((floorId: string) =>
  Promise.resolve({
    skills: [
      {
        name: "pdf",
        description: "PDFs.",
        source: "repository" as const,
        folder: ".claude/skills/pdf",
        overridesOffice: false,
        files: [{ path: "SKILL.md", content: skillMd }],
      },
    ],
    ignored: [],
    repositoryError: floorId === "blog" ? "GitHub is down." : null,
  }),
);

describe("floorChatSkills", () => {
  it("gives each Skill's instructions below its frontmatter, and why the repository's could not be read", async () => {
    const skills = floorChatSkills({ available });
    expect(await skills("web-shop")).toEqual({
      skills: [
        {
          name: "pdf",
          description: "PDFs.",
          source: "repository",
          instructions: "\n# PDFs\n\nRead every page.\n",
        },
      ],
      repositoryError: null,
    });
    expect((await skills("blog")).repositoryError).toBe("GitHub is down.");
  });

  it("gives a built-in Skill's supporting files after its instructions, as the Manager cannot read its folder", async () => {
    const skills = floorChatSkills({
      available: () =>
        Promise.resolve({
          skills: [
            {
              name: "domain-modeling",
              description: "Domain models.",
              source: "built-in" as const,
              folder: null,
              overridesOffice: false,
              files: [
                {
                  path: "SKILL.md",
                  content:
                    "---\nname: domain-modeling\ndescription: Domain models.\n---\n\nSee ADR-FORMAT.md.\n",
                },
                { path: "ADR-FORMAT.md", content: "# ADR Format\n" },
              ],
            },
          ],
          ignored: [],
          repositoryError: null,
        }),
    });
    expect((await skills("web-shop")).skills[0]?.instructions).toBe(
      "\nSee ADR-FORMAT.md.\n\n---\n\nThe supporting file ADR-FORMAT.md, which these instructions refer to:\n\n# ADR Format",
    );
  });

  it("keeps a Floor's Skills for a while, then reads them again; a failure is not kept", async () => {
    available.mockClear();
    let now = 0;
    const skills = floorChatSkills(
      { available },
      { cacheMs: 1000, now: () => now },
    );
    await skills("web-shop");
    now = 999;
    await skills("web-shop");
    expect(available).toHaveBeenCalledTimes(1);
    now = 1000;
    await skills("web-shop");
    expect(available).toHaveBeenCalledTimes(2);

    available.mockRejectedValueOnce(new Error("no Floor"));
    await expect(skills("elsewhere")).rejects.toThrow("no Floor");
    await skills("elsewhere");
    expect(available).toHaveBeenCalledTimes(4);
  });
});
