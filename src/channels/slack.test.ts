import { describe, it, expect } from 'vitest';
import { verifySlackSignature, parseSlackEvent, isUrlVerification } from './slack';

const SECRET = 'slack-signing-secret';
const NOW = Date.parse('2026-07-27T13:00:00.000Z');

async function sign(body: string, timestamp: string, secret = SECRET): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret) as Uint8Array<ArrayBuffer>,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`v0:${timestamp}:${body}`) as Uint8Array<ArrayBuffer>,
  );
  const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `v0=${hex}`;
}

const env = {
  SLACK_BOT_TOKEN: 'xoxb-test',
  SLACK_SIGNING_SECRET: SECRET,
} as unknown as Env;

describe('verifySlackSignature', () => {
  const body = '{"type":"event_callback"}';
  const ts = String(Math.floor(NOW / 1000));

  it('accepts a correctly signed request', async () => {
    expect(
      await verifySlackSignature({
        signingSecret: SECRET,
        body,
        signature: await sign(body, ts),
        timestamp: ts,
        now: NOW,
      }),
    ).toBe(true);
  });

  it('rejects a wrong secret', async () => {
    expect(
      await verifySlackSignature({
        signingSecret: SECRET,
        body,
        signature: await sign(body, ts, 'other-secret'),
        timestamp: ts,
        now: NOW,
      }),
    ).toBe(false);
  });

  it('rejects a tampered body', async () => {
    expect(
      await verifySlackSignature({
        signingSecret: SECRET,
        body: '{"type":"tampered"}',
        signature: await sign(body, ts),
        timestamp: ts,
        now: NOW,
      }),
    ).toBe(false);
  });

  it('rejects a replayed request from six minutes ago', async () => {
    const old = String(Math.floor(NOW / 1000) - 360);
    expect(
      await verifySlackSignature({
        signingSecret: SECRET,
        body,
        signature: await sign(body, old),
        timestamp: old,
        now: NOW,
      }),
    ).toBe(false);
  });

  it('accepts a request from within the skew window', async () => {
    const recent = String(Math.floor(NOW / 1000) - 60);
    expect(
      await verifySlackSignature({
        signingSecret: SECRET,
        body,
        signature: await sign(body, recent),
        timestamp: recent,
        now: NOW,
      }),
    ).toBe(true);
  });

  it('rejects missing headers', async () => {
    expect(
      await verifySlackSignature({
        signingSecret: SECRET,
        body,
        signature: null,
        timestamp: null,
        now: NOW,
      }),
    ).toBe(false);
  });

  it('rejects a non-numeric timestamp', async () => {
    expect(
      await verifySlackSignature({
        signingSecret: SECRET,
        body,
        signature: await sign(body, ts),
        timestamp: 'soon',
        now: NOW,
      }),
    ).toBe(false);
  });
});

describe('isUrlVerification', () => {
  it('returns the challenge for a verification request', () => {
    expect(isUrlVerification({ type: 'url_verification', challenge: 'abc123' })).toBe('abc123');
  });

  it('returns null for anything else', () => {
    expect(isUrlVerification({ type: 'event_callback' })).toBeNull();
  });
});

describe('parseSlackEvent', () => {
  const base = {
    type: 'event_callback',
    event: {
      type: 'app_mention' as const,
      text: '<@U0BOT> is anything down?',
      channel: 'C123',
      user: 'U456',
      ts: '1700000000.000100',
    },
  };

  it('extracts the text with the mention stripped', () => {
    const inbound = parseSlackEvent(base, env);
    expect(inbound?.text).toBe('is anything down?');
  });

  it('threads the reply to the prompting message', () => {
    expect(parseSlackEvent(base, env)?.sessionId).toBe('slack:C123:1700000000.000100');
  });

  it('keeps an existing thread', () => {
    const threaded = {
      ...base,
      event: { ...base.event, thread_ts: '1699999999.000001' },
    };
    expect(parseSlackEvent(threaded, env)?.sessionId).toBe('slack:C123:1699999999.000001');
  });

  it('ignores its own messages, so the bot cannot talk to itself', () => {
    const fromBot = { ...base, event: { ...base.event, bot_id: 'B999' } };
    expect(parseSlackEvent(fromBot, env)).toBeNull();
  });

  it('ignores edits and joins, which carry a subtype', () => {
    const edited = { ...base, event: { ...base.event, subtype: 'message_changed' } };
    expect(parseSlackEvent(edited, env)).toBeNull();
  });

  it('ignores a mention with no actual text', () => {
    const empty = { ...base, event: { ...base.event, text: '<@U0BOT>' } };
    expect(parseSlackEvent(empty, env)).toBeNull();
  });

  it('ignores an event type it does not handle', () => {
    const reaction = { ...base, event: { ...base.event, type: 'reaction_added' } };
    expect(parseSlackEvent(reaction, env)).toBeNull();
  });
});
