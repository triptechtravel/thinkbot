/**
 * Shared helpers for correlation tools.
 *
 * Two rules every tool here follows:
 *
 *   1. Fetch a small window, never a dump. Everything returned is paid for in
 *      context on every subsequent turn of the conversation.
 *   2. A missing credential is a message, not a crash. A half-configured
 *      deployment should still answer the questions it can.
 */

export class NotConfiguredError extends Error {
  constructor(what: string, secret: string) {
    super(`${what} is not configured — set the ${secret} secret.`);
    this.name = 'NotConfiguredError';
  }
}

export async function fetchJson<T>(
  url: string,
  init: RequestInit,
  label: string,
): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`${label} returned ${response.status}${body ? `: ${body.slice(0, 200)}` : ''}`);
  }
  return (await response.json()) as T;
}

/** ISO timestamp `minutes` ago — the usual shape of a correlation window. */
export function since(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

/** Trim free text so one verbose message cannot dominate the context. */
export function clip(text: string | null | undefined, max = 180): string {
  if (!text) return '';
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
