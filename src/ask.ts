import {
	type AudioPlayer,
	type AudioRecorder,
	createAudioPlayer,
	createAudioRecorder,
} from "./audio.js";
import type { AuthConfig } from "./config.js";
import { createRealtimeSession } from "./realtime.js";
import { DEFAULT_VOICE } from "./types.js";

export type AskOptions = {
	voice?: string;
	timeout?: number;
	ack?: boolean;
	auth?: AuthConfig;
	createPlayer?: () => AudioPlayer;
	createRecorder?: () => AudioRecorder;
};

export async function ask(
	message: string,
	options: AskOptions = {},
): Promise<string> {
	const {
		voice = DEFAULT_VOICE,
		timeout = 30,
		ack = false,
		auth,
		createPlayer = createAudioPlayer,
		createRecorder = createAudioRecorder,
	} = options;

	const player = createPlayer();
	player.start();

	return new Promise<string>((resolve, reject) => {
		let recorder: AudioRecorder | null = null;
		let transcript = "";
		let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
		let speechDetected = false;
		let cleaned = false;
		let resolved = false;

		async function cleanup() {
			if (cleaned) return;
			cleaned = true;
			if (timeoutTimer) clearTimeout(timeoutTimer);
			recorder?.stop();
			recorder?.close();
			await player.drain();
			session.close();
		}

		function finish() {
			if (resolved) return;
			resolved = true;
			cleanup().then(() => resolve(transcript));
		}

		const session = createRealtimeSession({
			voice,
			mode: "default",
			ack,
			auth,
			onAudioDelta(pcm16) {
				player.write(pcm16);
			},
			onTranscript(text) {
				transcript = text;
				if (!ack) finish();
			},
			onSpeechStarted() {
				speechDetected = true;
				if (timeoutTimer) {
					clearTimeout(timeoutTimer);
					timeoutTimer = null;
				}
			},
			onInitialResponseDone() {
				// Delay mic start to let speaker buffer drain and avoid echo
				setTimeout(() => {
					recorder = createRecorder();
					recorder.onData((pcm16) => {
						session.sendAudio(pcm16);
					});
					recorder.start();
				}, 500);

				timeoutTimer = setTimeout(() => {
					if (!speechDetected) {
						cleanup();
						reject(new Error(`No speech detected within ${timeout}s timeout`));
					}
				}, timeout * 1000);
			},
			onDone() {
				if (ack) finish();
			},
			async onError(error) {
				await cleanup();
				reject(new Error(error));
			},
		});

		session.connect().then(() => {
			session.sendMessage(message);
		}, reject);
	});
}
