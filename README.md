# thinkbot

An ops agent that triages monitoring alerts. It receives an alert from
[clawdwatch](https://github.com/triptechtravel/clawdwatch), investigates it
against GitHub, Datadog, Sentry and Rollbar, and reports what it found to Slack
or Telegram.

The point is the step monitoring cannot do on its own. A check tells you an
endpoint returned 500. thinkbot looks for what changed around that window — a
pull request merged, an exception that first appeared inside it, a metric that
stepped rather than wobbled — and says so in a paragraph. If the evidence does
not support a cause, it says the cause is unclear and lists what it ruled out.

Silence is a valid outcome. If triage found nothing, it posts nothing: an empty
channel beats filler under an incident someone is trying to read.

It runs as a single Cloudflare Worker on the
[Agents SDK](https://developers.cloudflare.com/agents/).

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
import { rpc } from 'clawdwatch';
notifiers: [rpc({ binding: (env) => env.AGENT })]
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

## What it can look at

| Source | Used for |
|---|---|
| GitHub | pull requests merged recently, workflow runs |
| Datadog | metrics that stepped around the failure window |
| Sentry | exceptions first seen inside the window |
| Rollbar | the same, for services reporting there |
| clawdwatch | check history, incidents, and writing findings back |

Each is optional. A source with no token configured reports that it is not
configured rather than failing the triage.

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

## Related

- [clawdwatch](https://github.com/triptechtravel/clawdwatch) — the monitor that
  sends the alerts ([documentation](https://triptechtravel.github.io/clawdwatch/))
- [AI agents guide](https://triptechtravel.github.io/clawdwatch/integration/agents)
  — this integration described from the other side

Scaffolded from [cloudflare/agents-starter](https://github.com/cloudflare/agents-starter).

## License

MIT. See [LICENSE](./LICENSE), and [NOTICE](./NOTICE) for the agents-starter
notice the scaffold came with.
