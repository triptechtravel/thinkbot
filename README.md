# thinkbot

An ops agent that triages monitoring alerts. It receives an alert from
[clawdwatch](https://github.com/triptechtravel/clawdwatch), investigates it
against GitHub, Datadog and Sentry, and reports what it found to Slack
or Telegram.

The point is the step monitoring cannot do on its own. A check tells you an
endpoint returned 500. thinkbot looks for what changed around that window — a
pull request merged, an exception that first appeared inside it, a metric that
stepped rather than wobbled — and says so in a paragraph. If the evidence does
not support a cause, it says the cause is unclear and lists what it ruled out.

Silence is a valid outcome. If triage found nothing, it posts nothing: an empty
channel beats filler under an incident someone is trying to read.

It runs as a single Cloudflare Worker — one `fetch` handler, an RPC
entrypoint, and a model turn on [Workers AI](https://developers.cloudflare.com/workers-ai/).
It was scaffolded on the [Agents SDK](https://developers.cloudflare.com/agents/),
but every caller wants one turn and an answer rather than a streaming
conversation, so the chat agent and its Durable Object are gone.

## Why it exists

A health endpoint returned a 500 whose body named the failing dependency for
five hours, while the alert carried only `expected 200, got 500`. The cause was
sitting in a response nobody kept, and nobody was awake to read it.

clawdwatch now captures that body. thinkbot is the thing that reads it at 3am.

## How it receives alerts

Two transports, one triage path.

**Service binding (preferred).** If clawdwatch runs on the same Cloudflare
account, it calls thinkbot's `AlertInbox` entrypoint directly. The platform
authenticates the call, so there is no shared secret and no public endpoint:

```jsonc
// in the monitoring Worker's config
"services": [
  { "binding": "AGENT", "service": "thinkbot", "entrypoint": "AlertInbox" }
]
```

```ts
import { rpc } from "clawdwatch";
notifiers: [rpc({ binding: (env) => env.AGENT })];
```

**Signed webhook.** For a sender that cannot use a binding,
`POST /hooks/clawdwatch` verifies an HMAC over `timestamp.body` using
clawdwatch's own `verifySignature` rather than a local reimplementation.

An RPC call carries no signature — authenticity comes from the binding — so the
shared triage path never assumes one was checked.

## How it receives failing test runs

`POST /hooks/e2e` takes a signed report from a CI runner when an end-to-end
suite fails, and triages it the same way. A service binding is not an option
here: bindings are same-account only and a GitHub runner is not on the account,
so this path is HMAC over `timestamp.body` under `x-thinkbot-signature` and
`x-thinkbot-timestamp`, keyed by `E2E_WEBHOOK_SECRET` — a different key from
the monitoring inbox, because a CI runner is a different sender in a different
trust domain.

The payload is deliberately not a clawdwatch `AlertEvent`. A test run is not a
synthetic check: there is no incident to annotate and no signed links to act
on. It carries the repository, the commit, the run URL, and the failures the
reporter saw:

```json
{
  "schemaVersion": 1,
  "repo": "owner/repo",
  "sha": "d0812c0d",
  "ref": "main",
  "trigger": "schedule",
  "baseUrl": "https://example.com",
  "runUrl": "https://github.com/owner/repo/actions/runs/1",
  "loadError": null,
  "failures": [{ "title": "…", "projects": ["desktop-chrome"], "error": "…" }],
  "passed": 65,
  "skipped": 5
}
```

The split is the point: the runner holds evidence no Worker can reach — which
specs failed and what they asserted — and thinkbot holds the credentials the
runner should not, and answers what changed around that commit.

`loadError` with no failures is a distinct incident: the suite never ran, so it
says nothing about whether the site is healthy. Reporting that as "0 tests
failed" is how a real two-night outage read as noise.

A report may set `"probe": true`. It travels the same route and is posted the
same way — a probe down a different code path would prove that path works and
nothing about the one a real failure takes — but it is labelled unmistakably and
skips triage, because an agent asked to explain a non-event will invent one.
It exists because there is no second notifier behind this path: without a way
to exercise delivery, you find out it is broken during the outage it was meant
to announce.

**This path always posts**, unlike monitoring triage. There is no second
notifier behind it, so silence would mean a failing nightly suite disappears.
The headline is the floor; the triage paragraph is what is added on top.

## Where the turns run

Every model turn — triage and chat replies alike — runs on a Cloudflare queue,
not in the `waitUntil` of the request that arrived. A `waitUntil` gets about
thirty seconds after the response; a turn that makes several tool calls
regularly needs more, and the runtime cancels it with no error and no message.
That failure is invisible by construction: the thing that broke is the thing
that would have told you.

Everything an inbox receives is therefore reduced to something that survives
JSON before it is queued. That is why a reply is a `ReplyTarget` — a channel,
a conversation, a thread — rather than the `reply()` closure it used to be.

Two consequences worth knowing:

- **The e2e headline is posted in the request, not from the queue.** The alert
  should not depend on the queue being healthy; only the explanation does.
- **Retries are off and every job is acked.** A retried turn may already have
  posted, so retrying risks a duplicate under an incident someone is reading,
  or the bot answering the same question twice. Failures go to the log and the
  dead-letter queue.

## What it can look at

Tools are composed per turn from whatever this deployment is credentialed for.
Nothing is hardcoded into the agent, so adopting this against a different
estate is configuration, not a patch.

| `TOOLS` name | Needs                           | Used for                                            |
| ------------ | ------------------------------- | --------------------------------------------------- |
| `github`     | `GITHUB_TOKEN`, `GITHUB_OWNER`  | pull requests merged recently, workflow runs        |
| `datadog`    | `DD_API_KEY`, `DD_APP_KEY`      | metrics that stepped around the failure window      |
| `sentry`     | `SENTRY_TOKEN`, `SENTRY_ORG`    | exceptions first seen inside the window             |
| `workers`    | `CF_ACCOUNT_ID`, `CF_API_TOKEN` | Worker invocation telemetry — outcomes, wall vs CPU |
| `clawdwatch` | `MONITORING_URL`                | check history, incidents, and writing findings back |

**A provider without its credentials is not offered at all.** That is the
important part, and it is not the same as failing gracefully. A tool that
cannot answer still costs the agent one of its handful of steps, and — since
the prompt requires reporting sources that failed — it earns a sentence in
every write-up forever. This deployment carried a Rollbar tool with an invalid
token for months and paid both costs on every single triage.

`TOOLS` narrows that default; it is not an opt-in, so a fresh install with
credentials works with `TOOLS` unset.

```bash
TOOLS=github,sentry   # only these two
TOOLS=-datadog        # everything credentialed, minus Datadog
```

An unrecognised name is reported rather than ignored — a typo silently removes
a tool, and a silently absent tool is indistinguishable from a deliberate
choice. Every turn logs a `[tools]` line naming what ran and why the rest did
not, and `/hooks/e2e/dry-run` returns the same in `tools` and `toolsSkipped`.

### Adding one

`src/tools/registry.ts` holds the list. A provider is a name, the env vars it
cannot work without, and a function returning its tools:

```ts
{
  name: "pagerduty",
  summary: "Who was paged, and for what.",
  requires: ["PAGERDUTY_TOKEN"],
  build: pagerdutyTools,
}
```

Workers have no filesystem and no runtime `import()`, so that list IS the
registration — there is no directory to scan. One import, one entry.

Findings worth keeping are written back to the incident with `annotateIncident`,
using the short-lived signed links that arrive with the alert — so the agent
needs no standing credential to record what it concluded.

## Setup

See [SETUP.md](./SETUP.md). In short: deploy the Worker, give it tokens for
whichever sources you use, tell it who you are with `GITHUB_OWNER` and
`SENTRY_ORG`, and point clawdwatch at it.

There are no built-in defaults for the owner or org. A default would mean an
unconfigured deployment quietly querying someone else's organisation.

`ESTATE_NOTES` is where you describe what you are looking after — which
repositories matter, what the Sentry projects are called. It is appended to the
system prompt and read by a model, so plain prose is fine.

## Security

thinkbot holds a GitHub PAT and several vendor keys. It has **no public
surface**: `workers_dev` and `preview_urls` are off, there is no chat UI and no
static asset bundle, and every inbound route verifies its caller before doing
any work. The absence of assets is deliberate — they are matched before the
Worker runs, so a bundle answers requests that no route guard ever sees.

Read [SECURITY.md](./SECURITY.md) before deploying, particularly if you plan to
enable clawdwatch's `captureBodyOnFailure` on endpoints whose error paths can
return personal data.

## Development

```bash
npm install
npm test
npx tsc --noEmit
```

`npm test` mocks the model. That is the right default — the suite stays free
and offline — but it means the whole of it goes green whatever the model
emits, which is how a collapsed generation once posted 256 exclamation marks
into the alert channel under a live incident headline.

So the model half is exercised separately, against recorded reports:

```bash
export E2E_WEBHOOK_SECRET=...          # the same secret the CI reporter signs with

npm run test:integration               # assert: is the output the kind of thing that belongs in a channel?
VERBOSE=1 npm run test:integration     # ...and print every turn while doing it

node scripts/triage-harness.mjs --all  # read the turns yourself
node scripts/triage-harness.mjs three-map-timeouts \
  --model @cf/openai/gpt-oss-120b \
  --model @cf/moonshotai/kimi-k2.6     # compare two models on the same report
```

That comparison is how the current default was chosen. On 2026-08-22,
gpt-oss-120b collapsed into a wall of exclamation marks once in six turns —
the failure that reached the alert channel in August — and, where a tool
failed, reported "no new Sentry errors" rather than saying it could
not check. kimi-k2.6 did neither, and is the default as of that run. See
`DEFAULT_MODEL` in `src/config.ts`.

Neither model found the real cause, and that is the more useful result: both
called a server-side render stall a "test flake" because no tool here reached
Workers observability, which is where the evidence was. That gap is now
closed — `workerHealth` (`src/tools/workers.ts`) reads Worker invocation
telemetry, and against the incident window it returns:

    STALLED: p99 wall 52572ms against p99 CPU 1172ms — 45:1. That is a request
    waiting on I/O that never returns, NOT slow code. Treat the site as
    unhealthy however green the uptime checks look.

It needs `CF_ACCOUNT_ID` and `CF_API_TOKEN` (Workers Observability read). The
prompt also now forbids reporting a tool that failed as a source that came back
clean, which is the other half of how the wrong answer was reached.

Both drive `POST /hooks/e2e/dry-run`, which runs the same prompt through the
same turn as the real inbox and returns the result to the caller instead of
announcing it. Nothing they do reaches Slack — a harness that posted would
cry wolf every time anyone ran it. They do spend tokens and do reach GitHub,
Datadog and Sentry, and they need a deployed Worker (or `npx wrangler dev`,
which still reaches a real Workers AI binding) because the model and the
correlation credentials are both bindings.

The reports in `test/fixtures/` are real payloads recovered from the workflow
logs of the runs that produced them; see the README there before adding one.
What these can and cannot check is written at the top of
`test/integration/triage.itest.ts` — in short, they check that the output is
prose fit for an incident channel, not that its diagnosis is correct. No
assertion separates a sound conclusion from a confident wrong one.

## Related

- [clawdwatch](https://github.com/triptechtravel/clawdwatch) — the monitor that
  sends the alerts ([documentation](https://triptechtravel.github.io/clawdwatch/))
- [AI agents guide](https://triptechtravel.github.io/clawdwatch/integration/agents)
  — this integration described from the other side

Scaffolded from [cloudflare/agents-starter](https://github.com/cloudflare/agents-starter).

## License

MIT. See [LICENSE](./LICENSE), and [NOTICE](./NOTICE) for the agents-starter
notice the scaffold came with.
