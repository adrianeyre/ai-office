import { createRedactor, type Redactor } from "@ai-office/shared";
import { pino, type DestinationStream, type Logger } from "pino";

export interface LoggerOptions {
  readonly level: string;
  /** Values that must never appear in a log line. */
  readonly secrets: readonly string[];
  /**
   * The redactor to use, so values registered with it later (an AI
   * Account's credential, once it is added or opened) are removed too.
   * `secrets` are registered with it. A new one by default.
   */
  readonly redactor?: Redactor;
  /** Where JSON lines go; stdout by default. */
  readonly destination?: DestinationStream;
}

/**
 * A structured JSON logger that passes everything through the central
 * redactor. Each log object is redacted before serialisation (so the values
 * of keys like `password` or `authorization` are replaced), and each
 * serialised line again afterwards, so a configured secret or a
 * credential-shaped string is removed wherever it appears: in a message,
 * a nested object or an error's stack.
 */
export function createLogger(options: LoggerOptions): Logger {
  const redactor = options.redactor ?? createRedactor();
  redactor.register(...options.secrets);
  return pino(
    {
      level: options.level,
      formatters: {
        bindings: (bindings) => redactor.redact(bindings),
        log: (object) => redactor.redact(object),
      },
      hooks: { streamWrite: (line) => redactor.redactText(line) },
    },
    options.destination ?? pino.destination(1),
  );
}
