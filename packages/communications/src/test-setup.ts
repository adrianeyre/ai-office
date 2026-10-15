import { allowInternalHosts } from "@ai-office/shared";

// The Connections' tests stand up fake webhook receivers, Slack, ntfy,
// Confluence and SMTP servers on loopback, which an Owner allows with
// ALLOWED_INTERNAL_HOSTS (ADR 0007). The I1-2 probe
// (`transports/webhook.pen-test.test.ts`) allows none, as AI Office starts.
allowInternalHosts(["127.0.0.1", "localhost"]);
