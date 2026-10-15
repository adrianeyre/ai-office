// What the Postgres test harnesses share, without Vitest: the Vitest one
// (`postgres.ts`) and the Playwright end-to-end one (`e2e/`).
import { getContainerRuntimeClient } from "testcontainers";

/**
 * The image the integration tests run against; the PRD pins Postgres 18.
 * The stack's own (docker-compose.yml), pinned by the same digest.
 */
export const postgresImage =
  "postgres:18.6-alpine@sha256:77f585114c32fbca283dc835b0596f4e52b51b4c6662d7810b2f4084f60a1873";

export type DockerStatus =
  | { readonly available: true }
  | { readonly available: false; readonly reason: string };

let dockerStatus: Promise<DockerStatus> | undefined;

/** Whether Testcontainers can reach a container runtime. Checked once. */
export function checkDocker(): Promise<DockerStatus> {
  dockerStatus ??= getContainerRuntimeClient().then(
    (): DockerStatus => ({ available: true }),
    (error: unknown): DockerStatus => ({
      available: false,
      reason: `Docker is not available (${error instanceof Error ? error.message : String(error)})`,
    }),
  );
  return dockerStatus;
}
