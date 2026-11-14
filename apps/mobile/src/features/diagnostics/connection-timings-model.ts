import type { ClientTimingRecord } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Tracer from "effect/Tracer";

interface PhaseSpec {
  readonly span: string;
  readonly label: string;
  readonly keep: ReadonlyArray<string>;
  /** The span succeeds whatever happened and reports its result in `connection.outcome`. */
  readonly outcomeAttribute?: boolean;
  /** Record only under this ancestor; elsewhere the span times something else. */
  readonly within?: string;
}

const PHASES = [
  {
    span: "EnvironmentSupervisor.establish",
    label: "Connect",
    keep: ["connection.route", "connection.attempt", "connection.failure.reason"],
    outcomeAttribute: true,
  },
  {
    span: "ConnectionDriver.checkRoute",
    label: "Route check",
    keep: ["connection.route.kind", "connection.route.check"],
  },
  {
    span: "clientRuntime.connection.broker.authorize",
    label: "Authorize",
    keep: ["connection.target.kind"],
  },
  { span: "environment.websocket.connect", label: "Socket connect", keep: [] },
  { span: "environment.websocket.open", label: "Socket open", keep: [] },
  {
    span: "environment.initialSync",
    label: "Initial sync",
    keep: [],
    within: "ConnectionDriver.connect",
  },
  {
    span: "clientRuntime.state.executeAuthenticatedEnvironmentHttpRequest",
    label: "HTTP request",
    keep: ["http.path"],
  },
  {
    span: "EnvironmentShellState.live",
    label: "Thread list live",
    keep: ["shell.resume", "shell.source", "shell.cached", "shell.threads", "shell.projects"],
  },
  {
    span: "EnvironmentThreadState.firstContent",
    label: "Thread first content",
    keep: ["thread.source", "thread.messages", "thread.items", "thread.id"],
  },
  {
    span: "EnvironmentThreadState.live",
    label: "Thread live",
    keep: ["thread.resume", "thread.messages", "thread.items", "thread.id"],
  },
] as const satisfies ReadonlyArray<PhaseSpec>;

type TimingPhase = (typeof PHASES)[number];

const PHASE_BY_SPAN: ReadonlyMap<string, TimingPhase> = new Map<string, TimingPhase>(
  PHASES.map((phase) => [phase.span, phase]),
);

type TimingOutcome = "ok" | "failed" | "interrupted";

const CONNECTION_OUTCOMES: Readonly<Record<string, TimingOutcome>> = {
  connected: "ok",
  failed: "failed",
  timeout: "failed",
  interrupted: "interrupted",
};

type AttributeValue = string | number | boolean;

export interface ConnectionTimingRecord {
  readonly phase: TimingPhase;
  readonly startedAtMs: number;
  readonly durationMs: number;
  readonly outcome: TimingOutcome;
  readonly failure: string | null;
  readonly environmentId: string | null;
  readonly traceId: string;
  readonly spanId: string;
  readonly attributes: ReadonlyArray<readonly [string, AttributeValue]>;
}

const ANCESTOR_LIMIT = 16;

function findAttribute(span: Tracer.Span, keys: ReadonlyArray<string>): string | null {
  let current: Tracer.AnySpan | undefined = span;
  for (let depth = 0; current?._tag === "Span" && depth < ANCESTOR_LIMIT; depth++) {
    for (const key of keys) {
      const value = current.attributes.get(key);
      if (typeof value === "string") return value;
    }
    current = Option.getOrUndefined(current.parent);
  }
  return null;
}

function hasAncestor(span: Tracer.Span, name: string): boolean {
  let current = Option.getOrUndefined(span.parent);
  for (let depth = 0; current?._tag === "Span" && depth < ANCESTOR_LIMIT; depth++) {
    if (current.name === name) return true;
    current = Option.getOrUndefined(current.parent);
  }
  return false;
}

function exitOutcome(exit: Exit.Exit<unknown, unknown>): {
  readonly outcome: TimingOutcome;
  readonly failure: string | null;
} {
  if (Exit.isSuccess(exit)) return { outcome: "ok", failure: null };
  if (Cause.hasInterruptsOnly(exit.cause)) return { outcome: "interrupted", failure: null };
  const error = Cause.findErrorOption(exit.cause);
  if (Option.isNone(error)) return { outcome: "failed", failure: "defect" };
  const tag =
    Predicate.hasProperty(error.value, "_tag") && typeof error.value._tag === "string"
      ? error.value._tag
      : "error";
  return { outcome: "failed", failure: tag };
}

function attributeOutcome(span: Tracer.Span) {
  const value = span.attributes.get("connection.outcome");
  const outcome = typeof value === "string" ? CONNECTION_OUTCOMES[value] : undefined;
  if (outcome === undefined) return { outcome: "interrupted" as const, failure: null };
  if (outcome !== "failed") return { outcome, failure: null };
  const tag = span.attributes.get("connection.failure.tag");
  return { outcome, failure: value === "timeout" ? "timeout" : String(tag ?? "error") };
}

const nanosToMs = (nanos: bigint) => Math.round(Number(nanos) / 100_000) / 10;

function timingRecord(
  phase: TimingPhase,
  span: Tracer.Span,
  startTime: bigint,
  endTime: bigint,
  exit: Exit.Exit<unknown, unknown>,
): ConnectionTimingRecord {
  const attributes: Array<readonly [string, AttributeValue]> = [];
  for (const key of phase.keep) {
    const value = span.attributes.get(key);
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      attributes.push([key, value]);
    }
  }
  return {
    phase,
    startedAtMs: nanosToMs(startTime),
    durationMs: nanosToMs(endTime - startTime),
    ...("outcomeAttribute" in phase ? attributeOutcome(span) : exitOutcome(exit)),
    environmentId: findAttribute(span, ["environment.id", "connection.environment.id"]),
    traceId: span.traceId,
    spanId: span.spanId,
    attributes,
  };
}

export interface ConnectionTimingLog {
  readonly capacity: number;
  readonly push: (record: ConnectionTimingRecord, environmentLabel: string | null) => void;
  /** Latest start first. Returns the same array until the log changes. */
  readonly records: () => ReadonlyArray<ConnectionTimingRecord>;
  readonly labelFor: (environmentId: string) => string | null;
  readonly clear: () => void;
  readonly subscribe: (listener: () => void) => () => void;
}

/** A fixed-size ring of the latest records. Listeners run only while the diagnostics screen is open. */
export function makeConnectionTimingLog(capacity: number): ConnectionTimingLog {
  const ring: Array<ConnectionTimingRecord | undefined> = Array.from({ length: capacity });
  const labels = new Map<string, string>();
  const listeners = new Set<() => void>();
  let next = 0;
  let newestFirst: ReadonlyArray<ConnectionTimingRecord> | undefined;
  const changed = () => {
    newestFirst = undefined;
    for (const listener of listeners) listener();
  };
  return {
    capacity,
    push: (record, environmentLabel) => {
      ring[next] = record;
      next = (next + 1) % capacity;
      if (environmentLabel !== null && record.environmentId !== null) {
        labels.set(record.environmentId, environmentLabel);
      }
      changed();
    },
    records: () => {
      if (newestFirst !== undefined) return newestFirst;
      const records: ConnectionTimingRecord[] = [];
      for (let offset = 1; offset <= capacity; offset++) {
        const record = ring[(next - offset + capacity) % capacity];
        if (record !== undefined) records.push(record);
      }
      newestFirst = records.sort((a, b) => b.startedAtMs - a.startedAtMs);
      return newestFirst;
    },
    labelFor: (environmentId) => labels.get(environmentId) ?? null,
    clear: () => {
      ring.fill(undefined);
      next = 0;
      changed();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export const connectionTimingLog = makeConnectionTimingLog(200);

export interface ConnectionTimingOutbox {
  readonly capacity: number;
  /** Keeps a record for its environment; a record with no environment stays local. */
  readonly enqueue: (record: ConnectionTimingRecord) => void;
  /** Removes and returns up to `max` of the environment's oldest records. */
  readonly take: (environmentId: string, max: number) => ReadonlyArray<ConnectionTimingRecord>;
  /** Returns an unsent batch ahead of records queued since it was taken. */
  readonly requeue: (environmentId: string, batch: ReadonlyArray<ConnectionTimingRecord>) => void;
  readonly subscribe: (environmentId: string, listener: () => void) => () => void;
}

/** Records waiting to reach the environment they describe, at most `capacity` per environment. */
export function makeConnectionTimingOutbox(capacity: number): ConnectionTimingOutbox {
  const queues = new Map<string, ReadonlyArray<ConnectionTimingRecord>>();
  const listeners = new Map<string, Set<() => void>>();
  const store = (environmentId: string, records: ReadonlyArray<ConnectionTimingRecord>) => {
    queues.set(environmentId, records.length > capacity ? records.slice(-capacity) : records);
  };
  return {
    capacity,
    enqueue: (record) => {
      if (record.environmentId === null) return;
      store(record.environmentId, [...(queues.get(record.environmentId) ?? []), record]);
      for (const listener of listeners.get(record.environmentId) ?? []) listener();
    },
    take: (environmentId, max) => {
      const queued = queues.get(environmentId) ?? [];
      store(environmentId, queued.slice(max));
      return queued.slice(0, max);
    },
    requeue: (environmentId, batch) => {
      store(environmentId, [...batch, ...(queues.get(environmentId) ?? [])]);
    },
    subscribe: (environmentId, listener) => {
      const environmentListeners = listeners.get(environmentId) ?? new Set();
      listeners.set(environmentId, environmentListeners);
      environmentListeners.add(listener);
      return () => {
        environmentListeners.delete(listener);
      };
    },
  };
}

export const connectionTimingOutbox = makeConnectionTimingOutbox(200);

export function toClientTimingRecord(record: ConnectionTimingRecord): ClientTimingRecord {
  return {
    span: record.phase.span,
    startedAtMs: record.startedAtMs,
    durationMs: record.durationMs,
    outcome: record.outcome,
    failure: record.failure,
    traceId: record.traceId,
    spanId: record.spanId,
    attributes: Object.fromEntries(record.attributes),
  };
}

/**
 * Wraps a tracer so registered spans land in `log` when they end. Spans pass
 * through untouched; an unregistered span costs one map lookup.
 */
export function recordConnectionTimings(
  delegate: Tracer.Tracer,
  log: ConnectionTimingLog = connectionTimingLog,
  outbox: ConnectionTimingOutbox = connectionTimingOutbox,
): Tracer.Tracer {
  return Tracer.make({
    span(options) {
      const span = delegate.span(options);
      const phase = PHASE_BY_SPAN.get(options.name);
      if (phase === undefined) return span;
      const end = span.end.bind(span);
      span.end = (endTime, exit) => {
        end(endTime, exit);
        if ("within" in phase && !hasAncestor(span, phase.within)) return;
        const record = timingRecord(phase, span, options.startTime, endTime, exit);
        log.push(record, findAttribute(span, ["environment.label"]));
        outbox.enqueue(record);
      };
      return span;
    },
    ...(delegate.context ? { context: delegate.context } : {}),
  });
}

function formatAttributes(record: ConnectionTimingRecord): string {
  return record.attributes.map(([key, value]) => ` ${key}=${String(value)}`).join("");
}

/** Attribute values for a compact row, keyed by the last segment of each name. */
export function summarizeAttributes(record: ConnectionTimingRecord): string {
  return record.attributes
    .filter(([key]) => key !== "thread.id")
    .map(([key, value]) => `${key.slice(key.lastIndexOf(".") + 1)} ${String(value)}`)
    .join(" · ");
}

export function formatConnectionTimingReport(
  records: ReadonlyArray<ConnectionTimingRecord>,
  labelFor: (environmentId: string) => string | null,
  app: { readonly version: string; readonly build: string },
): string {
  const header = `T3 Code ${app.version} (${app.build}) connection timings, newest first`;
  if (records.length === 0) return `${header}\nNo connection timings recorded.`;
  return [
    header,
    ...records.map((record) => {
      const environment =
        record.environmentId === null
          ? "-"
          : `${labelFor(record.environmentId) ?? "?"} (${record.environmentId})`;
      const outcome =
        record.failure === null ? record.outcome : `${record.outcome}:${record.failure}`;
      return `${new Date(record.startedAtMs).toISOString()} ${environment} ${record.phase.label} [${record.phase.span}] ${record.durationMs}ms ${outcome}${formatAttributes(record)} trace=${record.traceId}`;
    }),
  ].join("\n");
}
