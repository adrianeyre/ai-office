// Test doubles for the AI Gateway's dependencies, for other packages'
// tests (`@ai-office/gateway/testing`).
import { fileURLToPath } from "node:url";

import { readFixture, type Fixture } from "./fixtures.ts";

export {
  startFakeOAuthServer,
  type FakeOAuthServer,
} from "./accounts/fake-oauth.ts";
export {
  startFakeProxy,
  type FakeProxy,
  type ProxiedRequest,
} from "./test-support.ts";
export { readFixture, type Fixture };

/** A recorded model list from `fixtures/models/`, such as `xai.json`. */
export const modelListFixture = (name: string): Promise<Fixture> =>
  readFixture(
    fileURLToPath(new URL(`../fixtures/models/${name}`, import.meta.url)),
  );
