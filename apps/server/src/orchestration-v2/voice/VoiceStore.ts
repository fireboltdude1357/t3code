import { VoiceAgendaItem, VoiceNotice, type ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/** One final transcript part from a realtime session. */
export interface VoiceTranscriptEntry {
  readonly generation: number;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly at: DateTime.Utc;
}

/**
 * The voice orchestrator's memory: SQLite that code owns. It is not thread
 * history, so it lives in plain tables (migration 057), not domain events.
 * Every session generation reads its briefing from here, so a rotation or
 * reconnect loses nothing that matters.
 */
export interface VoiceStoreShape {
  /** Next generation number, persisted so it keeps increasing across restarts. */
  readonly nextGeneration: Effect.Effect<number>;

  /** Opens or refreshes the agenda item for a thread (one open item per thread). */
  readonly openThreadItem: (input: {
    readonly threadId: ThreadId;
    readonly title: string;
    readonly detail: string;
  }) => Effect.Effect<VoiceAgendaItem>;
  readonly closeThreadItem: (threadId: ThreadId) => Effect.Effect<void>;
  readonly openTopic: (input: {
    readonly title: string;
    readonly detail: string;
  }) => Effect.Effect<VoiceAgendaItem>;
  /** Closes any item by id. False when it does not exist or is already closed. */
  readonly closeItem: (id: string) => Effect.Effect<boolean>;
  readonly listAgenda: (input?: {
    readonly status?: VoiceAgendaItem["status"];
  }) => Effect.Effect<ReadonlyArray<VoiceAgendaItem>>;

  /**
   * Records a notice unless `dedupeKey` was already recorded. Returns whether
   * it was new, so the same run event is never announced twice.
   */
  readonly recordNotice: (
    notice: VoiceNotice & { readonly dedupeKey: string },
  ) => Effect.Effect<boolean>;
  readonly markDelivered: (noticeIds: ReadonlyArray<string>) => Effect.Effect<void>;
  /** Oldest first. */
  readonly undeliveredNotices: (limit: number) => Effect.Effect<ReadonlyArray<VoiceNotice>>;
  /** Newest first. */
  readonly recentNotices: (limit: number) => Effect.Effect<ReadonlyArray<VoiceNotice>>;

  readonly appendTranscript: (entry: VoiceTranscriptEntry) => Effect.Effect<void>;
  /** Oldest first, the last `limit` entries across generations. */
  readonly recentTranscript: (limit: number) => Effect.Effect<ReadonlyArray<VoiceTranscriptEntry>>;
}

export class VoiceStore extends Context.Service<VoiceStore, VoiceStoreShape>()(
  "t3/orchestration-v2/voice/VoiceStore",
) {}

const decodeAgenda = Schema.decodeUnknownEffect(
  Schema.Array(
    VoiceAgendaItem.mapFields((fields) => ({
      ...fields,
      openedAt: Schema.DateTimeUtcFromString,
      closedAt: Schema.NullOr(Schema.DateTimeUtcFromString),
    })),
  ),
);
const decodeNotices = Schema.decodeUnknownEffect(
  Schema.Array(
    VoiceNotice.mapFields((fields) => ({ ...fields, createdAt: Schema.DateTimeUtcFromString })),
  ),
);
const decodeTranscript = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.Struct({
      generation: Schema.Number,
      role: Schema.Literals(["user", "assistant"]),
      text: Schema.String,
      at: Schema.DateTimeUtcFromString,
    }),
  ),
);

const iso = (value: DateTime.DateTime) => DateTime.formatIso(DateTime.toUtc(value));

/** Single orchestrator per server, so the generation counter has one row. */
const SESSION_KEY = "orchestrator";

/**
 * SQLite-backed store. Storage failures are defects: the orchestrator cannot
 * do anything useful without its memory, and the interface has no error channel.
 */
export const layer = Layer.effect(
  VoiceStore,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const crypto = yield* Crypto.Crypto;

    const newId = (prefix: string) =>
      crypto.randomUUIDv4.pipe(Effect.map((uuid) => `${prefix}:${uuid}`));

    const agendaColumns = sql.literal(`
      item_id AS id, kind, thread_id AS threadId, title, detail, status,
      opened_at AS openedAt, closed_at AS closedAt
    `);
    const noticeColumns = sql.literal(`
      notice_id AS id, kind, thread_id AS threadId, thread_title AS threadTitle, text,
      created_at AS createdAt
    `);

    const firstAgendaItem = (rows: ReadonlyArray<unknown>) =>
      decodeAgenda(rows).pipe(
        Effect.flatMap((items) =>
          items[0] === undefined
            ? Effect.die(new Error("Voice agenda write returned no row."))
            : Effect.succeed(items[0]),
        ),
      );

    const nextGeneration = Effect.gen(function* () {
      const now = iso(yield* DateTime.now);
      const rows = yield* sql<{ readonly generation: number }>`
        INSERT INTO voice_sessions (session_key, generation, updated_at)
        VALUES (${SESSION_KEY}, 1, ${now})
        ON CONFLICT(session_key) DO UPDATE SET
          generation = generation + 1,
          updated_at = excluded.updated_at
        RETURNING generation
      `;
      const generation = rows[0]?.generation;
      return generation === undefined
        ? yield* Effect.die(new Error("Voice generation counter returned no row."))
        : generation;
    }).pipe(Effect.orDie);

    const openThreadItem: VoiceStoreShape["openThreadItem"] = (input) =>
      Effect.gen(function* () {
        const id = yield* newId("voice-agenda");
        const now = iso(yield* DateTime.now);
        const rows = yield* sql`
          INSERT INTO voice_agenda (item_id, kind, thread_id, title, detail, status, opened_at, closed_at)
          VALUES (${id}, 'thread', ${input.threadId}, ${input.title}, ${input.detail}, 'open', ${now}, NULL)
          ON CONFLICT(thread_id) WHERE status = 'open' AND thread_id IS NOT NULL
          DO UPDATE SET title = excluded.title, detail = excluded.detail
          RETURNING ${agendaColumns}
        `;
        return yield* firstAgendaItem(rows);
      }).pipe(Effect.orDie);

    const closeThreadItem: VoiceStoreShape["closeThreadItem"] = (threadId) =>
      Effect.gen(function* () {
        const now = iso(yield* DateTime.now);
        yield* sql`
          UPDATE voice_agenda SET status = 'closed', closed_at = ${now}
          WHERE thread_id = ${threadId} AND status = 'open'
        `;
      }).pipe(Effect.orDie);

    const openTopic: VoiceStoreShape["openTopic"] = (input) =>
      Effect.gen(function* () {
        const id = yield* newId("voice-topic");
        const now = iso(yield* DateTime.now);
        const rows = yield* sql`
          INSERT INTO voice_agenda (item_id, kind, thread_id, title, detail, status, opened_at, closed_at)
          VALUES (${id}, 'topic', NULL, ${input.title}, ${input.detail}, 'open', ${now}, NULL)
          RETURNING ${agendaColumns}
        `;
        return yield* firstAgendaItem(rows);
      }).pipe(Effect.orDie);

    const closeItem: VoiceStoreShape["closeItem"] = (id) =>
      Effect.gen(function* () {
        const now = iso(yield* DateTime.now);
        const rows = yield* sql<{ readonly id: string }>`
          UPDATE voice_agenda SET status = 'closed', closed_at = ${now}
          WHERE item_id = ${id} AND status = 'open'
          RETURNING item_id AS id
        `;
        return rows.length > 0;
      }).pipe(Effect.orDie);

    // Oldest first, so the briefing reads the agenda in the order it grew.
    const listAgenda: VoiceStoreShape["listAgenda"] = (input) =>
      (input?.status === undefined
        ? sql`SELECT ${agendaColumns} FROM voice_agenda ORDER BY opened_at ASC, item_id ASC`
        : sql`
            SELECT ${agendaColumns} FROM voice_agenda
            WHERE status = ${input.status}
            ORDER BY opened_at ASC, item_id ASC
          `
      ).pipe(Effect.flatMap(decodeAgenda), Effect.orDie);

    const recordNotice: VoiceStoreShape["recordNotice"] = (notice) =>
      sql`
        INSERT INTO voice_notice_ledger
          (notice_id, dedupe_key, kind, thread_id, thread_title, text, created_at, delivered_at)
        VALUES (${notice.id}, ${notice.dedupeKey}, ${notice.kind}, ${notice.threadId},
          ${notice.threadTitle}, ${notice.text}, ${iso(notice.createdAt)}, NULL)
        ON CONFLICT(dedupe_key) DO NOTHING
        RETURNING notice_id
      `.pipe(
        Effect.map((rows) => rows.length > 0),
        Effect.orDie,
      );

    const markDelivered: VoiceStoreShape["markDelivered"] = (noticeIds) =>
      noticeIds.length === 0
        ? Effect.void
        : Effect.gen(function* () {
            const now = iso(yield* DateTime.now);
            yield* sql`
              UPDATE voice_notice_ledger SET delivered_at = ${now}
              WHERE delivered_at IS NULL AND notice_id IN ${sql.in(noticeIds)}
            `;
          }).pipe(Effect.orDie);

    const undeliveredNotices: VoiceStoreShape["undeliveredNotices"] = (limit) =>
      sql`
        SELECT ${noticeColumns} FROM voice_notice_ledger
        WHERE delivered_at IS NULL
        ORDER BY created_at ASC, notice_id ASC
        LIMIT ${limit}
      `.pipe(Effect.flatMap(decodeNotices), Effect.orDie);

    const recentNotices: VoiceStoreShape["recentNotices"] = (limit) =>
      sql`
        SELECT ${noticeColumns} FROM voice_notice_ledger
        ORDER BY created_at DESC, notice_id DESC
        LIMIT ${limit}
      `.pipe(Effect.flatMap(decodeNotices), Effect.orDie);

    const appendTranscript: VoiceStoreShape["appendTranscript"] = (entry) =>
      sql`
        INSERT INTO voice_transcript (generation, role, text, at)
        VALUES (${entry.generation}, ${entry.role}, ${entry.text}, ${iso(entry.at)})
      `.pipe(Effect.asVoid, Effect.orDie);

    const recentTranscript: VoiceStoreShape["recentTranscript"] = (limit) =>
      sql`
        SELECT generation, role, text, at FROM (
          SELECT entry_id, generation, role, text, at FROM voice_transcript
          ORDER BY entry_id DESC
          LIMIT ${limit}
        )
        ORDER BY entry_id ASC
      `.pipe(Effect.flatMap(decodeTranscript), Effect.orDie);

    return VoiceStore.of({
      nextGeneration,
      openThreadItem,
      closeThreadItem,
      openTopic,
      closeItem,
      listAgenda,
      recordNotice,
      markDelivered,
      undeliveredNotices,
      recentNotices,
      appendTranscript,
      recentTranscript,
    });
  }),
);
