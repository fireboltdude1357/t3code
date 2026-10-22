import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { ThreadId } from "./baseSchemas.ts";
import {
  VoiceMcpAgendaResult,
  VoiceMcpNoticesResult,
  VoiceMcpTopicOpenResult,
} from "./voiceMcp.ts";
import { VoiceAgendaItem, VoiceNotice } from "./voiceSession.ts";

const openedAtIso = "2026-09-30T12:00:00.123Z";
const closedAtIso = "2026-09-30T12:30:00.456Z";
const openedAt = DateTime.makeUnsafe(openedAtIso);
const closedAt = DateTime.makeUnsafe(closedAtIso);

const encodeNotices = Schema.encodeUnknownSync(VoiceMcpNoticesResult);
const decodeNotices = Schema.decodeUnknownSync(VoiceMcpNoticesResult);
const encodeAgenda = Schema.encodeUnknownSync(VoiceMcpAgendaResult);
const decodeAgenda = Schema.decodeUnknownSync(VoiceMcpAgendaResult);
const encodeTopic = Schema.encodeUnknownSync(VoiceMcpTopicOpenResult);
const decodeTopic = Schema.decodeUnknownSync(VoiceMcpTopicOpenResult);

describe("voice MCP date results", () => {
  it("encodes nonempty notices as JSON with ISO dates and decodes domain dates", () => {
    const notice = VoiceNotice.make({
      id: "notice-1",
      kind: "completed",
      threadId: ThreadId.make("thread-1"),
      threadTitle: "Fix voice dates",
      text: "The date fix is ready.",
      createdAt: openedAt,
    });
    const result = { notices: [notice] } satisfies VoiceMcpNoticesResult;
    const expected = { notices: [{ ...notice, createdAt: openedAtIso }] };

    const encoded = encodeNotices(result);

    expect(encoded).toEqual(expected);
    expect(JSON.stringify(encoded)).toBe(JSON.stringify(expected));
    expect(decodeNotices(encoded)).toEqual(result);
    expect(DateTime.isUtc(notice.createdAt)).toBe(true);
  });

  it.each(["open", "closed"] as const)(
    "encodes %s agenda items as JSON with ISO dates and decodes domain dates",
    (status) => {
      const item = VoiceAgendaItem.make({
        id: "agenda-1",
        kind: "thread",
        threadId: ThreadId.make("thread-1"),
        title: "Follow up on the fix",
        detail: "Check the result.",
        status,
        openedAt,
        closedAt: status === "closed" ? closedAt : null,
      });
      const result = { items: [item] } satisfies VoiceMcpAgendaResult;
      const expected = {
        items: [
          { ...item, openedAt: openedAtIso, closedAt: status === "closed" ? closedAtIso : null },
        ],
      };

      const encoded = encodeAgenda(result);

      expect(encoded).toEqual(expected);
      expect(JSON.stringify(encoded)).toBe(JSON.stringify(expected));
      expect(decodeAgenda(encoded)).toEqual(result);
      expect(DateTime.isUtc(item.openedAt)).toBe(true);
      if (item.closedAt !== null) expect(DateTime.isUtc(item.closedAt)).toBe(true);
    },
  );

  it("encodes an opened topic as JSON with an ISO date and preserves its domain date", () => {
    const item = VoiceAgendaItem.make({
      id: "topic-1",
      kind: "topic",
      threadId: null,
      title: "Review the deployment",
      detail: "Come back to this later.",
      status: "open",
      openedAt,
      closedAt: null,
    });
    const result = { item } satisfies VoiceMcpTopicOpenResult;
    const expected = { item: { ...item, openedAt: openedAtIso, closedAt: null } };

    const encoded = encodeTopic(result);

    expect(encoded).toEqual(expected);
    expect(JSON.stringify(encoded)).toBe(JSON.stringify(expected));
    expect(decodeTopic(encoded)).toEqual(result);
    expect(DateTime.isUtc(item.openedAt)).toBe(true);
  });
});
