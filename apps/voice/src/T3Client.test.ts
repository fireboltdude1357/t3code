import { assert, it } from "@effect/vitest";
import type {
  OrchestrationProjectShell,
  OrchestrationV2ShellStreamItem,
  OrchestrationV2ThreadShell,
  ThreadId,
} from "@t3tools/contracts";

import { applyShellItem } from "./T3Client.ts";

// Only the fields the mirror reads; the rest of a shell is irrelevant here.
const thread = (id: string, status: string, latestRunId: string | null) =>
  ({
    id,
    status,
    latestRunId,
    pendingRuntimeRequest: null,
    archivedAt: null,
  }) as unknown as OrchestrationV2ThreadShell;
const project = {
  id: "p1",
  title: "Work",
  workspaceRoot: "/w",
} as unknown as OrchestrationProjectShell;
const snapshot = (
  threads: ReadonlyArray<OrchestrationV2ThreadShell>,
  resolvedRepositoryIdentityRoots?: ReadonlyArray<string>,
) =>
  ({
    kind: "snapshot",
    snapshot: {
      schemaVersion: 1,
      snapshotSequence: 1,
      projects: [project],
      threads,
      archivedThreads: [],
    },
    ...(resolvedRepositoryIdentityRoots === undefined ? {} : { resolvedRepositoryIdentityRoots }),
  }) as unknown as OrchestrationV2ShellStreamItem;

it("an enrichment snapshot keeps the mirrored threads", () => {
  const threads = new Map<ThreadId, OrchestrationV2ThreadShell>();
  const projects = new Map<string, OrchestrationProjectShell>();
  applyShellItem(threads, projects, snapshot([thread("t1", "running", "r1")]), false);
  assert.deepStrictEqual(applyShellItem(threads, projects, snapshot([], ["/w"]), true), []);
  assert.strictEqual(threads.size, 1);
  assert.strictEqual(projects.size, 1);
});

it("a reconnect reports threads that moved while away, and nothing on first connect", () => {
  const threads = new Map<ThreadId, OrchestrationV2ThreadShell>();
  const projects = new Map<string, OrchestrationProjectShell>();
  const first = applyShellItem(
    threads,
    projects,
    snapshot([thread("t1", "running", "r1"), thread("t2", "idle", null)]),
    false,
  );
  assert.deepStrictEqual(first, []);
  const changes = applyShellItem(
    threads,
    projects,
    snapshot([
      thread("t1", "completed", "r1"),
      thread("t2", "idle", null),
      thread("t3", "running", "r3"),
    ]),
    true,
  );
  assert.deepStrictEqual(
    changes.map((change): ReadonlyArray<string | undefined> => [
      change.thread.id,
      change.previous?.status,
      change.thread.status,
    ]),
    [["t1", "running", "completed"]],
  );
});
