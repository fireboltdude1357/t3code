/**
 * expo-audio players and recorders are shared native objects that their hooks
 * release during unmount, before later-declared effect cleanups run. Any
 * native call after that throws "Unable to find the native shared object
 * associated with given JavaScript object", which is fatal when it escapes an
 * effect cleanup in a release build. Route every native call that can run in
 * a cleanup path through this guard.
 */
export function ignoreReleasedNativeObject<T>(run: () => T): T | undefined {
  try {
    return run();
  } catch {
    return undefined;
  }
}
