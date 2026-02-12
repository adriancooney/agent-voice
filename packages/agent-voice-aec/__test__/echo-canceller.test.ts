import { describe, expect, it } from "vitest";
import { EchoCanceller } from "../index.js";

const FRAME_SIZE = 480;
const FILTER_LENGTH = 4800;
const SAMPLE_RATE = 24000;
const FRAME_BYTES = FRAME_SIZE * 2;

function createToneFrame(
	frequency: number,
	sampleRate: number,
	frameIndex: number,
): Buffer {
	const buf = Buffer.alloc(FRAME_BYTES);
	const samplesOffset = frameIndex * FRAME_SIZE;
	for (let i = 0; i < FRAME_SIZE; i++) {
		const t = (samplesOffset + i) / sampleRate;
		const value = Math.round(Math.sin(2 * Math.PI * frequency * t) * 16000);
		buf.writeInt16LE(value, i * 2);
	}
	return buf;
}

function rms(buf: Buffer): number {
	let sum = 0;
	const samples = buf.length / 2;
	for (let i = 0; i < samples; i++) {
		const sample = buf.readInt16LE(i * 2);
		sum += sample * sample;
	}
	return Math.sqrt(sum / samples);
}

describe("EchoCanceller", () => {
	it("outputs silence when fed silence", () => {
		const aec = new EchoCanceller(FRAME_SIZE, FILTER_LENGTH, SAMPLE_RATE);
		const silence = Buffer.alloc(FRAME_BYTES);

		aec.playback(silence);
		const out = aec.capture(silence);

		expect(out.length).toBe(FRAME_BYTES);
		expect(rms(out)).toBeLessThan(10);
	});

	it("suppresses echo from playback in capture", () => {
		const aec = new EchoCanceller(FRAME_SIZE, FILTER_LENGTH, SAMPLE_RATE);

		// Feed several frames to let the filter converge
		const convergenceFrames = 50;
		for (let i = 0; i < convergenceFrames; i++) {
			const tone = createToneFrame(440, SAMPLE_RATE, i);
			aec.playback(tone);
			// Simulate echo: mic picks up the same tone
			aec.capture(tone);
		}

		// Now measure: feed a tone to playback, same tone to capture
		const testFrame = createToneFrame(440, SAMPLE_RATE, convergenceFrames);
		aec.playback(testFrame);
		const out = aec.capture(testFrame);

		const inputRms = rms(testFrame);
		const outputRms = rms(out);

		// Echo should be significantly attenuated
		expect(outputRms).toBeLessThan(inputRms * 0.5);
	});

	it("throws on wrong playback frame size", () => {
		const aec = new EchoCanceller(FRAME_SIZE, FILTER_LENGTH, SAMPLE_RATE);

		expect(() => aec.playback(Buffer.alloc(100))).toThrow(
			`playback frame must be ${FRAME_BYTES} bytes, got 100`,
		);
	});

	it("throws on wrong capture frame size", () => {
		const aec = new EchoCanceller(FRAME_SIZE, FILTER_LENGTH, SAMPLE_RATE);

		expect(() => aec.capture(Buffer.alloc(100))).toThrow(
			`capture frame must be ${FRAME_BYTES} bytes, got 100`,
		);
	});

	it("resets state cleanly", () => {
		const aec = new EchoCanceller(FRAME_SIZE, FILTER_LENGTH, SAMPLE_RATE);

		// Train the filter
		for (let i = 0; i < 20; i++) {
			const tone = createToneFrame(440, SAMPLE_RATE, i);
			aec.playback(tone);
			aec.capture(tone);
		}

		aec.reset();

		// After reset, should behave like a fresh instance
		const silence = Buffer.alloc(FRAME_BYTES);
		aec.playback(silence);
		const out = aec.capture(silence);
		expect(rms(out)).toBeLessThan(10);
	});

	it("throws on invalid constructor args", () => {
		expect(() => new EchoCanceller(0, FILTER_LENGTH, SAMPLE_RATE)).toThrow();
		expect(() => new EchoCanceller(FRAME_SIZE, 0, SAMPLE_RATE)).toThrow();
		expect(() => new EchoCanceller(FRAME_SIZE, FILTER_LENGTH, 0)).toThrow();
	});
});
