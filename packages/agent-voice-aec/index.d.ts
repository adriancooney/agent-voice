export class EchoCanceller {
	constructor(frameSize: number, filterLength: number, sampleRate: number);
	playback(frame: Buffer): void;
	capture(frame: Buffer): Buffer;
	reset(): void;
}
