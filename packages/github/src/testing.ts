// The fake GitHub, for tests across the codebase: in memory, or served over
// HTTP for the real App client (and the server) to call.
export {
  createFakeGitHub,
  type FakeGitHub,
  type FakeGitHubOptions,
  type FakeLabel,
  type FakeTokenScope,
} from "./fake.ts";
export {
  createAppKeys,
  serveFakeGitHub,
  type FakeGitHubServer,
} from "./fake-server.ts";
