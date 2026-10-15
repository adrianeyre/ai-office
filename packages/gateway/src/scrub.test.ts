import { describe, expect, it } from "vitest";

import { credentialsSent, scrubbed, scrubbing } from "./scrub.ts";

// An AI Account's credential never reaches a caller in an answer
// (pen-testing G1-6), however its bytes arrive.

const key = "sk-ant-api03-fakeaccountkeyforscrubbing-0000";

/** What `scrubbing` sends on for `chunks`, written one after another. */
async function through(
  credentials: readonly string[],
  chunks: readonly (string | Buffer)[],
): Promise<string> {
  const stream = scrubbing(credentials);
  const out: Buffer[] = [];
  stream.on("data", (chunk: Buffer) => out.push(chunk));
  const done = new Promise((resolve) => stream.on("end", resolve));
  for (const chunk of chunks) {
    stream.write(
      typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk,
    );
  }
  stream.end();
  await done;
  return Buffer.concat(out).toString("utf8");
}

describe("credentialsSent", () => {
  it("is the key and each header that presented it, a bearer token alone too, longest first; too short a value is left out", () => {
    expect(
      credentialsSent(key, {
        "x-api-key": key,
        authorization: `Bearer ${key}`,
      }),
    ).toEqual([`Bearer ${key}`, key]);
    expect(credentialsSent("", {})).toEqual([]);
    expect(credentialsSent("abc", { "x-api-key": "abc" })).toEqual([]);
  });
});

describe("scrubbing", () => {
  it("replaces a credential however the stream splits it, a byte at a time too", async () => {
    const text = `data: {"text":"Your key is ${key}, é ✓"}\n\n`;
    expect(await through([key], [text])).toBe(scrubbed(text, [key]));
    const bytes = [...Buffer.from(text, "utf8")].map((byte) =>
      Buffer.from([byte]),
    );
    expect(await through([key], bytes)).toBe(scrubbed(text, [key]));
    const at = text.indexOf(key) + 7;
    expect(await through([key], [text.slice(0, at), text.slice(at)])).toBe(
      'data: {"text":"Your key is [REDACTED], é ✓"}\n\n',
    );
  });

  it("holds back only what could start a credential, and lets it go when it does not", async () => {
    const stream = scrubbing([key]);
    const out: string[] = [];
    stream.on("data", (chunk: Buffer) => out.push(chunk.toString("utf8")));
    stream.write(Buffer.from("event one\n\n"));
    await new Promise((resolve) => setImmediate(resolve));
    // Nothing in it starts the key: sent on at once.
    expect(out.join("")).toBe("event one\n\n");
    stream.write(Buffer.from("then sk-ant"));
    await new Promise((resolve) => setImmediate(resolve));
    expect(out.join("")).toBe("event one\n\nthen ");
    const done = new Promise((resolve) => stream.on("end", resolve));
    stream.end(Buffer.from("-not-the-key"));
    await done;
    expect(out.join("")).toBe("event one\n\nthen sk-ant-not-the-key");
  });

  it("passes everything on unchanged with no credential to remove", async () => {
    expect(await through([], ["a", "b"])).toBe("ab");
  });
});
