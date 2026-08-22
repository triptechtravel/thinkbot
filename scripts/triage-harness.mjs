#!/usr/bin/env node
/**
 * Drive triage against a recorded report, from a terminal.
 *
 * The integration suite asserts; this shows. Judging whether a triage
 * paragraph is any good is not something an assertion does — you have to read
 * it, next to the report it came from and next to what another model said
 * about the same one. Every fault this path has shown so far was obvious on
 * sight and invisible to a test: a wall of exclamation marks, a planning line
 * leaking out of the analysis channel, a sentence stopping mid-word.
 *
 *   node scripts/triage-harness.mjs three-map-timeouts
 *   node scripts/triage-harness.mjs --all
 *
 * Compare models on the same report — the reason the dry-run route takes a
 * model override at all, since changing `MODEL` and redeploying means the two
 * runs happen on different days against a different estate:
 *
 *   node scripts/triage-harness.mjs three-map-timeouts \
 *     --model @cf/openai/gpt-oss-120b \
 *     --model @cf/moonshotai/kimi-k2.6
 *
 * Nothing here posts to Slack: it drives `/hooks/e2e/dry-run`, which runs the
 * same prompt through the same turn and hands back the result. Running it does
 * spend tokens and does hit GitHub, Datadog and Sentry.
 *
 * Env: E2E_WEBHOOK_SECRET (required), THINKBOT_URL (default the deployment).
 */
import { readFileSync, readdirSync } from "node:fs";
import { createHmac } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const FIXTURES = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "test",
  "fixtures"
);
const BASE = process.env.THINKBOT_URL || "https://thinkbot.campermate.com";
const SECRET = process.env.E2E_WEBHOOK_SECRET;

if (!SECRET) {
  console.error("E2E_WEBHOOK_SECRET is required — it signs the request.");
  process.exit(1);
}

const argv = process.argv.slice(2);
const models = [];
const names = [];
let all = false;

for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--model") models.push(argv[++i]);
  else if (argv[i] === "--all") all = true;
  else names.push(argv[i]);
}

const available = readdirSync(FIXTURES)
  .filter((f) => f.endsWith(".json"))
  .map((f) => f.replace(/\.json$/, ""));

const reports = all ? available : names;
if (reports.length === 0) {
  console.error(`usage: triage-harness.mjs <report> [--model <id>]... | --all`);
  console.error(`reports: ${available.join(", ")}`);
  process.exit(1);
}

const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const cyan = (s) => `\x1b[36m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;

/** Wrap to a readable column, so a paragraph can be judged as a paragraph. */
function wrap(text, indent = "  ") {
  return text
    .split("\n")
    .flatMap((line) => {
      const out = [];
      let current = "";
      for (const word of line.split(" ")) {
        if ((current + word).length > 76) {
          out.push(current.trimEnd());
          current = "";
        }
        current += `${word} `;
      }
      out.push(current.trimEnd());
      return out;
    })
    .map((line) => indent + line)
    .join("\n");
}

async function dryRun(report, model) {
  const body = JSON.stringify(report);
  const timestamp = String(Date.now());
  const signature = createHmac("sha256", SECRET)
    .update(`${timestamp}.${body}`)
    .digest("hex");

  const url = new URL("/hooks/e2e/dry-run", BASE);
  if (model) url.searchParams.set("model", model);

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-thinkbot-signature": `sha256=${signature}`,
      "x-thinkbot-timestamp": timestamp
    },
    body
  });

  if (!response.ok) {
    throw new Error(`${response.status} ${await response.text()}`);
  }
  return response.json();
}

for (const name of reports) {
  const report = JSON.parse(
    readFileSync(join(FIXTURES, `${name}.json`), "utf8")
  );

  console.log(
    `\n${bold(name)} ${dim(`— ${report.failures?.length ?? 0} failure(s), ${report.sha?.slice(0, 8)}`)}`
  );

  for (const model of models.length ? models : [undefined]) {
    let result;
    try {
      result = await dryRun(report, model);
    } catch (err) {
      console.log(`  ${red("request failed")} ${dim(String(err.message))}`);
      continue;
    }

    console.log(
      `\n  ${cyan(result.model)} ${dim(`${result.steps} step(s) · ${(result.ms / 1000).toFixed(1)}s · ${result.raw.length} chars`)}`
    );

    // The raw text is what the model said; `posted` is what the channel would
    // get. Printing both is the whole value — when they differ, the guard did
    // something, and the reason says what.
    console.log(wrap(result.raw || dim("(nothing)"), "    "));

    if (result.reason) {
      const note = result.posted
        ? yellow(`altered: ${result.reason}`)
        : red(`DROPPED: ${result.reason} — the channel would stay silent`);
      console.log(`\n    ${note}`);
    }
  }
}

console.log("");
