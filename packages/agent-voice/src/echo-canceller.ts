import { EchoCanceller } from "agent-voice-aec";
import { SAMPLE_RATE } from "./types.js";

const FRAME_SIZE = 480;
const FILTER_LENGTH = 4800;
const FRAME_BYTES = FRAME_SIZE * 2;

export type FrameAlignedAec = {
	playback(pcm16: Buffer): void;
	capture(pcm16: Buffer): Buffer[];
	reset(): void;
};

export function createEchoCanceller(): FrameAlignedAec {
	const aec = new EchoCanceller(FRAME_SIZE, FILTER_LENGTH, SAMPLE_RATE);
	let playbackBuffer = Buffer.alloc(0);
	let captureBuffer = Buffer.alloc(0);

	return {
		playback(pcm16: Buffer) {
			playbackBuffer = Buffer.concat([playbackBuffer, pcm16]);

			while (playbackBuffer.length >= FRAME_BYTES) {
				aec.playback(playbackBuffer.subarray(0, FRAME_BYTES));
				playbackBuffer = playbackBuffer.subarray(FRAME_BYTES);
			}
		},

		capture(pcm16: Buffer): Buffer[] {
			captureBuffer = Buffer.concat([captureBuffer, pcm16]);
			const frames: Buffer[] = [];

			while (captureBuffer.length >= FRAME_BYTES) {
				const out = aec.capture(captureBuffer.subarray(0, FRAME_BYTES));
				frames.push(out);
				captureBuffer = captureBuffer.subarray(FRAME_BYTES);
			}

			return frames;
		},

		reset() {
			aec.reset();
			playbackBuffer = Buffer.alloc(0);
			captureBuffer = Buffer.alloc(0);
		},
	};
}
