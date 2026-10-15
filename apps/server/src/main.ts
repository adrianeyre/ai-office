// The server's entry point: `pnpm --filter @ai-office/server start` (or `dev`).
import { ConfigError } from "./config.ts";
import { startServer } from "./server.ts";

try {
  const app = await startServer(process.env);
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      app.log.info({ signal }, "Shutting down.");
      void app.close().then(() => process.exit(0));
    });
  }
} catch (error) {
  // A ConfigError names the keys at fault and never their values.
  console.error(
    error instanceof ConfigError
      ? error.message
      : `AI Office failed to start: ${(error as Error).message}`,
  );
  process.exit(1);
}
