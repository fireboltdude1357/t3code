import type * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";

const AppUpdateYmlConfig = Schema.Record(Schema.String, Schema.String);
const decodeAppUpdateYmlConfig = Schema.decodeUnknownEffect(AppUpdateYmlConfig);

function hasUpdateProvider(raw: string): Effect.Effect<boolean> {
  const entries: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const match = line.match(/^(\w+):\s*(.+)$/);
    if (match?.[1] && match[2]) {
      entries[match[1]] = match[2].trim();
    }
  }

  return decodeAppUpdateYmlConfig(entries).pipe(
    Effect.map((config) => Boolean(config.provider)),
    Effect.orElseSucceed(() => false),
  );
}

function getAutoUpdateDisabledReason(args: {
  isDevelopment: boolean;
  isPackaged: boolean;
  platform: NodeJS.Platform;
  appImage?: string | undefined;
  isDebPackage: boolean;
  disabledByEnv: boolean;
  hasUpdateFeedConfig: boolean;
}): string | null {
  if (!args.hasUpdateFeedConfig) {
    return "Automatic updates are not available because no update feed is configured.";
  }
  if (args.isDevelopment || !args.isPackaged) {
    return "Automatic updates are only available in packaged production builds.";
  }
  if (args.disabledByEnv) {
    return "Automatic updates are disabled by the T3CODE_DISABLE_AUTO_UPDATE setting.";
  }
  if (args.platform === "linux" && !args.appImage && !args.isDebPackage) {
    return "Automatic updates on Linux require the AppImage or the .deb package.";
  }
  return null;
}

/** Why this install cannot update itself, or none when it can. The updater and the backend bootstrap both read it. */
export const resolveAutoUpdateDisabledReason = Effect.fn(
  "desktop.updates.resolveAutoUpdateDisabledReason",
)(function* (config: Config.Success<typeof DesktopConfig.DesktopConfig>) {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;

  const hasUpdateFeedConfig =
    config.mockUpdates ||
    (yield* fileSystem.readFileString(environment.appUpdateYmlPath, "utf-8").pipe(
      Effect.flatMap(hasUpdateProvider),
      Effect.orElseSucceed(() => false),
    ));

  // electron-updater uses this marker to install .deb updates with dpkg.
  const isDebPackage =
    environment.platform === "linux" && environment.isPackaged
      ? yield* fileSystem
          .readFileString(environment.path.join(environment.resourcesPath, "package-type"))
          .pipe(
            Effect.map((packageType) => packageType.trim() === "deb"),
            Effect.orElseSucceed(() => false),
          )
      : false;

  return Option.fromNullishOr(
    getAutoUpdateDisabledReason({
      isDevelopment: environment.isDevelopment,
      isPackaged: environment.isPackaged,
      platform: environment.platform,
      appImage: Option.getOrUndefined(config.appImagePath),
      isDebPackage,
      disabledByEnv: config.disableAutoUpdate,
      hasUpdateFeedConfig,
    }),
  );
});
