---
title: thinkbot
---

<div class="run-strip">
  <div class="run-strip-label"><span>business login</span><span>incident 4f2a · opened 03:14</span></div>
  <div class="run-strip-marks">
    <i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i><i></i>
    <i></i><i></i><i></i><i></i><i></i><i></i><i></i>
    <i data-state="unhealthy"></i><i data-state="unhealthy"></i><i data-state="unhealthy"></i>
    <i data-state="unhealthy"></i><i data-state="unhealthy"></i><i data-state="unhealthy"></i><i data-state="unhealthy"></i>
  </div>
  <div class="run-strip-note"><b>Annotated 03:16</b> — auth-service #482 merged at 03:09 changed the session cookie domain. Sentry shows <code>InvalidSessionError</code> first seen 03:11, inside the window.</div>
</div>

# thinkbot

An ops agent that triages monitoring alerts. It receives an alert from
[clawdwatch](https://triptechtravel.github.io/clawdwatch/), investigates it
against GitHub, Datadog, Sentry and Rollbar, and reports what it found to Slack
or Telegram.

A check tells you an endpoint returned 500. thinkbot looks for what changed
around that window — a pull request merged, an exception that first appeared
inside it, a metric that stepped rather than wobbled — and says so in a
paragraph. If the evidence does not support a cause, it says the cause is
unclear and lists what it ruled out.

Silence is a valid outcome. If triage found nothing, it posts nothing: an empty
channel beats filler under an incident someone is trying to read.

## Why it exists

A health endpoint returned a 500 whose body named the failing dependency for
five hours, while the alert carried only `expected 200, got 500`. The cause was
sitting in a response nobody kept, and nobody was awake to read it.

clawdwatch now captures that body. thinkbot is the thing that reads it at 3am.

## Receiving alerts

Two transports, one triage path.

**Service binding.** If clawdwatch runs on the same Cloudflare account, it calls
thinkbot's `AlertInbox` entrypoint directly. The platform authenticates the
call, so there is no shared secret and no public endpoint:

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

## Where to go

| Page | What it covers |
|---|---|
| [Setup](/guide/setup) | Deploying it and wiring up the sources |
| [Security](/guide/security) | What it holds, and what verifies each caller |
| [Contributing](/guide/contributing) | Conventions that are load-bearing rather than stylistic |

## The other half

[clawdwatch](https://triptechtravel.github.io/clawdwatch/) is the monitor that
sends the alerts. Its [AI agents guide](https://triptechtravel.github.io/clawdwatch/integration/agents)
describes this integration from the sending side, including response-body
capture and the alert payload versioning contract.

MIT. [Source on GitHub](https://github.com/triptechtravel/thinkbot).
