# Security

thinkbot holds a GitHub PAT, Datadog and Sentry keys, and write access
to monitoring incidents. Treat a deployment as a credential store that happens
to talk.

## Reporting a vulnerability

Open a private security advisory on the repository rather than a public issue.

## Design

**No public surface.** `workers_dev` and `preview_urls` are off, there is no
chat UI, and there is no static asset bundle. The last of those is the one
worth stating explicitly: assets are matched _before_ the Worker runs, so a
bundle is a second way into the hostname that no route guard ever sees. While
one was deployed it served the chat shell to any unauthenticated GET, answered
`/health` with `index.html` rather than the handler, and — before
`run_worker_first` — returned 405 to every signed inbox, because the asset
handler rejects non-GET instead of falling through.

Adding a UI later means putting the hostname behind Cloudflare Access first,
with a bypass for `/hooks/*` — webhook senders cannot authenticate to Access —
and serving it from a route rather than from assets, so it stays behind the
same check as everything else.

**Every inbound route verifies its caller before doing any work.**

- clawdwatch alerts: HMAC over `timestamp.body`, with stale timestamps
  rejected. Verification uses clawdwatch's own `verifySignature` rather than a
  local reimplementation.
- Slack: request signing secret.
- Telegram: the secret token Telegram echoes back, plus an allow-list of chat
  ids.

**RPC carries no signature.** When clawdwatch reaches the `AlertInbox`
entrypoint over a service binding, authenticity comes from the binding itself —
only Workers on the same account that declare the binding can call it. The
shared triage path is written not to assume a signature was checked, so do not
move verification out of the HTTP adapter and into it.

**Outbound credentials are read-only where the provider allows it.** The GitHub
PAT should be fine-grained with contents and actions read scope only. Datadog,
The Sentry token should be a read token. The one write capability is
annotating monitoring incidents, and that is scoped by short-lived signed links
that arrive with the alert rather than by a standing credential.

**No org defaults.** `GITHUB_OWNER` and `SENTRY_ORG` have no built-in values. A
default would mean an unconfigured deployment quietly querying someone else's
organisation.

## What the model sees

Alert payloads are put into a prompt. If a check enables clawdwatch's
`captureBodyOnFailure`, an excerpt of the failing response body is included —
truncated and scrubbed of known secret values by clawdwatch before it is sent.
Do not enable that on endpoints whose error paths can return personal data.

Model output is posted to Slack and Telegram. Treat the agent's conclusions as
untrusted text: it is summarising logs and third-party API responses, which are
themselves attacker-influenceable in principle.
