/**
 * What a model turn produced, judged fit to post — or not.
 *
 * Triage text goes to Slack unread by anyone. That is the whole point: nobody
 * is watching the channel at 06:00 UTC, which is why the paragraph has to
 * stand on its own. It also means nothing sits between `generateText` and the
 * channel, so whatever the model emits is what the team reads under an
 * incident.
 *
 * On 2026-08-22 that was 256 exclamation marks. `!` is token 0 in most
 * tokenizers, so a generation that collapses emits exactly that, and the only
 * checks in front of it were "is the string empty" and "is it the word
 * NOTHING". The wall posted under a real headline about three failing specs,
 * where it read as the alert itself having broken.
 *
 * These are property checks, not quality checks. No rule here can tell a
 * correct diagnosis from a confident wrong one — that is what the fixtures in
 * the integration suite are for. What they can do is recognise output that is
 * not prose at all, and prefer silence to it: the headline has already been
 * posted, so a dropped finding costs a paragraph, while a dropped guard costs
 * the reader's trust in the whole channel.
 */

/**
 * Below this, it is not the paragraph the prompt asked for. The headline
 * already says what failed, so a fragment adds nothing that survives being
 * wrong. `NOTHING` is handled before this and is not measured against it.
 */
const MIN_CHARS = 24;

/**
 * No single character carries this much of a real sentence. English prose sits
 * near 15% on the space character and lower on everything else; the failure
 * this catches sits at 100%. Deliberately loose — the job is to separate prose
 * from a collapsed generation, not to police style.
 */
const MAX_CHAR_SHARE = 0.4;

/**
 * Letters, as a share of everything. A finding full of PR numbers, ratios and
 * URLs still clears this comfortably; a wall of punctuation cannot reach it.
 * Counted with a Unicode property so a non-Latin answer is not judged empty.
 */
const MIN_LETTER_SHARE = 0.35;

/** The bare word the prompt asks for when triage found nothing worth saying. */
const NOTHING = /^nothing[.!]?$/i;

/**
 * The final channel of a harmony response, where the whole envelope survives.
 *
 * gpt-oss emits its planning on an `analysis` channel and its answer on
 * `final`. When the provider passes the envelope through intact, taking the
 * final channel is not a heuristic — it is reading the format as specified,
 * and it discards the analysis exactly and completely.
 */
const HARMONY_FINAL =
  /<\|channel\|>final<\|message\|>([\s\S]*?)(?:<\|(?:return|end)\|>|$)/;

/**
 * A channel or role header, marker and label together.
 *
 * `<|channel|>final<|message|>` is one header, not a marker with the word
 * `final` inside it, so removing only the delimiters leaves `final` glued to
 * the front of the answer. Bounded to a short label so this can never eat
 * prose that happens to follow an unpaired marker.
 */
const HARMONY_HEADER = /<\|(?:start|channel|constrain)\|>[^<|]{0,32}(?=<\|)/g;

/**
 * Whatever markers are left once the headers are gone.
 *
 * The provider is supposed to split the analysis channel out of the final
 * text; when it does not, the model's own planning arrives as the first line
 * of the Slack message — the deployment posted `We need to fetch PR details.`
 * above an otherwise sound paragraph. These patterns are exact where the
 * markers survive; `LEADING_PLAN` covers the case where only the prose does.
 */
const HARMONY = /<\|(?:start|end|channel|message|return|constrain)\|>/g;

/** Reduce a harmony envelope to the answer it carries. */
function unwrapHarmony(raw: string): string {
  const final = HARMONY_FINAL.exec(raw);
  const text = final ? final[1] : raw;
  return text.replace(HARMONY_HEADER, "").replace(HARMONY, "");
}

/**
 * A first line that is the model talking to itself about what to do next.
 *
 * Narrow on purpose, because a false positive silently removes real content:
 * it must be first-person, forward-looking, short, and followed by something
 * else. A finding that genuinely opens `We need to roll back #1246` is a
 * recommendation about the estate rather than about the turn — hence the
 * verbs, which name the model's own next action.
 */
const LEADING_PLAN =
  /^(?:we|i|let(?:'|’)s)\s+(?:need to|should|must|will|can|could|might|have to)\s+(?:fetch|check|look|call|query|inspect|search|get|find|review|examine|use|start|begin|first|see)\b[^\n]{0,120}\n+/i;

/** The largest share any one character holds of the string. */
function peakCharShare(text: string): number {
  const counts = new Map<string, number>();
  for (const char of text) counts.set(char, (counts.get(char) ?? 0) + 1);

  let peak = 0;
  for (const count of counts.values()) peak = Math.max(peak, count);
  return peak / [...text].length;
}

/** Letters as a share of the string, Unicode-aware. */
function letterShare(text: string): number {
  const characters = [...text];
  if (characters.length === 0) return 0;
  return characters.filter((c) => /\p{L}/u.test(c)).length / characters.length;
}

/**
 * Whether the text stops where a sentence stops.
 *
 * Not grounds for dropping it — a truncated paragraph still carries most of
 * its information, and throwing it away would lose more than it saves. It is
 * grounds for saying so, because the reader needs to know the sentence was cut
 * rather than that the model trailed off, and because it is the signal that
 * `maxOutputTokens` is set too low.
 */
export function looksTruncated(text: string): boolean {
  return text.length > 0 && !/[.!?)\]"'”’]$/.test(text.trim());
}

export interface FindingVerdict {
  /** Text fit to post; empty when nothing should be. */
  text: string;
  /** Why it was dropped or altered, for the log. Absent when it passed clean. */
  reason?: string;
}

/**
 * Judge one turn's output and return what should reach the channel.
 *
 * Returns the text unchanged in the ordinary case. Returns an empty string —
 * silence — when the output is not prose, when it is the agreed `NOTHING`, or
 * when it is too short to be the paragraph that was asked for. Truncation is
 * marked rather than suppressed.
 */
export function usableFinding(raw: string): FindingVerdict {
  // Harmony first: the markers inflate the length and skew both shares, so a
  // leaked control token could otherwise carry a fragment past MIN_CHARS.
  let text = unwrapHarmony(raw).trim();

  if (!text) return { text: "", reason: "empty" };
  if (NOTHING.test(text)) return { text: "", reason: "nothing" };

  const stripped = text.replace(LEADING_PLAN, "").trim();
  const leaked = stripped !== text && stripped.length > 0;
  if (leaked) text = stripped;

  // Order matters: shape before size. A collapsed generation is often long,
  // and reporting it as "too short" would send the next reader looking at the
  // token limit instead of at the model.
  if (peakCharShare(text) > MAX_CHAR_SHARE) {
    return { text: "", reason: "degenerate: one character dominates" };
  }
  if (letterShare(text) < MIN_LETTER_SHARE) {
    return { text: "", reason: "degenerate: not enough letters" };
  }
  if (text.length < MIN_CHARS) {
    return { text: "", reason: `too short (${text.length} chars)` };
  }

  if (looksTruncated(text)) {
    return {
      text: `${text} […cut off]`,
      reason: "truncated mid-sentence"
    };
  }

  return leaked ? { text, reason: "stripped a leaked plan line" } : { text };
}
