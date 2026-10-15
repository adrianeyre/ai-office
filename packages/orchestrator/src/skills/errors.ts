import type { SkillErrorCode } from "@ai-office/shared";

/** Why a Skill library operation was refused; `code` is one of `skillErrorCodes`. */
export class SkillError extends Error {
  readonly code: SkillErrorCode;
  /** What was wrong, one line each, when there is a list to give. */
  readonly problems: readonly string[] | undefined;

  constructor(
    code: SkillErrorCode,
    message: string,
    problems?: readonly string[],
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "SkillError";
    this.code = code;
    this.problems = problems;
  }
}
