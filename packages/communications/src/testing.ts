import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
} from "node:http";
import { createServer as createTcpServer, type AddressInfo } from "node:net";

// A fake webhook receiver for tests: it records every POST and answers
// with whatever status the test asks for.

export interface ReceivedWebhook {
  readonly headers: IncomingHttpHeaders;
  /** The body exactly as it arrived, for checking its signature. */
  readonly raw: string;
  readonly body: unknown;
}

export interface FakeWebhook {
  /** Where to send to, with a secret-looking path as real webhooks have. */
  readonly url: string;
  /** Every request so far, oldest first, whatever it was answered. */
  readonly received: ReceivedWebhook[];
  /** Answers the next requests with `status` (and headers) until told otherwise. */
  answerWith(status: number, headers?: Record<string, string>): void;
  close(): Promise<void>;
}

export async function serveFakeWebhook(
  path = "/hooks/T0001/B0001/s3cr3t-webhook-path",
): Promise<FakeWebhook> {
  const received: ReceivedWebhook[] = [];
  let answer = { status: 200, headers: {} as Record<string, string> };
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let body: unknown;
      try {
        body = JSON.parse(raw);
      } catch {
        body = undefined;
      }
      received.push({ headers: request.headers, raw, body });
      response.writeHead(answer.status, answer.headers).end();
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${String(port)}${path}`,
    received,
    answerWith(status, headers = {}) {
      answer = { status, headers };
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        // Closing it twice is fine.
        server.close(() => {
          resolve();
        });
      }),
  };
}

/** A message the fake Slack accepted. */
export interface SlackPost {
  /** `bot` for `chat.postMessage`, `webhook` for an incoming webhook. */
  readonly via: "bot" | "webhook";
  readonly channel: string | undefined;
  readonly text: string;
  readonly blocks: readonly Record<string, unknown>[];
}

export interface FakeSlack {
  /** Its Web API, as `slackTransport`'s `apiUrl`. */
  readonly apiUrl: string;
  /** An incoming webhook's address that posts to `#ops`. */
  readonly webhookUrl: string;
  /** Every message it accepted, oldest first. */
  readonly posts: SlackPost[];
  /** How many requests were refused with a 429. */
  readonly rateLimited: number;
  /** Answers the next `count` requests with 429 and `Retry-After`. */
  rateLimit(count: number, retryAfterSeconds: number): void;
  close(): Promise<void>;
}

const blockTypes = new Set(["section", "context", "actions", "header"]);

/** Why Slack would refuse `blocks` as `invalid_blocks`, if it would. */
function invalidBlocks(blocks: unknown): boolean {
  if (!Array.isArray(blocks) || blocks.length === 0 || blocks.length > 50) {
    return true;
  }
  return blocks.some((block: Record<string, unknown>) => {
    if (!blockTypes.has(String(block["type"]))) {
      return true;
    }
    const text = block["text"] as { text?: unknown } | undefined;
    if (typeof text?.text === "string" && text.text.length > 3000) {
      return true;
    }
    const elements = (block["elements"] ?? []) as Record<string, unknown>[];
    return elements.some((element) => {
      if (element["type"] !== "button") {
        return false;
      }
      const label = (element["text"] as { text?: unknown } | undefined)?.text;
      const url = element["url"];
      return (
        typeof label !== "string" ||
        label.length > 75 ||
        typeof url !== "string" ||
        url.length > 3000 ||
        !/^https?:\/\//.test(url)
      );
    });
  });
}

/**
 * A fake Slack for contract tests: `chat.postMessage` with a bot token,
 * and one incoming webhook, answering as Slack does: `invalid_auth` for
 * another token, `channel_not_found`, `invalid_blocks`, and 429 with
 * `Retry-After` when told to.
 */
export async function serveFakeSlack(
  options: {
    readonly botToken?: string;
    readonly channels?: readonly string[];
  } = {},
): Promise<FakeSlack> {
  const botToken = options.botToken ?? "xoxb-1111111111-fake-slack-token";
  const channels = new Set(options.channels ?? ["#ops", "C0123456789"]);
  const webhookPath = "/services/T0000000/B0000000/fakeWebhookSecret";
  const posts: SlackPost[] = [];
  let limited = { count: 0, retryAfter: 0 };
  let rateLimited = 0;
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const json = (status: number, body: unknown) => {
        response
          .writeHead(status, { "content-type": "application/json" })
          .end(JSON.stringify(body));
      };
      const text = (status: number, body: string) => {
        response.writeHead(status, { "content-type": "text/plain" }).end(body);
      };
      if (limited.count > 0) {
        limited = { ...limited, count: limited.count - 1 };
        rateLimited += 1;
        response
          .writeHead(429, { "retry-after": String(limited.retryAfter) })
          .end();
        return;
      }
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<
          string,
          unknown
        >;
      } catch {
        text(400, "invalid_payload");
        return;
      }
      const post = (via: SlackPost["via"], channel: string | undefined) => {
        posts.push({
          via,
          channel,
          text: String(body["text"]),
          blocks: body["blocks"] as Record<string, unknown>[],
        });
      };
      if (request.url === webhookPath) {
        if (invalidBlocks(body["blocks"])) {
          text(400, "invalid_blocks");
          return;
        }
        post("webhook", "#ops");
        text(200, "ok");
        return;
      }
      if (request.url === "/api/chat.postMessage") {
        if (request.headers.authorization !== `Bearer ${botToken}`) {
          json(200, { ok: false, error: "invalid_auth" });
          return;
        }
        const channel = String(body["channel"]);
        if (!channels.has(channel)) {
          json(200, { ok: false, error: "channel_not_found" });
          return;
        }
        if (invalidBlocks(body["blocks"])) {
          json(200, { ok: false, error: "invalid_blocks" });
          return;
        }
        post("bot", channel);
        json(200, { ok: true, channel, ts: `${String(posts.length)}.000100` });
        return;
      }
      text(404, "no_service");
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${String(port)}`;
  return {
    apiUrl: `${origin}/api`,
    webhookUrl: `${origin}${webhookPath}`,
    posts,
    get rateLimited() {
      return rateLimited;
    },
    rateLimit(count, retryAfterSeconds) {
      limited = { count, retryAfter: retryAfterSeconds };
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}

/** A message the fake SMTP server took. */
export interface SmtpMessage {
  readonly from: string;
  readonly to: readonly string[];
  /** The message as sent, headers and body, dots unstuffed. */
  readonly data: string;
  /** Who signed in to send it; null without signing in. */
  readonly signedInAs: string | null;
}

export interface FakeSmtp {
  readonly host: string;
  readonly port: number;
  /** Every message it took, oldest first. */
  readonly messages: SmtpMessage[];
  /** Sign-ins it refused. */
  readonly refusedSignIns: number;
  close(): Promise<void>;
}

/**
 * A small fake SMTP server for tests without Docker: EHLO, AUTH PLAIN and
 * LOGIN (refusing any other account with 535), MAIL, RCPT and DATA, no
 * TLS. The contract tests run against Mailpit (`./testing/mailpit`).
 */
export async function serveFakeSmtp(account?: {
  readonly username: string;
  readonly password: string;
}): Promise<FakeSmtp> {
  const messages: SmtpMessage[] = [];
  let refusedSignIns = 0;
  const decode = (text: string) => Buffer.from(text, "base64").toString("utf8");
  const server = createTcpServer((socket) => {
    let buffer = "";
    let signedInAs: string | null = null;
    let envelope: { from: string; to: string[] } | undefined;
    let data: string[] | undefined;
    let login:
      | { step: "plain" | "username" | "password"; username?: string }
      | undefined;
    const reply = (line: string) => {
      socket.write(`${line}\r\n`);
    };
    const signIn = (username: string, password: string) => {
      if (username === account?.username && password === account.password) {
        signedInAs = username;
        reply("235 2.7.0 Authentication successful");
      } else {
        refusedSignIns += 1;
        reply("535 5.7.8 Authentication credentials invalid");
      }
    };
    const plain = (encoded: string) => {
      const [, username = "", password = ""] = decode(encoded).split("\0");
      signIn(username, password);
    };
    const handle = (line: string) => {
      if (data !== undefined) {
        if (line === ".") {
          messages.push({
            from: envelope?.from ?? "",
            to: envelope?.to ?? [],
            data: data.join("\r\n"),
            signedInAs,
          });
          data = undefined;
          envelope = undefined;
          reply("250 2.0.0 Ok: queued");
        } else {
          data.push(line.startsWith("..") ? line.slice(1) : line);
        }
        return;
      }
      if (login !== undefined) {
        const step = login;
        login = undefined;
        if (step.step === "plain") {
          plain(line);
        } else if (step.step === "username") {
          login = { step: "password", username: decode(line) };
          reply("334 UGFzc3dvcmQ6");
        } else {
          signIn(step.username ?? "", decode(line));
        }
        return;
      }
      const [verb = "", ...rest] = line.split(" ");
      const argument = rest.join(" ");
      switch (verb.toUpperCase()) {
        case "EHLO":
          reply("250-fake-smtp");
          reply(
            account === undefined ? "250-8BITMIME" : "250-AUTH PLAIN LOGIN",
          );
          reply("250 SMTPUTF8");
          return;
        case "HELO":
          reply("250 fake-smtp");
          return;
        case "AUTH": {
          const [method = "", initial] = argument.split(" ");
          if (method.toUpperCase() === "PLAIN") {
            if (initial === undefined) {
              login = { step: "plain" };
              reply("334 ");
            } else {
              plain(initial);
            }
          } else if (method.toUpperCase() === "LOGIN") {
            login = { step: "username" };
            reply("334 VXNlcm5hbWU6");
          } else {
            reply("504 5.5.4 Unrecognized authentication type");
          }
          return;
        }
        case "MAIL":
          if (account !== undefined && signedInAs === null) {
            reply("530 5.7.0 Authentication required");
            return;
          }
          envelope = {
            from: /<([^>]*)>/.exec(argument)?.[1] ?? "",
            to: [],
          };
          reply("250 2.1.0 Ok");
          return;
        case "RCPT":
          envelope?.to.push(/<([^>]*)>/.exec(argument)?.[1] ?? "");
          reply("250 2.1.5 Ok");
          return;
        case "DATA":
          data = [];
          reply("354 End data with <CR><LF>.<CR><LF>");
          return;
        case "RSET":
          envelope = undefined;
          reply("250 2.0.0 Ok");
          return;
        case "NOOP":
          reply("250 2.0.0 Ok");
          return;
        case "QUIT":
          reply("221 2.0.0 Bye");
          socket.end();
          return;
        default:
          reply("502 5.5.2 Command not recognized");
      }
    };
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let end = buffer.indexOf("\r\n");
      while (end !== -1) {
        handle(buffer.slice(0, end));
        buffer = buffer.slice(end + 2);
        end = buffer.indexOf("\r\n");
      }
    });
    socket.on("error", () => undefined);
    reply("220 fake-smtp ESMTP");
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as AddressInfo;
  return {
    host: "127.0.0.1",
    port,
    messages,
    get refusedSignIns() {
      return refusedSignIns;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
  };
}

/** Reads a request's body as text. */
const bodyOf = (request: IncomingMessage) =>
  new Promise<string>((resolve) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
  });

/** A notification the fake ntfy published. */
export interface NtfyNotification {
  readonly topic: string;
  readonly title: string | undefined;
  readonly message: string;
  /** 1 (min) to 5 (max); 3 when the publisher gave none. */
  readonly priority: number;
  /** Where tapping it goes. */
  readonly click: string | undefined;
  readonly actions: readonly Record<string, unknown>[];
}

export interface FakeNtfy {
  /** The server's address, as an ntfy Connection's `server`. */
  readonly url: string;
  /** Every notification it published, oldest first. */
  readonly notifications: NtfyNotification[];
  /** How many requests were refused with a 429. */
  readonly rateLimited: number;
  /** Answers the next `count` requests with 429 and `Retry-After`. */
  rateLimit(count: number, retryAfterSeconds: number): void;
  close(): Promise<void>;
}

/**
 * A fake ntfy server for contract tests: JSON publishing to its root, as
 * ntfy's API takes it. Topics in `protectedTopics` need `accessToken` as
 * a bearer token (403 without one); any other token is refused with 401,
 * as ntfy refuses an unknown token on any topic. A bad topic, priority or
 * click address is a 400.
 */
export async function serveFakeNtfy(
  options: {
    readonly accessToken?: string;
    readonly protectedTopics?: readonly string[];
  } = {},
): Promise<FakeNtfy> {
  const accessToken = options.accessToken ?? "tk_fakentfytoken0123456789abcdef";
  const protectedTopics = new Set(options.protectedTopics ?? []);
  const notifications: NtfyNotification[] = [];
  let limited = { count: 0, retryAfter: 0 };
  let rateLimited = 0;
  const server = createServer((request, response) => {
    void bodyOf(request).then((raw) => {
      const error = (status: number, code: number, text: string) => {
        response
          .writeHead(status, { "content-type": "application/json" })
          .end(JSON.stringify({ code, http: status, error: text }));
      };
      if (limited.count > 0) {
        limited = { ...limited, count: limited.count - 1 };
        rateLimited += 1;
        response
          .writeHead(429, { "retry-after": String(limited.retryAfter) })
          .end();
        return;
      }
      if (request.method !== "POST" || request.url !== "/") {
        error(404, 40401, "page not found");
        return;
      }
      const { authorization } = request.headers;
      if (
        authorization !== undefined &&
        authorization !== `Bearer ${accessToken}`
      ) {
        error(401, 40101, "unauthorized");
        return;
      }
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        error(400, 40017, "invalid request: request body must be JSON");
        return;
      }
      const topic = body["topic"];
      if (typeof topic !== "string" || !/^[-_A-Za-z0-9]{1,64}$/.test(topic)) {
        error(400, 40009, "invalid topic");
        return;
      }
      if (protectedTopics.has(topic) && authorization === undefined) {
        error(403, 40301, "forbidden");
        return;
      }
      const priority = body["priority"] ?? 3;
      if (
        typeof priority !== "number" ||
        !Number.isInteger(priority) ||
        priority < 1 ||
        priority > 5
      ) {
        error(400, 40007, "invalid priority");
        return;
      }
      const click = body["click"];
      if (
        click !== undefined &&
        (typeof click !== "string" || !/^https?:\/\//.test(click))
      ) {
        error(400, 40013, "invalid click URL");
        return;
      }
      notifications.push({
        topic,
        title: typeof body["title"] === "string" ? body["title"] : undefined,
        message:
          typeof body["message"] === "string" ? body["message"] : "triggered",
        priority,
        click,
        actions: (body["actions"] ?? []) as Record<string, unknown>[],
      });
      response.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          id: `fake${String(notifications.length)}`,
          time: 0,
          event: "message",
          topic,
        }),
      );
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${String(port)}`,
    notifications,
    get rateLimited() {
      return rateLimited;
    },
    rateLimit(count, retryAfterSeconds) {
      limited = { count, retryAfter: retryAfterSeconds };
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}

/** A message the fake Pushover accepted. */
export interface PushoverMessage {
  readonly user: string;
  readonly title: string | undefined;
  readonly message: string;
  /** -2 (lowest) to 2 (emergency); 0 when the sender gave none. */
  readonly priority: number;
  /** Its supplementary link, and that link's title. */
  readonly url: string | undefined;
  readonly urlTitle: string | undefined;
  readonly timestamp: number | undefined;
}

export interface FakePushover {
  /** Its API, as `pushoverTransport`'s `apiUrl`. */
  readonly apiUrl: string;
  /** Every message it accepted, oldest first. */
  readonly messages: PushoverMessage[];
  close(): Promise<void>;
}

/**
 * A fake Pushover for contract tests: `POST /1/messages.json`, form
 * encoded, answering as Pushover does: 400 with `"token": "invalid"` for
 * an application token it does not know, `"user": "invalid"` for a user
 * key, and Pushover's checks on the message, title, link and priority.
 */
export async function serveFakePushover(
  options: {
    readonly applicationToken?: string;
    readonly userKeys?: readonly string[];
  } = {},
): Promise<FakePushover> {
  const applicationToken =
    options.applicationToken ?? "azGDORePK8gMaC0QOYAMyEEuzJnyUi";
  const userKeys = new Set(
    options.userKeys ?? ["uQiRzpo4DXghDmr9QzzfQu27cmVRsG"],
  );
  const messages: PushoverMessage[] = [];
  const server = createServer((request, response) => {
    void bodyOf(request).then((raw) => {
      const answer = (status: number, body: Record<string, unknown>) => {
        response
          .writeHead(status, { "content-type": "application/json" })
          .end(JSON.stringify({ ...body, request: "fake-request" }));
      };
      const refuse = (field: string, error: string) => {
        answer(400, { [field]: "invalid", errors: [error], status: 0 });
      };
      if (request.method !== "POST" || request.url !== "/1/messages.json") {
        answer(404, { errors: ["not found"], status: 0 });
        return;
      }
      const form = new URLSearchParams(raw);
      const field = (name: string) => form.get(name) ?? undefined;
      if (field("token") !== applicationToken) {
        refuse("token", "application token is invalid");
        return;
      }
      const user = field("user") ?? "";
      if (!userKeys.has(user)) {
        refuse(
          "user",
          "user identifier is not a valid user, group, or subscribed user key",
        );
        return;
      }
      const message = field("message") ?? "";
      if (message === "" || message.length > 1024) {
        refuse(
          "message",
          "message cannot be blank or longer than 1024 characters",
        );
        return;
      }
      const title = field("title");
      if (title !== undefined && title.length > 250) {
        refuse("title", "title is too long");
        return;
      }
      const url = field("url");
      if (url !== undefined && url.length > 512) {
        refuse("url", "url is too long");
        return;
      }
      const priority = Number(field("priority") ?? "0");
      if (!Number.isInteger(priority) || priority < -2 || priority > 2) {
        refuse("priority", "priority is invalid");
        return;
      }
      if (
        priority === 2 &&
        (field("retry") === undefined || field("expire") === undefined)
      ) {
        refuse("retry", "retry and expire are required for emergency priority");
        return;
      }
      const timestamp = field("timestamp");
      messages.push({
        user,
        title,
        message,
        priority,
        url,
        urlTitle: field("url_title"),
        timestamp: timestamp === undefined ? undefined : Number(timestamp),
      });
      answer(200, { status: 1 });
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as AddressInfo;
  return {
    apiUrl: `http://127.0.0.1:${String(port)}`,
    messages,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}

export {
  serveFakeConfluence,
  serveFakeNotion,
  type ConfluencePage,
  type FakeConfluence,
  type FakeNotion,
  type NotionPage,
} from "./publishing-fakes.ts";
export {
  serveFakeGoogle,
  type ConsentScreen,
  type FakeConsent,
  type FakeGoogle,
} from "./google-fakes.ts";
export type {
  FakeDocParagraph,
  FakeDocRun,
  FakeDriveFile,
  FakeSlideText,
  FakeSlideView,
} from "./google-workspace-fakes.ts";
export type { FakeCalendarEvent } from "./google-calendar-fakes.ts";
export {
  readPdf,
  type PdfDocument,
  type PdfLink,
  type PdfPage,
} from "./pdf-text.ts";
