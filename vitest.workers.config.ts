import path from "node:path";
import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";

/**
 * Integration suite: the real Worker inside workerd, on a real (miniflare) D1
 * with the shipped migrations applied. The unit suite mocks the channels and
 * the store; this one proves the SQL, the Access gate and the page render
 * through `SELF.fetch`, the way a browser reaches them.
 */
export default defineConfig(async () => {
  const migrations = await readD1Migrations(
    path.join(import.meta.dirname, "migrations")
  );
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./test/workers/wrangler.jsonc" },
        miniflare: { bindings: { TEST_MIGRATIONS: migrations } }
      })
    ],
    test: {
      include: ["test/workers/**/*.workers.test.ts"],
      setupFiles: ["./test/workers/apply-migrations.ts"]
    }
  };
});
