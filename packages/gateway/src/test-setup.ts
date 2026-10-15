import { allowInternalHosts } from "@ai-office/shared";

// The Gateway's tests stand up fake AI Providers, proxies and token
// endpoints on loopback, which an Owner allows with ALLOWED_INTERNAL_HOSTS
// (ADR 0007). The I1-1 probe (`endpoint-ssrf.pen-test.test.ts`) allows
// none, as the Gateway starts.
allowInternalHosts(["127.0.0.1", "localhost"]);
