import { describe, expect, it } from "vitest";
import type { RealtimeSession, RealtimeSessionOptions } from "./realtime.js";
import { say } from "./say.js";

class FakePlaybackEngine {
	private pendingPlaybackSamples = 0;
	private drainTimer: ReturnType<typeof setInterval> | null = null;
	stoppedPendingPlaybackSamples = -1;

	constructor(private readonly drainSamplesPerTick: number) {}

	start() {
		this.drainTimer = setInterval(() => {
			this.pendingPlaybackSamples = Math.max(
				0,
				this.pendingPlaybackSamples - this.drainSamplesPerTick,
			);
		}, 20);
	}

	stop() {
		this.stoppedPendingPlaybackSamples = this.pendingPlaybackSamples;
		if (this.drainTimer) clearInterval(this.drainTimer);
		this.drainTimer = null;
	}

	close() {
		if (this.drainTimer) clearInterval(this.drainTimer);
		this.drainTimer = null;
	}

	play(pcm16: Buffer) {
		this.pendingPlaybackSamples += Math.floor(pcm16.length / 2);
	}

	getStats() {
		return { pendingPlaybackSamples: this.pendingPlaybackSamples };
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

describe("say deterministic", () => {
	it("waits for playback drain after audio.done before closing engine", async () => {
		const engine = new FakePlaybackEngine(240);
		const startedAt = Date.now();

		await say("hello", {
			createAudioEngine: () => engine,
			createSession: createScriptedSession((options) => {
				options.onAudioDelta(Buffer.alloc(16_000));
				setTimeout(() => {
					options.onAudioDone?.();
				}, 10);
			}),
		});

		const elapsedMs = Date.now() - startedAt;
		expect(elapsedMs).toBeGreaterThanOrEqual(500);
		expect(engine.stoppedPendingPlaybackSamples).toBe(0);
	});

	it("uses response.done fallback path when audio.done never arrives", async () => {
		const engine = new FakePlaybackEngine(320);
		const startedAt = Date.now();

		await say("fallback", {
			createAudioEngine: () => engine,
			createSession: createScriptedSession((options) => {
				options.onAudioDelta(Buffer.alloc(12_000));
				setTimeout(() => {
					options.onInitialResponseDone();
				}, 10);
			}),
		});

		const elapsedMs = Date.now() - startedAt;
		expect(elapsedMs).toBeGreaterThanOrEqual(900);
		expect(engine.stoppedPendingPlaybackSamples).toBe(0);
	});

	it("does not cut off when playback drain takes longer than 2s", async () => {
		const engine = new FakePlaybackEngine(50);

		await say("long tail", {
			createAudioEngine: () => engine,
			createSession: createScriptedSession((options) => {
				options.onAudioDelta(Buffer.alloc(12_000));
				setTimeout(() => {
					options.onAudioDone?.();
				}, 10);
			}),
		});

		expect(engine.stoppedPendingPlaybackSamples).toBe(0);
	});
});
