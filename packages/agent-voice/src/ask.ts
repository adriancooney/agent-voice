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
	readProcessedCapture(maxFrames?: number): Buffer[];
	readRawCapture(maxFrames?: number): Buffer[];
	setStreamDelayMs(delayMs: number): void;
	getStats(): {
		captureFrames: number;
		processedFrames: number;
		playbackUnderruns: number;
		droppedRawFrames: number;
		droppedProcessedFrames: number;
	};
};

export type AskOptions = {
	voice?: string;
	timeout?: number;
	ack?: boolean;
	auth?: AuthConfig;
	createPlayer?: unknown;
	createRecorder?: unknown;
	onAudioFrameSent?: (pcm16: Buffer) => void;
	onAssistantAudio?: (pcm16: Buffer) => void;
	onMicAudio?: (pcm16: Buffer) => void;
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
		onAudioFrameSent,
		onAssistantAudio,
		onMicAudio,
	} = options;

	const { AudioEngine } = require("agent-voice-audio") as {
		AudioEngine: new (options?: {
			sampleRate?: number;
			channels?: number;
			enableAec?: boolean;
			streamDelayMs?: number;
			maxCaptureFrames?: number;
		}) => RustAudioEngine;
	};

	const streamDelayMs = Number.parseInt(
		process.env.AGENT_VOICE_AEC_STREAM_DELAY_MS ?? "30",
		10,
	);

	const engine = new AudioEngine({
		sampleRate: SAMPLE_RATE,
		channels: 1,
		enableAec: true,
		streamDelayMs,
	});
	engine.start();

	const debug = process.env.AGENT_VOICE_DEBUG_ASK_EVENTS === "1";
	const startMs = Date.now();
	function logEvent(event: string, detail?: string) {
		if (!debug) return;
		const elapsed = Date.now() - startMs;
		const suffix = detail ? ` ${detail}` : "";
		process.stderr.write(`[ask ${elapsed}ms] ${event}${suffix}\n`);
	}
	logEvent("start");

	return new Promise<string>((resolve, reject) => {
		let transcript = "";
		let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
		let responseStartTimer: ReturnType<typeof setTimeout> | null = null;
		let transcriptTimer: ReturnType<typeof setTimeout> | null = null;
		let capturePollTimer: ReturnType<typeof setInterval> | null = null;
		let speechDetected = false;
		let initialResponseDone = false;
		let heardAssistantAudio = false;
		let lastAssistantAudioAt = 0;
		let cleaned = false;
		let settled = false;

		async function cleanup() {
			if (cleaned) return;
			cleaned = true;
			logEvent("cleanup:start");
			if (timeoutTimer) clearTimeout(timeoutTimer);
			if (responseStartTimer) clearTimeout(responseStartTimer);
			if (transcriptTimer) clearTimeout(transcriptTimer);
			if (capturePollTimer) clearInterval(capturePollTimer);
			try {
				engine.stop();
				engine.close();
			} catch {}
			session.close();
			logEvent("cleanup:done");
		}

		function resolveOnce(value: string) {
			if (settled) return;
			settled = true;
			cleanup().then(() => resolve(value));
		}

		function rejectOnce(error: Error) {
			if (settled) return;
			settled = true;
			cleanup().then(() => reject(error));
		}

		capturePollTimer = setInterval(() => {
			if (settled) return;
			let rawFrames: Buffer[] = [];
			let processedFrames: Buffer[] = [];
			try {
				rawFrames = engine.readRawCapture(64);
				processedFrames = engine.readProcessedCapture(64);
			} catch (err) {
				rejectOnce(
					new Error(
						`audio engine capture read failed: ${
							err instanceof Error ? err.message : String(err)
						}`,
					),
				);
				return;
			}

			for (const frame of rawFrames) onMicAudio?.(frame);
			if (!heardAssistantAudio) return;
			for (const frame of processedFrames) {
				onAudioFrameSent?.(frame);
				session.sendAudio(frame);
			}
		}, 10);

		const session = createRealtimeSession({
			voice,
			mode: "default",
			ack,
			auth,
			onAudioDelta(pcm16) {
				logEvent("realtime:audio_delta", `bytes=${pcm16.length}`);
				heardAssistantAudio = true;
				lastAssistantAudioAt = Date.now();
				onAssistantAudio?.(pcm16);
				engine.play(pcm16);
			},
			onTranscript(text) {
				const echoGuardMs = Number.parseInt(
					process.env.AGENT_VOICE_ECHO_GUARD_MS ?? "1500",
					10,
				);
				const sinceAssistantMs = Date.now() - lastAssistantAudioAt;
				if (heardAssistantAudio && sinceAssistantMs < echoGuardMs) {
					logEvent(
						"realtime:transcript_ignored_echo_guard",
						`since_assistant_ms=${sinceAssistantMs} text=\"${text}\"`,
					);
					return;
				}
				logEvent("realtime:transcript", `text=\"${text}\"`);
				if (transcriptTimer) {
					clearTimeout(transcriptTimer);
					transcriptTimer = null;
				}
				transcript = text;
				if (!ack) resolveOnce(transcript);
			},
			onSpeechStarted() {
				logEvent("realtime:speech_started");
				speechDetected = true;
				if (timeoutTimer) {
					clearTimeout(timeoutTimer);
					timeoutTimer = null;
				}
				if (transcriptTimer) clearTimeout(transcriptTimer);
				transcriptTimer = setTimeout(() => {
					logEvent("timeout:no_transcript_after_speech");
					rejectOnce(
						new Error(
							`No transcript received within ${timeout}s after speech started`,
						),
					);
				}, timeout * 1000);

				if (!initialResponseDone && heardAssistantAudio) {
					try {
						engine.play(Buffer.alloc(0));
					} catch {}
				}
			},
			onInitialResponseDone() {
				logEvent("realtime:initial_response_done");
				initialResponseDone = true;
				timeoutTimer = setTimeout(() => {
					if (!speechDetected) {
						logEvent("timeout:no_speech");
						rejectOnce(
							new Error(`No speech detected within ${timeout}s timeout`),
						);
					}
				}, timeout * 1000);
			},
			onDone() {
				logEvent("realtime:done");
				if (ack) resolveOnce(transcript);
			},
			onError(error) {
				logEvent("realtime:error", error);
				rejectOnce(new Error(error));
			},
		});

		session.connect().then(
			() => {
				logEvent("realtime:connected");
				logEvent("realtime:send_message");
				session.sendMessage(message);
				responseStartTimer = setTimeout(() => {
					if (!heardAssistantAudio) {
						logEvent("timeout:no_assistant_audio");
						rejectOnce(
							new Error("No assistant audio received after sending message"),
						);
					}
				}, 10000);
			},
			(err) => {
				logEvent(
					"realtime:connect_error",
					err instanceof Error ? err.message : String(err),
				);
				rejectOnce(err instanceof Error ? err : new Error(String(err)));
			},
		);
	});
}
