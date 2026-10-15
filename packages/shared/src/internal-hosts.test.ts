import { afterEach, describe, expect, it } from "vitest";

import {
  allowInternalHosts,
  allowedInternalHostSchema,
  isAllowedHost,
  isInternalAddress,
  isInternalHost,
  isIpAddress,
  ownerUrlProblem,
} from "./internal-hosts.ts";

// The host policy for addresses the Owner gives (ADR 0007, I1-1 to I1-3).

afterEach(() => {
  allowInternalHosts([]);
});

describe("internal addresses", () => {
  it("are loopback, link-local, private and the other ranges no public host has, in IPv4", () => {
    for (const address of [
      "0.0.0.0",
      "10.0.0.5",
      "100.64.0.1",
      "127.0.0.1",
      "127.255.255.254",
      "169.254.169.254",
      "172.16.0.1",
      "172.31.255.255",
      "192.0.0.8",
      "192.168.1.1",
      "198.18.0.1",
      "224.0.0.1",
      "255.255.255.255",
    ]) {
      expect(isInternalAddress(address), address).toBe(true);
    }
    for (const address of [
      "1.1.1.1",
      "8.8.8.8",
      "100.63.255.255",
      "100.128.0.1",
      "172.15.0.1",
      "172.32.0.1",
      "192.169.0.1",
      "203.0.114.1",
    ]) {
      expect(isInternalAddress(address), address).toBe(false);
    }
  });

  it("are unspecified, loopback, unique-local, link-local and multicast in IPv6, and an internal IPv4 address carried in one", () => {
    for (const address of [
      "::",
      "::1",
      "[::1]",
      "fc00::1",
      "fd12:3456::1",
      "fe80::1",
      "ff02::1",
      "::ffff:127.0.0.1",
      "::ffff:7f00:1",
      "::ffff:169.254.169.254",
      "::127.0.0.1",
      "64:ff9b::a9fe:a9fe",
      "2002:a9fe:a9fe::1",
      "fd00:ec2::254",
    ]) {
      expect(isInternalAddress(address), address).toBe(true);
    }
    for (const address of [
      "2606:4700::1111",
      "2001:4860:4860::8888",
      "::ffff:8.8.8.8",
      "2002:808:808::1",
    ]) {
      expect(isInternalAddress(address), address).toBe(false);
    }
  });

  it("are told from names, and a name is never one", () => {
    expect(isIpAddress("127.0.0.1")).toBe(true);
    expect(isIpAddress("[fe80::1]")).toBe(true);
    expect(isIpAddress("example.com")).toBe(false);
    expect(isIpAddress("1.2.3")).toBe(false);
    expect(isIpAddress("1:2:3:4:5:6:7:8:9")).toBe(false);
    expect(isInternalAddress("localhost")).toBe(false);
  });
});

describe("internal hosts", () => {
  it("are internal addresses, localhost, single labels such as the stack's own services, and private suffixes", () => {
    for (const host of [
      "127.0.0.1",
      "[::1]",
      "localhost",
      "LOCALHOST.",
      "ai.localhost",
      "app",
      "postgres",
      "sandbox-relay",
      "metadata.google.internal",
      "host.docker.internal",
      "nas.local",
      "ollama.lan",
      "router.home.arpa",
      "proxy.corp",
    ]) {
      expect(isInternalHost(host), host).toBe(true);
    }
    for (const host of [
      "api.anthropic.com",
      "hooks.slack.com",
      "github.com",
      "8.8.8.8",
      "internal.example.com",
    ]) {
      expect(isInternalHost(host), host).toBe(false);
    }
  });
});

describe("the hosts the Owner allows", () => {
  it("are names, which cover their subdomains, domains and addresses", () => {
    const allowed = ["ollama.lan", ".internal", "10.0.0.5", "::1"];
    expect(isAllowedHost("ollama.lan", allowed)).toBe(true);
    expect(isAllowedHost("gpu.ollama.lan", allowed)).toBe(true);
    expect(isAllowedHost("host.docker.internal", allowed)).toBe(true);
    expect(isAllowedHost("10.0.0.5", allowed)).toBe(true);
    expect(isAllowedHost("[::1]", allowed)).toBe(true);
    expect(isAllowedHost("[0:0::1]", allowed)).toBe(true);
    expect(isAllowedHost("other.lan", allowed)).toBe(false);
    expect(isAllowedHost("10.0.0.50", allowed)).toBe(false);
    expect(isAllowedHost("notollama.lan", allowed)).toBe(false);
  });

  it("are the server's once set, and none until then", () => {
    expect(isAllowedHost("ollama.lan")).toBe(false);
    allowInternalHosts([" Ollama.LAN "]);
    expect(isAllowedHost("ollama.lan")).toBe(true);
  });

  it("are checked as the environment gives them", () => {
    for (const entry of ["ollama.lan", ".lan", "10.0.0.5", "::1"]) {
      expect(allowedInternalHostSchema.safeParse(entry).success, entry).toBe(
        true,
      );
    }
    for (const entry of ["*", "ollama.lan:11434", "http://ollama.lan", ""]) {
      expect(allowedInternalHostSchema.safeParse(entry).success, entry).toBe(
        false,
      );
    }
  });
});

describe("an address the Owner gives", () => {
  it("is https:// to a public host, or anything to a host they allowed", () => {
    expect(ownerUrlProblem("https://llm.example.com/v1", "It")).toBeUndefined();
    expect(ownerUrlProblem("http://llm.example.com/v1", "It")).toBe(
      "It is https://; http:// is only for a host ALLOWED_INTERNAL_HOSTS names.",
    );
    expect(ownerUrlProblem("http://10.0.0.5/v1", "It")).toBe(
      "It is on an internal address (10.0.0.5), which AI Office reaches only if ALLOWED_INTERNAL_HOSTS names it.",
    );
    allowInternalHosts(["10.0.0.5"]);
    expect(ownerUrlProblem("http://10.0.0.5/v1", "It")).toBeUndefined();
    expect(
      ownerUrlProblem("http://proxy.example.com:3128", "It", {
        plainHttp: true,
      }),
    ).toBeUndefined();
  });
});
