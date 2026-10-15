import { fileURLToPath } from "node:url";

/** The repository's root folder. */
export const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));

/** The built web app's page, which the server serves. */
export const webIndexHtml = fileURLToPath(
  new URL("../../apps/web/dist/index.html", import.meta.url),
);

/** The database each test's database is copied from. */
export const templateDatabase = "ai_office_e2e_template";

/** Set by the global setup: the Postgres server's superuser URL. */
export const postgresServerEnv = "AI_OFFICE_E2E_POSTGRES_SERVER";

/** Set by the global setup, with the reason, when the tests must skip. */
export const skipEnv = "AI_OFFICE_E2E_SKIP";

/** `serverUrl` with its database replaced by `database`. */
export function urlFor(serverUrl: string, database: string): string {
  const url = new URL(serverUrl);
  url.pathname = `/${database}`;
  return url.toString();
}
