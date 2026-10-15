import type { Database } from "@ai-office/db";
import {
  databaseFloorStopStore,
  memoryFloorStopStore,
  type FloorStopStore,
} from "./floors/stops.ts";
import { builtInRoles } from "@ai-office/shared";

import {
  databaseStorageStore,
  memoryStorageStore,
  type StorageStore,
} from "./storage/storage.ts";
import {
  databaseAgentStore,
  memoryAgentStore,
  type AgentStore,
  type MemoryAgentStore,
} from "./agents/store.ts";
import {
  databaseAiProviderSettingsStore,
  memoryAiProviderSettingsStore,
  type AiProviderSettingsStore,
} from "./ai-providers/ai-providers.ts";
import {
  databaseBatchStore,
  memoryBatchStore,
  type BatchStore,
} from "./batches/store.ts";
import {
  databaseCapPauseStore,
  memoryCapPauseStore,
  type CapPauseStore,
} from "./caps/pauses.ts";
import {
  databaseTokenCapStore,
  memoryTokenCapStore,
  type TokenCapStore,
} from "./caps/store.ts";
import {
  databaseFloorStore,
  memoryFloorStore,
  type FloorStore,
} from "./floors/store.ts";
import {
  databaseDecisionStore,
  memoryDecisionStore,
  type DecisionStore,
} from "./manager/decision-store.ts";
import {
  databaseGrillingStore,
  memoryGrillingStore,
  type GrillingStore,
} from "./grilling/store.ts";
import {
  databaseStatusUpdateStore,
  memoryStatusUpdateStore,
  type StatusUpdateStore,
} from "./manager/status-update.ts";
import {
  databaseDirectChatStore,
  memoryDirectChatStore,
  type DirectChatStore,
} from "./direct-chats/store.ts";
import {
  databaseManagerChatSessionStore,
  memoryManagerChatSessionStore,
  type ManagerChatSessionStore,
} from "./manager/chat-session-store.ts";
import {
  databaseChatAttachmentStore,
  memoryChatAttachmentStore,
  type ChatAttachmentStore,
} from "./manager/attachments.ts";
import {
  databaseManagerChatStore,
  memoryManagerChatStore,
  type ManagerChatStore,
} from "./manager/store.ts";
import {
  databaseTriageStore,
  memoryTriageStore,
  type TriageStore,
} from "./manager/triage-store.ts";
import {
  databaseMemoryStore,
  memoryMemoryStore,
  type MemoryStore,
} from "./memory/store.ts";
import {
  databaseOfficeMemoryStore,
  memoryOfficeMemoryStore,
  type OfficeMemoryStore,
} from "./memory/office-store.ts";
import {
  databaseNoticeStore,
  memoryNoticeStore,
  type NoticeStore,
} from "./notices/store.ts";
import {
  databaseReviewLoopStore,
  memoryReviewLoopStore,
  type ReviewLoopStore,
} from "./review/store.ts";
import {
  databaseSkillStore,
  memorySkillStore,
  type SkillStore,
} from "./skills/store.ts";
import {
  databaseFloorSkillToggleStore,
  memoryFloorSkillToggleStore,
  type FloorSkillToggleStore,
} from "./skills/toggles.ts";
import {
  databaseRepositorySkillReviewStore,
  memoryRepositorySkillReviewStore,
  type RepositorySkillReviewStore,
} from "./skills/reviews.ts";
import {
  databaseRoleStore,
  memoryRoleStore,
  type MemoryRoleStore,
  type RoleStore,
} from "./roles/store.ts";
import {
  databaseFloorTemplateStore,
  memoryFloorTemplateStore,
  type FloorTemplateStore,
} from "./templates/store.ts";
import {
  databaseWorkTurnsStore,
  memoryWorkTurnsStore,
  type WorkTurnsStore,
} from "./work/turns.ts";
import {
  databaseGitHubConnectionStore,
  memoryGitHubConnectionStore,
  type GitHubConnectionStore,
} from "./github-connections/store.ts";
import {
  databaseOfficeSettingsStore,
  memoryOfficeSettingsStore,
  type OfficeSettingsStore,
} from "./office/settings.ts";

/**
 * Where the Office's settings (and its AI Providers'), Floors, Agents, the
 * Role library, Notices, Token Caps and the Agents paused at them, the
 * Review Loop's verdicts and Handoffs, Skills and each Floor's Skill settings, the
 * Manager chats, the Manager's triage of issues and its decision log,
 * Batches with their Plans, the turns of an issue's work Roles,
 * repository memory's proposals and curations, and the office-wide and
 * Role memory live.
 */
export interface OfficeStores {
  readonly office: OfficeSettingsStore;
  readonly aiProviders: AiProviderSettingsStore;
  readonly floors: FloorStore;
  readonly agents: AgentStore;
  /** The office Role library (FR-98). */
  readonly roles: RoleStore;
  /** The Owner's own Floor Templates (FR-101). */
  readonly floorTemplates: FloorTemplateStore;
  readonly notices: NoticeStore;
  readonly tokenCaps: TokenCapStore;
  readonly capPauses: CapPauseStore;
  /** The Floors where the Owner stopped everything. */
  readonly floorStops: FloorStopStore;
  readonly reviews: ReviewLoopStore;
  readonly skills: SkillStore;
  readonly managerChat: ManagerChatStore;
  /** The files and images the Owner attaches to Manager chat messages (FR-24). */
  readonly chatAttachments: ChatAttachmentStore;
  /** Each Manager chat conversation's agent session (ADR 0004). */
  readonly managerChatSessions: ManagerChatSessionStore;
  /** Direct chats with each Agent, and the Terminal. */
  readonly directChats: DirectChatStore;
  /** Each Floor's Grilling Sessions (FR-77, FR-82). */
  readonly grilling: GrillingStore;
  /** Each Floor's Status updates, one a day (FR-23a). */
  readonly statusUpdates: StatusUpdateStore;
  readonly triage: TriageStore;
  readonly decisions: DecisionStore;
  readonly floorSkills: FloorSkillToggleStore;
  /** The repository Skills the Owner reviewed on each Floor (P1-10). */
  readonly repositorySkillReviews: RepositorySkillReviewStore;
  readonly batches: BatchStore;
  /** The turns of the work Roles a Plan gives an issue (FR-25 (1)). */
  readonly workTurns: WorkTurnsStore;
  readonly memory: MemoryStore;
  readonly officeMemory: OfficeMemoryStore;
  /** How much each kind of history takes, and deleting the oldest. */
  readonly storage: StorageStore;
  /** The GitHub Apps and access tokens the Owner added (ADR 0011). */
  readonly githubConnections: GitHubConnectionStore;
}

/**
 * The `office_settings`, `ai_provider_settings`, `floors`, `agents`, `roles`,
 * `floor_templates`,
 * `notices`, `issue_token_caps`, `agent_cap_pauses`, `review_verdicts`,
 * `qa_reports`, `design_reviews`, `handoffs`, `skills`, `floor_skill_toggles`,
 * `repository_skill_reviews`,
 * `manager_chat_messages`, `grilling_sessions`, `status_updates`, `issue_triage`, `manager_decisions`, `batches`,
 * `plans`, `batch_issues`, `issue_work_turns`, `memory_proposals`,
 * `memory_curations`,
 * `office_memory`, `role_memory` and `github_connections` tables; and the
 * storage the histories take.
 */
export const databaseStores = (db: Database): OfficeStores => ({
  office: databaseOfficeSettingsStore(db),
  aiProviders: databaseAiProviderSettingsStore(db),
  floors: databaseFloorStore(db),
  agents: databaseAgentStore(db),
  roles: databaseRoleStore(db),
  floorTemplates: databaseFloorTemplateStore(db),
  notices: databaseNoticeStore(db),
  tokenCaps: databaseTokenCapStore(db),
  capPauses: databaseCapPauseStore(db),
  floorStops: databaseFloorStopStore(db),
  reviews: databaseReviewLoopStore(db),
  skills: databaseSkillStore(db),
  managerChat: databaseManagerChatStore(db),
  chatAttachments: databaseChatAttachmentStore(db),
  managerChatSessions: databaseManagerChatSessionStore(db),
  directChats: databaseDirectChatStore(db),
  grilling: databaseGrillingStore(db),
  statusUpdates: databaseStatusUpdateStore(db),
  triage: databaseTriageStore(db),
  decisions: databaseDecisionStore(db),
  floorSkills: databaseFloorSkillToggleStore(db),
  repositorySkillReviews: databaseRepositorySkillReviewStore(db),
  batches: databaseBatchStore(db),
  workTurns: databaseWorkTurnsStore(db),
  memory: databaseMemoryStore(db),
  officeMemory: databaseOfficeMemoryStore(db),
  storage: databaseStorageStore(db),
  githubConnections: databaseGitHubConnectionStore(db),
});

/** Office settings, Floors, Agents, Notices, caps, Skills and chats in memory: for tests. */
export function memoryStores(): OfficeStores & {
  readonly floors: ReturnType<typeof memoryFloorStore>;
  readonly agents: MemoryAgentStore;
  readonly roles: MemoryRoleStore;
  readonly floorTemplates: ReturnType<typeof memoryFloorTemplateStore>;
  readonly notices: ReturnType<typeof memoryNoticeStore>;
  readonly capPauses: ReturnType<typeof memoryCapPauseStore>;
  readonly floorStops: ReturnType<typeof memoryFloorStopStore>;
  readonly reviews: ReturnType<typeof memoryReviewLoopStore>;
  readonly skills: ReturnType<typeof memorySkillStore>;
  readonly managerChat: ReturnType<typeof memoryManagerChatStore>;
  readonly chatAttachments: ReturnType<typeof memoryChatAttachmentStore>;
  readonly managerChatSessions: ReturnType<
    typeof memoryManagerChatSessionStore
  >;
  readonly directChats: ReturnType<typeof memoryDirectChatStore>;
  readonly grilling: ReturnType<typeof memoryGrillingStore>;
  readonly triage: ReturnType<typeof memoryTriageStore>;
  readonly decisions: ReturnType<typeof memoryDecisionStore>;
  readonly batches: ReturnType<typeof memoryBatchStore>;
  readonly workTurns: ReturnType<typeof memoryWorkTurnsStore>;
  readonly memory: ReturnType<typeof memoryMemoryStore>;
  readonly officeMemory: ReturnType<typeof memoryOfficeMemoryStore>;
  readonly githubConnections: ReturnType<typeof memoryGitHubConnectionStore>;
} {
  const officeMemory = memoryOfficeMemoryStore();
  // As in the database: a Role an Agent fills stays, and a deleted Role's
  // Role memory goes with it.
  const roles = memoryRoleStore(builtInRoles, {
    inUse: async (id) => ((await agents.countByRole()).get(id) ?? 0) > 0,
    onRemove: (id) => {
      const kept = officeMemory.roleEntries.filter(({ role }) => role !== id);
      officeMemory.roleEntries.splice(0, Infinity, ...kept);
    },
  });
  const agents = memoryAgentStore(roles);
  // A message's attachments are bound to it as it is kept (FR-24).
  const chatAttachments = memoryChatAttachmentStore();
  return {
    office: memoryOfficeSettingsStore(),
    aiProviders: memoryAiProviderSettingsStore(),
    floors: memoryFloorStore(agents),
    agents,
    roles,
    floorTemplates: memoryFloorTemplateStore(),
    notices: memoryNoticeStore(),
    tokenCaps: memoryTokenCapStore(),
    capPauses: memoryCapPauseStore(),
    floorStops: memoryFloorStopStore(),
    reviews: memoryReviewLoopStore(),
    skills: memorySkillStore(),
    managerChat: memoryManagerChatStore({ attachments: chatAttachments }),
    chatAttachments,
    managerChatSessions: memoryManagerChatSessionStore(),
    directChats: memoryDirectChatStore(),
    grilling: memoryGrillingStore(),
    statusUpdates: memoryStatusUpdateStore(),
    triage: memoryTriageStore(),
    decisions: memoryDecisionStore(),
    floorSkills: memoryFloorSkillToggleStore(),
    repositorySkillReviews: memoryRepositorySkillReviewStore(),
    batches: memoryBatchStore(),
    workTurns: memoryWorkTurnsStore(),
    memory: memoryMemoryStore(),
    officeMemory,
    storage: memoryStorageStore(),
    githubConnections: memoryGitHubConnectionStore(),
  };
}
