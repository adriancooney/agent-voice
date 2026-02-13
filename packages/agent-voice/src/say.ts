import { createRequire } from "node:module";
import type { AuthConfig } from "./config.js";
import {
	type RealtimeSession,
	type RealtimeSessionOptions,
	createRealtimeSession,
} from "./realtime.js";
import { DEFAULT_VOICE, SAMPLE_RATE } from "./types.js";

const require = createRequire(import.meta.url);

type RustAudioEngine = {
	start(): void;
	stop(): void;
	close(): void;
	play(pcm16: Buffer): void;
	getStats?(): {
		pendingPlaybackSamples?: number;
	};
};

export type SayOptions = {
	voice?: string;
	auth?: AuthConfig;
	createSession?: (options: RealtimeSessionOptions) => RealtimeSession;
	createAudioEngine?: (options: {
		sampleRate?: number;
		channels?: number;
		enableAec?: boolean;
		streamDelayMs?: number;
	}) => RustAudioEngine;
	onTrace?: (event: {
		atMs: number;
		event: string;
		detail?: Record<string, unknown>;
	}) => void;
	createPlayer?: unknown;
};

export async function say(
	message: string,
	options: SayOptions = {},
): Promise<void> {
	const {
		voice = DEFAULT_VOICE,
		auth,
		createSession,
		createAudioEngine,
		onTrace,
	} = options;
	const { AudioEngine } = require("agent-voice-audio") as {
		AudioEngine: new (options?: {
			sampleRate?: number;
			channels?: number;
			enableAec?: boolean;
			streamDelayMs?: number;
		}) => RustAudioEngine;
	};

	const startMs = Date.now();
	function trace(event: string, detail?: Record<string, unknown>) {
		onTrace?.({ atMs: Date.now() - startMs, event, detail });
	}

	const engine = (
		createAudioEngine ?? ((engineOptions) => new AudioEngine(engineOptions))
	)({
		sampleRate: SAMPLE_RATE,
		channels: 1,
		enableAec: false,
	});
	engine.start();
	trace("start");

	return new Promise<void>((resolve, reject) => {
		let cleaned = false;
		let settled = false;
		let responseDoneFallbackTimer: ReturnType<typeof setTimeout> | null = null;
		let completionTailTimer: ReturnType<typeof setTimeout> | null = null;
		let drainPollTimer: ReturnType<typeof setInterval> | null = null;
		let drainDeadlineTimer: ReturnType<typeof setTimeout> | null = null;

		function cleanup() {
			if (cleaned) return;
			cleaned = true;
			if (responseDoneFallbackTimer) clearTimeout(responseDoneFallbackTimer);
			if (completionTailTimer) clearTimeout(completionTailTimer);
			if (drainPollTimer) clearInterval(drainPollTimer);
			if (drainDeadlineTimer) clearTimeout(drainDeadlineTimer);
			try {
				engine.stop();
				engine.close();
			} catch {}
			session.close();
			trace("cleanup");
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

		function waitForPlaybackDrain() {
			if (settled) return;
			if (!engine.getStats) {
				trace("drain:no_stats");
				resolveOnce();
				return;
			}

			const absoluteDeadlineMs = 20000;
			const maxNoProgressMs = 1200;
			const drainStartMs = Date.now();
			let lastProgressAtMs = drainStartMs;
			let lastPending = Number.POSITIVE_INFINITY;
			trace("drain:deadline_scheduled", {
				absoluteDeadlineMs,
				maxNoProgressMs,
			});

			let zeroStreak = 0;
			drainPollTimer = setInterval(() => {
				if (settled) return;
				let pending = 0;
				try {
					pending = Number(engine.getStats?.().pendingPlaybackSamples ?? 0);
				} catch {
					pending = 0;
				}
				trace("drain:poll", { pendingPlaybackSamples: pending });
				if (pending < lastPending) {
					lastPending = pending;
					lastProgressAtMs = Date.now();
				}
				if (pending <= 0) {
					zeroStreak += 1;
					if (zeroStreak >= 3) {
						resolveOnce();
					}
					return;
				}
				zeroStreak = 0;
				if (Date.now() - lastProgressAtMs > maxNoProgressMs) {
					trace("drain:no_progress_timeout", {
						pendingPlaybackSamples: pending,
					});
					resolveOnce();
				}
			}, 20);

			drainDeadlineTimer = setTimeout(() => {
				trace("drain:deadline");
				resolveOnce();
			}, absoluteDeadlineMs);
		}

		function scheduleTailResolve(delayMs: number) {
			if (settled) return;
			if (completionTailTimer) clearTimeout(completionTailTimer);
			completionTailTimer = setTimeout(() => {
				waitForPlaybackDrain();
			}, delayMs);
			trace("tail_scheduled", { delayMs });
		}

		const session = (createSession ?? createRealtimeSession)({
			voice,
			mode: "say",
			ack: false,
			auth,
			onAudioDelta(pcm16) {
				engine.play(pcm16);
				trace("realtime:audio_delta", { bytes: pcm16.length });
			},
			onAudioDone() {
				// Preferred completion signal: all response audio chunks delivered.
				scheduleTailResolve(140);
				trace("realtime:audio_done");
			},
			onTranscript() {},
			onSpeechStarted() {},
			onInitialResponseDone() {
				// Fallback if response.audio.done is delayed or missing.
				if (responseDoneFallbackTimer) clearTimeout(responseDoneFallbackTimer);
				responseDoneFallbackTimer = setTimeout(() => {
					scheduleTailResolve(220);
				}, 700);
				trace("realtime:initial_response_done");
			},
			onDone() {},
			onError(error) {
				trace("realtime:error", { error });
				rejectOnce(new Error(error));
			},
		});

		session.connect().then(() => {
			trace("realtime:connected");
			session.sendMessage(message);
		}, reject);
	});
}
