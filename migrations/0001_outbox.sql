-- The outbox: every message thinkbot sent, or decided not to send.
--
-- Until this existed the only record of what the bot told people was the
-- channel itself, and the only record of what it chose NOT to say was a log
-- line that Workers Observability drops after a few days. "Why did triage go
-- quiet on that incident?" had no answer.
--
-- One row per outgoing message or per decision to stay silent. An e2e report
-- writes two: the headline, posted on receipt, and the finding, from the queue.
--
-- Pruned to 30 days on write (src/outbox/store.ts).

CREATE TABLE IF NOT EXISTS outbox (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  at          TEXT NOT NULL,             -- ISO time the row was written
  source      TEXT NOT NULL,             -- alert | e2e | chat
  step        TEXT NOT NULL,             -- headline | finding | reply
  trigger     TEXT NOT NULL,             -- what prompted it, one line
  outcome     TEXT NOT NULL,             -- posted | silent | failed | logged
  destination TEXT,                      -- where it went, never a secret
  text        TEXT,                      -- what it said (null when silent)
  raw         TEXT,                      -- the model's raw output, when it differs
  reason      TEXT,                      -- why silent, or the error when failed
  model       TEXT,
  steps       INTEGER,                   -- tool-calling steps in the turn
  tools       TEXT,                      -- JSON array of tool names called
  ms          INTEGER,                   -- turn duration
  context     TEXT                       -- JSON: the alert event or report, trimmed
);

CREATE INDEX IF NOT EXISTS idx_outbox_at ON outbox (at);
