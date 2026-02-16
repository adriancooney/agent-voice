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

function pcm16Rms(pcm16: Buffer): number {
	const samples = Math.floor(pcm16.length / 2);
	if (samples === 0) return 0;
	let sumSquares = 0;
	for (let i = 0; i < samples; i++) {
		const value = pcm16.readInt16LE(i * 2);
		sumSquares += value * value;
	}
	return Math.sqrt(sumSquares / samples);
}

function readEnvInt(name: string, fallback: number): number {
	const raw = process.env[name];
	if (raw == null) return fallback;
	const parsed = Number.parseInt(raw, 10);
	return Number.isFinite(parsed) ? parsed : fallback;
}

export type AskOptions = {
	voice?: string;
	timeout?: number;
	ack?: boolean;
	auth?: AuthConfig;
	createSession?: (options: RealtimeSessionOptions) => RealtimeSession;
	createAudioEngine?: (options: {
		sampleRate?: number;
		channels?: number;
		enableAec?: boolean;
		streamDelayMs?: number;
		maxCaptureFrames?: number;
	}) => RustAudioEngine;
	onTrace?: (event: {
		atMs: number;
		event: string;
		detail?: Record<string, unknown>;
	}) => void;
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
		createSession,
		createAudioEngine,
		onTrace,
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

	const streamDelayMs = readEnvInt("AGENT_VOICE_AEC_STREAM_DELAY_MS", 30);

	const engine = (
		createAudioEngine ?? ((engineOptions) => new AudioEngine(engineOptions))
	)({
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
	function trace(event: string, detail?: Record<string, unknown>) {
		onTrace?.({ atMs: Date.now() - startMs, event, detail });
	}
	logEvent("start");
	trace("start");

	return new Promise<string>((resolve, reject) => {
		let transcript = "";
		let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
		let responseStartTimer: ReturnType<typeof setTimeout> | null = null;
		let transcriptTimer: ReturnType<typeof setTimeout> | null = null;
		let capturePollTimer: ReturnType<typeof setInterval> | null = null;
		let speechDetected = false;
		let speechStartedAtMs = 0;
		let initialResponseDone = false;
		let heardAssistantAudio = false;
		let lastAssistantAudioAt = 0;
		let nearEndEvidenceSeen = false;
		let nearEndEvidenceAtMs = 0;
		let nearEndEvidenceConfirmed = false;
		let cleaned = false;
		let settled = false;

		async function cleanup() {
			if (cleaned) return;
			cleaned = true;
			logEvent("cleanup:start");
			trace("cleanup:start");
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
			trace("cleanup:done");
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
				trace("audio:capture_read_error", {
					error: err instanceof Error ? err.message : String(err),
				});
				return;
			}

			for (const frame of rawFrames) onMicAudio?.(frame);
			if (!heardAssistantAudio) return;
			for (const frame of processedFrames) {
				const rms = pcm16Rms(frame);
				const configuredMinSpeechRms = readEnvInt(
					"AGENT_VOICE_MIN_SPEECH_RMS",
					220,
				);
				const relaxAfterMs = readEnvInt(
					"AGENT_VOICE_MIN_SPEECH_RMS_RELAX_AFTER_MS",
					500,
				);
				const relaxedMinSpeechRms = readEnvInt(
					"AGENT_VOICE_MIN_SPEECH_RMS_RELAXED",
					120,
				);
				const minSpeechRms =
					speechDetected &&
					speechStartedAtMs > 0 &&
					Date.now() - speechStartedAtMs >= relaxAfterMs
						? relaxedMinSpeechRms
						: configuredMinSpeechRms;
				if (rms >= minSpeechRms) {
					nearEndEvidenceSeen = true;
					nearEndEvidenceAtMs = Date.now();
					if (!nearEndEvidenceConfirmed && speechStartedAtMs > 0) {
						const evidencePreRollMs = readEnvInt(
							"AGENT_VOICE_SPEECH_EVIDENCE_PREROLL_MS",
							200,
						);
						const evidencePostRollMs = readEnvInt(
							"AGENT_VOICE_SPEECH_EVIDENCE_POSTROLL_MS",
							1500,
						);
						if (
							nearEndEvidenceAtMs >= speechStartedAtMs - evidencePreRollMs &&
							nearEndEvidenceAtMs <= speechStartedAtMs + evidencePostRollMs
						) {
							nearEndEvidenceConfirmed = true;
						}
					}
					trace("audio:near_end_evidence", { rms, minSpeechRms });
				}
				onAudioFrameSent?.(frame);
				session.sendAudio(frame);
			}
			if (processedFrames.length > 0) {
				trace("audio:sent_capture", { frames: processedFrames.length });
			}
		}, 10);

		const session = (createSession ?? createRealtimeSession)({
			voice,
			mode: "default",
			ack,
			auth,
			onAudioDelta(pcm16) {
				logEvent("realtime:audio_delta", `bytes=${pcm16.length}`);
				trace("realtime:audio_delta", { bytes: pcm16.length });
				heardAssistantAudio = true;
				lastAssistantAudioAt = Date.now();
				onAssistantAudio?.(pcm16);
				engine.play(pcm16);
			},
			onTranscript(text) {
				const echoGuardMs = readEnvInt("AGENT_VOICE_ECHO_GUARD_MS", 1500);
				const sinceAssistantMs = Date.now() - lastAssistantAudioAt;
				if (heardAssistantAudio && sinceAssistantMs < echoGuardMs) {
					logEvent(
						"realtime:transcript_ignored_echo_guard",
						`since_assistant_ms=${sinceAssistantMs} text=\"${text}\"`,
					);
					trace("realtime:transcript_ignored_echo_guard", {
						sinceAssistantMs,
						text,
					});
					return;
				}
				logEvent("realtime:transcript", `text=\"${text}\"`);
				trace("realtime:transcript", { text });
				if (speechDetected && !nearEndEvidenceConfirmed) {
					trace("realtime:transcript_ignored_no_near_end_evidence", {
						text,
						speechStartedAtMs,
						nearEndEvidenceSeen,
						nearEndEvidenceAtMs,
					});
					return;
				}
				if (transcriptTimer) {
					clearTimeout(transcriptTimer);
					transcriptTimer = null;
				}
				transcript = text;
				if (!ack) resolveOnce(transcript);
			},
			onSpeechStarted() {
				logEvent("realtime:speech_started");
				trace("realtime:speech_started");
				speechDetected = true;
				speechStartedAtMs = Date.now();
				if (nearEndEvidenceSeen && !nearEndEvidenceConfirmed) {
					const evidencePreRollMs = readEnvInt(
						"AGENT_VOICE_SPEECH_EVIDENCE_PREROLL_MS",
						200,
					);
					if (nearEndEvidenceAtMs >= speechStartedAtMs - evidencePreRollMs) {
						nearEndEvidenceConfirmed = true;
					}
				}
				if (timeoutTimer) {
					clearTimeout(timeoutTimer);
					timeoutTimer = null;
				}
				if (transcriptTimer) clearTimeout(transcriptTimer);
				transcriptTimer = setTimeout(() => {
					logEvent("timeout:no_transcript_after_speech");
					trace("timeout:no_transcript_after_speech", {
						timeoutSeconds: timeout,
					});
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
				trace("realtime:initial_response_done");
				initialResponseDone = true;
				timeoutTimer = setTimeout(() => {
					if (!speechDetected) {
						logEvent("timeout:no_speech");
						trace("timeout:no_speech", { timeoutSeconds: timeout });
						rejectOnce(
							new Error(`No speech detected within ${timeout}s timeout`),
						);
					}
				}, timeout * 1000);
			},
			onDone() {
				logEvent("realtime:done");
				trace("realtime:done");
				if (ack) resolveOnce(transcript);
			},
			onError(error) {
				logEvent("realtime:error", error);
				trace("realtime:error", { error });
				rejectOnce(new Error(error));
			},
		});

		session.connect().then(
			() => {
				logEvent("realtime:connected");
				trace("realtime:connected");
				logEvent("realtime:send_message");
				trace("realtime:send_message");
				session.sendMessage(message);
				responseStartTimer = setTimeout(() => {
					if (!heardAssistantAudio) {
						logEvent("timeout:no_assistant_audio");
						trace("timeout:no_assistant_audio");
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
				trace("realtime:connect_error", {
					error: err instanceof Error ? err.message : String(err),
				});
				rejectOnce(err instanceof Error ? err : new Error(String(err)));
			},
		);
	});
}
