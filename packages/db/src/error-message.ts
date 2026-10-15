/**
 * What went wrong, in one line, for an error from connecting to or querying
 * Postgres. Drizzle wraps the driver's error as `cause`. When a host name
 * resolves to several addresses (`localhost` is both ::1 and 127.0.0.1 on
 * Windows), Node tries each one and reports an AggregateError whose own
 * message is empty, so the attempts' messages are joined instead. pg's
 * messages name the host and port, never the connection string.
 */
export function errorMessage(error: unknown): string {
  const inner =
    error instanceof Error && error.cause instanceof Error
      ? error.cause
      : error;
  if (inner instanceof AggregateError && inner.errors.length > 0) {
    return inner.errors.map(errorMessage).join("; ");
  }
  if (inner instanceof Error) {
    const code = (inner as { code?: unknown }).code;
    return inner.message !== ""
      ? inner.message
      : typeof code === "string"
        ? code
        : inner.name;
  }
  return String(inner);
}
