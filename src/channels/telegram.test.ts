import { describe, it, expect } from "vitest";
import {
  parseTelegramUpdate,
  verifyTelegramRequest,
  telegramConfigured
} from "./telegram";

function envWith(overrides: Record<string, string | undefined> = {}) {
  return {
    TELEGRAM_BOT_TOKEN: "bot-token",
    TELEGRAM_WEBHOOK_SECRET: "webhook-secret",
    ...overrides
  } as unknown as Env;
}

function update(text = "hello", chatId = 12345) {
  return {
    message: {
      message_id: 1,
      chat: { id: chatId, type: "private" },
      from: { id: 999, username: "isaac" },
      text
    }
  };
}

describe("telegramConfigured", () => {
  it("needs both the token and the webhook secret", () => {
    expect(telegramConfigured(envWith())).toBe(true);
    expect(
      telegramConfigured(envWith({ TELEGRAM_WEBHOOK_SECRET: undefined }))
    ).toBe(false);
    expect(telegramConfigured(envWith({ TELEGRAM_BOT_TOKEN: undefined }))).toBe(
      false
    );
  });
});

describe("verifyTelegramRequest", () => {
  function request(secret?: string) {
    return new Request("https://example.test/hooks/telegram", {
      method: "POST",
      headers: secret ? { "X-Telegram-Bot-Api-Secret-Token": secret } : {}
    });
  }

  it("accepts the registered secret", () => {
    expect(verifyTelegramRequest(request("webhook-secret"), envWith())).toBe(
      true
    );
  });

  it("rejects a wrong secret", () => {
    expect(verifyTelegramRequest(request("guessed"), envWith())).toBe(false);
  });

  it("rejects a request with no header at all", () => {
    // Anyone can POST to a public Worker; without this the endpoint is open.
    expect(verifyTelegramRequest(request(), envWith())).toBe(false);
  });
});

describe("parseTelegramUpdate", () => {
  it("extracts text and a per-chat session", () => {
    const inbound = parseTelegramUpdate(update("is anything down?"), envWith());
    expect(inbound?.text).toBe("is anything down?");
    expect(inbound?.sessionId).toBe("telegram:12345");
  });

  /** The target is what travels through the queue, so assert on it directly. */
  it("addresses the answer to the chat that asked", () => {
    const inbound = parseTelegramUpdate(update("is anything down?"), envWith());
    expect(inbound?.target).toEqual({ channel: "telegram", chatId: "12345" });
  });

  it("ignores an update with no text", () => {
    expect(parseTelegramUpdate({ message: undefined }, envWith())).toBeNull();
    expect(
      parseTelegramUpdate(
        { message: { message_id: 1, chat: { id: 1, type: "private" } } },
        envWith()
      )
    ).toBeNull();
  });

  it("serves every chat when no allow-list is set", () => {
    expect(parseTelegramUpdate(update("hi", 999), envWith())).not.toBeNull();
  });

  it("serves only allow-listed chats when one is set", () => {
    const env = envWith({ TELEGRAM_ALLOWED_CHATS: "12345, 67890" });
    expect(parseTelegramUpdate(update("hi", 12345), env)).not.toBeNull();
    expect(parseTelegramUpdate(update("hi", 67890), env)).not.toBeNull();
    // Anyone who finds the bot could otherwise run tools with it.
    expect(parseTelegramUpdate(update("hi", 11111), env)).toBeNull();
  });
});
