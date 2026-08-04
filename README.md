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
surface**: `workers_dev` and `preview_urls` are off, the chat UI is deliberately
not served, and every inbound route verifies its caller before doing any work.

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

Apache-2.0. See [LICENSE](./LICENSE).
