import { createAudioPlayer, type AudioPlayer } from "expo-audio";

export type VoiceStartupAudioChoice = "ringing" | "jazz" | "silence";

type StartupPlayer = Pick<AudioPlayer, "loop" | "volume" | "play" | "pause" | "remove" | "release">;
type AudibleChoice = Exclude<VoiceStartupAudioChoice, "silence">;

export interface VoiceStartupAudio {
  /** Starts or switches the loop. Repeating the active choice leaves it playing. */
  readonly start: (choice: VoiceStartupAudioChoice) => void;
  /** Call immediately on connect, failure or cancellation. Safe to repeat. */
  readonly stop: () => void;
  /** Stops playback and makes subsequent starts inert. Use for owner cleanup. */
  readonly dispose: () => void;
}

function createStartupPlayer(choice: AudibleChoice): StartupPlayer {
  // Original oscillator/noise synthesis, with no samples or external recordings.
  const source: number =
    choice === "ringing"
      ? require("./assets/startup-ringback.wav")
      : require("./assets/startup-jazz.wav");
  return createAudioPlayer(source, {
    // No deferred download/replace that could revive a stopped player.
    downloadFirst: false,
    // Pausing this loop must not deactivate the WebRTC call's audio session.
    keepAudioSessionActive: true,
  });
}

/**
 * Owns only the startup loop. The call controller owns audio mode and routing.
 * Every operation is synchronous; releasing a player also cancels pending loading.
 * Player failures leave startup silent and never prevent the call from connecting.
 */
export function createVoiceStartupAudio(
  createPlayer: (choice: AudibleChoice) => StartupPlayer = createStartupPlayer,
): VoiceStartupAudio {
  let active: { readonly choice: AudibleChoice; readonly player: StartupPlayer } | null = null;
  let disposed = false;

  const stop = () => {
    const current = active;
    active = null;
    if (!current) return;
    try {
      current.player.pause();
    } catch {
      // Still release if the native player has already failed.
    }
    try {
      current.player.remove();
    } catch {
      // Cleanup may run after the native player was released.
    }
    try {
      // remove() unregisters the player; release() tears down its native resources.
      current.player.release();
    } catch {
      // A previously released shared object needs no further cleanup.
    }
  };

  return {
    start: (choice) => {
      if (disposed || active?.choice === choice) return;
      stop();
      if (choice === "silence") return;
      try {
        const player = createPlayer(choice);
        active = { choice, player };
        player.loop = true;
        player.volume = 0.35;
        player.play();
      } catch {
        stop();
      }
    },
    stop,
    dispose: () => {
      disposed = true;
      stop();
    },
  };
}
