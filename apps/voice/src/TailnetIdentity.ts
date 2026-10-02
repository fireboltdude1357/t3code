import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

/** How long a `tailscale whois` answer is trusted. */
const CACHE_TTL = Duration.minutes(5);

const SelfStatus = Schema.Struct({ Self: Schema.Struct({ UserID: Schema.Number }) });
const Whois = Schema.Struct({ Node: Schema.Struct({ User: Schema.Number }) });
const decodeStatus = Schema.decodeUnknownEffect(Schema.fromJsonString(SelfStatus));
const decodeWhois = Schema.decodeUnknownEffect(Schema.fromJsonString(Whois));

/** Strips the IPv4-mapped prefix Node reports for IPv4 peers on dual-stack sockets. */
export const normalizeAddress = (address: string) => address.replace(/^::ffff:/, "");

export const isLoopback = (address: string) =>
  address === "127.0.0.1" || address === "::1" || address.startsWith("127.");

/**
 * Decides who may open a voice call: the host itself, or a device signed in
 * to the host's own Tailscale user. Shared or tagged devices are refused.
 */
export interface TailnetIdentityShape {
  readonly isOwner: (address: string | undefined) => Effect.Effect<boolean>;
}

export class TailnetIdentity extends Context.Service<TailnetIdentity, TailnetIdentityShape>()(
  "@t3tools/voice/TailnetIdentity",
) {}

export const layer = Layer.effect(
  TailnetIdentity,
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const tailscale = (args: ReadonlyArray<string>) =>
      spawner.string(ChildProcess.make("tailscale", args)).pipe(Effect.timeout("3 seconds"));
    const owner = yield* tailscale(["status", "--json"]).pipe(
      Effect.flatMap(decodeStatus),
      Effect.map((status) => status.Self.UserID),
      Effect.orDie,
    );
    const cache = yield* Ref.make(new Map<string, { owned: boolean; at: number }>());

    const lookup = (address: string) =>
      tailscale(["whois", "--json", address]).pipe(
        Effect.flatMap(decodeWhois),
        Effect.map((whois) => whois.Node.User === owner),
        Effect.catchCause((cause) =>
          Effect.logWarning("voice.tailnet.whois-failed", { address, cause }).pipe(
            Effect.as(false),
          ),
        ),
      );

    return TailnetIdentity.of({
      isOwner: (raw) =>
        Effect.gen(function* () {
          if (raw === undefined) return false;
          const address = normalizeAddress(raw);
          if (isLoopback(address)) return true;
          const now = yield* Clock.currentTimeMillis;
          const cached = (yield* Ref.get(cache)).get(address);
          if (cached !== undefined && now - cached.at < Duration.toMillis(CACHE_TTL))
            return cached.owned;
          const owned = yield* lookup(address);
          yield* Ref.update(cache, (current) => new Map(current).set(address, { owned, at: now }));
          return owned;
        }),
    });
  }),
);
