import type { LunaSnapshot } from "./lunaHostApi";

/**
 * Last known snapshot per opened response, kept for the life of the app run.
 * Reopening the sidecar for the same response renders from here at once and
 * refreshes in the background, instead of showing "Opening Luna" again. The
 * host remains the source of truth; this only removes the wait.
 */
const MAX_SESSIONS = 8;
const snapshots = new Map<string, LunaSnapshot>();

export function sessionCacheKey(input: {
  readonly environmentId: string;
  readonly threadId: string;
  readonly messageId: string;
  readonly hostUrl: string;
}): string {
  return `${input.environmentId}:${input.threadId}:${input.messageId}:${input.hostUrl}`;
}

export function readCachedSession(key: string): LunaSnapshot | null {
  return snapshots.get(key) ?? null;
}

export function writeCachedSession(key: string, snapshot: LunaSnapshot): void {
  snapshots.delete(key);
  snapshots.set(key, snapshot);
  while (snapshots.size > MAX_SESSIONS) {
    const oldest = snapshots.keys().next().value;
    if (oldest === undefined) break;
    snapshots.delete(oldest);
  }
}

export function forgetCachedSession(key: string): void {
  snapshots.delete(key);
}
