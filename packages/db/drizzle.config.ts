import { defineConfig } from "drizzle-kit";

// Used only by `pnpm db:generate` (src/generate-schema.ts), which exports the
// whole of `src/schema.ts` as plain SQL with `drizzle-kit export`. Applying
// the schema never needs drizzle-kit.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema.ts",
});
