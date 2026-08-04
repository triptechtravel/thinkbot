# Security

thinkbot holds a GitHub PAT, Datadog, Sentry and Rollbar keys, and write access
to monitoring incidents. Treat a deployment as a credential store that happens
to talk.

## Reporting a vulnerability

Open a private security advisory on the repository rather than a public issue.

## Design

**No public surface.** `workers_dev` and `preview_urls` are off, and the chat UI
and agent RPC routes are deliberately not served. An unauthenticated chat
surface would hand every credential above to anyone who found the hostname.
Re-enabling the UI means putting the hostname behind Cloudflare Access first,
with a bypass for `/hooks/*` — webhook senders cannot authenticate to Access.

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
Sentry and Rollbar tokens should be read tokens. The one write capability is
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
