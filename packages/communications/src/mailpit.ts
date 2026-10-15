// Mailpit, the fake SMTP server the email Connection's contract tests run
// against (PRD §9): a real SMTP server in a container, whose HTTP API
// shows what it received. One container is started per test file.
//
// Without Docker (the Sandcastle sandbox, for one) the tests are skipped
// with the reason. In CI (`CI` set) a missing Docker fails them instead,
// as the Postgres harness does.
import { checkDocker } from "@ai-office/db/testing/docker";
import { GenericContainer, Wait } from "testcontainers";
import { test } from "vitest";

/** The image the contract tests run against. */
export const mailpitImage =
  "axllent/mailpit:v1.27.11@sha256:e22dce5b36f93c77082e204a3942fb6b283b7896e057458400a4c88344c3df68";

/** The one account Mailpit accepts. */
export const mailpitAccount = {
  username: "ai-office",
  password: "mailpit-correct-horse",
} as const;

/** A message as Mailpit's API shows it. */
export interface MailpitMessage {
  readonly from: string;
  readonly to: readonly string[];
  readonly subject: string;
  readonly text: string;
  readonly html: string;
  readonly headers: Readonly<Record<string, readonly string[]>>;
}

export interface Mailpit {
  /** Where its SMTP server listens. */
  readonly host: string;
  readonly smtpPort: number;
  /** Every message it received, oldest first. */
  messages(): Promise<MailpitMessage[]>;
  /** Forgets every message. */
  clear(): Promise<void>;
}

interface Address {
  readonly Address: string;
}

async function startMailpit(): Promise<{
  mailpit: Mailpit;
  stop: () => Promise<void>;
}> {
  const container = await new GenericContainer(mailpitImage)
    .withEnvironment({
      // SMTP sign-in with this one account, allowed without TLS.
      MP_SMTP_AUTH: `${mailpitAccount.username}:${mailpitAccount.password}`,
      MP_SMTP_AUTH_ALLOW_INSECURE: "true",
    })
    .withExposedPorts(1025, 8025)
    .withWaitStrategy(Wait.forHttp("/livez", 8025))
    .start();
  const host = container.getHost();
  const api = `http://${host}:${String(container.getMappedPort(8025))}/api/v1`;
  const get = async (path: string): Promise<unknown> => {
    const response = await fetch(`${api}${path}`);
    if (!response.ok) {
      throw new Error(`Mailpit answered ${String(response.status)}.`);
    }
    return response.json();
  };
  return {
    mailpit: {
      host,
      smtpPort: container.getMappedPort(1025),
      async messages() {
        const { messages } = (await get("/messages")) as {
          messages: { ID: string }[];
        };
        // Mailpit lists the newest first.
        return Promise.all(
          [...messages].reverse().map(async ({ ID }) => {
            const message = (await get(`/message/${ID}`)) as {
              From: Address;
              To: Address[];
              Subject: string;
              Text: string;
              HTML: string;
            };
            const headers = (await get(`/message/${ID}/headers`)) as Record<
              string,
              string[]
            >;
            return {
              from: message.From.Address,
              to: message.To.map(({ Address }) => Address),
              subject: message.Subject,
              text: message.Text,
              html: message.HTML,
              headers,
            };
          }),
        );
      },
      async clear() {
        await fetch(`${api}/messages`, { method: "DELETE" });
      },
    },
    stop: async () => {
      await container.stop();
    },
  };
}

/**
 * `test` with a `mailpit` fixture: one Mailpit per test file, emptied
 * before each test that asks for it.
 */
export const mailpitTest = test
  .extend(
    "mailpitServer",
    { scope: "file" },
    // Vitest reads a fixture's dependencies from its destructuring pattern,
    // so a fixture that depends on nothing must destructure nothing.
    // eslint-disable-next-line no-empty-pattern
    async ({}, { onCleanup }): Promise<Mailpit | string> => {
      const docker = await checkDocker();
      if (!docker.available) {
        if (process.env["CI"]) {
          throw new Error(
            `${docker.reason}. CI must run the email contract tests against Mailpit, so they fail here instead of skipping.`,
          );
        }
        const message = `${docker.reason}, so the email contract tests against Mailpit are skipped. They run in CI and on the host.`;
        console.warn(message);
        return message;
      }
      const { mailpit, stop } = await startMailpit();
      onCleanup(stop);
      return mailpit;
    },
  )
  .extend("mailpit", async ({ mailpitServer, skip }): Promise<Mailpit> => {
    if (typeof mailpitServer === "string") {
      return skip(mailpitServer);
    }
    await mailpitServer.clear();
    return mailpitServer;
  });
