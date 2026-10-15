import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

// I1 probe (pen-testing, "Infrastructure and delivery"): documentation drift
// (H17). A tester, or an Owner hardening a deployment, who reads the
// documents gets a surface narrower than the code's. Each finding reads the
// document against the code it describes. See
// docs/pen-testing/assessments/I1.md.
//
// Fixed (I1-8): FR-1 and FR-2 name every way the Owner signs in (any of
// the Owner's passwords, or an API key with UI access), as do the PRD's
// summary, non-goals and security requirements, the EC2 process and the
// running guide.
//
// Fixed (I1-9): .env.example says every Gateway request needs a Gateway
// Key (main's 3b8565c rewrote the comment after the probe's commit), as
// do the compose files' and the server's own comments on the Gateway.
//
// Fixed (I1-10): the compose file's comment on the sandboxes' network says
// what a sandbox reaches there, and so does the issue-pipeline guide. When
// I1-10 was fixed that was the app's 3045 and 1455 as well as the Gateway's
// 3047; since S2-3 (#233) took the app off that network, it is the AI
// Gateway through the sandbox relay and nothing else of the stack, which
// these tests hold to the compose file itself.

const root = join(import.meta.dirname, "..");
const read = (path: string) => readFile(join(root, path), "utf8");

const prd = await read("docs/product-requirements-document/ai-office.md");
const envExample = await read(".env.example");
const compose = await read("docker-compose.yml");
const ec2 = await read("docs/processes/deploying-to-ec2.md");
const running = await read("docs/guide/running.md");

/** Every comment an Owner reads on how the Gateway is reached. */
const gatewayComments = {
  "docker-compose.yml": compose,
  "docker/pen-test/compose.yml": await read("docker/pen-test/compose.yml"),
  "docker-compose.dev.yml": await read("docker-compose.dev.yml"),
  "apps/server/src/config.ts": await read("apps/server/src/config.ts"),
  ".env.example": envExample,
};

/** `text`'s comment lines run together, so a sentence reads across lines. */
const flat = (text: string) => text.replace(/\n\s*(#|\/\/)\s*/g, " ");

/** FR-1 and FR-2, the Access and security requirements, as written. */
const fr1 = /\*\*FR-1:\*\*[^\n]*/.exec(prd)?.[0] ?? "";
const fr2 = /\*\*FR-2:\*\*[^\n]*/.exec(prd)?.[0] ?? "";

describe("I1-8 (H17): FR-1/FR-2 describe one password; the code has more ways in", () => {
  it("regression (I1-8): FR-1 and FR-2 no longer speak of a single password alone; they name further Owner passwords and API-key sign-in", () => {
    expect(fr1).not.toMatch(/set the password/i);
    expect(fr1).toMatch(/first Owner password/);
    expect(fr1).toMatch(/further Owner passwords/);
    expect(fr2).toMatch(/any of the Owner's passwords/);
    expect(fr2).toMatch(/an API key that has UI access/);
    // An API key asks for no second factor, which FR-2 says outright.
    expect(fr2).toMatch(/asks for no second factor/);
  });

  it("confirms the code has several Owner passwords and API-key sign-in the documents do not", async () => {
    // The routes A1 (#192) and H5 exercised: more Owner passwords, and a
    // sign-in with a UI-capable API key.
    const passwordRoutes = await read(
      "apps/server/src/auth/password-routes.ts",
    );
    expect(passwordRoutes).toMatch(/owner-passwords/);
    const authRoutes = await read("apps/server/src/auth/routes.ts");
    expect(authRoutes).toMatch(/api-key/);
  });

  it("FR-1 and FR-2 describe every way the Owner signs in: several passwords, and an API key", () => {
    // The property: the requirements name the mechanisms the code has.
    expect(`${fr1}\n${fr2}`).toMatch(/passwords/i);
    expect(`${fr1}\n${fr2}`).toMatch(/API key/i);
  });
});

describe("I1-8 siblings: nothing else the Owner hardens from speaks of one password", () => {
  it("the PRD's summary, non-goals and security requirements name the Owner's passwords and API keys, never a single password", () => {
    expect(prd).not.toMatch(/single[- ]password/i);
    expect(prd).not.toMatch(/one Owner and one password, and/);
    expect(prd).toMatch(
      /sits behind the Owner's sign-in: any of the Owner's passwords, or an API key with UI access/,
    );
    expect(prd).toMatch(
      /There is one Owner, to whom every Owner password and API key belongs/,
    );
    expect(prd).toMatch(
      /Access for the Owner alone: the Owner's passwords and API keys with UI access/,
    );
    // FR-3's second factor: every password, and not an API key.
    const fr3 = /\*\*FR-3:\*\*[^\n]*/.exec(prd)?.[0] ?? "";
    expect(fr3).toMatch(/every Owner password/);
    expect(fr3).toMatch(/an API key does not ask for it/);
  });

  it("the EC2 process names every way in, and that an API key skips TOTP", () => {
    const restrict = ec2.slice(ec2.indexOf("## 3. Restrict access"));
    expect(ec2).not.toMatch(/AI Office has one password/);
    expect(restrict).toMatch(/any of your Owner passwords/);
    expect(restrict).toMatch(
      /API key that has UI access, which asks for no\s+TOTP/,
    );
    expect(ec2).toMatch(/An API key with UI access still signs in without one/);
  });

  it("the running guide's sign-in names every Owner password and API-key sign-in", () => {
    const signingIn = running.slice(running.indexOf("### Signing in"));
    expect(signingIn).toMatch(/any of the Owner's\s+passwords/);
    expect(signingIn).toMatch(/`POST \/api\/login\/api-key`/);
    expect(signingIn).toMatch(/asks for no second factor/);
  });
});

describe("I1-9 (H17): .env.example says the Gateway has no authentication", () => {
  it("regression (I1-9): .env.example no longer says the Gateway 'has no authentication of its own yet (Gateway Keys come later)'", () => {
    expect(envExample).not.toMatch(/has no authentication of its own yet/);
    expect(flat(envExample)).not.toMatch(/Gateway Keys come later/);
    expect(flat(envExample)).not.toMatch(/no authentication/i);
  });

  it("confirms the code and the guide require a Gateway Key on every request", async () => {
    const guide = await read("docs/guide/ai-gateway.md");
    expect(guide).toMatch(
      /Every request to the Gateway presents a Gateway Key/,
    );
  });

  it(".env.example says a Gateway Key is required, as the code demands and the guide says", () => {
    expect(envExample).not.toMatch(/has no authentication of its own yet/);
    // Where it says how the Gateway is reached: its own port, and /v1 on
    // the app's published address.
    expect(flat(envExample)).toMatch(
      /The AI Gateway's own port: the sandboxes' way to it\. .*? Every request needs a Gateway Key/,
    );
    expect(flat(envExample)).toMatch(
      /It opens the AI Gateway \(\/v1\) too: every Gateway request needs a Gateway Key/,
    );
  });
});

describe("I1-9 siblings: every start-up comment on the Gateway says a Gateway Key is required", () => {
  it("none says the Gateway has no authentication, or that Gateway Keys come later", () => {
    for (const [file, text] of Object.entries(gatewayComments)) {
      expect(flat(text), file).not.toMatch(/no authentication/i);
      expect(flat(text), file).not.toMatch(/Gateway Keys? comes? later/i);
      expect(flat(text), file).not.toMatch(/unauthenticated/i);
    }
  });

  it("the compose file and the server's configuration say every Gateway request needs a Gateway Key", () => {
    expect(flat(compose)).toMatch(
      /opens the Gateway too: every Gateway request needs a Gateway Key/,
    );
    expect(flat(gatewayComments["apps/server/src/config.ts"])).toMatch(
      /Every request needs a Gateway Key, but it listens on loopback/,
    );
  });
});

describe("I1-10 (H17): the compose comment claims sandboxes reach only the Gateway", () => {
  /** The services compose puts on the sandboxes' network. */
  const onSandboxes = Object.entries(
    (
      parse(compose) as {
        services: Record<string, { networks?: string[] }>;
      }
    ).services,
  )
    .filter(([, service]) => service.networks?.includes("sandboxes"))
    .map(([name]) => name);

  it("regression (I1-10): the compose file no longer says sandboxes reach 'the AI Gateway as app:3047 and nothing else of the stack'", () => {
    expect(compose).not.toMatch(
      /the AI Gateway as app:3047 and nothing\s+#?\s*else of the\s+#?\s*stack/,
    );
    // Where it says a sandbox reaches nothing else of the stack, the
    // compose file bears it out: since S2-3 (#233) the sandbox relay is
    // the only service on the sandboxes' network, and the app is not.
    if (flat(compose).includes("nothing else of the stack")) {
      expect(onSandboxes).toEqual(["sandbox-relay"]);
    }
  });

  it("the compose comment reflects what a sandbox reaches on its network (S2-3)", () => {
    // The property: the comment names what a sandbox reaches, as the
    // compose file has it. S2 (#193) confirmed 3045 and 1455 answered too
    // while the app was on the network; S2-3 (#233) took it off.
    const networks = flat(compose.slice(compose.indexOf("\nnetworks:")));
    expect(onSandboxes).toEqual(["sandbox-relay"]);
    expect(networks).not.toMatch(
      /a sandbox reaches the AI Gateway as app:3047/,
    );
    expect(networks).toMatch(
      /The relay is the only other container on a sandbox's network: sandboxes reach the AI Gateway through it, as sandbox-relay:3047/,
    );
    expect(networks).toMatch(
      /since neither the app, Postgres nor Caddy is on it, and no other sandbox/,
    );
  });
});

describe("I1-10 siblings: the guide says what a sandbox reaches on its network", () => {
  it("the issue-pipeline guide names the sandbox relay as the one other thing on a sandbox's network, and the Gateway's port through it", async () => {
    const guide = await read("docs/guide/issue-pipeline.md");
    // The paragraph on what a sandbox reaches.
    const network = guide
      .slice(guide.indexOf("**What a sandbox reaches**"))
      .split("\n\n", 1)[0]
      ?.replace(/\s+/g, " ");
    expect(network).toMatch(/That network is `internal`: it has no route out/);
    expect(network).toMatch(
      /The one other thing on it is the \*\*sandbox relay\*\*/,
    );
    expect(network).toMatch(/a sandbox never reaches another sandbox/);
    // The app is not on it, so it no longer answers there.
    expect(guide).not.toMatch(/the app also answers on `app:3045`/);
    const relay = guide
      .slice(guide.indexOf("- **Port 3047** is forwarded"))
      .split("\n- ", 1)[0]
      ?.replace(/\s+/g, " ");
    expect(relay).toMatch(
      /`SANDBOX_GATEWAY_URL` is `http:\/\/sandbox-relay:3047`/,
    );
  });
});
