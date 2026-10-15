import { parseSkillDocument, skillFileName } from "@ai-office/shared";

import { withSupportingFiles } from "../skills/built-in.ts";
import type { FloorSkills } from "../skills/floor.ts";
import type { ChatSkills } from "./chat.ts";

// The Floor's Skills as the Manager chat runs them (PRD FR-74): every Skill
// on the Floor (the office library's enabled Skills and the repository's,
// which override them, and AI Office's built-in ones), with its
// `SKILL.md`'s instructions, and a built-in Skill's supporting files. The
// repository's are read through the GitHub App, so a Floor's are kept for a
// short while rather than read again for every message.

/** How long a Floor's Skills are kept before they are read again. */
export const chatSkillsCacheMs = 30_000;

export function floorChatSkills(
  floorSkills: Pick<FloorSkills, "available">,
  options: { readonly cacheMs?: number; readonly now?: () => number } = {},
): (floorId: string) => Promise<ChatSkills> {
  const cacheMs = options.cacheMs ?? chatSkillsCacheMs;
  const now = options.now ?? Date.now;
  const kept = new Map<string, { at: number; skills: Promise<ChatSkills> }>();
  const read = async (floorId: string): Promise<ChatSkills> => {
    const { skills, repositoryError } = await floorSkills.available(floorId);
    return {
      skills: skills.map(({ name, description, source, files }) => {
        const text =
          files.find(({ path }) => path === skillFileName)?.content ?? "";
        const parsed = parseSkillDocument(text);
        const instructions = parsed.ok ? parsed.document.instructions : text;
        return {
          name,
          description,
          source,
          // A built-in Skill's supporting files are given with it: the
          // Manager cannot read its folder.
          instructions:
            source === "built-in"
              ? withSupportingFiles(instructions, files)
              : instructions,
        };
      }),
      repositoryError,
    };
  };
  return (floorId) => {
    const cached = kept.get(floorId);
    if (cached !== undefined && now() - cached.at < cacheMs) {
      return cached.skills;
    }
    const skills = read(floorId);
    kept.set(floorId, { at: now(), skills });
    // A failure is not kept.
    skills.catch(() => {
      if (kept.get(floorId)?.skills === skills) {
        kept.delete(floorId);
      }
    });
    return skills;
  };
}
