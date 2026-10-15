import {
  grillWithDocsSkillName,
  grillingSkillName,
  isGrillingSkillName,
  toSpecSkillName,
  toTicketsSkillName,
  wayfinderSkillName,
} from "./grilling.ts";

// AI Office's built-in Skills (PRD FR-77, FR-83b), on every Floor. Some
// start a Grilling Session (`grillingSkillNames`); the rest load their
// instructions into the Manager chat, as any `/name` does. Every one but
// `/grilling` is adapted from Matt Pocock's skills
// (https://github.com/mattpocock/skills, MIT), so the Available Skills
// list credits him. The server, the web app and the orchestrator share
// these, so whatever sends a Skill's command (the chat, a Meeting Room)
// spells it as AI Office reads it.

/** `/pr`: how to write a pull request's body. */
export const prSkillName = "pr";
/** `/domain-modeling`: sharpen the glossary and record ADRs. */
export const domainModelingSkillName = "domain-modeling";
/** `/research <question>`: find out from primary sources. */
export const researchSkillName = "research";
/** `/prototype <question>`: a throwaway prototype that answers it. */
export const prototypeSkillName = "prototype";
/** `/tdd`: test-driven development, red, green, refactor. */
export const tddSkillName = "tdd";
/** `/codebase-design`: the vocabulary of deep modules and seams. */
export const codebaseDesignSkillName = "codebase-design";
/** `/diagnosing-bugs`: the loop for a hard bug or a slowdown. */
export const diagnosingBugsSkillName = "diagnosing-bugs";
/** `/code-review [since]`: review changes against standards and the spec. */
export const codeReviewSkillName = "code-review";

/** The built-in Skills that load instructions, starting no session. */
export const instructionSkillNames = [
  prSkillName,
  domainModelingSkillName,
  researchSkillName,
  prototypeSkillName,
  tddSkillName,
  codebaseDesignSkillName,
  diagnosingBugsSkillName,
  codeReviewSkillName,
] as const;
export type InstructionSkillName = (typeof instructionSkillNames)[number];

/** The built-in Skills adapted from Matt Pocock's skills. */
export const mattPocockSkillNames = [
  grillWithDocsSkillName,
  wayfinderSkillName,
  toTicketsSkillName,
  toSpecSkillName,
  ...instructionSkillNames,
] as const;

/** Whether the built-in Skill `name` starts a Grilling Session when run. */
export const startsGrillingSession = (name: string): boolean =>
  isGrillingSkillName(name);

/** Whether the built-in Skill `name` is adapted from Matt Pocock's skills. */
export const isMattPocockSkill = (name: string): boolean =>
  name !== grillingSkillName &&
  (mattPocockSkillNames as readonly string[]).includes(name);
