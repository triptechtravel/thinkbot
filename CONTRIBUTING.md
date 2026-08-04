# Contributing

## Getting set up

```bash
npm install
npm test
```

Tests run on the node pool and do not need Cloudflare credentials. The Worker
itself does — `npm run dev` opens a remote proxy session for Workers AI, which
has no local simulator.

## Before opening a pull request

```bash
npm test
npx tsc --noEmit
```

Type checking covers the test files as well as `src/`, so a fixture that drifts
from a changed contract fails here rather than in review.

## Conventions worth knowing

**Nothing about one organisation belongs in the code.** `GITHUB_OWNER` and
`SENTRY_ORG` have no defaults, on purpose: a default means an unconfigured
deployment quietly queries someone else's org. What the agent knows about the
services it watches comes from `ESTATE_NOTES`, not from a string in
`agent-ops.ts`. If you find yourself typing a repository or project name into
source, it belongs in config.

**Every inbound route verifies its caller before doing any work.** Slack,
Telegram and the clawdwatch webhook each check a signature or a shared secret
first. The RPC entrypoint is the exception and deliberately so — authenticity
comes from the service binding — which is why `triageAlert` must never assume a
verification step ran. Do not move a check into it.

**Verification uses the sender's own implementation.** Alert signatures are
checked with clawdwatch's `verifySignature`, not a local reimplementation. The
signature covers `timestamp.body` and rejects stale timestamps; getting either
detail subtly wrong produces a bug that only shows up when someone exploits it.

**A missing token is configuration, not a crash.** Tools throw
`NotConfiguredError` so triage can continue without that source. An unset value
must never reach a request URL as the string `undefined` — that reads as a 404
and sends someone looking for a deleted repo.

**Treat the alert payload as versioned.** It carries `schemaVersion`. Additive
fields do not bump it, so ignore what you do not recognise and degrade rather
than reject on a version newer than this build knows. Refusing an unknown
version turns a clawdwatch release into a monitoring outage.

**Silence is a feature.** The agent replies with the single word `NOTHING` when
triage found nothing, and the route posts nothing at all. Do not add filler,
headlines that repeat what clawdwatch already sent, or a "no issues found"
message — these land in a channel under an incident someone is trying to read.

## Security

Please report vulnerabilities through a private advisory rather than a public
issue. See [SECURITY.md](https://github.com/triptechtravel/thinkbot/blob/main/SECURITY.md).
