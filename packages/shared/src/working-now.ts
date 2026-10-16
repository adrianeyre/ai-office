import { z } from "zod";

import { pipelineStages } from "./pipeline.ts";

// The Working now page: every Agent's work and every Manager's answer
// going on across the Floors in use, in one place, each of which the
// Owner can stop.

const at = z.iso.datetime({ offset: true });

/** One piece of an Agent's work: running, or queued for it. */
export const workingAgentSchema = z.object({
  /** The work's id, to stop it by. */
  id: z.number().int(),
  floorId: z.string(),
  floorName: z.string(),
  repository: z.string(),
  issue: z.number().int(),
  stage: z.enum(pipelineStages),
  status: z.enum(["running", "queued"]),
  /** Null while no Agent fits it. */
  agentId: z.string().nullable(),
  agentName: z.string().nullable(),
  /** The Role doing it: the Agent's, or the stage's when it has none. */
  role: z.string().nullable(),
  queuedAt: at,
  /** Null while it is queued. */
  startedAt: at.nullable(),
});
export type WorkingAgent = z.infer<typeof workingAgentSchema>;

/** A Floor's Manager answering the Owner. */
export const workingManagerSchema = z.object({
  floorId: z.string(),
  floorName: z.string(),
  agentId: z.string().nullable(),
  agentName: z.string(),
  /** Writing its reply, carrying out a request, or otherwise busy. */
  phase: z.enum(["writing", "acting", "busy"]),
  since: at,
});
export type WorkingManager = z.infer<typeof workingManagerSchema>;

/** The body of `GET /api/working-now`. */
export const workingNowSchema = z.object({
  work: z.array(workingAgentSchema),
  managers: z.array(workingManagerSchema),
});
export type WorkingNow = z.infer<typeof workingNowSchema>;

/** Codes in the `error` field of the Working now API's errors. */
export const workingNowErrorCodes = {
  workNotFound: "work_not_found",
  managerNotWorking: "manager_not_working",
} as const;
