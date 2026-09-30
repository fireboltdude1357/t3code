import InCallManager from "react-native-incall-manager";
import { mediaDevices, RTCPeerConnection, type MediaStream } from "react-native-webrtc";

// The published typings omit the vendored event-target-shim, so listeners use the `on*` properties.

/** Long enough for host and STUN candidates on a normal network; the offer goes out either way. */
const ICE_GATHERING_TIMEOUT_MS = 3_000;

export interface VoiceCallPeer {
  /** The complete local offer, sent to the server unmodified. */
  readonly offerSdp: string;
  readonly acceptAnswer: (sdp: string) => Promise<void>;
  readonly setMuted: (muted: boolean) => void;
  /** Idempotent. Stops the microphone, closes the connection, and releases the audio session. */
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
 * Captures the microphone and prepares a WebRTC offer for a realtime voice call.
 * Remote audio plays on its own once the answer is accepted. The caller must
 * call `close` when the call ends; setup failures clean up before rejecting.
 */
export async function openVoiceCallPeer(handlers: {
  readonly onRealtimeEvent: (event: unknown) => void;
  readonly onConnectionFailed: () => void;
}): Promise<VoiceCallPeer> {
  // "video" media selects the speaker by default while still yielding to
  // headphones and Bluetooth; "audio" would route the reply to the earpiece.
  InCallManager.start({ media: "video" });
  let pc: RTCPeerConnection | null = null;
  let stream: MediaStream | null = null;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    stream?.getTracks().forEach((track) => track.stop());
    stream?.release();
    pc?.close();
    InCallManager.stop();
  };

  try {
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
      if (connection.connectionState === "failed") handlers.onConnectionFailed();
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
      close,
    };
  } catch (error) {
    close();
    throw error;
  }
}
