import type { FloorErrorCode } from "@ai-office/shared";

/** Why a Floor operation was refused; `code` is one of `floorErrorCodes`. */
export class FloorError extends Error {
  readonly code: FloorErrorCode;

  constructor(code: FloorErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "FloorError";
    this.code = code;
  }
}
