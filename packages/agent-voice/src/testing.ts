import OpenAI, { toFile } from "openai";
import type { AudioPlayer, AudioRecorder } from "./audio.js";
import { BIT_DEPTH, CHANNELS, SAMPLE_RATE } from "./types.js";

let _openai: OpenAI;
function openai() {
	if (!_openai) _openai = new OpenAI();
	return _openai;
}

export function createDeferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

export function createWavBuffer(pcm16: Buffer): Buffer {
	const header = Buffer.alloc(44);
	const dataSize = pcm16.length;
	const fileSize = 36 + dataSize;
	const byteRate = SAMPLE_RATE * CHANNELS * (BIT_DEPTH / 8);
	const blockAlign = CHANNELS * (BIT_DEPTH / 8);

	header.write("RIFF", 0);
	header.writeUInt32LE(fileSize, 4);
	header.write("WAVE", 8);
	header.write("fmt ", 12);
	header.writeUInt32LE(16, 16);
	header.writeUInt16LE(1, 20);
	header.writeUInt16LE(CHANNELS, 22);
	header.writeUInt32LE(SAMPLE_RATE, 24);
	header.writeUInt32LE(byteRate, 28);
	header.writeUInt16LE(blockAlign, 32);
	header.writeUInt16LE(BIT_DEPTH, 34);
	header.write("data", 36);
	header.writeUInt32LE(dataSize, 40);

	return Buffer.concat([header, pcm16]);
}

export async function transcribeAudio(pcm16: Buffer): Promise<string> {
	const wav = createWavBuffer(pcm16);
	const file = await toFile(wav, "audio.wav");
	const result = await openai().audio.transcriptions.create({
		model: "whisper-1",
		file,
	});
	return result.text;
}

export async function generateSpeech(text: string): Promise<Buffer> {
	const response = await openai().audio.speech.create({
		model: "tts-1",
		voice: "alloy",
		input: text,
		response_format: "pcm",
	});
	return Buffer.from(await response.arrayBuffer());
}

export async function evaluateSimilarity(
	expected: string,
	actual: string,
): Promise<{ score: number; reasoning: string }> {
	const response = await openai().chat.completions.create({
		model: "gpt-4o-mini",
		messages: [
			{
				role: "system",
				content:
					'You evaluate semantic similarity between two texts. Score from 0.0 to 1.0 where 1.0 means identical meaning and 0.0 means completely unrelated. Minor wording differences, punctuation, and capitalization differences should not reduce the score significantly. Return JSON: { "score": number, "reasoning": string }',
			},
			{
				role: "user",
				content: `Expected: "${expected}"\nActual: "${actual}"`,
			},
		],
		response_format: { type: "json_object" },
	});
	const content = response.choices[0].message.content;
	if (!content) throw new Error("No content in similarity evaluation response");
	return JSON.parse(content);
}

export function createSilence(durationSeconds: number): Buffer {
	const numSamples = SAMPLE_RATE * durationSeconds;
	return Buffer.alloc(numSamples * (BIT_DEPTH / 8) * CHANNELS);
}

export function createFakePlayer(): AudioPlayer & { chunks: Buffer[] } {
	const chunks: Buffer[] = [];
	return {
		chunks,
		write(pcm16: Buffer) {
			chunks.push(pcm16);
			return true;
		},
		start() {},
		drain() {
			return Promise.resolve();
		},
		close() {},
	};
}

export function createFakeRecorder(
	audio: Buffer,
	chunkInterval = 50,
): () => AudioRecorder {
	return () => {
		let cb: ((pcm16: Buffer) => void) | null = null;
		let timer: ReturnType<typeof setInterval> | null = null;

		return {
			onData(callback: (pcm16: Buffer) => void) {
				cb = callback;
			},
			start() {
				const bytesPerChunk = SAMPLE_RATE * 2 * (chunkInterval / 1000);
				let offset = 0;

				timer = setInterval(() => {
					if (!cb || offset >= audio.length) {
						if (timer) clearInterval(timer);
						// Feed trailing silence so VAD detects end of speech
						const silence = createSilence(2);
						cb?.(silence);
						return;
					}
					const end = Math.min(offset + bytesPerChunk, audio.length);
					cb(audio.subarray(offset, end));
					offset = end;
				}, chunkInterval);
			},
			stop() {
				if (timer) clearInterval(timer);
			},
			close() {
				if (timer) clearInterval(timer);
			},
		};
	};
}

export function createDelayedFakeRecorder(
	audio: Buffer,
	delayMs: number,
	chunkInterval = 50,
): () => AudioRecorder {
	return () => {
		let cb: ((pcm16: Buffer) => void) | null = null;
		let timer: ReturnType<typeof setInterval> | null = null;
		let delayTimer: ReturnType<typeof setTimeout> | null = null;

		return {
			onData(callback: (pcm16: Buffer) => void) {
				cb = callback;
			},
			start() {
				delayTimer = setTimeout(() => {
					const bytesPerChunk = SAMPLE_RATE * 2 * (chunkInterval / 1000);
					let offset = 0;

					timer = setInterval(() => {
						if (!cb || offset >= audio.length) {
							if (timer) clearInterval(timer);
							const silence = createSilence(2);
							cb?.(silence);
							return;
						}
						const end = Math.min(offset + bytesPerChunk, audio.length);
						cb(audio.subarray(offset, end));
						offset = end;
					}, chunkInterval);
				}, delayMs);
			},
			stop() {
				if (delayTimer) clearTimeout(delayTimer);
				if (timer) clearInterval(timer);
			},
			close() {
				if (delayTimer) clearTimeout(delayTimer);
				if (timer) clearInterval(timer);
			},
		};
	};
}

type EchoMixRecorderOptions = {
	userSpeech: Buffer;
	playbackChunks: Buffer[];
	captureChunks?: Buffer[];
	chunkInterval?: number;
	echoDelayMs?: number;
	echoGain?: number;
	userGain?: number;
	noiseAmplitude?: number;
	preSpeechSilenceMs?: number;
	trailingSilenceMs?: number;
};

function clampPcm16(value: number): number {
	if (value > 32767) return 32767;
	if (value < -32768) return -32768;
	return value;
}

export function createEchoMixRecorder({
	userSpeech,
	playbackChunks,
	captureChunks,
	chunkInterval = 50,
	echoDelayMs = 60,
	echoGain = 0.8,
	userGain = 1,
	noiseAmplitude = 200,
	preSpeechSilenceMs = 1200,
	trailingSilenceMs = 1800,
}: EchoMixRecorderOptions): () => AudioRecorder {
	return () => {
		let cb: ((pcm16: Buffer) => void) | null = null;
		let timer: ReturnType<typeof setInterval> | null = null;
		let emittedSamples = 0;
		let chunkIndex = 0;
		let playbackAudio = Buffer.alloc(0);
		let sentTrailingSilence = false;

		const bytesPerChunk = SAMPLE_RATE * 2 * (chunkInterval / 1000);
		const samplesPerChunk = Math.floor(bytesPerChunk / 2);
		const userSamples = Math.floor(userSpeech.length / 2);
		const preSpeechSamples = Math.floor(
			(SAMPLE_RATE * preSpeechSilenceMs) / 1000,
		);
		const trailingSamples = Math.floor(
			(SAMPLE_RATE * trailingSilenceMs) / 1000,
		);
		const stopAfterSamples = preSpeechSamples + userSamples + trailingSamples;
		const echoDelaySamples = Math.floor((SAMPLE_RATE * echoDelayMs) / 1000);

		function syncPlaybackAudio() {
			if (chunkIndex >= playbackChunks.length) return;
			playbackAudio = Buffer.concat([
				playbackAudio,
				...playbackChunks.slice(chunkIndex),
			]);
			chunkIndex = playbackChunks.length;
		}

		function readPlaybackSample(sampleIdx: number): number {
			if (sampleIdx < 0) return 0;
			const byteOffset = sampleIdx * 2;
			if (byteOffset + 2 > playbackAudio.length) return 0;
			return playbackAudio.readInt16LE(byteOffset);
		}

		return {
			onData(callback: (pcm16: Buffer) => void) {
				cb = callback;
			},
			start() {
				timer = setInterval(() => {
					if (!cb) return;

					if (emittedSamples >= stopAfterSamples) {
						if (!sentTrailingSilence) {
							sentTrailingSilence = true;
							cb(createSilence(2));
						}
						if (timer) clearInterval(timer);
						return;
					}

					syncPlaybackAudio();
					const out = Buffer.alloc(samplesPerChunk * 2);

					for (let i = 0; i < samplesPerChunk; i++) {
						const sampleIdx = emittedSamples + i;
						const userIdx = sampleIdx - preSpeechSamples;
						const echoIdx = sampleIdx - echoDelaySamples;

						const userSample =
							userIdx >= 0 && userIdx < userSamples
								? userSpeech.readInt16LE(userIdx * 2)
								: 0;
						const echoSample = readPlaybackSample(echoIdx);
						const noise =
							noiseAmplitude > 0 ? (Math.random() * 2 - 1) * noiseAmplitude : 0;

						const mixed = clampPcm16(
							Math.round(echoSample * echoGain + userSample * userGain + noise),
						);
						out.writeInt16LE(mixed, i * 2);
					}

					emittedSamples += samplesPerChunk;
					captureChunks?.push(out);
					cb(out);
				}, chunkInterval);
			},
			stop() {
				if (timer) clearInterval(timer);
			},
			close() {
				if (timer) clearInterval(timer);
			},
		};
	};
}
