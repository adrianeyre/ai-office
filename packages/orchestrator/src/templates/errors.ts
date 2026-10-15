import type { FloorTemplateErrorCode } from "@ai-office/shared";

/**
 * Why a change to the Owner's Floor Templates was refused; `code` is one
 * of `floorTemplateErrorCodes`.
 */
export class FloorTemplateLibraryError extends Error {
  readonly code: FloorTemplateErrorCode;
  /** What was wrong, one line each, when there is a list to give. */
  readonly problems: readonly string[] | undefined;

  constructor(
    code: FloorTemplateErrorCode,
    message: string,
    problems?: readonly string[],
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "FloorTemplateLibraryError";
    this.code = code;
    this.problems = problems;
  }
}
