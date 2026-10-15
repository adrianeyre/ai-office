import { afterEach, describe, expect, it } from "vitest";

import { addAiAccountRequestSchema } from "./ai-accounts.ts";
import { allowInternalHosts } from "./internal-hosts.ts";
import { outboundProxyUrlSchema } from "./outbound-proxy.ts";

// I1 probe (pen-testing, "Infrastructure and delivery"): the URL-shape half
// of the custom-AI-endpoint fetch to an internal address (H13, I1-1). The
// Gateway half — that the fetched body is handed to the Gateway Key holder —
// is packages/gateway/src/endpoint-ssrf.pen-test.test.ts. See
// docs/pen-testing/assessments/I1.md.
//
// An endpoint account (an Anthropic- or OpenAI-compatible endpoint, or an
// Ollama server) carries an `endpointUrl` the Gateway then calls. The Owner
// sets it, so this is position 4: a stolen session that adds an AI Account.
// The schema blocks credentials in the URL and a query or fragment, but not
// the host: a loopback, the EC2 metadata service, a private address or a
// bare internal name (app, postgres) is accepted, and plain http is too.
//
// Fixed (I1-1, ADR 0007): such a host, and plain http, is refused unless
// ALLOWED_INTERNAL_HOSTS names it, which a stolen session cannot set.

afterEach(() => {
  allowInternalHosts([]);
});

/** An endpoint account pointing at `endpointUrl`, as the add route takes it. */
const endpointAccount = (endpointUrl: string) => ({
  name: "Owner's endpoint",
  aiProvider: "OpenAI-compatible" as const,
  accountType: "endpoint" as const,
  credential: "sk-not-a-real-key",
  endpointUrl,
});

/** Hosts the Gateway should never be pointed at from a custom endpoint. */
const internalEndpoints = [
  "http://127.0.0.1/v1",
  "https://127.0.0.1:5432/v1",
  "http://169.254.169.254/latest/meta-data/iam/security-credentials/",
  "http://localhost:3047/v1",
  "https://[::1]/v1",
  "http://10.0.0.5/v1",
  "http://192.168.1.1/v1",
  "http://app:3047/v1",
  "http://postgres:3048/v1",
];

describe("I1-1 (H13): a custom AI endpoint's URL may name an internal host", () => {
  it("regression (I1-1): the endpoint URL no longer accepts loopback, the metadata service, private addresses or bare internal names", () => {
    for (const endpointUrl of internalEndpoints) {
      const parsed = addAiAccountRequestSchema.safeParse(
        endpointAccount(endpointUrl),
      );
      expect(parsed.success, endpointUrl).toBe(false);
      expect(
        parsed.error?.issues.map(({ message }) => message).join(" "),
        endpointUrl,
      ).toContain("ALLOWED_INTERNAL_HOSTS");
    }
  });

  it("regression (I1-1): the endpoint URL no longer accepts plain http to a host the Owner did not allow", () => {
    for (const endpointUrl of [
      "http://an-internal-host.internal/v1",
      "http://api.example.com/v1",
    ]) {
      expect(
        addAiAccountRequestSchema.safeParse(endpointAccount(endpointUrl))
          .success,
        endpointUrl,
      ).toBe(false);
    }
    expect(
      addAiAccountRequestSchema.safeParse(
        endpointAccount("https://api.example.com/v1"),
      ).success,
    ).toBe(true);
  });

  it("a custom AI endpoint cannot be set to a loopback, link-local or private address", () => {
    const refused = internalEndpoints.filter(
      (endpointUrl) =>
        !addAiAccountRequestSchema.safeParse(endpointAccount(endpointUrl))
          .success,
    );
    // The property: every internal host is refused.
    expect(refused).toEqual(internalEndpoints);
  });

  it("a host the Owner allowed in the environment is accepted, over http too, and only that host", () => {
    allowInternalHosts(["host.docker.internal", "10.0.0.5", ".lan"]);
    for (const endpointUrl of [
      "http://host.docker.internal:11434",
      "http://10.0.0.5/v1",
      "http://ollama.lan:11434",
    ]) {
      expect(
        addAiAccountRequestSchema.safeParse(endpointAccount(endpointUrl))
          .success,
        endpointUrl,
      ).toBe(true);
    }
    for (const endpointUrl of [
      "http://169.254.169.254/latest/meta-data/",
      "http://10.0.0.6/v1",
      "http://app:3047/v1",
    ]) {
      expect(
        addAiAccountRequestSchema.safeParse(endpointAccount(endpointUrl))
          .success,
        endpointUrl,
      ).toBe(false);
    }
  });
});

describe("I1-1 siblings: other addresses the Gateway fetches", () => {
  it("an Ollama account with no URL, whose default is localhost, is refused until the Owner allows localhost", () => {
    const ollama = {
      name: "Owner's Ollama",
      aiProvider: "Ollama" as const,
      accountType: "endpoint" as const,
    };
    expect(addAiAccountRequestSchema.safeParse(ollama).success).toBe(false);
    allowInternalHosts(["localhost"]);
    expect(addAiAccountRequestSchema.safeParse(ollama).success).toBe(true);
  });

  it("the outbound proxy cannot be an internal host unless the Owner allowed it", () => {
    for (const url of [
      "http://proxy:3128",
      "http://127.0.0.1:3128",
      "http://169.254.169.254",
      "https://[::1]:3128",
    ]) {
      expect(outboundProxyUrlSchema.safeParse(url).success, url).toBe(false);
    }
    // A forward proxy carries https:// inside its own connection.
    expect(
      outboundProxyUrlSchema.safeParse("http://proxy.example.com:3128").success,
    ).toBe(true);
    allowInternalHosts(["proxy"]);
    expect(outboundProxyUrlSchema.safeParse("http://proxy:3128").success).toBe(
      true,
    );
  });

  it("a Vertex AI service account's token_uri cannot be an internal host", () => {
    const vertex = (tokenUri: string) => ({
      name: "Vertex",
      aiProvider: "Claude" as const,
      accountType: "vertex" as const,
      region: "us-east5",
      projectId: "a-project",
      serviceAccount: JSON.stringify({
        type: "service_account",
        client_email: "ai-office@a-project.iam.gserviceaccount.com",
        private_key:
          "-----BEGIN PRIVATE KEY-----\nnot-a-real-key\n-----END PRIVATE KEY-----\n",
        token_uri: tokenUri,
      }),
    });
    expect(
      addAiAccountRequestSchema.safeParse(
        vertex("https://oauth2.googleapis.com/token"),
      ).success,
    ).toBe(true);
    expect(
      addAiAccountRequestSchema.safeParse(
        vertex("http://169.254.169.254/computeMetadata/v1/"),
      ).success,
    ).toBe(false);
  });
});
