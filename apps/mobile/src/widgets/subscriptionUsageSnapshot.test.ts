import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  UsageLimitSourceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  buildSubscriptionUsageSnapshot,
  createWidgetRefresher,
  keepLastLimits,
  WIDGET_REFRESH_INTERVAL,
} from "./subscriptionUsageSnapshot";

const checkedAt = "2026-09-05T12:00:00.000Z";
const now = Date.parse(checkedAt);
const window = {
  id: "session",
  kind: "session",
  label: "5 hours",
  usedPercent: 40,
  resetsAt: "2026-09-05T12:10:00.000Z",
} as const;
const limits = { checkedAt, windows: [window] };
const deepLink = "t3code-dev://settings/usage?tab=limits";
function provider(overrides: Partial<ServerProvider> = {}): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make("codex"),
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated", email: "private@example.com" },
    checkedAt,
    models: [],
    slashCommands: [],
    skills: [],
    usageLimits: limits,
    ...overrides,
  };
}
function presentations(providers: readonly ServerProvider[] = [provider()]) {
  return new Map([
    [
      EnvironmentId.make("env"),
      { entry: { target: { label: "Remote" } }, serverConfig: { providers } },
    ],
  ]);
}

describe("subscription widget snapshots", () => {
  it("uses provider data and its observation time without exposing account emails", () => {
    const snapshot = buildSubscriptionUsageSnapshot(
      presentations([provider({ displayName: "private@example.com" })]),
      deepLink,
    );
    expect(snapshot.checkedAt).toBe(now);
    expect(snapshot.providers[0]).toMatchObject({
      name: "Codex",
      windows: [{ remaining: 60 }],
    });
    expect(snapshot.url).toBe(deepLink);
    expect(JSON.stringify(snapshot)).not.toContain("private@example.com");
  });
  it("clears data after removing environments", () => {
    expect(buildSubscriptionUsageSnapshot(new Map(), deepLink).providers).toEqual([]);
  });
  it.each<{ name: string; overrides: Partial<ServerProvider> }>([
    { name: "disabled", overrides: { enabled: false } },
    {
      name: "missing",
      overrides: { installed: false, status: "error", usageLimits: undefined },
    },
    {
      name: "API-key",
      overrides: {
        usageLimits: { checkedAt, windows: [], unavailable: { reason: "unsupported" } },
      },
    },
  ])("hides $name providers", ({ overrides }) => {
    expect(
      buildSubscriptionUsageSnapshot(presentations([provider(overrides)]), deepLink).providers,
    ).toEqual([]);
  });
  it.each([
    { name: "Codex", driver: "codex" },
    { name: "Claude", driver: "claudeAgent" },
  ])("only shows $name when $name and OpenCode are configured", ({ name, driver }) => {
    const snapshot = buildSubscriptionUsageSnapshot(
      presentations([
        provider({
          instanceId: ProviderInstanceId.make(driver),
          driver: ProviderDriverKind.make(driver),
        }),
        provider({
          instanceId: ProviderInstanceId.make("opencode"),
          driver: ProviderDriverKind.make("opencode"),
          usageLimits: undefined,
        }),
      ]),
      deepLink,
    );
    expect(snapshot.providers).toHaveLength(1);
    expect(snapshot.providers[0]).toMatchObject({
      name,
      totalWindows: 1,
      windows: [{ remaining: 60 }],
    });
  });
  it("keeps an enabled provider visible before its first usage read", () => {
    const snapshot = buildSubscriptionUsageSnapshot(
      presentations([provider({ usageLimits: undefined })]),
      deepLink,
    );
    expect(snapshot.checkedAt).toBe(0);
    expect(snapshot.providers).toEqual([
      { name: "Codex", detail: "No limits available", windows: [], totalWindows: 0 },
    ]);
  });
  it("uses upstream deduplication for a native account also present in a proxy hub", () => {
    const input = new Map([
      [
        EnvironmentId.make("env"),
        {
          entry: { target: { label: "Remote" } },
          serverConfig: {
            providers: [provider()],
            usageLimitSources: [
              {
                id: UsageLimitSourceId.make("hub"),
                kind: "cliproxy" as const,
                label: "Hub",
                checkedAt,
                accounts: [
                  {
                    id: "account",
                    driver: ProviderDriverKind.make("codex"),
                    email: " PRIVATE@example.com ",
                    usageLimits: limits,
                  },
                ],
              },
            ],
          },
        },
      ],
    ]);
    expect(buildSubscriptionUsageSnapshot(input, deepLink).providers[0]?.detail).toBe(
      "Subscription remaining",
    );
    input.get(EnvironmentId.make("env"))!.serverConfig.providers = [];
    const snapshot = buildSubscriptionUsageSnapshot(input, deepLink);
    expect(snapshot.providers[0]?.name).toBe("Codex");
    expect(JSON.stringify(snapshot)).not.toContain("example.com");
  });
  it("keeps unavailable quotas distinct from zero usage and omits provider error messages", () => {
    const snapshot = buildSubscriptionUsageSnapshot(
      presentations([
        provider({
          usageLimits: {
            ...limits,
            unavailable: { reason: "probeFailed", message: "token secret" },
          },
        }),
      ]),
      deepLink,
    );
    expect(snapshot.providers[0]?.windows).toEqual([]);
    expect(JSON.stringify(snapshot)).not.toContain("token secret");
    expect(
      buildSubscriptionUsageSnapshot(
        presentations([
          provider({ usageLimits: { checkedAt, windows: [{ ...window, usedPercent: 0 }] } }),
        ]),
        deepLink,
      ).providers[0]?.windows[0]?.remaining,
    ).toBe(100);
  });
  it("bounds OS storage and puts the most constrained windows first", () => {
    const windows = Array.from({ length: 20 }, (_, index) => ({
      ...window,
      id: `${index}`,
      usedPercent: index * 5,
    }));
    const snapshot = buildSubscriptionUsageSnapshot(
      presentations([provider({ usageLimits: { checkedAt, windows } })]),
      deepLink,
    );
    expect(snapshot.providers[0]?.windows).toHaveLength(6);
    expect(snapshot.providers[0]?.totalWindows).toBe(20);
    expect(snapshot.providers[0]?.windows[0]?.remaining).toBe(5);
  });
  it("includes every limit for the scrollable Android widget", () => {
    const windows = Array.from({ length: 20 }, (_, index) => ({
      ...window,
      id: `${index}`,
      usedPercent: index * 5,
    }));
    const snapshot = buildSubscriptionUsageSnapshot(
      presentations([provider({ usageLimits: { checkedAt, windows } })]),
      deepLink,
      Infinity,
    );
    expect(snapshot.providers[0]?.windows.map((window) => window.remaining)).toEqual(
      Array.from({ length: 20 }, (_, index) => 5 + index * 5),
    );
  });
  it("keeps readings that are past a reset or older than fifteen minutes", () => {
    const snapshot = buildSubscriptionUsageSnapshot(
      presentations([
        provider(),
        provider({
          instanceId: ProviderInstanceId.make("claude"),
          driver: ProviderDriverKind.make("claudeAgent"),
          usageLimits: { checkedAt, windows: [{ ...window, resetsAt: undefined }] },
        }),
      ]),
      deepLink,
    );
    expect(snapshot.providers.map((provider) => provider.windows[0]?.remaining)).toEqual([60, 60]);
    expect(snapshot.providers[1]?.windows[0]?.reset).toBe("Reset time unavailable");
  });
  it("keeps a malformed check time's limits without storing null", () => {
    const snapshot = buildSubscriptionUsageSnapshot(
      presentations([provider({ usageLimits: { ...limits, checkedAt: "invalid" } })]),
      deepLink,
    );
    expect(snapshot.checkedAt).toBe(0);
    expect(snapshot.providers[0]?.windows).toHaveLength(1);
    expect(JSON.stringify(snapshot)).not.toContain("null");
  });
  it("uses the freshest copy of an account across environments before pooling", () => {
    const input = presentations();
    input.set(EnvironmentId.make("other"), {
      entry: { target: { label: "Other" } },
      serverConfig: {
        providers: [
          provider({
            usageLimits: {
              checkedAt: new Date(now + 60_000).toISOString(),
              windows: [{ ...window, usedPercent: 80 }],
            },
          }),
        ],
      },
    });
    const snapshot = buildSubscriptionUsageSnapshot(input, deepLink);
    expect(snapshot.providers[0]?.detail).toBe("Subscription remaining");
    expect(snapshot.providers[0]?.windows[0]?.remaining).toBe(20);
  });
});

describe("keeping the last widget limits", () => {
  const codex = buildSubscriptionUsageSnapshot(presentations(), deepLink);
  const claude = provider({
    instanceId: ProviderInstanceId.make("claude"),
    driver: ProviderDriverKind.make("claudeAgent"),
  });

  it("skips publishing when no provider has limits", () => {
    expect(keepLastLimits(codex, buildSubscriptionUsageSnapshot(new Map(), deepLink))).toBe(
      undefined,
    );
    expect(
      keepLastLimits(
        undefined,
        buildSubscriptionUsageSnapshot(
          presentations([provider({ usageLimits: undefined })]),
          deepLink,
        ),
      ),
    ).toBe(undefined);
  });

  it("carries a provider's last limits while its new reading is missing", () => {
    const later = new Date(now + 60_000).toISOString();
    const next = buildSubscriptionUsageSnapshot(
      presentations([
        provider({ usageLimits: undefined }),
        { ...claude, usageLimits: { checkedAt: later, windows: [window] } },
      ]),
      deepLink,
    );
    const published = keepLastLimits(codex, next);
    expect(
      published?.providers.map((provider) => [provider.name, provider.windows.length]),
    ).toEqual([
      ["Codex", 1],
      ["Claude", 1],
    ]);
    // The footer time reflects the older carried reading.
    expect(published?.checkedAt).toBe(now);
  });

  it("drops a provider the user disabled and replaces limits with newer ones", () => {
    const next = buildSubscriptionUsageSnapshot(
      presentations([provider({ enabled: false }), claude]),
      deepLink,
    );
    expect(next.providers.map((provider) => provider.name)).toEqual(["Claude"]);
    expect(keepLastLimits(codex, next)).toEqual(next);
  });
});

describe("widget refresh probes", () => {
  it("throttles each connected environment independently and retries failures", async () => {
    const probe = vi
      .fn<(id: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue(undefined);
    const refresh = createWidgetRefresher(probe);
    await refresh([], now);
    expect(probe).not.toHaveBeenCalled();
    await refresh(["first"], now);
    await refresh(["first", "second"], now + 1);
    expect(probe.mock.calls).toEqual([["first"], ["second"]]);
    await refresh(["first"], now + WIDGET_REFRESH_INTERVAL);
    expect(probe.mock.calls).toEqual([["first"], ["second"], ["first"]]);
  });

  it("does not overlap a slow probe even after the refresh interval", async () => {
    let finish!: () => void;
    const probe = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const refresh = createWidgetRefresher(probe);
    const first = refresh(["one", "one"], now);
    await refresh(["one"], now + WIDGET_REFRESH_INTERVAL);
    expect(probe).toHaveBeenCalledTimes(1);
    finish();
    await first;
  });
});
