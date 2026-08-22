import { defineConfig } from "vitest/config";

/**
 * Integration tests run a real model turn against a deployed Worker, so they
 * need the inbox secret and are kept out of the default run: `npm test` must
 * stay free and offline, and a suite that costs tokens is a suite people stop
 * running.
 *
 * A triage turn makes several tool calls against GitHub, Datadog and Sentry
 * before it writes anything, so the timeout is generous by design — the
 * deployment allows one turn two minutes before recording it as silence, and
 * a test that gave up sooner would report a slow model as a broken one.
 */
export default defineConfig({
  test: {
    include: ["test/integration/**/*.itest.ts"],
    testTimeout: 180_000,
    hookTimeout: 180_000
  }
});
