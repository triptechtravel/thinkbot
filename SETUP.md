# Setup

Everything is optional. An unconfigured channel returns 404 rather than
failing at startup, so you can bring one up at a time.

```bash
npm install
npm test
npx wrangler dev --remote     # --remote: the AI binding has no local mode
```

`GET /health` should return `{"ok":true,"service":"thinkbot"}`.

## Model

Defaults to `@cf/openai/gpt-oss-120b`, chosen for tool calling. Override
without a code change:

```bash
wrangler secret put MODEL          # e.g. @cf/meta/llama-4-scout-17b-16e-instruct
```

Route through AI Gateway for request logs, caching, and metrics:

```bash
wrangler secret put CF_AI_GATEWAY_ID
```

## Monitoring tools

```bash
wrangler secret put MONITORING_URL              # https://monitoring.<account>.workers.dev
wrangler secret put CF_ACCESS_CLIENT_ID         # Access service token
wrangler secret put CF_ACCESS_CLIENT_SECRET
```

Issue the service token in Zero Trust → Access → Service Tokens, and add it to
a policy on the monitoring API application with action **Service Auth**.

Without `MONITORING_URL` the tools still load; they report that monitoring is
not configured rather than erroring.

## Your estate

The correlation tools need to know whose repositories and projects to look at.
There are no built-in defaults — a default owner would silently query someone
else's organisation:

```bash
wrangler secret put GITHUB_OWNER     # org or user owning the repos, e.g. acme
wrangler secret put SENTRY_ORG       # Sentry org slug, as it appears in the URL
```

Optionally give the agent a short description of what it is looking after. It
is appended to the system prompt and read by the model, so plain prose is fine:

```bash
wrangler secret put ESTATE_NOTES
# e.g. "Repositories worth knowing: api-server (the backend), web (the site).
#       Sentry projects: web (the Next.js site) and mobile (the apps)."
```

Without it the agent still triages; it just has no map of your services.

## Alert inbox

clawdwatch signs its webhooks. Use the same secret on both sides:

```bash
# in the monitoring worker
wrangler secret put ALERT_SIGNING_SECRET

# here
wrangler secret put MONITORING_WEBHOOK_SECRET   # the same value
wrangler secret put SLACK_ALERT_CHANNEL         # e.g. C0123456789
```

### Or bind it directly (same Cloudflare account)

If clawdwatch runs as a Worker on the same account, prefer a service binding:
the platform authenticates the call, so there is no shared secret at all.

```jsonc
// in the monitoring worker's wrangler config
"services": [
  { "binding": "AGENT", "service": "thinkbot", "entrypoint": "AlertInbox" }
]
```

```ts
import { rpc } from 'clawdwatch';
notifiers: [rpc({ binding: (env) => env.AGENT })]
```

`MONITORING_WEBHOOK_SECRET` is then unnecessary. The HTTP inbox stays available
for senders that cannot use a binding.

Point clawdwatch at the inbox:

```ts
notifiers: [
  slack({ webhook: '${SLACK_WEBHOOK_URL}' }),
  webhook({
    url: 'https://thinkbot.<account>.workers.dev/hooks/clawdwatch',
    auth: hmac('${ALERT_SIGNING_SECRET}'),
    on: ['opened', 'recovered'],
  }),
]
```

Keep the Slack notifier alongside it. If the agent is the only alert path, an
agent outage is a monitoring outage — and you find out at the worst moment.

On an alert the inbox posts a headline immediately, then the analysis once
triage finishes. The headline does not depend on the model working.

## Telegram

```bash
wrangler secret put TELEGRAM_BOT_TOKEN          # from @BotFather
wrangler secret put TELEGRAM_WEBHOOK_SECRET     # any long random string
wrangler secret put TELEGRAM_ALLOWED_CHATS      # comma-separated chat ids
```

Register the webhook:

```bash
curl "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook" \
  -H 'Content-Type: application/json' \
  -d '{
    "url": "https://thinkbot.<account>.workers.dev/hooks/telegram",
    "secret_token": "<TELEGRAM_WEBHOOK_SECRET>"
  }'
```

Telegram echoes the secret on every delivery; requests without it are rejected.

**Set `TELEGRAM_ALLOWED_CHATS`.** Without it any chat that finds the bot can
run its tools. Get your chat id by messaging the bot and reading:

```bash
curl "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/getUpdates"
```

## Slack

Create an app at api.slack.com/apps.

- **OAuth scopes**: `app_mentions:read`, `chat:write`
- **Event Subscriptions**: request URL
  `https://thinkbot.<account>.workers.dev/hooks/slack`, subscribe to
  `app_mention`

Slack verifies the URL by asking it to echo a challenge; the route handles
that, so deploy before saving the URL.

```bash
wrangler secret put SLACK_BOT_TOKEN       # xoxb-…
wrangler secret put SLACK_SIGNING_SECRET  # Basic Information → Signing Secret
```

Requests are verified against `v0:timestamp:body` and anything older than five
minutes is rejected. Replies are threaded to the message that prompted them.

## Deploy

```bash
npm run deploy
```

## Notes

Slack retries any event not acknowledged within three seconds, and a retry
would run the agent twice — so both channels acknowledge immediately and reply
from `waitUntil`.

Tool results are trimmed before reaching the model. A full status dump is
mostly noise and you pay for every token of it on each turn.
