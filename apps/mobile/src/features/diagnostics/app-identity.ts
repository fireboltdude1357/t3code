import * as Application from "expo-application";
import Constants from "expo-constants";
import * as Updates from "expo-updates";
import { Platform } from "react-native";

export function appIdentity() {
  return {
    platform: Platform.OS,
    version: Constants.expoConfig?.version ?? "0.0.0",
    // EAS assigns build numbers remotely, so expo-constants never sees them;
    // only the installed binary knows its own.
    build: Application.nativeBuildVersion ?? "dev",
    // The embedded bundle has an update ID too; only an OTA update's is sent.
    ...(Updates.updateId && !Updates.isEmbeddedLaunch ? { updateId: Updates.updateId } : {}),
  };
}
