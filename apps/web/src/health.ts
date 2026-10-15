import { healthResponseSchema, type HealthResponse } from "@ai-office/shared";
import { queryOptions } from "@tanstack/react-query";

/**
 * The server's `GET /health`. A 503 still carries a valid body (the
 * database is down), so the body is read whatever the status.
 */
export async function fetchHealth(): Promise<HealthResponse> {
  const response = await fetch("/health");
  return healthResponseSchema.parse(await response.json());
}

export const healthQuery = queryOptions({
  queryKey: ["health"],
  queryFn: fetchHealth,
  refetchInterval: 30_000,
});
