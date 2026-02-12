import { AudioIO, SampleFormat16Bit } from "naudiodon2";
import { CHANNELS, SAMPLE_RATE } from "./types.js";

export type AudioPlayer = {
	write(pcm16: Buffer): boolean;
	start(): void;
	drain(): Promise<void>;
	close(): void;
};

export type AudioRecorder = {
	onData(cb: (pcm16: Buffer) => void): void;
	start(): void;
	stop(): void;
	close(): void;
};

export function createAudioPlayer(): AudioPlayer {
	const stream = AudioIO({
		outOptions: {
			channelCount: CHANNELS,
			sampleFormat: SampleFormat16Bit,
			sampleRate: SAMPLE_RATE,
			closeOnError: true,
		},
	});

	let closed = false;

	return {
		write(pcm16: Buffer) {
			return stream.write(pcm16);
		},
		start() {
			stream.start();
		},
		drain() {
			if (closed) return Promise.resolve();
			closed = true;
			return new Promise<void>((resolve) => {
				stream.quit(() => resolve());
			});
		},
		close() {
			if (closed) return;
			closed = true;
			stream.quit();
		},
	};
}

export function createAudioRecorder(): AudioRecorder {
	const stream = AudioIO({
		inOptions: {
			channelCount: CHANNELS,
			sampleFormat: SampleFormat16Bit,
			sampleRate: SAMPLE_RATE,
			closeOnError: true,
		},
	});

	let stopped = false;

	return {
		onData(cb: (pcm16: Buffer) => void) {
			stream.on("data", cb);
		},
		start() {
			stream.start();
		},
		stop() {
			if (stopped) return;
			stopped = true;
			stream.quit();
		},
		close() {
			if (stopped) return;
			stopped = true;
			stream.quit();
		},
	};
}
