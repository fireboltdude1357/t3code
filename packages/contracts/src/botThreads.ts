import * as Schema from "effect/Schema";

const BOT_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;

/**
 * A bot's short name, as it appears in the ids of the threads it launches and
 * in the sidebar's Bots section.
 */
export const BotName = Schema.String.check(Schema.isPattern(BOT_NAME_PATTERN)).annotate({
  description: "1-32 lowercase letters, digits, or dashes, starting with a letter or digit.",
});
export type BotName = typeof BotName.Type;

/**
 * Every thread a bot launches has an id that starts with this, then the bot's
 * name and another colon. The marker travels with the thread, so clients and
 * the relay keep bot work out of the inbox without any new thread state.
 */
export const BOT_THREAD_ID_PREFIX = "bot:";

/** The id for a thread `bot` launches, built from an otherwise unique id. */
export const botThreadId = (bot: BotName, id: string): string =>
  `${BOT_THREAD_ID_PREFIX}${bot}:${id}`;

/** The bot whose work a thread is: its own marker, or its lineage root's for
    a delegated child. MCP create paths use this to mark what a bot's thread
    creates. */
export const threadOwnerBotName = (thread: {
  readonly id: string;
  readonly lineage: { readonly rootThreadId: string };
}): BotName | null => threadBotName(thread.id) ?? threadBotName(thread.lineage.rootThreadId);

/** The bot that launched a thread, or null for every other thread. */
export function threadBotName(threadId: string): BotName | null {
  if (!threadId.startsWith(BOT_THREAD_ID_PREFIX)) return null;
  const end = threadId.indexOf(":", BOT_THREAD_ID_PREFIX.length);
  if (end === -1 || end === threadId.length - 1) return null;
  const name = threadId.slice(BOT_THREAD_ID_PREFIX.length, end);
  return BOT_NAME_PATTERN.test(name) ? name : null;
}
