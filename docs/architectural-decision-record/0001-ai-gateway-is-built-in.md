# The AI Gateway is built in, not run as a third-party sidecar

Every Agent's model call goes through AI Office's own AI Gateway: a TypeScript service in this monorepo that load-balances across the Owner's AI Accounts (session stickiness, fallback chains, automatic return to a preferred account, OAuth token health and refresh, format translation between providers, usage throttling, request analytics and logs). We considered running an existing open-source load-balancing proxy as a pinned sidecar container, which would have given us its features immediately, but rejected it: it would add a second runtime and a second data model to the stack, its admin API was never designed to be driven by another application, and it has no notion of an Agent, so Token Caps could only be enforced after the fact by pausing Agents. Built in, the Gateway knows which Agent is calling and can refuse the call that would exceed a Token Cap.

## Consequences

- Each Agent gets its own Gateway key, created with the Agent. Sandboxes receive only the Gateway's URL and that key, never a real AI Account credential.
- The Gateway is a large piece of work with its own phase in the PRD, and its feature list is specified there in full.
- The Gateway is never exposed unauthenticated: every request presents a Gateway key. Sandboxes reach it on its own port inside the compose network; the Owner's tools reach it at `/v1` on the app's one address (one entry point), so whatever that address is opened to, the Gateway is too, still key-protected.
