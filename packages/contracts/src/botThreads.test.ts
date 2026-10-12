import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { BotName, botThreadId, threadBotName } from "./botThreads.ts";

describe("bot thread ids", () => {
  it("round-trips the bot name through a launched thread id", () => {
    expect(threadBotName(botThreadId("warden", "cmd-1"))).toBe("warden");
    expect(threadBotName(botThreadId("ledger-2", "a:b:fork"))).toBe("ledger-2");
  });

  it("does not mark ordinary or malformed ids", () => {
    for (const id of [
      "cmd-1",
      "home-launched:cmd-1",
      "bot:",
      "bot:warden",
      "bot:warden:",
      "bot::cmd-1",
      "bot:Warden:cmd-1",
      "bot:-warden:cmd-1",
      `bot:${"a".repeat(33)}:cmd-1`,
    ]) {
      expect(threadBotName(id)).toBeNull();
    }
  });

  it("accepts only names a thread id can carry", () => {
    const valid = Schema.is(BotName);
    expect(valid("warden")).toBe(true);
    expect(valid("a")).toBe(true);
    expect(valid("bot:warden")).toBe(false);
    expect(valid("")).toBe(false);
  });
});
