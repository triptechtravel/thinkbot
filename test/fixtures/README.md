# Recorded reports

Real payloads, lifted from the `Report the failure to thinkbot` step of the
runs that produced them — the reporter prints what it sends, so a failing
nightly leaves its own fixture behind in the workflow log.

Recorded rather than written, because an invented report is a report whose
failures correlate with nothing. Triage is judged on whether it finds the
change that broke the run, and that only means something when a real commit,
a real window and a real set of merged PRs sit behind the payload.

| file                       | what it is                                                                                                                                                                                      |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `three-map-timeouts.json`  | 2026-08-22 06:07 UTC. Three specs across two files, all `Test timeout of 30000ms exceeded.`, against a real commit. The run whose triage turn posted 256 exclamation marks.                     |
| `suite-failed-to-run.json` | The `loadError` branch: the suite died before any test executed, so the report says nothing about whether the site is healthy. A different incident from tests failing, and a different prompt. |
| `probe.json`               | The delivery probe. Triage must recognise it as a non-event and say `NOTHING` — an agent asked to explain a non-event will invent one.                                                          |

To add one, find the run and pull the payload back out of its log:

    gh run view <id> --repo triptechtravel/campermate.com --log \
      | grep -a 'Report the failure to thinkbot'

Logs outlive the 14-day artifact retention but not forever — the 2026-08-21
run's payload was already gone by the time these were collected. Capture a
report worth keeping when it happens.
