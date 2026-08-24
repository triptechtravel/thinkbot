import { describe, it, expect, vi, afterEach } from "vitest";
import { PROVIDERS, composeTools, missing, selectProviders } from "./registry";

/**
 * Composition rules for the tool set.
 *
 * The one that carries weight is that an unconfigured provider is not offered
 * at all. Rollbar sat in this deployment for months with an invalid token:
 * every turn spent one of its handful of steps to be told 403, and once the
 * prompt required reporting failed tools, every write-up carried "Rollbar
 * could not be checked" as though it were a finding.
 */

const full = {
  MONITORING_URL: "https://monitoring.example",
  GITHUB_TOKEN: "t",
  GITHUB_OWNER: "o",
  DD_API_KEY: "k",
  DD_APP_KEY: "a",
  CF_ACCOUNT_ID: "acct",
  CF_API_TOKEN: "tok",
  SENTRY_TOKEN: "s",
  SENTRY_ORG: "org"
} as unknown as Env;

const names = (env: Env) => selectProviders(env).enabled.map((p) => p.name);
const skipped = (env: Env) =>
  Object.fromEntries(
    selectProviders(env).skipped.map((s) => [s.name, s.reason])
  );

afterEach(() => vi.restoreAllMocks());

describe("selectProviders — credentials decide", () => {
  it("offers every provider a fully configured deployment can run", () => {
    expect(names(full)).toEqual(PROVIDERS.map((p) => p.name));
  });

  it("does not offer a provider whose credentials are absent", () => {
    const { DD_API_KEY, ...rest } = full as unknown as Record<string, string>;
    void DD_API_KEY;

    expect(names(rest as unknown as Env)).not.toContain("datadog");
    expect(skipped(rest as unknown as Env).datadog).toMatch(/DD_API_KEY unset/);
  });

  it("treats an empty string as unset, not as a credential", () => {
    // A var declared but blank is the shape a half-finished deployment has,
    // and it would otherwise buy a tool that can only fail.
    const env = { ...full, SENTRY_TOKEN: "   " } as unknown as Env;

    expect(names(env)).not.toContain("sentry");
  });

  it("offers nothing at all when nothing is configured", () => {
    // Degraded, not broken: the turn still runs and says it found nothing,
    // which is honest. A crash here would take the alert down with it.
    expect(names({} as Env)).toEqual([]);
    expect(() => composeTools({} as Env)).not.toThrow();
  });
});

describe("selectProviders — the TOOLS setting", () => {
  it("defaults to everything credentialed when unset", () => {
    expect(names(full)).toHaveLength(PROVIDERS.length);
  });

  it("narrows to an explicit list", () => {
    expect(
      names({ ...full, TOOLS: "github,sentry" } as unknown as Env)
    ).toEqual(["github", "sentry"]);
  });

  it("removes one from the default with a leading dash", () => {
    const got = names({ ...full, TOOLS: "-datadog" } as unknown as Env);

    expect(got).not.toContain("datadog");
    expect(got).toContain("github");
    expect(got.length).toBe(PROVIDERS.length - 1);
  });

  it("ignores spacing and case, which a config file will have", () => {
    expect(
      names({ ...full, TOOLS: " GitHub , SENTRY " } as unknown as Env)
    ).toEqual(["github", "sentry"]);
  });

  it("still refuses an included provider that is not configured", () => {
    // Asking for a tool does not conjure its credentials, and offering it
    // anyway is how you buy a step that can only fail.
    const env = { ...full, TOOLS: "datadog", DD_APP_KEY: "" } as unknown as Env;

    expect(names(env)).toEqual([]);
    expect(skipped(env).datadog).toMatch(/not configured/);
  });

  /**
   * A typo in TOOLS removes a tool silently, and a silently absent tool is
   * indistinguishable from a deliberate choice — the exact failure this
   * codebase has hit three times under other names.
   */
  it("reports a name nobody recognises rather than ignoring it", () => {
    const env = { ...full, TOOLS: "github,sentryy" } as unknown as Env;

    expect(names(env)).toEqual(["github"]);
    expect(skipped(env).sentryy).toMatch(/unknown provider/);
  });

  it("reports an unknown name used as an exclusion too", () => {
    const env = { ...full, TOOLS: "-datadoge" } as unknown as Env;

    expect(skipped(env).datadoge).toMatch(/unknown provider/);
    // ...and does not quietly drop a real provider on the strength of a typo.
    expect(names(env)).toContain("datadog");
  });
});

describe("composeTools", () => {
  it("merges the enabled providers into one tool set", () => {
    const tools = composeTools({
      ...full,
      TOOLS: "github,sentry"
    } as unknown as Env);
    const fromBoth = [
      ...Object.keys(PROVIDERS.find((p) => p.name === "github")!.build(full)),
      ...Object.keys(PROVIDERS.find((p) => p.name === "sentry")!.build(full))
    ];

    expect(Object.keys(tools).sort()).toEqual(fromBoth.sort());
  });

  it("never builds a provider it is not offering", () => {
    // Building is cheap today, but a provider that reads a binding or throws
    // on a missing secret at construction would take the whole turn down.
    const provider = PROVIDERS.find((p) => p.name === "datadog")!;
    const build = vi.spyOn(provider, "build");

    composeTools({ ...full, TOOLS: "-datadog" } as unknown as Env);

    expect(build).not.toHaveBeenCalled();
  });

  it("logs what ran and what did not, with the reason", () => {
    // A turn that found nothing means something different with four sources
    // than with one, and that has to be recoverable afterwards.
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    composeTools({
      ...full,
      TOOLS: "-datadog",
      SENTRY_ORG: ""
    } as unknown as Env);

    const line = String(log.mock.calls.at(0)?.[0]);
    expect(line).toContain("[tools]");
    expect(line).toContain("github");
    expect(line).toMatch(/datadog \(excluded by TOOLS\)/);
    expect(line).toMatch(/sentry \(not configured — SENTRY_ORG unset\)/);
  });
});

describe("the provider list itself", () => {
  it("has no duplicate names, which would shadow silently", () => {
    const seen = PROVIDERS.map((p) => p.name);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it("gives every provider a usable id and a stated requirement", () => {
    for (const provider of PROVIDERS) {
      expect(provider.name, provider.name).toMatch(/^[a-z][a-z0-9-]*$/);
      expect(provider.summary.length, provider.name).toBeGreaterThan(10);
      expect(provider.requires.length, provider.name).toBeGreaterThan(0);
      // `missing` compares against env keys, so a requirement that is not a
      // real env var name can never be satisfied.
      for (const key of provider.requires) {
        expect(key, provider.name).toMatch(/^[A-Z][A-Z0-9_]*$/);
      }
    }
  });

  it("names requirements the env type actually declares", () => {
    // Catches a provider requiring a var nobody can set — it would be skipped
    // forever, and the deployment would never know why.
    const declared = new Set(Object.keys(full as unknown as object));
    for (const provider of PROVIDERS) {
      for (const key of provider.requires) {
        expect(declared.has(key), `${provider.name} requires ${key}`).toBe(
          true
        );
      }
    }
  });
});

describe("missing", () => {
  it("names every absent variable, not just the first", () => {
    const provider = PROVIDERS.find((p) => p.name === "datadog")!;
    expect(missing(provider, {} as Env)).toEqual(["DD_API_KEY", "DD_APP_KEY"]);
  });
});
