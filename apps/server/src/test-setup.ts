import { allowInternalHosts } from "@ai-office/shared";

// The server's tests stand up fake AI Providers, proxies, webhook receivers
// and Git servers on loopback, which an Owner allows with
// ALLOWED_INTERNAL_HOSTS (ADR 0007). A test that starts the whole Office
// sets its own, from the environment it gives.
allowInternalHosts(["127.0.0.1", "localhost"]);
