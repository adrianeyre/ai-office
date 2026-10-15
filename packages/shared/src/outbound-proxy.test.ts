import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { allowInternalHosts } from "./internal-hosts.ts";
import {
  bypassesProxy,
  outboundProxySettingsSchema,
  outboundProxyUpdateSchema,
} from "./outbound-proxy.ts";

// The outbound HTTP proxy's settings (PRD FR-35): its address, its
// username and password, and the hosts reached without it. The proxy here
// is on the Owner's own network, which they allow (ADR 0007).

beforeAll(() => {
  allowInternalHosts([".corp"]);
});
afterAll(() => {
  allowInternalHosts([]);
});

const problems = (body: unknown) =>
  outboundProxyUpdateSchema
    .safeParse(body)
    .error?.issues.map(({ message }) => message);

describe("the outbound proxy's settings", () => {
  it("take a proxy's address, its username and password, and hosts to bypass it for", () => {
    expect(
      outboundProxyUpdateSchema.parse({
        url: "http://proxy.corp:3128/",
        username: " office ",
        password: "s3cret",
        noProxy: [" Ollama.LAN ", ".internal", "10.0.0.7", "*"],
      }),
    ).toEqual({
      url: "http://proxy.corp:3128",
      username: "office",
      password: "s3cret",
      noProxy: ["ollama.lan", ".internal", "10.0.0.7", "*"],
    });
    // No proxy at all.
    expect(outboundProxyUpdateSchema.parse({ url: null })).toEqual({
      url: null,
    });
  });

  it("refuse a proxy URL with credentials, a path or another scheme", () => {
    expect(problems({ url: "http://office:s3cret@proxy.corp:3128" })).toEqual([
      "Leave credentials out of the proxy URL; the username and password have their own fields.",
    ]);
    expect(problems({ url: "http://proxy.corp:3128/route?x=1" })).toEqual([
      "The proxy URL is a host and port, with no path or query.",
    ]);
    expect(problems({ url: "socks5://proxy.corp:1080" })).toEqual([
      "The proxy is an http:// or https:// URL, such as http://proxy:3128.",
    ]);
  });

  it("refuse a password without a username, or credentials without a proxy", () => {
    expect(
      problems({ url: "http://proxy.corp:3128", password: "s3cret" }),
    ).toEqual(["Enter the username the password is for."]);
    expect(problems({ url: null, username: "office" })).toEqual([
      "Enter the proxy's URL, or leave the username and password out.",
    ]);
    expect(
      problems({
        url: "http://proxy.corp:3128",
        username: "off:ice",
      }),
    ).toEqual(["The proxy's username has no spaces or colons in it."]);
    expect(
      problems({
        url: "http://proxy.corp:3128",
        noProxy: ["ollama.lan:11434"],
      }),
    ).toEqual([
      "A host to bypass the proxy for is a name (ollama.lan), a domain (.internal) or an IP address, without a port.",
    ]);
    expect(
      problems({ url: "http://proxy.corp:3128", extra: true })?.length,
    ).toBe(1);
  });

  it("never show the password", () => {
    expect(Object.keys(outboundProxySettingsSchema.shape).sort()).toEqual([
      "hasPassword",
      "noProxy",
      "url",
      "username",
    ]);
  });
});

describe("what bypasses the outbound proxy", () => {
  it("is the AI Office host itself, always", () => {
    for (const url of [
      "http://localhost:11434/v1/models",
      "http://ollama.localhost:11434",
      "http://127.0.0.1:11434",
      "http://127.8.9.10",
      "http://[::1]:11434",
    ]) {
      expect(bypassesProxy(url, []), url).toBe(true);
    }
    expect(bypassesProxy("https://api.anthropic.com/v1/messages", [])).toBe(
      false,
    );
  });

  it("is each host the Owner lists, with its subdomains", () => {
    const noProxy = ["ollama.lan", ".internal", "10.0.0.7"];
    expect(bypassesProxy("http://ollama.lan:11434", noProxy)).toBe(true);
    expect(bypassesProxy("http://gpu.ollama.lan:11434", noProxy)).toBe(true);
    expect(bypassesProxy("http://llm.internal/v1", noProxy)).toBe(true);
    expect(bypassesProxy("http://10.0.0.7:8000/v1", noProxy)).toBe(true);
    expect(bypassesProxy("http://notollama.lan", noProxy)).toBe(false);
    expect(bypassesProxy("http://10.0.0.70", noProxy)).toBe(false);
    expect(bypassesProxy("https://api.x.ai", noProxy)).toBe(false);
    // Every host.
    expect(bypassesProxy("https://api.x.ai", ["*"])).toBe(true);
  });
});
