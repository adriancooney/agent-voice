import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock config module before importing daemon-log
vi.mock("./config.js", () => {
	let debugEnabled = false;
	let debugAudioEnabled = false;
	let ringBufferSize = 50;
	let logDir = "";
	let audioLogDir = "";
	let eventsLogPath = "";

	return {
		get LOG_DIR() {
			return logDir;
		},
		get AUDIO_LOG_DIR() {
			return audioLogDir;
		},
		get EVENTS_LOG_PATH() {
			return eventsLogPath;
		},
		isDebugEnabled: () => debugEnabled,
		isDebugAudioEnabled: () => debugAudioEnabled,
		resolveDaemonConfig: () => ({
			idleTimeoutMinutes: 30,
			audioRingBufferSize: ringBufferSize,
		}),
		__setTestPaths(base: string) {
			logDir = join(base, "logs");
			audioLogDir = join(logDir, "audio");
			eventsLogPath = join(logDir, "events.ndjson");
		},
		__setDebug(enabled: boolean) {
			debugEnabled = enabled;
		},
		__setDebugAudio(enabled: boolean) {
			debugAudioEnabled = enabled;
		},
		__setRingBufferSize(size: number) {
			ringBufferSize = size;
		},
	};
});

// eslint-disable-next-line @typescript-eslint/consistent-type-imports
let configMock: typeof import("./config.js") & {
	__setTestPaths(base: string): void;
	__setDebug(enabled: boolean): void;
	__setDebugAudio(enabled: boolean): void;
	__setRingBufferSize(size: number): void;
};

let mod: typeof import("./daemon-log.js");
let testDir: string;

beforeEach(async () => {
	testDir = mkdtempSync(join(tmpdir(), "daemon-log-test-"));
	configMock = (await import("./config.js")) as typeof configMock;
	configMock.__setTestPaths(testDir);
	configMock.__setDebug(false);
	configMock.__setDebugAudio(false);
	mod = await import("./daemon-log.js");
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("appendLogEntry", () => {
	it("writes nothing when debug is disabled", () => {
		mod.appendLogEntry({
			ts: "2026-01-01T00:00:00.000Z",
			cmd: "say",
			id: "abc",
			event: "start",
		});
		const logDir = join(testDir, "logs");
		expect(() => readFileSync(join(logDir, "events.ndjson"))).toThrow();
	});

	it("appends NDJSON when debug is enabled", () => {
		configMock.__setDebug(true);
		mod.appendLogEntry({
			ts: "2026-01-01T00:00:00.000Z",
			cmd: "say",
			id: "abc",
			event: "start",
		});
		mod.appendLogEntry({
			ts: "2026-01-01T00:00:00.100Z",
			cmd: "say",
			id: "abc",
			event: "done",
		});

		const content = readFileSync(
			join(testDir, "logs", "events.ndjson"),
			"utf-8",
		);
		const lines = content.trim().split("\n");
		expect(lines).toHaveLength(2);
		expect(JSON.parse(lines[0])).toMatchObject({ event: "start" });
		expect(JSON.parse(lines[1])).toMatchObject({ event: "done" });
	});
});

describe("createCommandLogger", () => {
	it("logs trace events with command context", () => {
		configMock.__setDebug(true);
		const logger = mod.createCommandLogger("ask", "test-id");
		logger.trace({ atMs: 50, event: "realtime:connected" });

		const content = readFileSync(
			join(testDir, "logs", "events.ndjson"),
			"utf-8",
		);
		const entry = JSON.parse(content.trim());
		expect(entry.cmd).toBe("ask");
		expect(entry.id).toBe("test-id");
		expect(entry.event).toBe("realtime:connected");
		expect(entry.detail).toMatchObject({ atMs: 50 });
	});
});

describe("writeAudioCapture", () => {
	it("writes nothing when debug.audio is disabled", () => {
		configMock.__setDebug(true);
		const result = mod.writeAudioCapture("test-id", {
			assistant: [Buffer.from([0, 0])],
		});
		expect(result).toEqual([]);
	});

	it("writes WAV files when debug.audio is enabled", () => {
		configMock.__setDebugAudio(true);
		const pcm16 = Buffer.alloc(4800); // 100ms of silence at 24kHz
		const result = mod.writeAudioCapture("test-id", {
			assistant: [pcm16],
			mic: [pcm16],
		});
		expect(result).toHaveLength(2);

		for (const path of result) {
			const wav = readFileSync(path);
			// Check RIFF header
			expect(wav.subarray(0, 4).toString()).toBe("RIFF");
			expect(wav.subarray(8, 12).toString()).toBe("WAVE");
			// Data size should be pcm16 length
			expect(wav.readUInt32LE(40)).toBe(pcm16.length);
		}
	});

	it("skips empty streams", () => {
		configMock.__setDebugAudio(true);
		const result = mod.writeAudioCapture("test-id", {
			assistant: [Buffer.from([0, 0])],
			mic: [],
		});
		expect(result).toHaveLength(1);
		expect(result[0]).toContain("assistant");
	});

	it("enforces ring buffer limit", () => {
		configMock.__setDebugAudio(true);
		configMock.__setRingBufferSize(3);

		// Write 5 commands worth of audio
		for (let i = 0; i < 5; i++) {
			mod.writeAudioCapture(`cmd-${String(i).padStart(3, "0")}`, {
				assistant: [Buffer.from([0, 0])],
			});
		}

		const files = readdirSync(join(testDir, "logs", "audio"));
		const ids = new Set(files.map((f) => f.replace(/-assistant\.wav$/, "")));
		expect(ids.size).toBeLessThanOrEqual(3);
		// Should keep the most recent ones
		expect(ids.has("cmd-004")).toBe(true);
		expect(ids.has("cmd-003")).toBe(true);
		expect(ids.has("cmd-002")).toBe(true);
	});
});
