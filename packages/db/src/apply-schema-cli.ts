// `pnpm db:schema`: applies the schema (`schema.sql`) to the database at
// DATABASE_URL if it is empty, checks it is the same schema if not, then
// exits.
import { applySchema } from "./apply-schema.ts";
import { connect, databaseUrlFromEnv } from "./client.ts";
import { errorMessage } from "./error-message.ts";

let url: string;
try {
  url = databaseUrlFromEnv();
} catch (error) {
  console.error((error as Error).message);
  process.exit(1);
}

const connection = connect(url);
try {
  await applySchema(connection.db);
  console.log("Schema is up to date.");
} catch (error) {
  const message = errorMessage(error);
  console.error("Applying the schema failed:", message);
  if (message.includes("ECONNREFUSED")) {
    console.error(
      "Nothing is accepting connections there: is Postgres running, on the host and port in DATABASE_URL?",
    );
  }
  process.exitCode = 1;
} finally {
  await connection.close();
}
