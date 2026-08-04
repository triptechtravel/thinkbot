---
layout: default
title: thinkbot
---

# thinkbot

An ops agent that triages monitoring alerts. It receives an alert from
[clawdwatch](https://github.com/triptechtravel/clawdwatch), investigates it
against GitHub, Datadog, Sentry and Rollbar, and reports what it found to Slack
or Telegram.

A check tells you an endpoint returned 500. thinkbot looks for what changed
around that window — a pull request merged, an exception that first appeared
inside it, a metric that stepped rather than wobbled — and says so in a
paragraph. If the evidence does not support a cause, it says the cause is
unclear and lists what it ruled out.

Silence is a valid outcome. If triage found nothing, it posts nothing.

## Start here

- **[README](https://github.com/triptechtravel/thinkbot#readme)** — what it is,
  how it receives alerts, what it can look at
- **[SETUP.md](https://github.com/triptechtravel/thinkbot/blob/main/SETUP.md)** —
  deploying it and wiring up the sources
- **[SECURITY.md](https://github.com/triptechtravel/thinkbot/blob/main/SECURITY.md)** —
  read before deploying; it holds a GitHub PAT and vendor keys
- **[CONTRIBUTING.md](https://github.com/triptechtravel/thinkbot/blob/main/CONTRIBUTING.md)**

## The other half

thinkbot is a receiver. The monitor that sends the alerts is
**[clawdwatch](https://triptechtravel.github.io/clawdwatch/)**:

- [AI agents guide](https://triptechtravel.github.io/clawdwatch/integration/agents)
  — this integration described from the sending side, including response-body
  capture and the alert payload versioning contract
- [Notifiers](https://triptechtravel.github.io/clawdwatch/integration/notifiers)
  — Slack, signed webhook, and the RPC service binding thinkbot exposes

Apache-2.0.
