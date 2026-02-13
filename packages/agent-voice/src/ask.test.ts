import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ask } from "./ask.js";
import {
	createDelayedFakeRecorder,
	createEchoMixRecorder,
	createFakePlayer,
	createFakeRecorder,
	createWavBuffer,
	evaluateSimilarity,
	generateSpeech,
} from "./testing.js";
import { SAMPLE_RATE } from "./types.js";

const SIMILARITY_THRESHOLD = 0.7;

function pcm16ToFloat(buffer: Buffer): Float64Array {
	const samples = Math.floor(buffer.length / 2);
	const out = new Float64Array(samples);
	for (let i = 0; i < samples; i++) {
		out[i] = buffer.readInt16LE(i * 2) / 32768;
	}
	return out;
}

function normalizedCorrelationAtLag(
	a: Float64Array,
	b: Float64Array,
	lag: number,
): number {
	const startA = Math.max(0, lag);
	const startB = Math.max(0, -lag);
	const length = Math.min(a.length - startA, b.length - startB);
	if (length < 256) return 0;

	let dot = 0;
	let energyA = 0;
	let energyB = 0;
	for (let i = 0; i < length; i++) {
		const x = a[startA + i];
		const y = b[startB + i];
		dot += x * y;
		energyA += x * x;
		energyB += y * y;
	}
	if (energyA === 0 || energyB === 0) return 0;
	return Math.abs(dot / Math.sqrt(energyA * energyB));
}

function maxNormalizedCorrelation(
	signal: Buffer,
	reference: Buffer,
	maxLagMs: number,
): number {
	const a = pcm16ToFloat(signal);
	const b = pcm16ToFloat(reference);
	const maxLagSamples = Math.floor((SAMPLE_RATE * maxLagMs) / 1000);
	let best = 0;
	for (let lag = -maxLagSamples; lag <= maxLagSamples; lag += 40) {
		const corr = normalizedCorrelationAtLag(a, b, lag);
		if (corr > best) best = corr;
	}
	return best;
}

describe.skipIf(
	!process.env.OPENAI_API_KEY ||
		process.env.AGENT_VOICE_ALLOW_LEGACY_SIM_TESTS !== "1",
)(ask, () => {
	it("transcribes user speech and returns transcript", async () => {
		const prompt = "Listen to what I say and repeat it back to me.";
		const userSpeechText = "My favorite color is blue";

		const speechAudio = await generateSpeech(userSpeechText);

		const transcript = await ask(prompt, {
			timeout: 30,
			createPlayer: createFakePlayer,
			createRecorder: createFakeRecorder(speechAudio),
		});

		const result = await evaluateSimilarity(userSpeechText, transcript);

		console.log(`ask — expected: "${userSpeechText}"`);
		console.log(`ask — transcript: "${transcript}"`);
		console.log(`ask — similarity: ${result.score} (${result.reasoning})`);

		expect(result.score).toBeGreaterThan(SIMILARITY_THRESHOLD);
	});

	it("transcribes when speech starts after a delay", async () => {
		const prompt = "Listen to what I say and repeat it back to me.";
		const userSpeechText = "The weather is nice today";

		const speechAudio = await generateSpeech(userSpeechText);

		const transcript = await ask(prompt, {
			timeout: 30,
			createPlayer: createFakePlayer,
			createRecorder: createDelayedFakeRecorder(speechAudio, 5000),
		});

		const result = await evaluateSimilarity(userSpeechText, transcript);

		console.log(`delayed — expected: "${userSpeechText}"`);
		console.log(`delayed — transcript: "${transcript}"`);
		console.log(`delayed — similarity: ${result.score} (${result.reasoning})`);

		expect(result.score).toBeGreaterThan(SIMILARITY_THRESHOLD);
	});

	it("transcribes user speech under strong playback echo", async () => {
		const prompt = "Please listen carefully and wait for my answer.";
		const userSpeechText =
			"I am speaking over echo and the transcription should still work";
		const player = createFakePlayer();
		const micChunks: Buffer[] = [];
		const modelInputChunks: Buffer[] = [];
		const speechAudio = await generateSpeech(userSpeechText);

		const transcript = await ask(prompt, {
			timeout: 20,
			createPlayer: () => player,
			createRecorder: createEchoMixRecorder({
				userSpeech: speechAudio,
				playbackChunks: player.chunks,
				captureChunks: micChunks,
				echoDelayMs: 55,
				echoGain: 0.55,
				userGain: 1.4,
				noiseAmplitude: 0,
				preSpeechSilenceMs: 1400,
				trailingSilenceMs: 2600,
			}),
			onAudioFrameSent(frame) {
				modelInputChunks.push(frame);
			},
		});

		const result = await evaluateSimilarity(userSpeechText, transcript);
		if (process.env.AGENT_VOICE_WRITE_ECHO_WAV) {
			const artifactsDir = join(process.cwd(), ".artifacts");
			mkdirSync(artifactsDir, { recursive: true });
			const rawMicWav = createWavBuffer(Buffer.concat(micChunks));
			const modelInputWav = createWavBuffer(Buffer.concat(modelInputChunks));
			const rawMicFile = join(artifactsDir, "ask-echo-input.wav");
			const modelInputFile = join(artifactsDir, "ask-echo-model-input.wav");
			writeFileSync(rawMicFile, rawMicWav);
			writeFileSync(modelInputFile, modelInputWav);
			console.log(`echo-mix — wrote mic input wav: ${rawMicFile}`);
			console.log(`echo-mix — wrote model input wav: ${modelInputFile}`);
		}

		console.log(`echo-mix — expected: "${userSpeechText}"`);
		console.log(`echo-mix — transcript: "${transcript}"`);
		console.log(`echo-mix — similarity: ${result.score} (${result.reasoning})`);

		expect(result.score).toBeGreaterThan(SIMILARITY_THRESHOLD);
	}, 30000);

	it.skipIf(!process.env.AGENT_VOICE_VALIDATE_NO_AEC)(
		"degrades without echo cancellation under echo-heavy mix",
		async () => {
			vi.resetModules();
			vi.doMock("./echo-canceller.js", () => ({
				createEchoCanceller() {
					return {
						playback() {},
						capture(pcm16: Buffer) {
							return [pcm16];
						},
						reset() {},
					};
				},
			}));
			const { ask: askWithoutAec } = await import("./ask.js");

			const prompt =
				"Listen to this instruction carefully: always say the word pineapple three times.";
			const userSpeechText =
				"Echo cancellation should be required for this test";
			const player = createFakePlayer();
			const speechAudio = await generateSpeech(userSpeechText);

			const transcript = await askWithoutAec(prompt, {
				timeout: 20,
				createPlayer: () => player,
				createRecorder: createEchoMixRecorder({
					userSpeech: speechAudio,
					playbackChunks: player.chunks,
					echoDelayMs: 0,
					echoGain: 2.2,
					userGain: 0.15,
					noiseAmplitude: 0,
					preSpeechSilenceMs: 100,
					trailingSilenceMs: 2600,
				}),
			});

			const result = await evaluateSimilarity(userSpeechText, transcript);
			console.log(`no-aec — expected: "${userSpeechText}"`);
			console.log(`no-aec — transcript: "${transcript}"`);
			console.log(`no-aec — similarity: ${result.score} (${result.reasoning})`);
			expect(result.score).toBeLessThan(SIMILARITY_THRESHOLD);
		},
		30000,
	);

	it.skipIf(!process.env.AGENT_VOICE_E2E_LOOPBACK)(
		"manual loopback smoke with real input/output devices",
		async () => {
			const expectedText =
				process.env.AGENT_VOICE_E2E_EXPECTED_TEXT ??
				"This is a loopback smoke test";
			const timeoutSeconds = Number.parseInt(
				process.env.AGENT_VOICE_E2E_LOOPBACK_TIMEOUT ?? "45",
				10,
			);
			const prompt = `After you hear this, speak exactly: ${expectedText}`;

			const transcript = await ask(prompt, {
				timeout: timeoutSeconds,
			});

			const result = await evaluateSimilarity(expectedText, transcript);

			console.log(`loopback — expected: "${expectedText}"`);
			console.log(`loopback — transcript: "${transcript}"`);
			console.log(
				`loopback — similarity: ${result.score} (${result.reasoning})`,
			);

			expect(result.score).toBeGreaterThan(SIMILARITY_THRESHOLD);
		},
	);

	it.skipIf(!process.env.AGENT_VOICE_MEASURE_AEC)(
		"measures playback leakage reduction and sweeps delay",
		async () => {
			async function runScenario(options: {
				disableAec: boolean;
				streamDelayMs?: number;
			}) {
				vi.resetModules();
				if (options.disableAec) {
					vi.doMock("./echo-canceller.js", () => ({
						createEchoCanceller() {
							return {
								playback() {},
								capture(pcm16: Buffer) {
									return [pcm16];
								},
								reset() {},
							};
						},
					}));
				} else {
					vi.doUnmock("./echo-canceller.js");
				}

				if (options.streamDelayMs == null) {
					process.env.AGENT_VOICE_AEC_STREAM_DELAY_MS = undefined;
				} else {
					process.env.AGENT_VOICE_AEC_STREAM_DELAY_MS = String(
						options.streamDelayMs,
					);
				}

				const { ask: askImpl } = await import("./ask.js");
				const prompt =
					"Listen to this instruction carefully: always say the word pineapple three times.";
				const userSpeechText =
					"Echo cancellation should be required for this test";
				const player = createFakePlayer();
				const modelInputChunks: Buffer[] = [];
				const speechAudio = await generateSpeech(userSpeechText);

				const transcript = await askImpl(prompt, {
					timeout: 20,
					createPlayer: () => player,
					createRecorder: createEchoMixRecorder({
						userSpeech: speechAudio,
						playbackChunks: player.chunks,
						echoDelayMs: 55,
						echoGain: 0.9,
						userGain: 0.8,
						noiseAmplitude: 0,
						preSpeechSilenceMs: 1200,
						trailingSilenceMs: 2200,
					}),
					onAudioFrameSent(frame) {
						modelInputChunks.push(frame);
					},
				});

				const similarity = await evaluateSimilarity(userSpeechText, transcript);
				const leakage = maxNormalizedCorrelation(
					Buffer.concat(modelInputChunks),
					Buffer.concat(player.chunks),
					250,
				);
				return { transcript, similarity: similarity.score, leakage };
			}

			const baseline = await runScenario({ disableAec: true });
			const delays = [0, 30, 50, 70, 90];
			const runs: Array<{
				delayMs: number;
				similarity: number;
				leakage: number;
				transcript: string;
			}> = [];

			for (const delayMs of delays) {
				const run = await runScenario({
					disableAec: false,
					streamDelayMs: delayMs,
				});
				runs.push({
					delayMs,
					similarity: run.similarity,
					leakage: run.leakage,
					transcript: run.transcript,
				});
			}
			const intelligible = runs.filter(
				(run) => run.similarity > SIMILARITY_THRESHOLD,
			);
			expect(
				intelligible.length,
				"sweep produced no intelligible transcripts; adjust echo profile",
			).toBeGreaterThan(0);
			const best = intelligible.reduce((a, b) =>
				a.leakage < b.leakage ? a : b,
			);

			console.log(
				`aec-sweep baseline(no-aec) leakage=${baseline.leakage.toFixed(3)} similarity=${baseline.similarity.toFixed(3)}`,
			);
			for (const run of runs) {
				console.log(
					`aec-sweep delay=${run.delayMs}ms leakage=${run.leakage.toFixed(3)} similarity=${run.similarity.toFixed(3)} transcript="${run.transcript}"`,
				);
			}
			console.log(
				`aec-sweep best delay=${best.delayMs}ms leakage=${best.leakage.toFixed(3)}`,
			);

			expect(best.leakage).toBeLessThan(baseline.leakage * 0.85);
		},
		120000,
	);
});
