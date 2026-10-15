// The control channel between an end-to-end test and its server
// (`server/main.ts`), over IPC. Types and constants only, so both sides can
// import it.
import type { OfficeEvent } from "@ai-office/events/schema";
import type { GatewayEndpointName, NewNotice } from "@ai-office/shared";

/** A task the server's stand-in sandbox runner was given: who, and with what. */
export interface SandboxTaskRecord {
  readonly agentId: string;
  readonly issue: number;
  readonly aiProvider: string;
  readonly model: string;
  readonly effort: string | null;
}

/**
 * A request as the AI Gateway would have recorded it, for the analytics
 * (FR-43): when, its Model and AI Account, who made it, its status, tokens,
 * cost and latency. What it leaves out is empty.
 */
export interface SeededGatewayRequest {
  readonly startedAt: string;
  readonly endpoint?: GatewayEndpointName;
  readonly model: string;
  readonly account: string | null;
  readonly status: number;
  readonly latencyMs: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadInputTokens?: number;
  readonly cacheCreationInputTokens?: number;
  readonly estimatedCostUsd: number | null;
  readonly floorId?: string;
  readonly agentId?: string;
  readonly issue?: number;
  readonly ownerTool?: string;
}

/** What a test asks of its server. */
export type ControlRequest =
  | { readonly command: "raiseNotice"; readonly notice: NewNotice }
  | { readonly command: "publish"; readonly event: OfficeEvent }
  /** Runs issue intake now, rather than at its next interval. */
  | { readonly command: "pollIntake" }
  /** The tasks Agents were given so far, oldest first. */
  | { readonly command: "sandboxTasks" }
  /** The prompt an Agent's latest task on an issue was given. */
  | {
      readonly command: "sandboxPrompt";
      readonly agentId: string;
      readonly issue: number;
    }
  /** Records requests in the Gateway's history, as if it had served them. */
  | {
      readonly command: "recordGatewayRequests";
      readonly requests: readonly SeededGatewayRequest[];
    };

export type ControlMessage = ControlRequest & { readonly id: number };

/**
 * What the server answers: the id of what it made, how many issues intake
 * picked up, the tasks Agents were given, or a task's prompt.
 */
export type ControlResult = string | number | readonly SandboxTaskRecord[];

/** The answer, or why the server could not do it. */
export type ControlReply =
  | { readonly id: number; readonly ok: true; readonly result: ControlResult }
  | { readonly id: number; readonly ok: false; readonly error: string };

/** Why every task the server's stand-in sandbox runner is given fails. */
export const standInFailure = "The end-to-end tests' sandboxes run nothing.";

/** The action the tests' Notices offer; taking it does nothing else. */
export const testAction = { id: "acknowledge", label: "Acknowledge" };
