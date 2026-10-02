import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  EnvironmentId,
  ThreadId,
  VoiceSidecarError,
  type VoiceSessionEvent,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";
import type { Preferences } from "../../persistence/mobile-preferences";
import type { VoiceSessionPeer, openVoiceSessionPeer } from "./voiceSessionPeer";

const native = vi.hoisted(() => ({
  permission: vi.fn(),
  openPeer: vi.fn<typeof openVoiceSessionPeer>(),
  respond: vi.fn(),
  startRouting: vi.fn(),
  stopRouting: vi.fn(),
  removeListener: vi.fn(),
  players: [] as Array<{
    play: ReturnType<typeof vi.fn>;
    pause: ReturnType<typeof vi.fn>;
    remove: ReturnType<typeof vi.fn>;
    release: ReturnType<typeof vi.fn>;
  }>,
}));
vi.mock("expo-audio", () => ({ requestRecordingPermissionsAsync: native.permission }));
vi.mock("react-native", () => ({
  AppState: { addEventListener: () => ({ remove: native.removeListener }) },
}));
vi.mock("react-native-incall-manager", () => ({
  default: { start: native.startRouting, stop: native.stopRouting },
}));
vi.mock("./voiceSessionPeer", () => ({ openVoiceSessionPeer: native.openPeer }));
vi.mock("./voiceStartupAudio", async (original) => {
  const actual = await original<typeof import("./voiceStartupAudio")>();
  return {
    createVoiceStartupAudio: () =>
      actual.createVoiceStartupAudio(() => {
        const player = {
          loop: false,
          volume: 1,
          play: vi.fn(),
          pause: vi.fn(),
          remove: vi.fn(),
          release: vi.fn(),
        };
        native.players.push(player);
        return player;
      }),
  };
});
vi.mock("../../state/preferences", () => ({
  mobilePreferencesAtom: Atom.make(
    AsyncResult.success<Preferences>({ voiceStartupAudio: "ringing" }),
  ),
}));
vi.mock("../../state/atom-registry", () => ({ appAtomRegistry: AtomRegistry.make() }));
vi.mock("./voiceSidecar", async () => {
  const Stream = await import("effect/Stream");
  return {
    voiceSidecarUrl: "http://sidecar.test",
    // The socket "opens" as soon as the generation asks for its stream.
    openVoiceSidecarSession: (
      _url: string,
      _input: unknown,
      onClient: (client: unknown) => void,
    ) => {
      onClient({ "voiceSession.respond": native.respond });
      return Stream.empty;
    },
  };
});
vi.mock("../../connection/runtime", () => ({
  connectionAtomRuntime: {
    atom: () => Atom.make(AsyncResult.initial<ReadonlyArray<VoiceSessionEvent>, unknown>()),
  },
}));

import { appAtomRegistry } from "../../state/atom-registry";
import { mobilePreferencesAtom } from "../../state/preferences";
import * as controller from "./voiceSessionController";

type Handlers = Parameters<typeof openVoiceSessionPeer>[0];
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const answer: VoiceSessionEvent = {
  type: "answer",
  generation: 1,
  sessionThreadId: ThreadId.make("voice-thread"),
  sdpAnswer: "answer-sdp",
};
let handlers: Handlers;
let streamCallback: (
  result: AsyncResult.AsyncResult<ReadonlyArray<VoiceSessionEvent>, unknown>,
) => void;
let peer: VoiceSessionPeer;
function state() {
  return appAtomRegistry.get(controller.voiceSessionStateAtom);
}
function emit(...events: VoiceSessionEvent[]) {
  streamCallback(AsyncResult.success(events, { waiting: true }));
}
async function start() {
  controller.startVoiceSession({
    environmentId: EnvironmentId.make("test-environment"),
    focusThreadId: null,
  });
  await vi.advanceTimersByTimeAsync(0);
}
function expectStopped() {
  expect(native.players.length).toBeGreaterThan(0);
  for (const player of native.players) {
    expect(player.pause).toHaveBeenCalledOnce();
    expect(player.remove).toHaveBeenCalledOnce();
    expect(player.release).toHaveBeenCalledOnce();
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  native.players.length = 0;
  native.permission.mockResolvedValue({ granted: true });
  peer = {
    offerSdp: "offer-sdp",
    acceptAnswer: vi.fn(() => Promise.resolve()),
    close: vi.fn(),
    setMuted: vi.fn(),
    isConnected: () => true,
  };
  native.openPeer.mockImplementation(async (callbacks) => {
    handlers = callbacks;
    return peer;
  });
  const subscribe = appAtomRegistry.subscribe.bind(appAtomRegistry);
  vi.spyOn(appAtomRegistry, "subscribe").mockImplementation((...args) => {
    if (args[0] !== mobilePreferencesAtom) streamCallback = args[1] as typeof streamCallback;
    return subscribe(...args);
  });
});
afterEach(() => {
  controller.hangUpVoiceSession();
  vi.restoreAllMocks();
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("voice session startup lifecycle", () => {
  it("handles audio connecting immediately while the answer is applied", async () => {
    peer = {
      ...peer,
      acceptAnswer: () => {
        handlers.onConnected();
        return Promise.resolve();
      },
    };
    await start();
    emit(answer);
    expect(state().status).toBe("live");
    await vi.advanceTimersByTimeAsync(45_000);
    expect(state().failures).toBe(0);
    expectStopped();
  });

  it("releases startup audio on answer and stays silent when audio connects", async () => {
    await start();
    expect(native.players[0]?.play).toHaveBeenCalledOnce();
    emit(answer);
    expect(peer.acceptAnswer).toHaveBeenCalledWith("answer-sdp");
    expectStopped();
    handlers.onConnected();
    expect(state().status).toBe("live");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(state().status).toBe("live");
    expect(native.players).toHaveLength(1);
  });

  it("stops startup playback immediately on a peer failure", async () => {
    await start();
    handlers.onConnectionFailed();
    expectStopped();
    expect(peer.close).toHaveBeenCalledOnce();
    expect(state().failures).toBe(1);
  });

  it("stops startup playback when microphone permission is denied", async () => {
    native.permission.mockResolvedValue({ granted: false });
    await start();
    expect(state().status).toBe("microphone-denied");
    expectStopped();
    expect(native.openPeer).not.toHaveBeenCalled();
  });

  it("stops startup playback when the stream fails", async () => {
    await start();
    streamCallback(AsyncResult.failure(Cause.fail(new Error("RPC disconnected"))));
    expectStopped();
    expect(peer.close).toHaveBeenCalledOnce();
    expect(state().failures).toBe(1);
  });

  it("ignores an answer failure from a cancelled call while a new call rings", async () => {
    const acceptance = deferred<void>();
    vi.mocked(peer.acceptAnswer).mockImplementation(() => acceptance.promise);
    await start();
    emit(answer);
    const oldHandlers = handlers;
    controller.hangUpVoiceSession();
    await start();
    const nextCall = state();
    const nextPlayer = native.players.at(-1)!;
    expect(nextPlayer.play).toHaveBeenCalledOnce();
    acceptance.reject(new Error("Late SDP failure"));
    oldHandlers.onConnected();
    oldHandlers.onConnectionFailed();
    await vi.advanceTimersByTimeAsync(0);
    expect(state()).toBe(nextCall);
    expect(nextPlayer.pause).not.toHaveBeenCalled();
    expect(native.openPeer).toHaveBeenCalledTimes(2);
  });

  it("cancels synchronously and ignores late stream and peer callbacks", async () => {
    await start();
    controller.hangUpVoiceSession();
    const cancelled = state();
    expectStopped();
    expect(native.stopRouting).toHaveBeenCalledOnce();
    emit(answer, { type: "startup", stage: "briefing" });
    handlers.onConnected();
    handlers.onConnectionFailed();
    handlers.onRealtimeEvent({ type: "output_transcript.added", item: { text: "late" } });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(state()).toBe(cancelled);
    expect(peer.acceptAnswer).not.toHaveBeenCalled();
    expect(peer.close).toHaveBeenCalledOnce();
    expect(native.players).toHaveLength(1);
    expect(native.openPeer).toHaveBeenCalledOnce();
  });

  it("closes a peer that finishes opening after cancellation without contacting the server", async () => {
    const opening = deferred<VoiceSessionPeer>();
    native.openPeer.mockImplementationOnce((callbacks) => {
      handlers = callbacks;
      return opening.promise;
    });
    await start();
    controller.hangUpVoiceSession();
    const cancelled = state();
    opening.resolve(peer);
    await vi.advanceTimersByTimeAsync(0);
    handlers.onConnected();
    expect(state()).toBe(cancelled);
    expect(peer.close).toHaveBeenCalledOnce();
    expect(peer.setMuted).not.toHaveBeenCalled();
    expectStopped();
    expect(native.players).toHaveLength(1);
  });

  it("does not open a peer when microphone permission arrives after cancellation", async () => {
    const permission = deferred<{ granted: boolean }>();
    native.permission.mockReturnValueOnce(permission.promise);
    await start();
    controller.hangUpVoiceSession();
    permission.resolve({ granted: true });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(native.openPeer).not.toHaveBeenCalled();
    expect(state().status).toBe("ended");
    expectStopped();
  });

  it("times out startup despite server progress before an answer", async () => {
    await start();
    await vi.advanceTimersByTimeAsync(30_000);
    emit(
      { type: "startup", stage: "preparing-session" },
      { type: "startup", stage: "briefing" },
      { type: "startup", stage: "starting-realtime" },
    );
    expect(state().failures).toBe(0);
    await vi.advanceTimersByTimeAsync(14_999);
    expect(state().failures).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(state().failures).toBe(1);
    expect(state().message).toBe("The call did not connect in time.");
    expect(peer.close).toHaveBeenCalledOnce();
    expectStopped();
  });

  it("still times out when the answer arrives but audio never connects", async () => {
    await start();
    emit(answer);
    await vi.advanceTimersByTimeAsync(45_000);
    expect(state().failures).toBe(1);
    expect(state().message).toBe("The call did not connect in time.");
    expectStopped();
  });
});

describe("voice session confirm answers", () => {
  it("answers on the call's sidecar socket and reports refusals", async () => {
    await start();
    native.respond.mockReturnValueOnce(Effect.succeed({ accepted: false }));
    await expect(
      controller.respondToVoiceConfirm({ requestId: "confirm-1", approved: true }),
    ).resolves.toBe(true);
    expect(native.respond).toHaveBeenCalledWith({ requestId: "confirm-1", approved: true });

    native.respond.mockReturnValueOnce(Effect.fail(new VoiceSidecarError({ message: "denied" })));
    await expect(
      controller.respondToVoiceConfirm({ requestId: "confirm-2", approved: false }),
    ).resolves.toBe(false);
  });

  it("does not answer once the call has hung up", async () => {
    await start();
    controller.hangUpVoiceSession();
    await expect(
      controller.respondToVoiceConfirm({ requestId: "confirm-1", approved: true }),
    ).resolves.toBe(false);
    expect(native.respond).not.toHaveBeenCalled();
  });
});
