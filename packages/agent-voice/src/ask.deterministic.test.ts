import { afterEach, describe, expect, it } from "vitest";
import { ask } from "./ask.js";
import type { RealtimeSession, RealtimeSessionOptions } from "./realtime.js";

class FakeCaptureEngine {
	private processedQueue: Buffer[] = [];
	private rawQueue: Buffer[] = [];
	start() {}
	stop() {}
	close() {}
	play() {}
	pushProcessedFrame(frame: Buffer) {
		this.processedQueue.push(frame);
	}
	pushRawFrame(frame: Buffer) {
		this.rawQueue.push(frame);
	}
	readProcessedCapture() {
		if (this.processedQueue.length === 0) return [] as Buffer[];
		const out = this.processedQueue;
		this.processedQueue = [];
		return out;
	}
	readRawCapture() {
		if (this.rawQueue.length === 0) return [] as Buffer[];
		const out = this.rawQueue;
		this.rawQueue = [];
		return out;
	}
	setStreamDelayMs() {}
	getStats() {
		return {
			captureFrames: 0,
			processedFrames: 0,
			playbackUnderruns: 0,
			droppedRawFrames: 0,
			droppedProcessedFrames: 0,
		};
	}
}

function createScriptedSession(
	script: (options: RealtimeSessionOptions) => void,
): (options: RealtimeSessionOptions) => RealtimeSession {
	return (options) => ({
		connect: async () => {},
		sendMessage() {
			script(options);
		},
		sendAudio() {},
		close() {},
	});
}

const originalEchoGuard = process.env.AGENT_VOICE_ECHO_GUARD_MS;
const originalMinSpeechRms = process.env.AGENT_VOICE_MIN_SPEECH_RMS;
const originalEvidenceWindow =
	process.env.AGENT_VOICE_SPEECH_EVIDENCE_WINDOW_MS;

function createSpeechLikeFrame(sampleCount = 1600, amplitude = 3000): Buffer {
	const out = Buffer.alloc(sampleCount * 2);
	for (let i = 0; i < sampleCount; i++) {
		const sample = i % 2 === 0 ? amplitude : -amplitude;
		out.writeInt16LE(sample, i * 2);
	}
	return out;
}

afterEach(() => {
	if (originalEchoGuard == null) {
		Reflect.deleteProperty(process.env, "AGENT_VOICE_ECHO_GUARD_MS");
	} else {
		process.env.AGENT_VOICE_ECHO_GUARD_MS = originalEchoGuard;
	}
	if (originalMinSpeechRms == null) {
		Reflect.deleteProperty(process.env, "AGENT_VOICE_MIN_SPEECH_RMS");
	} else {
		process.env.AGENT_VOICE_MIN_SPEECH_RMS = originalMinSpeechRms;
	}
	if (originalEvidenceWindow == null) {
		Reflect.deleteProperty(
			process.env,
			"AGENT_VOICE_SPEECH_EVIDENCE_WINDOW_MS",
		);
	} else {
		process.env.AGENT_VOICE_SPEECH_EVIDENCE_WINDOW_MS = originalEvidenceWindow;
	}
});

describe("ask deterministic", () => {
	it("ignores transcripts during echo-guard window and times out on silence", async () => {
		const trace: string[] = [];
		const promise = ask("question", {
			timeout: 0.2,
			createAudioEngine: () => new FakeCaptureEngine(),
			createSession: createScriptedSession((options) => {
				setTimeout(() => options.onAudioDelta(Buffer.alloc(3200)), 10);
				setTimeout(() => options.onInitialResponseDone(), 20);
				setTimeout(
					() => options.onTranscript("assistant leaked transcript"),
					30,
				);
			}),
			onTrace(event) {
				trace.push(event.event);
			},
		});

		await expect(promise).rejects.toThrow(
			"No speech detected within 0.2s timeout",
		);
		expect(trace).toContain("realtime:transcript_ignored_echo_guard");
	});

	it("accepts transcript once outside echo-guard window", async () => {
		process.env.AGENT_VOICE_ECHO_GUARD_MS = "80";
		const engine = new FakeCaptureEngine();

		const transcript = await ask("question", {
			timeout: 1,
			createAudioEngine: () => engine,
			createSession: createScriptedSession((options) => {
				setTimeout(() => options.onAudioDelta(Buffer.alloc(3200)), 10);
				setTimeout(() => options.onInitialResponseDone(), 20);
				setTimeout(
					() => engine.pushProcessedFrame(createSpeechLikeFrame()),
					30,
				);
				setTimeout(() => options.onSpeechStarted(), 40);
				setTimeout(() => options.onTranscript("real user response"), 180);
			}),
		});

		expect(transcript).toBe("real user response");
	});

	it("does not accept assistant self-audio as barge-in answer", async () => {
		process.env.AGENT_VOICE_ECHO_GUARD_MS = "80";

		const promise = ask("question", {
			timeout: 0.2,
			createAudioEngine: () => new FakeCaptureEngine(),
			createSession: createScriptedSession((options) => {
				setTimeout(() => options.onAudioDelta(Buffer.alloc(3200)), 10);
				setTimeout(() => options.onInitialResponseDone(), 20);
				// False barge-in from leaked assistant playback.
				setTimeout(() => options.onSpeechStarted(), 40);
				// Delayed leaked transcript should still be treated as self-hearing, not answer.
				setTimeout(
					() => options.onTranscript("should not be accepted as user answer"),
					180,
				);
			}),
		});

		await expect(promise).rejects.toThrow(
			"No transcript received within 0.2s after speech started",
		);
	});

	it("accepts transcript when user speaks a long sentence (evidence drifts past postroll)", async () => {
		process.env.AGENT_VOICE_ECHO_GUARD_MS = "80";
		process.env.AGENT_VOICE_SPEECH_EVIDENCE_POSTROLL_MS = "1500";
		const engine = new FakeCaptureEngine();

		const transcript = await ask("question", {
			timeout: 5,
			createAudioEngine: () => engine,
			createSession: createScriptedSession((options) => {
				// Assistant speaks
				setTimeout(() => options.onAudioDelta(Buffer.alloc(3200)), 10);
				setTimeout(() => options.onInitialResponseDone(), 20);

				// User starts speaking — near-end evidence before speechStarted
				setTimeout(
					() => engine.pushProcessedFrame(createSpeechLikeFrame()),
					200,
				);
				setTimeout(() => options.onSpeechStarted(), 250);

				// User continues speaking for a long time — evidence keeps updating
				for (let i = 300; i <= 3000; i += 100) {
					setTimeout(
						() => engine.pushProcessedFrame(createSpeechLikeFrame()),
						i,
					);
				}

				// Transcript arrives well after postroll window
				// nearEndEvidenceAtMs will have drifted to ~3000ms
				// which is past speechStartedAtMs + 1500ms postroll
				setTimeout(
					() => options.onTranscript("this is a long user response"),
					3200,
				);
			}),
		});

		expect(transcript).toBe("this is a long user response");
	});

	it("keeps self-hearing false-positive rate at 0/20 across barge-in timing jitter", async () => {
		process.env.AGENT_VOICE_ECHO_GUARD_MS = "80";
		process.env.AGENT_VOICE_MIN_SPEECH_RMS = "550";
		process.env.AGENT_VOICE_SPEECH_EVIDENCE_WINDOW_MS = "1200";

		let accepted = 0;
		for (let i = 0; i < 20; i++) {
			const transcriptDelayMs = 120 + ((i * 23) % 120);
			try {
				await ask("question", {
					timeout: 0.25,
					createAudioEngine: () => new FakeCaptureEngine(),
					createSession: createScriptedSession((options) => {
						setTimeout(() => options.onAudioDelta(Buffer.alloc(3200)), 10);
						setTimeout(() => options.onInitialResponseDone(), 20);
						setTimeout(() => options.onSpeechStarted(), 40);
						setTimeout(
							() => options.onTranscript("assistant self-heard transcript"),
							transcriptDelayMs,
						);
					}),
				});
				accepted += 1;
			} catch {}
		}

		expect(accepted).toBe(0);
	});
});
