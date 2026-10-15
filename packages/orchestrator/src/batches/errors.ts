import type { BatchErrorCode } from "@ai-office/shared";

/** Why a Batch operation was refused; `code` is one of `batchErrorCodes`. */
export class BatchError extends Error {
  readonly code: BatchErrorCode;

  constructor(code: BatchErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "BatchError";
    this.code = code;
  }
}
