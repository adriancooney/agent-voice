export type AudioEngineOptions = {
	sampleRate?: number;
	channels?: number;
	enableAec?: boolean;
	streamDelayMs?: number;
	maxCaptureFrames?: number;
};

export type AudioEngineStats = {
	captureFrames: number;
	processedFrames: number;
	playbackUnderruns: number;
	pendingPlaybackSamples: number;
	droppedRawFrames: number;
	droppedProcessedFrames: number;
};

export class AudioEngine {
	constructor(options?: AudioEngineOptions);
	start(): void;
	stop(): void;
	close(): void;
	play(pcm16: Buffer): void;
	readProcessedCapture(maxFrames?: number): Buffer[];
	readRawCapture(maxFrames?: number): Buffer[];
	setStreamDelayMs(delayMs: number): void;
	getStats(): AudioEngineStats;
}
