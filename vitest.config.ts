import fs from "node:fs";
import path from "node:path";
import { defineConfig } from "vitest/config";

// Integration tests run against a REAL Postgres, but a separate database
// (<name>_test) so they never touch dev data. Derived from DATABASE_URL in .env.
function testDatabaseUrl(): string | undefined {
  if (process.env.TEST_DATABASE_URL) return process.env.TEST_DATABASE_URL;
  const envFile = path.resolve(import.meta.dirname, ".env");
  const text = fs.existsSync(envFile) ? fs.readFileSync(envFile, "utf8") : "";
  const raw = process.env.DATABASE_URL ?? text.match(/^DATABASE_URL=(.*)$/m)?.[1];
  return raw?.trim().replace(/^["']|["']$/g, "").replace(/\/([^/?]+)(\?|$)/, "/$1_test$2");
}

// globalSetup runs in the main process, so set the variable there too (not only in workers).
process.env.DATABASE_URL = testDatabaseUrl() ?? "";
process.env.JWT_SECRET = "test-jwt-secret-test-jwt-secret-1234";
process.env.ACCOUNTING_SERVICE_KEY = "test-service-key";

export default defineConfig({
  test: {
    globalSetup: ["./test/global-setup.ts"],
    setupFiles: ["./test/env.ts"],
    // Integration files share one database: run them one after another.
    fileParallelism: false,
    hookTimeout: 60_000,
    testTimeout: 30_000,
  },
});
