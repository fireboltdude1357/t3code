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
    // Absent when the app runs the bundle embedded in its binary.
    ...(Updates.updateId ? { updateId: Updates.updateId } : {}),
  };
}
