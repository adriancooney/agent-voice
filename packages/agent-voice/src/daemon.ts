import { rmSync } from "node:fs";
import { createRequire } from "node:module";
import { type Socket, createServer } from "node:net";
import {
	DAEMON_SOCKET_PATH,
	resolveAuth,
	resolveDaemonConfig,
} from "./config.js";
import { removeDaemonPid, writeDaemonPid } from "./daemon-lifecycle.js";
import { createCommandLogger, writeAudioCapture } from "./daemon-log.js";
import {
	type DaemonRequest,
	DaemonRequest as DaemonRequestSchema,
	type DaemonResponse,
	createMessageParser,
	encodeMessage,
} from "./daemon-protocol.js";
import { SAMPLE_RATE } from "./types.js";

const require = createRequire(import.meta.url);

type RustAudioEngine = {
	start(): void;
	stop(): void;
	close(): void;
	play(pcm16: Buffer): void;
	readProcessedCapture(maxFrames?: number): Buffer[];
	readRawCapture(maxFrames?: number): Buffer[];
	setStreamDelayMs(delayMs: number): void;
	getStats(): {
		pendingPlaybackSamples?: number;
		captureFrames: number;
		processedFrames: number;
		playbackUnderruns: number;
		droppedRawFrames: number;
		droppedProcessedFrames: number;
	};
};

type EngineState = {
	engine: RustAudioEngine;
	mode: "say" | "ask";
};

let engineState: EngineState | null = null;
let commandCount = 0;
const startedAt = Date.now();
let idleTimer: ReturnType<typeof setTimeout> | null = null;

function resetIdleTimer(): void {
	if (idleTimer) clearTimeout(idleTimer);
	const { idleTimeoutMinutes } = resolveDaemonConfig();
	idleTimer = setTimeout(
		() => {
			shutdown();
		},
		idleTimeoutMinutes * 60 * 1000,
	);
}

function getOrCreateEngine(mode: "say" | "ask"): RustAudioEngine {
	if (engineState && engineState.mode === mode) {
		return engineState.engine;
	}

	// Dispose old engine if mode changed
	if (engineState) {
		try {
			engineState.engine.stop();
			engineState.engine.close();
		} catch {}
		engineState = null;
	}

	const { AudioEngine } = require("agent-voice-audio") as {
		AudioEngine: new (options?: {
			sampleRate?: number;
			channels?: number;
			enableAec?: boolean;
			streamDelayMs?: number;
		}) => RustAudioEngine;
	};

	const engine = new AudioEngine({
		sampleRate: SAMPLE_RATE,
		channels: 1,
		enableAec: mode === "ask",
		streamDelayMs: mode === "ask" ? 30 : undefined,
	});
	engine.start();
	engineState = { engine, mode };
	return engine;
}

function createEngineProxy(engine: RustAudioEngine): RustAudioEngine {
	return {
		start() {},
		stop() {},
		close() {},
		play: engine.play.bind(engine),
		readProcessedCapture: engine.readProcessedCapture.bind(engine),
		readRawCapture: engine.readRawCapture.bind(engine),
		setStreamDelayMs: engine.setStreamDelayMs.bind(engine),
		getStats: engine.getStats.bind(engine),
	};
}

type QueuedCommand = {
	request: DaemonRequest;
	socket: Socket;
};

const commandQueue: QueuedCommand[] = [];
let processing = false;

async function processQueue(): Promise<void> {
	if (processing) return;
	processing = true;

	while (commandQueue.length > 0) {
		const item = commandQueue.shift();
		if (!item) break;
		await executeCommand(item.request, item.socket);
	}

	processing = false;
}

function send(socket: Socket, msg: DaemonResponse): void {
	if (!socket.destroyed) {
		socket.write(encodeMessage(msg));
	}
}

async function executeCommand(
	request: DaemonRequest,
	socket: Socket,
): Promise<void> {
	if (request.type === "ping") {
		send(socket, {
			type: "pong",
			uptime: Date.now() - startedAt,
			commandCount,
		});
		return;
	}

	if (request.type === "shutdown") {
		shutdown();
		return;
	}

	commandCount++;
	resetIdleTimer();

	if (request.type === "say") {
		await executeSay(request, socket);
	} else if (request.type === "ask") {
		await executeAsk(request, socket);
	}
}

async function executeSay(
	request: Extract<DaemonRequest, { type: "say" }>,
	socket: Socket,
): Promise<void> {
	const logger = createCommandLogger("say", request.id);
	const assistantChunks: Buffer[] = [];

	try {
		const engine = getOrCreateEngine("say");
		const proxy = createEngineProxy(engine);
		const auth = resolveAuth();

		const { say } = await import("./say.js");
		await say(request.message, {
			voice: request.voice,
			auth,
			createAudioEngine: () => proxy,
			onAssistantAudio(pcm16) {
				assistantChunks.push(Buffer.from(pcm16));
			},
			onTrace(event) {
				logger.trace(event);
				send(socket, { type: "log", id: request.id, entry: event });
			},
		});

		writeAudioCapture(request.id, { assistant: assistantChunks });
		logger.log("done");
		send(socket, { type: "say:done", id: request.id });
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		logger.log("error", { message });
		writeAudioCapture(request.id, { assistant: assistantChunks });
		send(socket, { type: "error", id: request.id, message });
	}
}

async function executeAsk(
	request: Extract<DaemonRequest, { type: "ask" }>,
	socket: Socket,
): Promise<void> {
	const logger = createCommandLogger("ask", request.id);
	const assistantChunks: Buffer[] = [];
	const micChunks: Buffer[] = [];
	const modelInputChunks: Buffer[] = [];

	try {
		const engine = getOrCreateEngine("ask");
		const proxy = createEngineProxy(engine);
		const auth = resolveAuth();

		const { ask } = await import("./ask.js");
		const transcript = await ask(request.message, {
			voice: request.voice,
			timeout: request.timeout,
			ack: request.ack,
			auth,
			createAudioEngine: () => proxy,
			onAssistantAudio(pcm16) {
				assistantChunks.push(Buffer.from(pcm16));
			},
			onMicAudio(pcm16) {
				micChunks.push(Buffer.from(pcm16));
			},
			onAudioFrameSent(pcm16) {
				modelInputChunks.push(Buffer.from(pcm16));
			},
			onTrace(event) {
				logger.trace(event);
				send(socket, { type: "log", id: request.id, entry: event });
			},
		});

		writeAudioCapture(request.id, {
			assistant: assistantChunks,
			mic: micChunks,
			"model-input": modelInputChunks,
		});
		logger.log("done", { transcript });
		send(socket, { type: "ask:done", id: request.id, transcript });
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		logger.log("error", { message });
		writeAudioCapture(request.id, {
			assistant: assistantChunks,
			mic: micChunks,
			"model-input": modelInputChunks,
		});
		send(socket, { type: "error", id: request.id, message });
	}
}

const server = createServer((socket) => {
	const parse = createMessageParser((msg) => {
		const result = DaemonRequestSchema.safeParse(msg);
		if (!result.success) {
			send(socket, {
				type: "error",
				id: "unknown",
				message: `Invalid request: ${result.error.message}`,
			});
			return;
		}
		commandQueue.push({ request: result.data, socket });
		processQueue();
	});

	socket.on("data", parse);
	socket.on("error", () => {});
});

function shutdown(): void {
	if (idleTimer) clearTimeout(idleTimer);

	server.close();

	if (engineState) {
		try {
			engineState.engine.stop();
			engineState.engine.close();
		} catch {}
		engineState = null;
	}

	removeDaemonPid();
	try {
		rmSync(DAEMON_SOCKET_PATH);
	} catch {}

	process.exit(0);
}

// Cleanup stale socket
try {
	rmSync(DAEMON_SOCKET_PATH);
} catch {}

server.listen(DAEMON_SOCKET_PATH, () => {
	writeDaemonPid(process.pid);
	resetIdleTimer();
});

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
