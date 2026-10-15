// The server each end-to-end test runs: AI Office, started as
// `apps/server/src/main.ts` starts it, with a control channel to the test
// over IPC (`support/control.ts`). Through it a test does what parts of AI
// Office not built yet will do: raise a Notice, or publish an Agent's
// events. It can also run intake at once, rather than wait for its
// interval, and record Gateway requests for the analytics to read. There is no Docker here, so Agents' tasks go to a stand-in
// sandbox runner, which records each task (its Agent, AI Provider, Model
// and effort) for the test and then fails it, as a sandbox that could not
// run would. It is never part of AI Office itself.
//
// It has its own tsconfig: it runs the server's code, which is Node's, and
// the tests' (`../tsconfig.json`) also know the browser's.
import { startOffice, type OfficeOptions } from "@ai-office/server";

import {
  testAction,
  type ControlMessage,
  type ControlReply,
  type ControlRequest,
  type ControlResult,
  type SandboxTaskRecord,
  standInFailure,
} from "../support/control.ts";

const sandboxTasks: SandboxTaskRecord[] = [];
/** Each task's prompt, by `<agentId>#<issue>`: the latest task's. */
const sandboxPrompts = new Map<string, string>();
const sandboxRunner: NonNullable<OfficeOptions["sandboxRunner"]> = {
  run(task) {
    sandboxPrompts.set(
      `${task.agent.id}#${String(task.issue.number)}`,
      task.prompt,
    );
    sandboxTasks.push({
      agentId: task.agent.id,
      issue: task.issue.number,
      aiProvider: task.agent.aiProvider,
      model: task.agent.model,
      effort: task.agent.effort,
    });
    return Promise.reject(new Error(standInFailure));
  },
};

const office = await startOffice(process.env, { sandboxRunner });
office.notices.registerAction(testAction.id, () => Promise.resolve());

const run = async (request: ControlRequest): Promise<ControlResult> => {
  switch (request.command) {
    case "raiseNotice":
      return (await office.notices.raise(request.notice)).id;
    case "publish":
      return (await office.events.publish(request.event)).id;
    case "pollIntake": {
      if (office.intake === undefined) {
        throw new Error("Intake needs the GitHub App.");
      }
      return (await office.intake.poll()).pickedUp.length;
    }
    case "sandboxTasks":
      return [...sandboxTasks];
    case "sandboxPrompt": {
      const prompt = sandboxPrompts.get(
        `${request.agentId}#${String(request.issue)}`,
      );
      if (prompt === undefined) {
        throw new Error(
          `No task of ${request.agentId} on #${String(request.issue)} has run.`,
        );
      }
      return prompt;
    }
    case "recordGatewayRequests":
      for (const seeded of request.requests) {
        await office.requestHistory.record({
          endpoint: "messages",
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          ...seeded,
          startedAt: new Date(seeded.startedAt),
          accountId: null,
          streamed: false,
          upstreamRequestId: null,
          gatewayKeyId: null,
          agentId: seeded.agentId ?? null,
          floorId: seeded.floorId ?? null,
          issue: seeded.issue ?? null,
          ownerTool: seeded.ownerTool ?? null,
          pullRequest: null,
          timeToFirstByteMs: null,
          requestHeaders: null,
          responseHeaders: null,
        });
      }
      return request.requests.length;
  }
};

const reply = (message: ControlReply): void => {
  process.send?.(message);
};

process.on("message", (message: ControlMessage) => {
  void run(message).then(
    (result) => {
      reply({ id: message.id, ok: true, result });
    },
    (error: unknown) => {
      reply({
        id: message.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    },
  );
});

const shutDown = (): void => {
  void office.app.close().then(() => process.exit(0));
};
process.once("SIGTERM", shutDown);
process.once("SIGINT", shutDown);
// The test runner went away.
process.once("disconnect", shutDown);
