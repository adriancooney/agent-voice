import { type AudioPlayer, createAudioPlayer } from "./audio.js";
import type { AuthConfig } from "./config.js";
import { createRealtimeSession } from "./realtime.js";

export type SayOptions = {
	voice?: string;
	auth?: AuthConfig;
	createPlayer?: () => AudioPlayer;
};

export async function say(
	message: string,
	options: SayOptions = {},
): Promise<void> {
	const { voice = "ash", auth, createPlayer = createAudioPlayer } = options;

	const player = createPlayer();
	player.start();

	return new Promise<void>((resolve, reject) => {
		let cleaned = false;

		function cleanup() {
			if (cleaned) return;
			cleaned = true;
			session.close();
		}

		const session = createRealtimeSession({
			voice,
			mode: "say",
			ack: false,
			auth,
			onAudioDelta(pcm16) {
				player.write(pcm16);
			},
			onTranscript() {},
			onSpeechStarted() {},
			async onInitialResponseDone() {
				try {
					await player.drain();
				} catch {
					player.close();
				}
				cleanup();
				resolve();
			},
			onDone() {},
			onError(error) {
				player.close();
				cleanup();
				reject(new Error(error));
			},
		});

		session.connect().then(() => {
			session.sendMessage(message);
		}, reject);
	});
}
