import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

import type { GitHubApp, Repository } from "@ai-office/github";
import type { ManagerChatToolUse } from "@ai-office/shared";

import { runGit } from "../git/command.ts";
import {
  callingToolOf,
  conversationPrompt,
  type CallingTool,
  type ToolRunner,
} from "../models/agent-tool-client.ts";
import {
  claudeSessionArgs,
  codexSessionArgs,
  readSessionTurn,
  sessionAttachments,
  sessionRepositoryTools,
  sessionImagePath,
  sessionToolHomes,
  sessionWorkspace,
} from "../models/agent-tool-session.ts";
import {
  ModelCallError,
  type ModelMessage,
  type ModelReply,
} from "../models/client.ts";
import { cloneRepository } from "../sandbox/clone.ts";
import {
  codexModelEnvironment,
  gatewayModelEnvironment,
  refuseAiAccountCredentials,
  sandboxEnvironment,
  type AiAccountCredentialCheck,
  type GatewayAccess,
  type ModelEnvironment,
} from "../sandbox/environment.ts";
import { sandboxImages } from "../sandbox/images.ts";
import { makeWorkDir } from "../sandbox/work-dir.ts";
import type { ManagerChatSessionStore } from "./chat-session-store.ts";
import type { ChatTurnAttachment } from "./chat-turn.ts";

// The Manager chat as a continuing, read-only agent session (PRD FR-24,
// ADR 0004), as the Owner has from Claude Code. A Manager whose AI
// Provider has an agent tool that can run a session (Claude Code for
// Claude, Codex for ChatGPT, FR-16) answers each plain message as a turn
// of one session per conversation: the tool runs in its sandbox image,
// reaching models only through the AI Gateway with the Manager's own
// Gateway Key (ADR 0001), whether a subscription or an API key serves the
// call there, so both get the same read-only tools. It reads and searches
// a read-only clone of the Floor's repository at its default branch, its
// history with `git log`, `git show` and `git diff`, and the web; it
// changes nothing: every change goes through an issue, an Agent or a
// Contractor.
//
// A conversation (the chat since its latest clear or compaction, as its
// calls name their session, FR-37, FR-84) is one session, kept by the
// tool's own id (`ManagerChatSessionStore`) and continued turn to turn
// rather than replaying the transcript: its first turn is given the
// conversation so far, each later turn only the newest of the Owner's
// turns. "/clear" and "/compact" start a new conversation, and so a new
// session. When the chat's instructions change within a conversation (a
// Skill loaded, research reported back), the turn carries them.

/** One turn of the Manager's session: its answer to the latest message. */
export interface ManagerChatTurn {
  readonly floor: {
    readonly id: string;
    /** `owner/name` on GitHub. */
    readonly repository: string;
    readonly defaultBranch: string;
  };
  readonly manager: {
    readonly id: string;
    readonly aiProvider: string;
  };
  /** The Manager's own Model, and its effort (null for the default). */
  readonly model: string;
  readonly effort: string | null;
  /** The Manager's instructions: its system prompt. */
  readonly system: string;
  /** The conversation the Model is given, the turn to answer last. */
  readonly messages: readonly ModelMessage[];
  /** The conversation, as its calls name their session. */
  readonly conversation: string;
  /**
   * The images the Owner attached, on a turn that carries their message:
   * the session views each where the turn's text says it is
   * (`sessionImagePath`). None if absent.
   */
  readonly images?: readonly ChatTurnAttachment[];
  readonly signal: AbortSignal;
  /** Each piece of the answer's text, as it is written. */
  readonly onText: (text: string) => void;
  /** Each tool the session uses, as it uses it. */
  readonly onTool: (tool: ManagerChatToolUse) => void;
}

/** The Manager chat's agent sessions. */
export interface ManagerChatSessions {
  /** Whether a Manager with this Model answers in a session. */
  serves(model: string): boolean;
  /** Answers the turn in the conversation's session, started or resumed. */
  turn(turn: ManagerChatTurn): Promise<ModelReply>;
}

/** One run of the Manager's agent tool: a session's turn. */
export interface SessionToolRun {
  readonly tool: CallingTool;
  readonly floor: ManagerChatTurn["floor"];
  readonly manager: ManagerChatTurn["manager"];
  readonly model: string;
  readonly effort: string | null;
  readonly system: string;
  readonly conversation: string;
  /**
   * The session: started with `id` (Claude Code is given its id) or by
   * the tool (Codex, `id` null); or resumed by `id`.
   */
  readonly session:
    | { readonly resume: false; readonly id: string | null }
    | { readonly resume: true; readonly id: string };
  /** The turn: the conversation so far on a session's first turn. */
  readonly input: string;
  /** The turn's images, put at `sessionImagePath` by their place. */
  readonly images: readonly ChatTurnAttachment[];
  readonly signal: AbortSignal;
  readonly onText: (text: string) => void;
  readonly onTool: (tool: ManagerChatToolUse) => void;
  /** Told the session's id as the tool names it. */
  readonly onSession: (id: string) => void;
}

/** Runs the Manager's agent tool, which keeps its sessions. */
export interface SessionTool {
  /** Whether the tool still holds the Floor's session `id`, to resume it. */
  holds(floorId: string, tool: CallingTool, id: string): Promise<boolean>;
  run(run: SessionToolRun): Promise<ModelReply>;
}

/** The turn, with the Manager's instructions as they now are. */
export const instructionsChangedTurn = (system: string, turn: string) =>
  `<instructions>\nYour instructions have changed. From now on, follow these in place of those you were given before:\n\n${system}\n</instructions>\n\n${turn}`;

const fingerprint = (text: string): string =>
  createHash("sha256").update(text).digest("hex");

export function createManagerChatSessions(options: {
  readonly store: ManagerChatSessionStore;
  readonly tool: SessionTool;
  readonly now?: () => Date;
}): ManagerChatSessions {
  const now = options.now ?? (() => new Date());
  /** The instructions each session was last given, by conversation. */
  const given = new Map<string, string>();
  return {
    serves: (model) => callingToolOf(model) !== undefined,

    async turn(turn) {
      const tool = callingToolOf(turn.model);
      if (tool === undefined) {
        throw new ModelCallError(
          503,
          `No agent tool runs a session with "${turn.model}".`,
        );
      }
      const { floor, conversation } = turn;
      const key = `${floor.id}\n${conversation}`;
      const kept = await options.store.get(floor.id, conversation);
      const resumed =
        kept?.tool === tool &&
        (await options.tool.holds(floor.id, tool, kept.toolSessionId))
          ? kept
          : undefined;
      const instructions = fingerprint(turn.system);
      let input: string;
      let session: SessionToolRun["session"];
      if (resumed !== undefined) {
        const latest = turn.messages.at(-1)?.content ?? "";
        input =
          given.get(key) === instructions
            ? latest
            : instructionsChangedTurn(turn.system, latest);
        session = { resume: true, id: resumed.toolSessionId };
      } else {
        // A new session: Claude Code is given its id, Codex names its own.
        const id = tool === "Claude Code" ? randomUUID() : null;
        if (id !== null) {
          await options.store.put(
            { floorId: floor.id, conversation, tool, toolSessionId: id },
            now(),
          );
        }
        input = conversationPrompt(turn.messages);
        session = { resume: false, id };
      }
      let saving: Promise<void> | undefined;
      const onSession = (id: string): void => {
        if (!session.resume && session.id === null) {
          saving = options.store.put(
            { floorId: floor.id, conversation, tool, toolSessionId: id },
            now(),
          );
        }
      };
      try {
        const reply = await options.tool.run({
          tool,
          floor,
          manager: turn.manager,
          model: turn.model,
          effort: turn.effort,
          system: turn.system,
          conversation,
          session,
          input,
          images: turn.images ?? [],
          signal: turn.signal,
          onText: turn.onText,
          onTool: turn.onTool,
          onSession,
        });
        given.set(key, instructions);
        if (session.resume) {
          await options.store.put(
            {
              floorId: floor.id,
              conversation,
              tool,
              toolSessionId: session.id,
            },
            now(),
          );
        }
        return reply;
      } finally {
        // A session the tool named is kept even if its turn failed.
        await saving;
        if (!session.resume) {
          given.set(key, instructions);
        }
      }
    },
  };
}

export interface DockerSessionToolOptions {
  readonly github: GitHubApp;
  /** The Gateway, as a sandbox reaches it, with the Manager's Gateway Key. */
  readonly gateway: (managerId: string) => Promise<GatewayAccess | undefined>;
  /** Runs the tool in its image: `dockerToolRunner` in production. */
  readonly run: ToolRunner;
  /** Where each Floor's clone and tool state are kept. */
  readonly workDir: string;
  /** Whether a value holds one of the Owner's AI Account credentials. */
  readonly isAiAccountCredential?: AiAccountCredentialCheck;
  /** Where to clone a repository from; its GitHub page plus `.git`. */
  readonly cloneUrl?: (repository: Repository) => string;
  readonly images?: Partial<Record<CallingTool, string>>;
  /** How long one turn may take; 10 minutes by default. */
  readonly timeoutMs?: number;
}

/** AI Office's repository tools, which the session runs as an MCP server. */
const repositoryToolsSource = new URL("./repository-tools.ts", import.meta.url);

const exists = (path: string): Promise<boolean> =>
  stat(path).then(
    () => true,
    () => false,
  );

/**
 * The Manager's agent tool, run with `docker run` like a sandbox: per
 * Floor, a clone of its repository at its default branch made with the
 * GitHub App's read-only token and refreshed before each turn
 * (`<workDir>/<floorId>/repo`, mounted read-only where the tool works),
 * each tool's own state (`<workDir>/<floorId>/<tool>`, mounted as its
 * home, so its sessions survive a restart), and AI Office's repository
 * tools (`<workDir>/<floorId>/tools`, mounted read-only), through which it
 * reads the history and, for Codex, the files: it has no shell. Its
 * environment is a sandbox's, allow-listed, with the way to the Gateway
 * only: no Git identity, no GitHub token, never an AI Account's
 * credential. Nothing is ever pushed.
 */
export function dockerSessionTool(
  options: DockerSessionToolOptions,
): SessionTool {
  const timeoutMs = options.timeoutMs ?? 10 * 60 * 1000;
  const floorDir = (floorId: string) => join(options.workDir, floorId);
  const homeOf = (floorId: string, tool: CallingTool) =>
    join(floorDir(floorId), tool === "Claude Code" ? "claude" : "codex");

  /** Brings the clone at `into` to the default branch, reading with `token`. */
  const refreshWith = async (
    into: string,
    repository: Repository,
    token: string,
    floor: ManagerChatTurn["floor"],
    signal: AbortSignal,
  ): Promise<string> => {
    const branch = floor.defaultBranch;
    const fresh = async () => {
      await rm(into, { recursive: true, force: true });
      await cloneRepository({
        url: options.cloneUrl?.(repository) ?? `${repository.htmlUrl}.git`,
        token,
        branch,
        into,
        signal,
      });
    };
    if (await exists(join(into, ".git"))) {
      try {
        await runGit(
          "fetch the default branch",
          [
            "fetch",
            "--quiet",
            "--no-tags",
            "origin",
            `+refs/heads/${branch}:refs/remotes/origin/${branch}`,
          ],
          { cwd: into, token, signal },
        );
        await runGit(
          "check out the default branch",
          ["reset", "--quiet", "--hard", `refs/remotes/origin/${branch}`],
          { cwd: into, signal },
        );
      } catch {
        await fresh();
      }
    } else {
      await fresh();
    }
    // A repository must not choose what a sandbox is given.
    await rm(join(into, ".sandcastle", ".env"), { force: true });
    return into;
  };

  /** The Floor's clone, at its default branch as GitHub has it now. */
  const refresh = async (
    floor: ManagerChatTurn["floor"],
    signal: AbortSignal,
  ): Promise<string> => {
    const into = join(floorDir(floor.id), "repo");
    const client = options.github.repository(floor.repository);
    const [repository, readOnly] = await Promise.all([
      client.get(),
      client.readOnlyToken(),
    ]);
    try {
      return await refreshWith(into, repository, readOnly.token, floor, signal);
    } finally {
      // Its own, used here and nowhere else: revoked once the clone is
      // fresh (W1-3).
      await client.revokeToken(readOnly.token).catch(() => undefined);
    }
  };

  return {
    async holds(floorId, tool, id) {
      const home = homeOf(floorId, tool);
      try {
        const files = await readdir(home, { recursive: true });
        return files.some((file) => file.endsWith(`${id}.jsonl`));
      } catch {
        return false;
      }
    },

    async run(run) {
      const signal = AbortSignal.any([
        run.signal,
        AbortSignal.timeout(timeoutMs),
      ]);
      const access = await options.gateway(run.manager.id);
      if (access === undefined) {
        throw new ModelCallError(401, "The Manager has no Gateway Key.");
      }
      // Its calls name the conversation as their session (FR-37, FR-84),
      // and no issue: it works none.
      const attribution = { session: run.conversation };
      const model: ModelEnvironment =
        run.tool === "Claude Code"
          ? gatewayModelEnvironment(access, attribution)
          : codexModelEnvironment(access, attribution);
      const environment = sandboxEnvironment({ githubToken: "", model });
      if (options.isAiAccountCredential !== undefined) {
        await refuseAiAccountCredentials(
          environment,
          options.isAiAccountCredential,
        );
      }
      const repository = await refresh(run.floor, signal);
      const home = homeOf(run.floor.id, run.tool);
      await makeWorkDir(options.workDir);
      await mkdir(home, { recursive: true });
      // The repository tools, as this AI Office has them, every turn.
      const tools = join(floorDir(run.floor.id), "tools");
      await mkdir(tools, { recursive: true });
      await writeFile(
        join(tools, "repository-tools.ts"),
        await readFile(repositoryToolsSource),
      );
      // The turn's images, in a directory of its own, mounted read-only
      // where the turn's text says they are, and removed after it.
      const attached =
        run.images.length === 0
          ? undefined
          : join(floorDir(run.floor.id), "attachments", randomUUID());
      try {
        if (attached !== undefined) {
          await mkdir(attached, { recursive: true });
          await Promise.all(
            run.images.map((image, index) =>
              writeFile(
                join(
                  attached,
                  sessionImagePath(index, image.name).slice(
                    sessionAttachments.length + 1,
                  ),
                ),
                image.content,
              ),
            ),
          );
        }
        const command = {
          model: run.model,
          aiProvider: run.manager.aiProvider,
          effort: run.effort,
          system: run.system,
          session: run.session,
        };
        const lines = options.run({
          tool: run.tool,
          image: options.images?.[run.tool] ?? sandboxImages[run.tool],
          args:
            run.tool === "Claude Code"
              ? claudeSessionArgs(command)
              : codexSessionArgs(
                  command,
                  model["OPENAI_BASE_URL"] ?? "",
                  // Codex is shown them too; Claude Code reads them.
                  run.images.map((image, index) =>
                    sessionImagePath(index, image.name),
                  ),
                ),
          environment,
          // Codex is given its instructions with the session's first turn.
          input:
            run.tool === "Codex" && !run.session.resume
              ? `${run.system}\n\n${run.input}`
              : run.input,
          mounts: [
            { host: repository, container: sessionWorkspace, readOnly: true },
            {
              host: home,
              container: sessionToolHomes[run.tool],
              readOnly: false,
            },
            ...(attached === undefined
              ? []
              : [
                  {
                    host: attached,
                    container: sessionAttachments,
                    readOnly: true,
                  },
                ]),
            { host: tools, container: sessionRepositoryTools, readOnly: true },
          ],
          workdir: sessionWorkspace,
          signal,
        });
        return await readSessionTurn(run.tool, lines, {
          onText: run.onText,
          onTool: run.onTool,
          onSession: run.onSession,
        });
      } finally {
        if (attached !== undefined) {
          await rm(attached, { recursive: true, force: true });
        }
      }
    },
  };
}
