import { type EventType, type OfficeEvent } from "@ai-office/events/schema";
import {
  aiAccountLimitReasonLabels,
  connectionTypeNames,
  contextUsageText,
  dayName,
  issuePriorityLabels,
  reviewVerdictLabels,
  roleName,
  type RouteJudge,
  type TriageJudge,
  type WatchdogTrigger,
} from "@ai-office/shared";

// How events read to the Owner: in the Activity Feed (PRD FR-52) and an
// Agent's live view. Text only; links are `sourceLinks`.

/** Each event type, as a short label. */
export const eventTypeLabels: Record<EventType, string> = {
  "floor.created": "Floor added",
  "floor.archived": "Floor archived",
  "floor.stopped": "Floor stopped",
  "floor.continued": "Floor continued",
  "floor.renamed": "Floor renamed",
  "agent.created": "Agent added",
  "agent.removed": "Agent removed",
  "agent.status_changed": "Agent status",
  "agent.queue_changed": "Agent queue",
  "agent.fresh_start": "Fresh Start",
  "agent.context_usage": "Context Usage",
  "contractor.added": "Contractor added",
  "contractor.kept": "Contractor kept",
  "contractor.left": "Contractor left",
  "issue.picked_up": "Issue picked up",
  "issue.triaged": "Issue triaged",
  "issue.routed": "Issue routed",
  "issue.assigned": "Issue assigned",
  "issue.label_changed": "Stage changed",
  "manager.decision": "Manager decision",
  "manager.action_refused": "Manager refused",
  "manager.issue_filed": "Manager filed an issue",
  "batch.planned": "Plan drafted",
  "batch.approved": "Plan approved",
  "batch.started": "Batch started",
  "batch.kickoff_started": "Kickoff started",
  "batch.acknowledged": "Plan acknowledged",
  "batch.kickoff_ended": "Kickoff ended",
  "batch.finished": "Batch finished",
  "status_update.given": "Status update given",
  "memory.proposed": "Memory proposed",
  "memory.curated": "Memory curated",
  "memory.office_changed": "Office-wide memory changed",
  "memory.role_proposed": "Role memory proposed",
  "memory.role_changed": "Role memory changed",
  "sandbox.started": "Sandbox started",
  "sandbox.stopped": "Sandbox stopped",
  "sandbox.text": "Agent output",
  "sandbox.tool_call": "Tool call",
  "sandbox.diff": "File changed",
  "grilling.session_changed": "Grilling Session",
  "grilling.fact_finding_started": "Fact-finding started",
  "grilling.fact_finding_stopped": "Fact-finding stopped",
  "grilling.documents_written": "Grilling documents written",
  "grilling.pull_request_opened": "Grilling pull request opened",
  "grilling.issue_filed": "Grilling issue filed",
  "repository.changed": "Repository changed",
  "branch.pushed": "Branch pushed",
  "pull_request.opened": "Pull request opened",
  "pull_request.merged": "Pull request merged",
  "review.posted": "Review posted",
  "qa.reported": "QA result",
  "design.reported": "Design review",
  handoff: "Handoff",
  "model_call.completed": "Model call",
  "notice.raised": "Notice raised",
  "notice.dismissed": "Notice dismissed",
  "notice.acted_on": "Notice acted on",
  "cap.warning": "Token Cap warning",
  "cap.reached": "Token Cap reached",
  "ai_account.token_health": "AI Account token",
  "ai_account.limit_changed": "AI Account limit",
  "ai_account.window_refreshed": "Usage window refreshed",
  "config.changed": "Settings changed",
  "skill.added": "Skill added",
  "skill.changed": "Skill changed",
  "skill.removed": "Skill removed",
  "role.created": "Role made",
  "role.changed": "Role changed",
  "role.removed": "Role deleted",
  "floor_template.added": "Floor Template added",
  "floor_template.changed": "Floor Template changed",
  "floor_template.removed": "Floor Template deleted",
  "connection.added": "Connection added",
  "connection.changed": "Connection changed",
  "connection.removed": "Connection removed",
  "connection.failing": "Connection failing",
  "connection.recovered": "Connection recovered",
  "connection.delivery_expired": "Delivery given up",
  "google.signed_in": "Signed in to Google",
  "google.signed_out": "Signed out of Google",
  "google.grant_revoked": "Google sign-in revoked",
  "sign_in.succeeded": "Signed in",
  "sign_in.failed": "Sign-in failed",
  "sign_in.locked_out": "Sign-ins locked out",
  signed_out: "Signed out",
  "gateway_key.failed": "Gateway Key refused",
  "gateway_key.locked_out": "Gateway Keys locked out",
};

/** The event types, grouped as the Activity Feed's type filter lists them. */
export const eventTypeGroups: readonly {
  readonly label: string;
  readonly types: readonly EventType[];
}[] = [
  {
    label: "Floors",
    types: [
      "floor.created",
      "floor.archived",
      "floor.renamed",
      "floor.stopped",
      "floor.continued",
    ],
  },
  {
    label: "Agents",
    types: [
      "agent.created",
      "agent.removed",
      "agent.status_changed",
      "agent.queue_changed",
      "agent.fresh_start",
      "agent.context_usage",
      "contractor.added",
      "contractor.kept",
      "contractor.left",
    ],
  },
  {
    label: "Issues",
    types: [
      "issue.picked_up",
      "issue.triaged",
      "issue.routed",
      "issue.assigned",
      "issue.label_changed",
      "grilling.issue_filed",
      "handoff",
    ],
  },
  {
    label: "Manager",
    types: [
      "manager.decision",
      "manager.action_refused",
      "manager.issue_filed",
      "grilling.session_changed",
      "status_update.given",
    ],
  },
  {
    label: "Batches",
    types: [
      "batch.planned",
      "batch.approved",
      "batch.started",
      "batch.kickoff_started",
      "batch.acknowledged",
      "batch.kickoff_ended",
      "batch.finished",
    ],
  },
  {
    label: "Memory",
    types: [
      "memory.proposed",
      "memory.curated",
      "memory.office_changed",
      "memory.role_proposed",
      "memory.role_changed",
    ],
  },
  {
    label: "Sandboxes",
    types: [
      "sandbox.started",
      "sandbox.stopped",
      "sandbox.text",
      "sandbox.tool_call",
      "sandbox.diff",
      "grilling.fact_finding_started",
      "grilling.fact_finding_stopped",
    ],
  },
  {
    label: "Pull requests",
    types: [
      "repository.changed",
      "branch.pushed",
      "pull_request.opened",
      "grilling.documents_written",
      "grilling.pull_request_opened",
      "review.posted",
      "qa.reported",
      "design.reported",
      "pull_request.merged",
    ],
  },
  { label: "Model calls", types: ["model_call.completed"] },
  {
    label: "Notices",
    types: ["notice.raised", "notice.dismissed", "notice.acted_on"],
  },
  { label: "Token Caps", types: ["cap.warning", "cap.reached"] },
  {
    label: "AI Accounts",
    types: [
      "ai_account.token_health",
      "ai_account.limit_changed",
      "ai_account.window_refreshed",
    ],
  },
  { label: "Settings", types: ["config.changed"] },
  { label: "Skills", types: ["skill.added", "skill.changed", "skill.removed"] },
  { label: "Roles", types: ["role.created", "role.changed", "role.removed"] },
  {
    label: "Floor Templates",
    types: [
      "floor_template.added",
      "floor_template.changed",
      "floor_template.removed",
    ],
  },
  {
    label: "Connections",
    types: [
      "connection.added",
      "connection.changed",
      "connection.removed",
      "connection.failing",
      "connection.recovered",
      "connection.delivery_expired",
      "google.signed_in",
      "google.signed_out",
      "google.grant_revoked",
    ],
  },
  {
    label: "Sign-ins",
    types: [
      "sign_in.succeeded",
      "sign_in.failed",
      "sign_in.locked_out",
      "signed_out",
    ],
  },
  {
    label: "Gateway Keys",
    types: ["gateway_key.failed", "gateway_key.locked_out"],
  },
];

/** Each Stage, as the text names it. */
const stageNames = {
  work: "work",
  review: "review",
  qa: "QA",
  docs: "docs",
} as const;

/** A Role's fields, as `role.changed` lists them. */
const roleFieldNames: Partial<Record<string, string>> = {
  name: "name",
  stage: "Stage",
  description: "routing description",
  instructions: "instructions",
  skills: "Skills",
  deskDressing: "desk dressing",
  aiProvider: "suggested AI Provider",
  model: "suggested Model",
};

/** A Floor Template's parts, as `floor_template.changed` lists them. */
const templatePartNames: Partial<Record<string, string>> = {
  name: "name",
  description: "description",
  icon: "icon",
  theme: "3D theme",
  roles: "Roles and counts",
  settings: "settings",
  manager: "Manager's guidance",
  labels: "labels",
  skills: "Skills",
};

/** What a Floor Template not yet reviewed waits for. */
const waitsForReview =
  "; it waits for review before a Floor can be added from it.";

/** What the text needs to know beyond the event: names for ids. */
export interface EventNames {
  /** An Agent's name, or its id when unknown. */
  readonly agent: (agentId: string) => string;
  /** A Floor's name as the Owner chose it, or its id when unknown. */
  readonly floor?: (floorId: string) => string;
}

const idNames: EventNames = { agent: (agentId) => agentId };

const tokens = (count: number | null): string =>
  count === null ? "?" : count.toLocaleString("en-GB");

const percent = (share: number): string =>
  `${String(Math.round(share * 100))}%`;

const stage = (label: string | null): string => label ?? "no stage";

/** `#1, #2 and #3`. */
const issueList = (issues: readonly number[]): string => {
  const named = issues.map((issue) => `#${String(issue)}`);
  return named.length <= 1
    ? named.join("")
    : `${named.slice(0, -1).join(", ")} and ${named.at(-1) ?? ""}`;
};

/** Who judged a triage, as the end of its sentence. */
const judgedBy: Record<TriageJudge, string> = {
  model: "",
  decision_model: " (by the Decision Model)",
  rules: " (by AI Office's rules)",
  owner: " (the Owner's choice)",
};

/** How a work Role was chosen, as the end of its sentence. */
const routedBy: Record<RouteJudge, string> = {
  model: "",
  label: " (by its role label)",
  owner: " (the Owner's choice)",
  plan: " (by its Batch's Plan)",
};

/** Why the watchdog decided, as the end of its sentence. */
const watchdogReasons: Record<WatchdogTrigger, string> = {
  stalled: "it had stalled",
  failing: "it kept failing",
  near_cap: "its Review Loop is near its Round Cap",
};

/** One sentence (or line) saying what happened. */
export function describeEvent(
  event: OfficeEvent,
  names: EventNames = idNames,
): string {
  const agent = names.agent;
  const floor = names.floor ?? ((floorId: string) => floorId);
  switch (event.type) {
    case "floor.created":
      return `Floor "${event.name}" added for ${event.repository}${
        event.template === undefined
          ? ""
          : `, from the ${event.template.name} Floor Template`
      }.`;
    case "floor.archived":
      return `Floor "${floor(event.floorId)}" archived.`;
    case "floor.stopped":
      return `Everything stopped on Floor "${floor(event.floorId)}".`;
    case "floor.continued":
      return `Floor "${floor(event.floorId)}" carries on working.`;
    case "floor.renamed":
      return `Floor "${event.previousName}" renamed "${event.name}".`;
    case "agent.created":
      return `${event.name} joined as ${roleName(event.role)} (${event.model === "" ? event.aiProvider : `${event.aiProvider} ${event.model}`}).`;
    case "agent.removed":
      return `${agent(event.agentId)} was removed.`;
    // Contractors (FR-10, ADR 0004): Agents the Manager adds for a Batch.
    case "contractor.added":
      return `${agent(event.managerId)} added ${event.name}, a Contractor in ${
        event.oneOff
          ? `a one-off ${event.roleName} Role`
          : `the ${event.roleName} Role`
      }, ${
        event.kind === "research"
          ? "to research a chat request"
          : event.batchId === undefined
            ? "for a chat request's Batch"
            : `for Batch ${String(event.batchId)}`
      }.`;
    case "contractor.kept":
      return `The Owner kept ${agent(event.agentId)} on the team: no longer a Contractor.`;
    case "contractor.left":
      return `${event.name} left${
        event.batchId === undefined
          ? ""
          : `: Batch ${String(event.batchId)} needs it no more`
      }.`;
    case "agent.status_changed":
      return `${agent(event.agentId)} is ${event.status}${
        event.issue === undefined ? "" : ` on #${String(event.issue)}`
      }${event.reason === undefined ? "" : `: ${event.reason}`}.`;
    case "agent.queue_changed":
      return `${String(event.queued)} ${event.queued === 1 ? "task waits" : "tasks wait"} for ${agent(event.agentId)}.`;
    case "agent.fresh_start":
      return `${agent(event.agentId)} made a Fresh Start${
        event.issue === undefined ? "" : ` on #${String(event.issue)}`
      } (${
        event.trigger === "manual"
          ? "by hand"
          : `Context Usage ${percent(event.contextUsage)}`
      }).`;
    case "agent.context_usage":
      return event.active
        ? `${agent(event.agentId)}'s Context Usage is ${
            event.contextUsage === null
              ? "unknown"
              : contextUsageText(event.contextUsage)
          }${event.issue === undefined ? "" : ` on #${String(event.issue)}`}.`
        : `${agent(event.agentId)}'s session ended.`;
    case "issue.picked_up":
      return `Picked up #${String(event.issue)}: ${event.title}`;
    case "issue.triaged":
      return event.outcome === "clear"
        ? `${agent(event.agentId)} triaged #${String(event.issue)}: clear to work, ${issuePriorityLabels[event.priority].toLowerCase()} priority${judgedBy[event.judgedBy]}.`
        : `${agent(event.agentId)} triaged #${String(event.issue)}: not clear enough to work, so it waits for the Owner${judgedBy[event.judgedBy]}.`;
    case "issue.routed":
      return `${agent(event.agentId)} gave #${String(event.issue)} to the ${event.roleName} Role${routedBy[event.routedBy]}.`;
    case "issue.assigned":
      return `#${String(event.issue)} assigned to ${agent(event.agentId)}.`;
    case "issue.label_changed":
      return `#${String(event.issue)} moved from ${stage(event.from)} to ${stage(event.to)}${
        event.agentId === undefined ? "" : ` by ${agent(event.agentId)}`
      }.`;
    case "manager.decision": {
      const manager = agent(event.agentId);
      const work = `#${String(event.issue)} (${event.stage})`;
      const from =
        event.fromAgentId === undefined
          ? ""
          : ` from ${agent(event.fromAgentId)}`;
      const to =
        event.toAgentId === undefined ? "" : ` to ${agent(event.toAgentId)}`;
      const done: Record<typeof event.action, string> = {
        retry: `retried ${work}`,
        reassign: `reassigned ${work}${from}${to}`,
        relabel: `moved #${String(event.issue)} from ${event.stage} to ${event.to ?? "another stage"}`,
        pause: `paused ${
          event.fromAgentId === undefined
            ? "an Agent"
            : agent(event.fromAgentId)
        } after ${work}`,
        escalate: `escalated ${work} to the Owner${
          event.to === undefined ? "" : `, moving it to ${event.to}`
        }`,
      };
      return `${manager} ${done[event.action]}, as ${watchdogReasons[event.trigger]}.`;
    }
    case "manager.action_refused":
      return `${agent(event.agentId)} was refused "${event.action}"${
        event.issue === undefined ? "" : ` on #${String(event.issue)}`
      }: a Manager may never merge, change repository settings or raise a cap.`;
    case "batch.planned":
      return `${agent(event.agentId)} ${
        event.editedFrom === undefined
          ? "drafted"
          : `replanned the Owner's edits to version ${String(event.editedFrom)} as`
      } version ${String(event.planVersion)} of Batch ${String(event.batchId)}'s Plan${
        event.draftedBy === "rules" ? ", by AI Office's rules" : ""
      }: ${issueList(event.issues)}.`;
    case "batch.approved":
      return `The Owner approved version ${String(event.planVersion)} of Batch ${String(event.batchId)}'s Plan, by ${agent(event.agentId)}.`;
    case "batch.started":
      return event.issues.length === 0
        ? `Batch ${String(event.batchId)} started; each of its issues waits for the issues it depends on.`
        : `Batch ${String(event.batchId)} started: work started on ${issueList(event.issues)}.`;
    case "batch.kickoff_started":
      return `${agent(event.agentId)} presented version ${String(event.planVersion)} of Batch ${String(event.batchId)}'s Plan at the Kickoff${
        event.agentIds.length === 0
          ? ", with no Agents assigned to acknowledge it"
          : ` to ${event.agentIds.map(agent).join(", ")}`
      }.`;
    case "batch.acknowledged":
      return `${agent(event.agentId)} acknowledged Batch ${String(event.batchId)}'s Plan${
        event.response === "ok"
          ? `: OK${event.by === "rules" ? " (by AI Office's rules)" : ""}.`
          : ` with a concern: ${event.concern ?? ""}`
      }`;
    case "batch.kickoff_ended":
      return `Batch ${String(event.batchId)}'s Kickoff ended${
        event.concerns === 0
          ? ", with no concerns."
          : `: ${String(event.concerns)} concern${event.concerns === 1 ? "" : "s"} on the whiteboard.`
      }`;
    case "batch.finished": {
      const parts = [
        `${String(event.merged)} of ${String(event.issues.length)} merged`,
        ...(event.closed > 0 ? [`${String(event.closed)} closed`] : []),
        ...(event.blocked > 0 ? [`${String(event.blocked)} blocked`] : []),
        ...(event.notStarted > 0
          ? [`${String(event.notStarted)} not started`]
          : []),
      ];
      return `Batch ${String(event.batchId)} finished: ${parts.join(", ")}; ${event.tokens.toLocaleString("en")} tokens. ${agent(event.agentId)} presented the Wrap-up.`;
    }
    case "status_update.given":
      return event.trigger === "hourly"
        ? `${agent(event.agentId)} gave the Floor's hourly Status update, as its Agents work: ${String(event.agentIds.length + 1)} ${event.agentIds.length === 0 ? "Agent" : "Agents"} in the last hour, and today.`
        : `${agent(event.agentId)} gave the Floor's Status update${event.trigger === "daily" ? ", as it was opened first today" : ""}: ${String(event.agentIds.length + 1)} ${event.agentIds.length === 0 ? "Agent" : "Agents"} on ${dayName(event.reportedDay)}, and today.`;
    case "memory.proposed":
      return `${agent(event.agentId)} proposed ${
        event.entries.length === 1
          ? "an entry"
          : `${String(event.entries.length)} entries`
      } for the repository's memory: ${event.entries
        .map((entry) => `"${entry}"`)
        .join("; ")}.`;
    case "memory.curated": {
      const why =
        event.reason === "batch"
          ? `as Batch ${String(event.batchId ?? "?")} ended`
          : "in its weekly tidy-up";
      const by = event.curatedBy === "rules" ? ", by AI Office's rules" : "";
      return event.pullRequest === undefined
        ? `${agent(event.agentId)} curated the repository's memory ${why}${by}: nothing changed (${String(event.proposals)} ${event.proposals === 1 ? "proposal" : "proposals"} taken).`
        : `${agent(event.agentId)} curated the repository's memory ${why}${by}, in PR #${String(event.pullRequest)}: ${String(event.entries)} ${event.entries === 1 ? "entry" : "entries"}, ${String(event.added)} added and ${String(event.removed)} removed, from ${String(event.proposals)} ${event.proposals === 1 ? "proposal" : "proposals"}.`;
    }
    case "memory.office_changed":
      return `The Owner changed the office-wide memory: ${String(event.added)} ${event.added === 1 ? "line" : "lines"} added and ${String(event.removed)} removed (${event.characters.toLocaleString("en-GB")} characters now).`;
    case "memory.role_proposed": {
      const entries =
        event.entries.length === 0
          ? "nothing"
          : `${event.entries.length === 1 ? "an entry" : `${String(event.entries.length)} entries`} (${event.entries
              .map((entry) => `"${entry}"`)
              .join("; ")})`;
      const refused =
        event.refused === 0
          ? ""
          : `; ${event.refused === 1 ? "one was" : `${String(event.refused)} were`} refused for looking like a credential`;
      return `${agent(event.agentId)} proposed ${entries} for the ${roleName(event.role)} memory, on #${String(event.issue)}${refused}.`;
    }
    case "memory.role_changed": {
      const who =
        event.by === "owner"
          ? "The Owner"
          : agent(event.agentId ?? "the Manager");
      const what = {
        recommended: "recommended",
        accepted: "accepted",
        rejected: "rejected",
        removed: "removed",
      }[event.change];
      const from = event.change === "removed" ? "from" : "for";
      return `${who} ${what} "${event.text}" ${from} the ${roleName(event.role)} memory${
        event.reason === undefined
          ? ""
          : `: ${event.reason.replace(/[.!?]+$/, "")}`
      }.`;
    }
    case "sandbox.started":
      return `${agent(event.agentId)} started a sandbox for #${String(event.issue)} on ${event.branch}.`;
    case "sandbox.stopped":
      return `${agent(event.agentId)}'s sandbox for #${String(event.issue)} ${
        {
          finished: "finished",
          failed: "failed",
          cancelled: "was cancelled",
          timed_out: "timed out",
          fresh_start: "stopped for a Fresh Start",
        }[event.outcome]
      }.`;
    case "grilling.session_changed": {
      const session = `Grilling Session ${String(event.sessionId)}`;
      const round = `round ${String(event.round)}`;
      const open = `${String(event.openQuestions)} ${event.openQuestions === 1 ? "question" : "questions"} open`;
      const settled = `${String(event.decisions)} ${event.decisions === 1 ? "decision" : "decisions"} settled`;
      return {
        started: `${agent(event.agentId)} started ${session}, in the meeting room.`,
        round: `${agent(event.agentId)} asked ${round} of ${session}: ${open}, ${settled}.`,
        settled: `${session}, ${round}: ${open}, ${settled}.`,
        paused: `${session} was paused in ${round}, with ${open} and ${settled}.`,
        resumed: `${session} was resumed in ${round}, with ${open} and ${settled}.`,
        ended: `${session} ended with ${settled}.`,
      }[event.change];
    }
    case "grilling.fact_finding_started":
      return `${agent(event.agentId)} started a read-only sandbox to find a fact for Grilling Session ${String(event.sessionId)}.`;
    case "grilling.fact_finding_stopped":
      return `${agent(event.agentId)}'s read-only sandbox for Grilling Session ${String(event.sessionId)} ${
        {
          found: "found the fact",
          unanswered: "finished without an answer",
          failed: "failed",
          cancelled: "was cancelled",
          timed_out: "timed out",
        }[event.outcome]
      }.`;
    case "sandbox.text":
      return event.text;
    case "sandbox.tool_call":
      return `${event.name} ${event.args}`;
    case "sandbox.diff":
      return `${agent(event.agentId)} changed ${event.path} (+${String(event.added)} −${String(event.removed)}).`;
    case "repository.changed":
      return `GitHub reported ${
        {
          push: "a push",
          pull_request: "a pull request change",
          check_run: "a check run",
          check_suite: "a check suite",
        }[event.change]
      } on the Floor's repository.`;
    case "branch.pushed":
      return `${event.branch} pushed for #${String(event.issue)} with ${String(event.commits)} new ${event.commits === 1 ? "commit" : "commits"} by ${agent(event.agentId)}${
        event.rebase === undefined
          ? ""
          : event.rebase.outcome === "up_to_date"
            ? `, already on ${event.rebase.onto}`
            : event.rebase.outcome === "rebased"
              ? `, rebased onto ${event.rebase.onto} at ${event.rebase.base.slice(0, 7)}`
              : `, not rebased onto ${event.rebase.onto}: ${event.rebase.files === undefined || event.rebase.files.length === 0 ? "it conflicts" : `${event.rebase.files.join(", ")} conflict`}`
      }.`;
    case "pull_request.opened":
      return `Pull request #${String(event.pullRequest)} opened for #${String(event.issue)}, by ${agent(event.agentId)}.`;
    case "grilling.documents_written":
      return `${agent(event.agentId)} wrote ${String(event.files)} ${event.files === 1 ? "document" : "documents"} of Grilling Session ${String(event.sessionId)} on ${event.branch}.`;
    case "grilling.pull_request_opened":
      return `Pull request #${String(event.pullRequest)} opened with the documents of Grilling Session ${String(event.sessionId)}, by ${agent(event.agentId)}.`;
    case "manager.issue_filed":
      return `${agent(event.agentId)} filed issue #${String(event.issue)} "${event.title}" for the Owner's chat request.`;
    case "grilling.issue_filed":
      return `Issue #${String(event.issue)} "${event.title}" filed from Grilling Session ${String(event.sessionId)}, drafted by ${agent(event.agentId)}${event.blockedBy.length === 0 ? "" : `, blocked by ${event.blockedBy.map((number) => `#${String(number)}`).join(", ")}`}.`;
    case "pull_request.merged":
      return `Pull request #${String(event.pullRequest)} for #${String(event.issue)} merged by the GitHub App, ${event.by === "owner" ? "as the Owner approved it" : "as the Merge Policy allowed"}.`;
    case "review.posted":
      return `${agent(event.agentId)} reviewed pull request #${String(event.pullRequest)} for #${String(event.issue)} (round ${String(event.round)}): ${reviewVerdictLabels[event.verdict].toLowerCase()}, with ${String(event.blocking)} blocking ${event.blocking === 1 ? "comment" : "comments"} and ${String(event.nits)} ${event.nits === 1 ? "nit" : "nits"}.`;
    case "qa.reported":
      return `${agent(event.agentId)} checked pull request #${String(event.pullRequest)} for #${String(event.issue)} (QA round ${String(event.round)}): ${event.result === "pass" ? "passed" : "failed"}.`;
    case "design.reported":
      return `${agent(event.agentId)} reviewed the UI of pull request #${String(event.pullRequest)} for #${String(event.issue)} (design round ${String(event.round)}): ${event.result === "pass" ? "approved" : "changes requested"}.`;
    case "handoff":
      return `${agent(event.fromAgentId)} handed #${String(event.issue)} to ${agent(event.toAgentId)} (${event.stage}): ${event.summary.changed}`;
    case "model_call.completed": {
      const caller =
        event.agentId !== undefined
          ? agent(event.agentId)
          : (event.ownerTool ?? "AI Office");
      return `${caller} called ${event.aiProvider}${
        event.model === null ? "" : ` ${event.model}`
      }: ${tokens(event.inputTokens)} in, ${tokens(event.outputTokens)} out (${String(event.status)}, ${String(event.latencyMs)} ms).`;
    }
    case "notice.raised":
      return `${event.kind === "action" ? "Action" : "Info"} Notice: ${event.title}`;
    case "notice.dismissed":
      return "A Notice was dismissed.";
    case "notice.acted_on":
      return `A Notice was acted on (${event.action}).`;
    case "cap.warning":
    case "cap.reached": {
      const who =
        event.level === "office"
          ? "The Office"
          : event.level === "floor"
            ? event.floorId === undefined
              ? "A Floor"
              : `Floor "${floor(event.floorId)}"`
            : event.level === "agent"
              ? event.agentId === undefined
                ? (event.ownerTool ?? "An Agent")
                : agent(event.agentId)
              : `#${String(event.issue ?? "")}`;
      const share = event.cap === 0 ? 1 : event.used / event.cap;
      return event.type === "cap.reached"
        ? `${who} reached its ${event.period} Token Cap (${tokens(event.used)} of ${tokens(event.cap)} tokens).`
        : `${who} used ${percent(share)} of its ${event.period} Token Cap (${tokens(event.used)} of ${tokens(event.cap)} tokens).`;
    }
    case "ai_account.token_health":
      return event.reauthenticationNeeded
        ? `${event.name} needs you to sign in again: its token could not be refreshed (${event.health}).`
        : `${event.name}'s token is ${event.health}, until ${new Date(event.expiresAt).toLocaleString()}.`;
    case "ai_account.limit_changed":
      return `${
        event.reason === null || event.until === null
          ? `${event.name} is serving again.`
          : `${event.name} is held back until ${new Date(event.until).toLocaleString()}: ${aiAccountLimitReasonLabels[event.reason].toLowerCase()}.`
      }${
        event.providerAvailable
          ? ""
          : ` No ${event.aiProvider} AI Account is left to serve.`
      }`;
    case "ai_account.window_refreshed": {
      const names = event.windows
        .map((window) => (window === "five_hour" ? "five-hour" : "weekly"))
        .join(" and ");
      const windows =
        event.windows.length > 1
          ? `new ${names} windows`
          : `a new ${names} window`;
      return event.served
        ? `Auto-refresh started ${windows} on ${event.name}${
            event.resetsAt === null
              ? "."
              : `; the five-hour window resets at ${new Date(event.resetsAt).toLocaleString()}.`
          }`
        : `Auto-refresh's request to ${event.name} was not served, so no new ${names} window started. It is sent again only once a later window resets.`;
    }
    case "config.changed":
      return `${
        {
          office: "Office",
          floor: "Floor",
          agent: "Agent",
          gateway: "AI Gateway",
          security: "Security",
          communications: "Communications Agent",
          google: "Google sign-in",
        }[event.scope]
      } settings changed: ${event.keys.join(", ")}.`;
    case "skill.added":
      return event.template === undefined
        ? `Skill "${event.name}" ${
            {
              upload: "uploaded",
              git: "imported from Git",
              editor: "written in the editor",
              template: "added by a Floor Template",
            }[event.source]
          }${event.enabled ? "." : "; it waits for review before it can be enabled."}`
        : `Skill "${event.name}" added to the library by the ${event.template.name} Floor Template.`;
    case "skill.changed":
      return `Skill "${event.name}" ${
        {
          edited: "edited",
          reviewed: "reviewed and enabled",
          enabled: "enabled",
          disabled: "disabled",
        }[event.change]
      }.`;
    case "skill.removed":
      return `Skill "${event.name}" removed.`;
    case "role.created":
      return event.template === undefined
        ? `Role "${event.name}" made${
            event.duplicatedFrom === null
              ? ""
              : ` as a copy of ${roleName(event.duplicatedFrom)}`
          }, in the ${stageNames[event.stage]} Stage.`
        : `Role "${event.name}" added to the library by the ${event.template.name} Floor Template, in the ${stageNames[event.stage]} Stage.`;
    case "role.changed":
      return `Role "${event.name}" changed: ${event.keys.map((key) => roleFieldNames[key] ?? key).join(", ")}. It reaches ${
        event.agents === 1 ? "1 Agent" : `${String(event.agents)} Agents`
      } from their next task.`;
    case "role.removed":
      return `Role "${event.name}" deleted, with its Role memory.`;
    case "floor_template.added":
      return `Floor Template "${event.name}" ${
        event.source === "duplicate" && event.duplicatedFrom !== null
          ? `made as a copy of ${event.duplicatedFrom.name}`
          : event.source === "floor" && event.floorId !== null
            ? `saved from the ${floor(event.floorId)} Floor's set-up`
            : event.source === "git"
              ? "imported from Git"
              : event.source === "file"
                ? "imported from a file"
                : "added"
      }${event.enabled ? "." : waitsForReview}`;
    case "floor_template.changed":
      return {
        edited: `Floor Template "${event.name}" changed: ${event.keys.map((key) => templatePartNames[key] ?? key).join(", ")}.`,
        reviewed: `Floor Template "${event.name}" reviewed and enabled: a Floor can be added from it.`,
        replaced: `Floor Template "${event.name}" replaced by a configuration import${waitsForReview}`,
      }[event.change];
    case "floor_template.removed":
      return `Floor Template "${event.name}" deleted. Floors added from it keep everything it set up.`;
    case "connection.added":
      return `Connection "${event.name}" added (${connectionTypeNames[event.connectionType]}).`;
    case "connection.changed":
      return event.keys.length === 1 && event.paused !== undefined
        ? `Connection "${event.name}" ${event.paused ? "paused" : "resumed"}.`
        : `Connection "${event.name}" changed: ${event.keys.join(", ")}.`;
    case "connection.removed":
      return `Connection "${event.name}" deleted.`;
    case "connection.failing":
      return event.reason === "google_sign_in_revoked"
        ? `Connection "${event.name}" is failing: Google refused AI Office's sign-in.`
        : `Connection "${event.name}" is failing: ${String(event.failures)} deliveries in a row failed.`;
    case "connection.recovered":
      return `Connection "${event.name}" recovered: a delivery arrived.`;
    case "connection.delivery_expired":
      return `A delivery to Connection "${event.name}" was given up after ${String(event.attempts)} attempts in 24 hours.`;
    case "google.signed_in":
      return `Signed in to Google for the Google Connections, granting ${
        event.scopes.length === 1
          ? "1 scope"
          : `${String(event.scopes.length)} scopes`
      }: ${event.scopes.join(", ") || "none"}.`;
    case "google.signed_out":
      return "Signed out of Google: the Google Connections publish nothing until the Owner signs in again.";
    case "google.grant_revoked":
      return `Google refused AI Office's sign-in (revoked or expired): ${
        event.connections === 1
          ? "1 Google Connection is"
          : `${String(event.connections)} Google Connections are`
      } failing until the Owner signs in again.`;
    case "sign_in.succeeded":
      return `The Owner signed in from ${event.ip}${
        event.secondFactor === undefined
          ? ""
          : event.secondFactor === "totp"
            ? " with a TOTP code"
            : " with a recovery code"
      }.`;
    case "sign_in.failed":
      return `A sign-in from ${event.ip} failed${
        event.secondFactor === undefined ? "" : " at the second factor"
      }.`;
    case "sign_in.locked_out":
      return `Sign-ins from ${event.ip} are locked out for ${String(event.lockoutSeconds)} seconds.`;
    case "signed_out":
      return event.everywhere
        ? "The Owner signed out everywhere."
        : "The Owner signed out.";
    case "gateway_key.failed":
      return `A Gateway Key not in use was presented at /v1 from ${event.ip}.`;
    case "gateway_key.locked_out":
      return `Gateway Keys from ${event.ip} are refused at /v1 for ${String(event.lockoutSeconds)} seconds, after repeated keys not in use.`;
  }
}
