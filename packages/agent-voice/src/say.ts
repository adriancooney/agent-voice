import { createRequire } from "node:module";
import type { AuthConfig } from "./config.js";
import { createRealtimeSession } from "./realtime.js";
import { DEFAULT_VOICE, SAMPLE_RATE } from "./types.js";

const require = createRequire(import.meta.url);

type RustAudioEngine = {
	start(): void;
	stop(): void;
	close(): void;
	play(pcm16: Buffer): void;
};

export type SayOptions = {
	voice?: string;
	auth?: AuthConfig;
	createPlayer?: unknown;
};

export async function say(
	message: string,
	options: SayOptions = {},
): Promise<void> {
	const { voice = DEFAULT_VOICE, auth } = options;
	const { AudioEngine } = require("agent-voice-audio") as {
		AudioEngine: new (options?: {
			sampleRate?: number;
			channels?: number;
			enableAec?: boolean;
			streamDelayMs?: number;
		}) => RustAudioEngine;
	};

	const engine = new AudioEngine({
		sampleRate: SAMPLE_RATE,
		channels: 1,
		enableAec: false,
	});
	engine.start();

	return new Promise<void>((resolve, reject) => {
		let cleaned = false;
		let settled = false;
		let responseDoneFallbackTimer: ReturnType<typeof setTimeout> | null = null;
		let completionTailTimer: ReturnType<typeof setTimeout> | null = null;

		function cleanup() {
			if (cleaned) return;
			cleaned = true;
			if (responseDoneFallbackTimer) clearTimeout(responseDoneFallbackTimer);
			if (completionTailTimer) clearTimeout(completionTailTimer);
			try {
				engine.stop();
				engine.close();
			} catch {}
			session.close();
		}

		function resolveOnce() {
			if (settled) return;
			settled = true;
			cleanup();
			resolve();
		}

		function rejectOnce(error: Error) {
			if (settled) return;
			settled = true;
			cleanup();
			reject(error);
		}

		function scheduleTailResolve(delayMs: number) {
			if (settled) return;
			if (completionTailTimer) clearTimeout(completionTailTimer);
			completionTailTimer = setTimeout(() => {
				resolveOnce();
			}, delayMs);
		}

		const session = createRealtimeSession({
			voice,
			mode: "say",
			ack: false,
			auth,
			onAudioDelta(pcm16) {
				engine.play(pcm16);
			},
			onAudioDone() {
				// Preferred completion signal: all response audio chunks delivered.
				scheduleTailResolve(140);
			},
			onTranscript() {},
			onSpeechStarted() {},
			onInitialResponseDone() {
				// Fallback if response.audio.done is delayed or missing.
				if (responseDoneFallbackTimer) clearTimeout(responseDoneFallbackTimer);
				responseDoneFallbackTimer = setTimeout(() => {
					scheduleTailResolve(220);
				}, 700);
			},
			onDone() {},
			onError(error) {
				rejectOnce(new Error(error));
			},
		});

		session.connect().then(() => {
			session.sendMessage(message);
		}, reject);
	});
}
