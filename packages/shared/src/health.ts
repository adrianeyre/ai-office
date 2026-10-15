import { z } from "zod";

/** The body of `GET /health` (PRD FR-47), used by compose health checks. */
export const healthResponseSchema = z.object({
  /** `ok` when every dependency is up; the response is then a 200. */
  status: z.enum(["ok", "unavailable"]),
  database: z.enum(["up", "down"]),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;
