import * as Schema from "effect/Schema";

export const CLIENT_TIMING_REPORT_MAX_RECORDS = 50;

export const ClientTimingOutcome = Schema.Literals(["ok", "failed", "interrupted"]);
export type ClientTimingOutcome = typeof ClientTimingOutcome.Type;

export const ClientTimingAttributeValue = Schema.Union([
  Schema.String,
  Schema.Number,
  Schema.Boolean,
]);
export type ClientTimingAttributeValue = typeof ClientTimingAttributeValue.Type;

export const ClientTimingRecord = Schema.Struct({
  span: Schema.String,
  startedAtMs: Schema.Number,
  durationMs: Schema.Number,
  outcome: ClientTimingOutcome,
  failure: Schema.NullOr(Schema.String),
  traceId: Schema.String,
  spanId: Schema.String,
  attributes: Schema.Record(Schema.String, ClientTimingAttributeValue),
});
export type ClientTimingRecord = typeof ClientTimingRecord.Type;

/** Timings a client measured against the environment that receives the report. */
export const ClientTimingReport = Schema.Struct({
  app: Schema.Struct({
    platform: Schema.String,
    version: Schema.String,
    build: Schema.String,
    updateId: Schema.optional(Schema.String),
  }),
  records: Schema.Array(ClientTimingRecord).check(
    Schema.isMaxLength(CLIENT_TIMING_REPORT_MAX_RECORDS),
  ),
});
export type ClientTimingReport = typeof ClientTimingReport.Type;
