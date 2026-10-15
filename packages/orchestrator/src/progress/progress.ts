import type { EventBus, EventType, OfficeEvent } from "@ai-office/events";
import type { GitHubApp } from "@ai-office/github";
import {
  createRedactor,
  roleName,
  type PipelineStage,
  type Redactor,
  type Role,
} from "@ai-office/shared";

import { liveViewUrl } from "../agents/live-view.ts";
import type { FloorRef } from "../pipeline/pipeline.ts";

// Progress comments (PRD FR-21): while an Agent works an issue, AI Office
// keeps the issue told with a single comment, edited in place: the stage,
// the Agent, the last few steps and a link to its live view. To respect
// GitHub's limits, the comment is edited at most once a minute, however
// many steps there are; the last edit is a final summary. The steps are
// the Agent's sandbox events from the event bus, already redacted there;
// the comment is redacted again as a whole before it is written.

/** Marks AI Office's progress comment on an issue, so a later run edits it. */
export const progressMarker = "<!-- ai-office:progress -->";

/** The steps a comment shows, newest last. */
const shownSteps = 5;
/** The longest a step is shown. */
const maxStep = 120;

/** The sandbox events that are steps. */
const stepTypes: readonly EventType[] = [
  "sandbox.text",
  "sandbox.tool_call",
  "sandbox.diff",
];

/** Who works which issue, where. */
export interface ProgressSubject {
  readonly floor: FloorRef;
  readonly issue: number;
  readonly agent: {
    readonly id: string;
    readonly name: string;
    readonly role: Role;
  };
  readonly stage: PipelineStage;
}

/** How the work ended, for the final summary. */
export type ProgressSummary =
  | {
      readonly outcome: "pull_request";
      /** Where the issue is now, such as `needs-review`. */
      readonly stage: PipelineStage;
      readonly pullRequest: { readonly number: number; readonly url: string };
      /** Whether this work opened it, rather than updated it. */
      readonly opened: boolean;
    }
  /** QA checked the pull request (FR-28): passed, or failed. */
  | {
      readonly outcome: "qa";
      readonly passed: boolean;
      /** Where the issue is now, such as `needs-work` after a failure. */
      readonly stage: PipelineStage;
      readonly pullRequest: { readonly number: number; readonly url: string };
    }
  /**
   * Its work Role took its turn, and handed the issue to the next work
   * Role on the same branch (FR-25 (1)), named here.
   */
  | { readonly outcome: "handed_on"; readonly role: string }
  /** A designer reviewed the pull request's UI: approved, or changes asked. */
  | {
      readonly outcome: "design";
      readonly approved: boolean;
      /** Where the issue is now, such as `needs-work` after changes. */
      readonly stage: PipelineStage;
      readonly pullRequest: { readonly number: number; readonly url: string };
    }
  | { readonly outcome: "blocked"; readonly reason: string }
  /** Its Agent was paused at a Token Cap; the work resumes with it. */
  | { readonly outcome: "paused"; readonly reason: string }
  | { readonly outcome: "stopped" };

/** One issue's progress comment, while an Agent works it. */
export interface ProgressComment {
  /**
   * Stops following the work and writes the final summary: within the
   * minute, after the last edit. Resolves once it is written (or writing
   * it failed); it never rejects.
   */
  finish(summary: ProgressSummary): Promise<void>;
}

export interface ProgressComments {
  /** Starts the issue's progress comment, writing it now. */
  start(subject: ProgressSubject): ProgressComment;
  /**
   * Writes every comment's pending edit now, without waiting for its
   * minute, and stops: for when AI Office stops.
   */
  stop(): Promise<void>;
}

export interface ProgressCommentsOptions {
  readonly github: GitHubApp;
  readonly events: EventBus;
  /** AI Office's address, for the link to the Agent's live view. */
  readonly publicUrl?: string;
  /** The least time between two writes of a comment: a minute. */
  readonly intervalMs?: number;
  /** Removes credentials from the comment before it is written. */
  readonly redactor?: Redactor;
  readonly now?: () => Date;
  /** Told when GitHub refuses a write; the work goes on regardless. */
  readonly onError?: (error: unknown) => void;
}

/** Text that is safe in a Markdown code span: one line, no backticks. */
const codeSpan = (text: string, max = maxStep): string => {
  const line = text.replaceAll(/\s+/g, " ").replaceAll("`", "'").trim();
  const cut = line.length <= max ? line : `${line.slice(0, max - 1)}…`;
  return `\`${cut === "" ? "…" : cut}\``;
};

/** What one step says, for the comment. */
function stepText(event: OfficeEvent): string | undefined {
  switch (event.type) {
    case "sandbox.tool_call":
      return `${event.name} ${event.args}`;
    case "sandbox.diff":
      return `Changed ${event.path} (+${String(event.added)} −${String(event.removed)})`;
    case "sandbox.text":
      return `Said: ${event.text}`;
    default:
      return undefined;
  }
}

const utc = (date: Date): string =>
  `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;

export function createProgressComments(
  options: ProgressCommentsOptions,
): ProgressComments {
  const { github, events } = options;
  const intervalMs = options.intervalMs ?? 60_000;
  const now = options.now ?? (() => new Date());
  const redactor = options.redactor ?? createRedactor();
  const report = (error: unknown): void => {
    options.onError?.(error);
  };
  /** Each comment's way to write what is pending now, and stop. */
  const active = new Set<() => Promise<void>>();

  return {
    start(subject) {
      const client = github.repository(subject.floor.repository);
      const steps: string[] = [];
      let count = 0;
      let summary: ProgressSummary | undefined;
      let commentId: number | undefined;
      let lastWrite = Number.NEGATIVE_INFINITY;
      let dirty = true;
      let timer: NodeJS.Timeout | undefined;
      let ended = false;
      let writing: Promise<void> = Promise.resolve();
      let finished = (): void => undefined;
      const done = new Promise<void>((resolve) => {
        finished = resolve;
      });

      const render = (): string => {
        const { agent } = subject;
        const liveView =
          options.publicUrl === undefined
            ? ""
            : ` · [live view](${liveViewUrl(options.publicUrl, subject.floor.id, agent.id)})`;
        const heading =
          summary === undefined
            ? "AI Office is working on this issue"
            : summary.outcome === "pull_request" ||
                summary.outcome === "qa" ||
                summary.outcome === "handed_on" ||
                summary.outcome === "design"
              ? "AI Office finished working on this issue"
              : summary.outcome === "blocked"
                ? "AI Office is blocked on this issue"
                : "AI Office paused work on this issue";
        const stage =
          summary?.outcome === "pull_request" ||
          summary?.outcome === "qa" ||
          summary?.outcome === "design"
            ? summary.stage
            : subject.stage;
        const outcome =
          summary === undefined
            ? []
            : summary.outcome === "pull_request"
              ? [
                  `- **Pull request:** [#${String(summary.pullRequest.number)}](${summary.pullRequest.url}) ${summary.opened ? "opened" : "updated"}`,
                ]
              : summary.outcome === "qa"
                ? [
                    `- **QA:** ${summary.passed ? "passed" : "failed"} on [#${String(summary.pullRequest.number)}](${summary.pullRequest.url})`,
                  ]
                : summary.outcome === "handed_on"
                  ? [
                      `- **Handed on:** to the ${summary.role.replaceAll(/[\\`*_[\]<>@]/g, "")}, who works on the same branch next`,
                    ]
                  : summary.outcome === "design"
                    ? [
                        `- **Design:** ${summary.approved ? "approved" : "changes requested"} on [#${String(summary.pullRequest.number)}](${summary.pullRequest.url})`,
                      ]
                    : summary.outcome === "blocked"
                      ? [
                          `- **Blocked:** ${codeSpan(summary.reason, 300)}. The Owner has a Notice.`,
                        ]
                      : summary.outcome === "paused"
                        ? [
                            `- **Paused:** ${codeSpan(summary.reason, 300)}. The Owner has a Notice; the work starts again when the Agent resumes.`,
                          ]
                        : [
                            "- **Paused:** AI Office stopped; the work starts again when it does.",
                          ];
        const latest = steps.slice(-shownSteps);
        return [
          progressMarker,
          `### ${heading}`,
          "",
          `- **Stage:** \`${stage}\``,
          `- **Agent:** ${agent.name.replaceAll(/[\\`*_[\]<>@]/g, "")} (${roleName(agent.role)})${liveView}`,
          ...outcome,
          `- **Steps ${summary === undefined ? "so far" : "taken"}:** ${String(count)}`,
          ...(latest.length === 0
            ? []
            : [
                "",
                `**${summary === undefined ? "Latest" : "Last"} steps**`,
                "",
                ...latest.map((step, index) => `${String(index + 1)}. ${step}`),
              ]),
          "",
          `<sub>Updated ${utc(now())}, at most once a minute.</sub>`,
          "",
        ].join("\n");
      };

      /** Creates the comment, or edits the issue's existing one. */
      const put = async (body: string): Promise<void> => {
        if (commentId === undefined) {
          const existing = (await client.listComments(subject.issue)).find(
            (comment) => comment.body.startsWith(progressMarker),
          );
          if (existing !== undefined) {
            commentId = existing.id;
          } else {
            commentId = (await client.createComment(subject.issue, body)).id;
            return;
          }
        }
        await client.updateComment(commentId, body);
      };

      /**
       * Writes what is pending, one write at a time: not within a minute
       * of the last write (then later) unless `atOnce`.
       */
      const write = (atOnce = false): Promise<void> => {
        writing = writing.then(async () => {
          if (!dirty) {
            return;
          }
          if (!atOnce && now().getTime() - lastWrite < intervalMs) {
            schedule();
            return;
          }
          dirty = false;
          lastWrite = now().getTime();
          try {
            await put(redactor.redactText(render()));
          } catch (error) {
            report(error);
          }
        });
        return writing;
      };

      const end = (): void => {
        ended = true;
        clearTimeout(timer);
        timer = undefined;
        unsubscribe();
        active.delete(flushNow);
      };

      /** Writes what is pending once the minute since the last write is up. */
      const schedule = (): void => {
        if (timer !== undefined || ended) {
          return;
        }
        const wait = Math.max(0, lastWrite + intervalMs - now().getTime());
        timer = setTimeout(() => {
          timer = undefined;
          void write().then(() => {
            if (dirty) {
              schedule();
            } else if (summary !== undefined) {
              end();
              finished();
            }
          });
        }, wait);
      };

      const flushNow = async (): Promise<void> => {
        end();
        await write(true);
        finished();
      };

      const unsubscribe = events.subscribe(
        ({ event }) => {
          const text = stepText(event);
          if (text === undefined || summary !== undefined) {
            return;
          }
          count++;
          steps.push(codeSpan(text));
          if (steps.length > shownSteps) {
            steps.shift();
          }
          dirty = true;
          schedule();
        },
        {
          floorId: subject.floor.id,
          agentId: subject.agent.id,
          issue: subject.issue,
          types: stepTypes,
        },
      );
      active.add(flushNow);
      void write();

      return {
        finish(final) {
          if (summary === undefined) {
            summary = final;
            dirty = true;
            unsubscribe();
            schedule();
          }
          return done;
        },
      };
    },

    async stop() {
      await Promise.all([...active].map((flush) => flush()));
    },
  };
}
