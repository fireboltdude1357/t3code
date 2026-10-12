import { mediaDevices, RTCPeerConnection, type MediaStream } from "react-native-webrtc";

// The published typings omit the vendored event-target-shim, so listeners use the `on*` properties.

/** Long enough for host and STUN candidates on a normal network; the offer goes out either way. */
const ICE_GATHERING_TIMEOUT_MS = 3_000;

/** One generation's WebRTC connection to OpenAI, with its own microphone track. */
export interface VoiceSessionPeer {
  /** The complete local offer, sent to the server unmodified. */
  readonly offerSdp: string;
  readonly acceptAnswer: (sdp: string) => Promise<void>;
  readonly setMuted: (muted: boolean) => void;
  /** False once the connection failed, dropped or closed. */
  readonly isConnected: () => boolean;
  /** Idempotent. Stops this peer's microphone track and closes the connection. */
  readonly close: () => void;
}

function waitForIceGathering(pc: RTCPeerConnection): Promise<void> {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      pc.onicegatheringstatechange = null;
      resolve();
    };
    const timer = setTimeout(finish, ICE_GATHERING_TIMEOUT_MS);
    pc.onicegatheringstatechange = () => {
      if (pc.iceGatheringState === "complete") finish();
    };
  });
}

/**
 * Captures the microphone and prepares a WebRTC offer for one generation.
 * Remote audio plays on its own once the answer is accepted. The audio session
 * (speaker routing) belongs to the controller, so closing one peer during a
 * rotation doesn't cut the next one. Setup failures clean up before rejecting.
 */
export async function openVoiceSessionPeer(handlers: {
  readonly onRealtimeEvent: (event: unknown) => void;
  readonly onConnectionFailed: () => void;
  readonly onConnected: () => void;
}): Promise<VoiceSessionPeer> {
  let pc: RTCPeerConnection | null = null;
  let stream: MediaStream | null = null;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    stream?.getTracks().forEach((track) => track.stop());
    stream?.release();
    pc?.close();
  };

  try {
    // OpenAI needs a real audio track in the offer; the mic track is that track.
    stream = await mediaDevices.getUserMedia({ audio: true });
    const connection = new RTCPeerConnection();
    pc = connection;
    for (const track of stream.getTracks()) connection.addTrack(track, stream);

    const events = connection.createDataChannel("oai-events");
    events.onmessage = (message: { readonly data: unknown }) => {
      if (typeof message.data !== "string") return;
      try {
        handlers.onRealtimeEvent(JSON.parse(message.data));
      } catch {
        // A malformed event only costs the transcript line.
      }
    };
    connection.onconnectionstatechange = () => {
      if (closed) return;
      if (connection.connectionState === "failed") handlers.onConnectionFailed();
      if (connection.connectionState === "connected") handlers.onConnected();
    };

    await connection.setLocalDescription(await connection.createOffer());
    await waitForIceGathering(connection);
    const offerSdp = connection.localDescription?.sdp;
    if (!offerSdp) throw new Error("Could not prepare the call audio.");

    const localStream = stream;
    return {
      offerSdp,
      acceptAnswer: (sdp) => connection.setRemoteDescription({ type: "answer", sdp }),
      setMuted: (muted) => {
        for (const track of localStream.getAudioTracks()) track.enabled = !muted;
      },
      isConnected: () =>
        !closed &&
        connection.connectionState !== "failed" &&
        connection.connectionState !== "disconnected" &&
        connection.connectionState !== "closed",
      close,
    };
  } catch (error) {
    close();
    throw error;
  }
}
