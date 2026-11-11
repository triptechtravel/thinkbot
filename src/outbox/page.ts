/**
 * The /outbox page: what thinkbot sent, where, and what it said.
 *
 * Server-rendered HTML with no build step and no asset bundle: thinkbot
 * deliberately has no `assets` block (see wrangler.jsonc), so the page is a
 * string from a route, behind the same Access check as its JSON.
 *
 * Every value from the database is escaped. Model output and alert payloads
 * are untrusted text.
 */

import {
  OUTCOMES,
  SOURCES,
  type OutboxOutcome,
  type OutboxRow,
  type OutboxSource
} from "./store";

export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const OUTCOME_LABEL: Record<OutboxOutcome, string> = {
  posted: "Posted",
  silent: "Stayed silent",
  failed: "Failed to send",
  logged: "Logged only"
};

const SOURCE_LABEL: Record<OutboxSource, string> = {
  alert: "Monitoring alert",
  e2e: "E2E failure",
  chat: "Question"
};

const STEP_LABEL: Record<string, string> = {
  headline: "headline",
  finding: "triage finding",
  reply: "reply"
};

export interface PageState {
  rows: OutboxRow[];
  source?: OutboxSource;
  outcome?: OutboxOutcome;
  next: number | null;
  viewer: string | null;
  configured: boolean;
}

function href(
  state: Pick<PageState, "source" | "outcome">,
  change: Partial<Pick<PageState, "source" | "outcome">> & { before?: number }
): string {
  const params = new URLSearchParams();
  const source = "source" in change ? change.source : state.source;
  const outcome = "outcome" in change ? change.outcome : state.outcome;
  if (source) params.set("source", source);
  if (outcome) params.set("outcome", outcome);
  if (change.before) params.set("before", String(change.before));
  const query = params.toString();
  return query ? `?${query}` : "?";
}

function chip(label: string, link: string, active: boolean): string {
  return `<a class="chip" href="${escapeHtml(link)}"${active ? ' aria-current="true"' : ""}>${escapeHtml(label)}</a>`;
}

function meta(row: OutboxRow): string {
  const bits: string[] = [];
  if (row.model) bits.push(`model <b>${escapeHtml(row.model)}</b>`);
  if (row.steps !== null && row.steps !== undefined)
    bits.push(`<b>${row.steps}</b> step${row.steps === 1 ? "" : "s"}`);
  if (row.ms !== null && row.ms !== undefined)
    bits.push(`<b>${(row.ms / 1000).toFixed(1)}</b>s`);
  return bits.length ? `<div class="meta">${bits.join(" · ")}</div>` : "";
}

function tools(row: OutboxRow): string {
  if (!row.tools || row.tools.length === 0) return "";
  return `<div class="tools"><span class="k">Tools called</span>${row.tools
    .map((t) => `<code>${escapeHtml(t)}</code>`)
    .join("")}</div>`;
}

function entry(row: OutboxRow): string {
  const said = row.text
    ? `<section><h3>What it said</h3><div class="said">${escapeHtml(row.text)}</div></section>`
    : `<section><h3>What it said</h3><p class="none">Nothing was sent.</p></section>`;

  const reason = row.reason
    ? `<section><h3>${row.outcome === "failed" ? "Error" : "Why"}</h3><p class="reason">${escapeHtml(row.reason)}</p></section>`
    : "";

  const raw = row.raw
    ? `<details class="sub"><summary>Raw model output (${row.raw.length.toLocaleString("en")} chars)</summary><pre>${escapeHtml(row.raw)}</pre></details>`
    : "";

  const context =
    row.context !== null && row.context !== undefined
      ? `<details class="sub"><summary>What it was responding to</summary><pre>${escapeHtml(JSON.stringify(row.context, null, 2))}</pre></details>`
      : "";

  return `<details class="entry o-${row.outcome}">
  <summary>
    <span class="bar" aria-hidden="true"></span>
    <time datetime="${escapeHtml(row.at)}">${escapeHtml(row.at.slice(0, 16).replace("T", " "))} UTC</time>
    <span class="pill o-${row.outcome}">${OUTCOME_LABEL[row.outcome] ?? escapeHtml(row.outcome)}</span>
    <span class="trigger">${escapeHtml(row.trigger)}</span>
    <span class="where"><span class="src">${escapeHtml(SOURCE_LABEL[row.source] ?? row.source)} · ${escapeHtml(STEP_LABEL[row.step] ?? row.step)}</span>${row.destination ? ` → ${escapeHtml(row.destination)}` : ""}</span>
  </summary>
  <div class="body">
    ${said}
    ${reason}
    ${meta(row)}
    ${tools(row)}
    ${raw}
    ${context}
  </div>
</details>`;
}

export function renderOutboxPage(state: PageState, nonce: string): string {
  const { rows } = state;

  const sourceChips = [
    chip("All", href(state, { source: undefined }), !state.source),
    ...SOURCES.map((s) =>
      chip(SOURCE_LABEL[s], href(state, { source: s }), state.source === s)
    )
  ].join("");
  const outcomeChips = [
    chip("Any outcome", href(state, { outcome: undefined }), !state.outcome),
    ...OUTCOMES.map((o) =>
      chip(OUTCOME_LABEL[o], href(state, { outcome: o }), state.outcome === o)
    )
  ].join("");

  const list = !state.configured
    ? `<p class="empty">No outbox database is bound, so nothing is being recorded. Add the <code>DB</code> D1 binding and apply <code>migrations/</code>.</p>`
    : rows.length === 0
      ? `<p class="empty">${state.source || state.outcome ? "Nothing matches those filters." : "Nothing sent yet. Entries appear here as thinkbot posts, or decides not to."}</p>`
      : rows.map(entry).join("\n");

  const more =
    state.next !== null
      ? `<a class="more" href="${escapeHtml(href(state, { before: state.next }))}">Older entries →</a>`
      : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>thinkbot outbox</title>
<style nonce="${nonce}">
:root {
  --bg: #f6f7f9; --surface: #fff; --surface-2: #f0f2f5;
  --ink: #0f1720; --ink-2: #3d4854; --muted: #5c6878;
  --line: #e3e7ec; --line-2: #cfd6de;
  --ok: #1f9d62; --ok-bg: #e6f4ed; --warn: #b77b0b; --warn-bg: #fbf1de;
  --down: #ce3b33; --down-bg: #fbeae9; --idle: #6b7686; --idle-bg: #eef0f3;
  --accent: #4c5fd7; --accent-bg: #eceffc;
  --mono: ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace;
  --sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, system-ui, sans-serif;
  color-scheme: light dark;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0f141b; --surface: #171e28; --surface-2: #1e2733;
    --ink: #e4e9f0; --ink-2: #b3bdca; --muted: #8b97a8;
    --line: #232c38; --line-2: #313d4c;
    --ok: #35c285; --ok-bg: #12291f; --warn: #e0a028; --warn-bg: #2b2213;
    --down: #f2635a; --down-bg: #2e1917; --idle: #8b97a8; --idle-bg: #1f262f;
    --accent: #7c8cf0; --accent-bg: #1a2035;
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink); font: 14px/1.5 var(--sans); -webkit-font-smoothing: antialiased; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 3px; }
header { position: sticky; top: 0; z-index: 2; display: flex; align-items: center; gap: 16px; padding: 0 20px; height: 52px; background: var(--surface); border-bottom: 1px solid var(--line); }
.wordmark { font: 600 13px var(--mono); }
.wordmark span { color: var(--muted); font-weight: 400; }
.viewer { margin-left: auto; font: 11.5px var(--mono); color: var(--muted); }
main { max-width: 1080px; margin: 0 auto; padding: 20px 16px 48px; }
.intro { color: var(--ink-2); margin: 0 0 16px; max-width: 70ch; }
.filters { display: flex; flex-direction: column; gap: 8px; margin-bottom: 16px; }
.chips { display: flex; flex-wrap: wrap; gap: 6px; }
.chip { font-size: 12.5px; padding: 4px 10px; border-radius: 99px; border: 1px solid var(--line-2); background: var(--surface); color: var(--ink-2); text-decoration: none; }
.chip:hover { background: var(--surface-2); }
.chip[aria-current] { background: var(--accent-bg); border-color: var(--accent); color: var(--ink); }
.entry { background: var(--surface); border: 1px solid var(--line); border-radius: 6px; margin-bottom: 8px; overflow: hidden; }
.entry > summary { list-style: none; cursor: pointer; display: grid; grid-template-columns: 4px 150px 120px 1fr; grid-template-areas: "bar time pill trigger" "bar time pill where"; column-gap: 12px; align-items: baseline; padding: 10px 14px 10px 0; }
.entry > summary::-webkit-details-marker { display: none; }
.entry > summary:hover { background: var(--surface-2); }
.bar { grid-area: bar; align-self: stretch; margin: -10px 0; background: var(--idle); }
.o-posted .bar { background: var(--ok); } .o-failed .bar { background: var(--down); } .o-silent .bar { background: var(--idle); } .o-logged .bar { background: var(--warn); }
time { grid-area: time; font: 12px var(--mono); color: var(--muted); white-space: nowrap; }
.pill { grid-area: pill; justify-self: start; font-size: 11.5px; font-weight: 600; padding: 1px 8px; border-radius: 99px; white-space: nowrap; }
.pill.o-posted { background: var(--ok-bg); color: var(--ok); } .pill.o-failed { background: var(--down-bg); color: var(--down); }
.pill.o-silent { background: var(--idle-bg); color: var(--idle); } .pill.o-logged { background: var(--warn-bg); color: var(--warn); }
.trigger { grid-area: trigger; font-weight: 600; overflow-wrap: anywhere; }
.where { grid-area: where; font-size: 12.5px; color: var(--muted); overflow-wrap: anywhere; }
.body { padding: 4px 18px 16px 18px; border-top: 1px solid var(--line); }
h3 { font: 600 10.5px var(--mono); letter-spacing: .07em; text-transform: uppercase; color: var(--muted); margin: 14px 0 6px; }
.said { white-space: pre-wrap; overflow-wrap: anywhere; background: var(--surface-2); border-left: 3px solid var(--line-2); padding: 10px 12px; border-radius: 0 4px 4px 0; }
.o-posted .said { border-left-color: var(--ok); }
.none { color: var(--muted); font-style: italic; margin: 0; }
.reason { margin: 0; color: var(--ink-2); overflow-wrap: anywhere; }
.o-failed .reason { color: var(--down); }
.meta { margin-top: 12px; font: 12px var(--mono); color: var(--muted); }
.meta b { color: var(--ink-2); font-weight: 500; }
.tools { margin-top: 8px; display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.tools .k { font: 12px var(--mono); color: var(--muted); margin-right: 2px; }
code { font: 12px var(--mono); background: var(--surface-2); border: 1px solid var(--line); padding: 0 5px; border-radius: 3px; }
details.sub { margin-top: 10px; }
details.sub > summary { cursor: pointer; font-size: 12.5px; color: var(--accent); }
pre { font: 12px/1.45 var(--mono); background: var(--surface-2); border: 1px solid var(--line); border-radius: 4px; padding: 10px; overflow: auto; max-height: 420px; white-space: pre-wrap; overflow-wrap: anywhere; }
.empty { color: var(--muted); padding: 32px 0; text-align: center; }
.more { display: inline-block; margin-top: 8px; color: var(--accent); }
@media (max-width: 720px) {
  .entry > summary { grid-template-columns: 4px 1fr auto; grid-template-areas: "bar time pill" "bar trigger trigger" "bar where where"; row-gap: 4px; }
}
</style>
</head>
<body>
<header>
  <div class="wordmark">thinkbot <span>/ outbox</span></div>
  ${state.viewer ? `<div class="viewer">${escapeHtml(state.viewer)}</div>` : ""}
</header>
<main>
  <p class="intro">Every message thinkbot sent, where it went and what it said, including the triage turns where it decided to stay silent. Kept for 30 days. Open an entry for the raw model output and the alert it was answering.</p>
  <nav class="filters" aria-label="Filters">
    <div class="chips" role="group" aria-label="Source">${sourceChips}</div>
    <div class="chips" role="group" aria-label="Outcome">${outcomeChips}</div>
  </nav>
  ${list}
  ${more}
</main>
<script nonce="${nonce}">
for (const el of document.querySelectorAll("time[datetime]")) {
  const d = new Date(el.getAttribute("datetime"));
  if (!isNaN(d)) {
    el.textContent = d.toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
    el.title = d.toISOString();
  }
}
</script>
</body>
</html>`;
}
