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

function removedLegacyBackendError(): Error {
	return new Error(
		"Legacy PortAudio backend has been removed. Use the default Rust audio backend.",
	);
}

export function createAudioPlayer(): AudioPlayer {
	throw removedLegacyBackendError();
}

export function createAudioRecorder(): AudioRecorder {
	throw removedLegacyBackendError();
}
