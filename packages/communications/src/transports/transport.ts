import { internalHostProblem, type OutboundMessage } from "@ai-office/shared";
import {
  InternalHostError,
  ownerFetch,
} from "@ai-office/shared/internal-hosts-guard";

// How a message reaches one kind of Connection (PRD FR-91): each type of
// Connection has a transport, which knows its credentials' shape, what may
// be shown of them, and how to send.

/**
 * A delivery that did not arrive. `retryAfterMs` is the service's own
 * word on when to try again (a 429's `Retry-After`), which the queue
 * respects (FR-94).
 */
export class DeliveryError extends Error {
  readonly retryAfterMs: number | undefined;

  constructor(
    message: string,
    options: ErrorOptions & { readonly retryAfterMs?: number } = {},
  ) {
    super(message, options);
    this.name = "DeliveryError";
    this.retryAfterMs = options.retryAfterMs;
  }
}

/** One message on its way to one Connection. */
export interface OutboundDelivery {
  /** The delivery's id: the same on every attempt, so a receiver can drop repeats. */
  readonly id: string;
  /** The Connection's id: the same for every delivery to it. */
  readonly connectionId: string;
  readonly message: OutboundMessage;
  /** True for a "Send test". */
  readonly test: boolean;
}

/** What a transport is told about its Connection. */
export interface ConnectionTarget<Credentials> {
  readonly credentials: Credentials;
  /** What is not secret, as `describe` made it. */
  readonly settings: Readonly<Record<string, unknown>>;
}

export interface ConnectionTransport<Credentials> {
  /** Checks credentials as they come from the API, or from storage. */
  readonly credentials: {
    parse(value: unknown): Credentials;
  };
  /**
   * What may be kept and shown of new credentials: a hint that identifies
   * them without giving them away, and the settings that are not secret.
   */
  describe(credentials: Credentials): {
    readonly hint: string;
    readonly settings: Readonly<Record<string, unknown>>;
  };
  /**
   * The values to keep out of everything kept or logged; every string in
   * the credentials when a transport does not say.
   */
  secrets?(credentials: Credentials): string[];
  /** The settings, one line each, for the office admin. */
  details(settings: Readonly<Record<string, unknown>>): string[];
  /** Sends it, or throws a `DeliveryError`. */
  send(
    delivery: OutboundDelivery,
    target: ConnectionTarget<Credentials>,
  ): Promise<void>;
}

/**
 * How long a `Retry-After` header asks to wait: seconds, or an HTTP date.
 * Undefined when there is none, or it makes no sense.
 */
export function retryAfterMs(
  header: string | null,
  now: Date = new Date(),
): number | undefined {
  if (header === null || header.trim() === "") {
    return undefined;
  }
  const seconds = Number(header.trim());
  if (Number.isFinite(seconds)) {
    return seconds >= 0 ? Math.ceil(seconds * 1000) : undefined;
  }
  const at = Date.parse(header);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now.getTime());
}

/** Why a request did not reach a service, without its address. */
export function unreachable(service: string, error: unknown): DeliveryError {
  const cause = (error as { cause?: { code?: unknown } } | undefined)?.cause;
  const code =
    typeof cause?.code === "string"
      ? cause.code
      : error instanceof Error && error.name === "TimeoutError"
        ? "timed out"
        : undefined;
  return new DeliveryError(
    `${service} could not be reached${code === undefined ? "" : ` (${code})`}.`,
    { cause: error },
  );
}

/**
 * The host refused because it is, or resolved to, an internal address the
 * Owner did not allow (ADR 0007), if that is why `error` happened.
 */
export const refusedHost = (error: unknown): string | undefined => {
  const cause = (error as { cause?: unknown } | undefined)?.cause;
  return error instanceof InternalHostError
    ? error.host
    : cause instanceof InternalHostError
      ? cause.host
      : undefined;
};

/** Node's `fetch`, refusing internal addresses the Owner did not allow. */
const toOwnerUrl = ownerFetch();

/**
 * POSTs (or whatever `init` says) to an address the Owner gave: a
 * webhook, an ntfy server, a Confluence site. One that is, or resolves to,
 * an internal address the Owner did not allow in ALLOWED_INTERNAL_HOSTS is
 * never connected to (ADR 0007, I1-2), and the delivery says why, the same
 * whether anything listens there or not; any other failure is
 * `unreachable`'s.
 */
export async function fetchOwnerUrl(
  service: string,
  url: string,
  init: RequestInit,
): Promise<Response> {
  try {
    return await toOwnerUrl(url, init);
  } catch (error) {
    const host = refusedHost(error);
    throw host === undefined
      ? unreachable(service, error)
      : new DeliveryError(internalHostProblem(service, host), {
          cause: error,
        });
  }
}
