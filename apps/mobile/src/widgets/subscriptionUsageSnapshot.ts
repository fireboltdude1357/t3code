import {
  collectLimitAccounts,
  collectLimitPools,
  type LimitAccount,
  type LimitPresentations,
} from "@t3tools/shared/usageLimits";

export interface SubscriptionUsageSnapshot {
  url?: string;
  checkedAt: number;
  providers: Array<{
    name: string;
    detail: string;
    windows: Array<{ kind?: string; label: string; remaining: number; reset: string }>;
    totalWindows: number;
    /** When these limits were read, or 0 when unknown. */
    checkedAt: number;
  }>;
}

// The app only refreshes limits while it runs. Widgets keep showing the last
// read with its "As of" time rather than blanking once it ages.
export const WIDGET_REFRESH_INTERVAL = 5 * 60_000;

/** Bound probes across config updates, reconnects, and foreground transitions. */
export function createWidgetRefresher<Id>(refresh: (id: Id) => Promise<unknown>) {
  const attempted = new Map<Id, number>();
  const pending = new Set<Id>();
  return async (connected: readonly Id[], now: number) => {
    await Promise.allSettled(
      connected.map(async (id) => {
        if (pending.has(id) || now - (attempted.get(id) ?? -Infinity) < WIDGET_REFRESH_INTERVAL)
          return;
        attempted.set(id, now);
        pending.add(id);
        try {
          await refresh(id);
        } finally {
          pending.delete(id);
        }
      }),
    );
  };
}

function subscriptionUsageProps(
  accounts: readonly LimitAccount[],
  configuredDrivers: ReadonlySet<string>,
  maxWindowsPerProvider: number,
): SubscriptionUsageSnapshot {
  const pools = collectLimitPools(accounts, 0);
  const checked = accounts
    .filter((account) => account.driver === "codex" || account.driver === "claudeAgent")
    .map((account) => Date.parse(account.limits.checkedAt));
  return {
    checkedAt: checked.length > 0 && checked.every(Number.isFinite) ? Math.min(...checked) : 0,
    providers: (["codex", "claudeAgent"] as const)
      .filter(
        (driver) =>
          configuredDrivers.has(driver) || accounts.some((account) => account.driver === driver),
      )
      .map((driver) => {
        const pool = pools.find((candidate) => candidate.driver === driver);
        const name = driver === "codex" ? "Codex" : "Claude";
        if (!pool)
          return {
            name,
            detail: "No limits available",
            windows: [],
            totalWindows: 0,
            checkedAt: 0,
          };
        const checkedAt = Math.min(...pool.accounts.map((a) => Date.parse(a.limits.checkedAt)));
        const sortedWindows = [...pool.windows].sort(
          (a, b) => a.remainingPercent - b.remainingPercent,
        );
        // Keep a session and weekly limit when scoped limits fill the storage budget.
        const selectedWindows = [
          ...new Set([
            sortedWindows.find((window) => window.kind === "session"),
            sortedWindows.find(
              (window) => window.kind === "weekly" && !window.label.includes(" · "),
            ) ?? sortedWindows.find((window) => window.kind === "weekly"),
            ...sortedWindows,
          ]),
        ]
          .filter((window) => window !== undefined)
          .slice(0, maxWindowsPerProvider)
          .sort((a, b) => a.remainingPercent - b.remainingPercent);
        return {
          name,
          detail:
            pool.accounts.length > 1
              ? `${pool.accounts.length} accounts · pooled`
              : "Subscription remaining",
          totalWindows: pool.windows.length,
          checkedAt: Number.isFinite(checkedAt) ? checkedAt : 0,
          windows: selectedWindows.map((window) => ({
            kind: window.kind,
            label: window.label,
            remaining: Math.round(window.remainingPercent),
            reset: window.resets[0]
              ? `Next reset ${new Date(window.resets[0].at).toLocaleString(undefined, {
                  month: "short",
                  day: "numeric",
                  hour: "numeric",
                  minute: "2-digit",
                })}`
              : "Reset time unavailable",
          })),
        };
      }),
  };
}

/** Deduplicate accounts before pooling, and only publish display data to the OS. */
export function buildSubscriptionUsageSnapshot(
  presentations: LimitPresentations,
  url: string,
  maxWindowsPerProvider = 6,
): SubscriptionUsageSnapshot {
  const configuredDrivers = new Set(
    [...presentations.values()].flatMap((presentation) =>
      (presentation.serverConfig?.providers ?? [])
        // Servers report default-enabled drivers even when their CLI is missing.
        .filter(
          (provider) =>
            provider.enabled &&
            provider.installed &&
            provider.usageLimits?.unavailable?.reason !== "unsupported",
        )
        .map((provider) => provider.driver),
    ),
  );
  return {
    ...subscriptionUsageProps(
      collectLimitAccounts(presentations),
      configuredDrivers,
      maxWindowsPerProvider,
    ),
    url,
  };
}

/**
 * Choose what the widget should show next. A provider whose limits are missing
 * from `next` (still loading, disconnected, cold start) keeps the limits it last
 * showed, and a snapshot with no limits at all is skipped so the widget never
 * blanks. Returns undefined when nothing should be published.
 */
export function keepLastLimits(
  previous: SubscriptionUsageSnapshot | undefined,
  next: SubscriptionUsageSnapshot,
): SubscriptionUsageSnapshot | undefined {
  const providers = next.providers.map((provider) =>
    provider.windows.length > 0
      ? provider
      : (previous?.providers.find(
          (candidate) => candidate.name === provider.name && candidate.windows.length > 0,
        ) ?? provider),
  );
  if (providers.every((provider) => provider.windows.length === 0)) return undefined;
  const carried = providers.some((provider, index) => provider !== next.providers[index]);
  // "As of" reflects the oldest limits on screen.
  const checked = [next.checkedAt, carried ? (previous?.checkedAt ?? 0) : 0].filter((at) => at > 0);
  return { ...next, checkedAt: checked.length > 0 ? Math.min(...checked) : 0, providers };
}
