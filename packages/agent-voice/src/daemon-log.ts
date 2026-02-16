import {
	appendFileSync,
	mkdirSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
	AUDIO_LOG_DIR,
	EVENTS_LOG_PATH,
	LOG_DIR,
	isDebugAudioEnabled,
	isDebugEnabled,
	resolveDaemonConfig,
} from "./config.js";
import { BIT_DEPTH, CHANNELS, SAMPLE_RATE } from "./types.js";

export type LogEntry = {
	ts: string;
	cmd: string;
	id: string;
	event: string;
	detail?: Record<string, unknown>;
};

function ensureLogDir(): void {
	mkdirSync(LOG_DIR, { recursive: true });
}

function ensureAudioDir(): void {
	mkdirSync(AUDIO_LOG_DIR, { recursive: true });
}

export function appendLogEntry(entry: LogEntry): void {
	if (!isDebugEnabled()) return;
	ensureLogDir();
	appendFileSync(EVENTS_LOG_PATH, `${JSON.stringify(entry)}\n`);
}

export function createCommandLogger(cmd: string, id: string) {
	const startMs = Date.now();

	return {
		log(event: string, detail?: Record<string, unknown>) {
			appendLogEntry({
				ts: new Date().toISOString(),
				cmd,
				id,
				event,
				detail,
			});
		},
		trace(event: {
			atMs: number;
			event: string;
			detail?: Record<string, unknown>;
		}) {
			appendLogEntry({
				ts: new Date().toISOString(),
				cmd,
				id,
				event: event.event,
				detail: { ...event.detail, atMs: event.atMs },
			});
		},
		get startMs() {
			return startMs;
		},
	};
}

function createWavBuffer(pcm16: Buffer): Buffer {
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

export function writeAudioCapture(
	id: string,
	streams: Record<string, Buffer[]>,
): string[] {
	if (!isDebugAudioEnabled()) return [];
	ensureAudioDir();

	const written: string[] = [];
	for (const [name, chunks] of Object.entries(streams)) {
		if (chunks.length === 0) continue;
		const path = join(AUDIO_LOG_DIR, `${id}-${name}.wav`);
		writeFileSync(path, createWavBuffer(Buffer.concat(chunks)));
		written.push(path);
	}

	enforceRingBuffer();
	return written;
}

function enforceRingBuffer(): void {
	const { audioRingBufferSize } = resolveDaemonConfig();
	let files: string[];
	try {
		files = readdirSync(AUDIO_LOG_DIR)
			.filter((f) => f.endsWith(".wav"))
			.sort();
	} catch {
		return;
	}

	// Group by command ID (everything before the last dash-separated suffix)
	const commandIds = new Set<string>();
	for (const file of files) {
		const match = file.match(/^(.+)-(?:assistant|mic|model-input)\.wav$/);
		if (match) commandIds.add(match[1]);
	}

	const ids = [...commandIds].sort();
	const excess = ids.length - audioRingBufferSize;
	if (excess <= 0) return;

	const idsToRemove = new Set(ids.slice(0, excess));
	for (const file of files) {
		const match = file.match(/^(.+)-(?:assistant|mic|model-input)\.wav$/);
		if (match && idsToRemove.has(match[1])) {
			try {
				rmSync(join(AUDIO_LOG_DIR, file));
			} catch {}
		}
	}
}
