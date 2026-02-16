import { randomUUID } from "node:crypto";
import {
	closeSync,
	createReadStream,
	mkdirSync,
	openSync,
	statSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { join } from "node:path";
import { Command } from "commander";
import {
	EVENTS_LOG_PATH,
	getConfigValue,
	isDebugEnabled,
	readConfig,
	resetConfig,
	resolveAuth,
	resolveVoice,
	setConfigValue,
	writeVoiceConfig,
} from "./config.js";
import { createCommandLogger, writeAudioCapture } from "./daemon-log.js";
import { BIT_DEPTH, CHANNELS, SAMPLE_RATE, VOICES } from "./types.js";

// Redirect C-level stdout (fd 1) and stderr (fd 2) to /dev/null so
// PortAudio's printf noise and SpeexDSP warnings are suppressed,
// then dynamically import audio-dependent modules.
// Returns a writeResult function that writes to the real stdout.
async function withSuppressedNativeOutput() {
	const savedStdout = openSync("/dev/fd/1", "w");
	const savedStderr = openSync("/dev/fd/2", "w");
	closeSync(1);
	openSync("/dev/null", "w"); // fd 1 now points to /dev/null
	closeSync(2);
	openSync("/dev/null", "w"); // fd 2 now points to /dev/null

	const { ask } = await import("./ask.js");
	const { say } = await import("./say.js");

	function writeResult(text: string) {
		writeSync(savedStdout, `${text}\n`);
		closeSync(savedStdout);
	}

	function writeError(text: string) {
		writeSync(savedStderr, `${text}\n`);
	}

	return { ask, say, writeResult, writeError };
}
async function readStdin(): Promise<string> {
	if (process.stdin.isTTY) return "";
	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) {
		chunks.push(chunk);
	}
	return Buffer.concat(chunks).toString("utf-8").trim();
}

async function getMessage(flag: string | undefined): Promise<string> {
	if (flag) return flag;
	const stdin = await readStdin();
	if (stdin) return stdin;
	throw new Error("No message provided. Use -m or pipe via stdin.");
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

function writeDebugAudio(
	dir: string,
	assistantChunks: Buffer[],
	micChunks: Buffer[],
	modelInputChunks: Buffer[],
) {
	mkdirSync(dir, { recursive: true });
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const assistantFile = join(dir, `ask-${stamp}-assistant-output.wav`);
	const micFile = join(dir, `ask-${stamp}-mic-input.wav`);
	const modelInputFile = join(dir, `ask-${stamp}-model-input.wav`);
	writeFileSync(assistantFile, createWavBuffer(Buffer.concat(assistantChunks)));
	writeFileSync(micFile, createWavBuffer(Buffer.concat(micChunks)));
	writeFileSync(
		modelInputFile,
		createWavBuffer(Buffer.concat(modelInputChunks)),
	);
	return { assistantFile, micFile, modelInputFile };
}

const program = new Command()
	.name("agent-voice")
	.description("AI agent voice interaction CLI");

program
	.command("auth")
	.description("Configure API key and base URL")
	.option("--api-url <url>", "Base URL for the API")
	.option("--api-key <key>", "API key")
	.option("--no-verify", "Skip API key verification")
	.action(async (opts) => {
		try {
			const { auth } = await import("./auth.js");
			await auth({
				apiUrl: opts.apiUrl,
				apiKey: opts.apiKey,
				noVerify: !opts.verify,
			});
			process.exit(0);
		} catch (err: unknown) {
			process.stderr.write(`${err instanceof Error ? err.message : err}\n`);
			process.exit(1);
		}
	});

const defaultVoice = resolveVoice();

const voicesCmd = program
	.command("voices")
	.description("List available voices");

voicesCmd.action(() => {
	for (const v of VOICES) {
		const marker = v === defaultVoice ? " (default)" : "";
		process.stdout.write(`${v}${marker}\n`);
	}
	process.exit(0);
});

voicesCmd
	.command("set <voice>")
	.description("Set the default voice")
	.action((voice: string) => {
		if (!VOICES.includes(voice as (typeof VOICES)[number])) {
			process.stderr.write(
				`Unknown voice "${voice}". Available: ${VOICES.join(", ")}\n`,
			);
			process.exit(1);
		}
		writeVoiceConfig(voice);
		process.stdout.write(`Default voice set to "${voice}".\n`);
		process.exit(0);
	});

// --- Config commands ---

const configCmd = program.command("config").description("Manage configuration");

configCmd
	.command("get [key]")
	.description("Show config (all or specific key)")
	.action((key?: string) => {
		if (key) {
			const value = getConfigValue(key);
			if (value === undefined) {
				process.stderr.write(`Unknown config key: ${key}\n`);
				process.exit(1);
			}
			process.stdout.write(
				`${typeof value === "object" ? JSON.stringify(value, null, 2) : value}\n`,
			);
		} else {
			const config = readConfig();
			process.stdout.write(`${JSON.stringify(config, null, 2)}\n`);
		}
		process.exit(0);
	});

configCmd
	.command("set <key> <value>")
	.description("Set a config value")
	.action((key: string, value: string) => {
		setConfigValue(key, value);
		process.stdout.write(`${key} = ${getConfigValue(key)}\n`);
		process.exit(0);
	});

configCmd
	.command("reset [key]")
	.description("Reset config to defaults (preserves auth)")
	.action((key?: string) => {
		resetConfig(key);
		process.stdout.write(key ? `Reset ${key}\n` : "Config reset to defaults\n");
		process.exit(0);
	});

// --- Daemon commands ---

const daemonCmd = program
	.command("daemon")
	.description("Manage the background audio daemon");

daemonCmd
	.command("start")
	.description("Start the daemon (no-op if already running)")
	.action(async () => {
		try {
			const { startDaemon } = await import("./daemon-lifecycle.js");
			const pid = await startDaemon();
			process.stdout.write(`Daemon running (PID ${pid})\n`);
			process.exit(0);
		} catch (err: unknown) {
			process.stderr.write(`${err instanceof Error ? err.message : err}\n`);
			process.exit(1);
		}
	});

daemonCmd
	.command("stop")
	.description("Stop the daemon")
	.action(async () => {
		try {
			const { stopDaemon } = await import("./daemon-lifecycle.js");
			await stopDaemon();
			process.stdout.write("Daemon stopped\n");
			process.exit(0);
		} catch (err: unknown) {
			process.stderr.write(`${err instanceof Error ? err.message : err}\n`);
			process.exit(1);
		}
	});

daemonCmd
	.command("restart")
	.description("Restart the daemon")
	.action(async () => {
		try {
			const { restartDaemon } = await import("./daemon-lifecycle.js");
			const pid = await restartDaemon();
			process.stdout.write(`Daemon restarted (PID ${pid})\n`);
			process.exit(0);
		} catch (err: unknown) {
			process.stderr.write(`${err instanceof Error ? err.message : err}\n`);
			process.exit(1);
		}
	});

daemonCmd
	.command("status")
	.description("Show daemon status")
	.action(async () => {
		try {
			const { getDaemonStatus } = await import("./daemon-lifecycle.js");
			const status = await getDaemonStatus();
			if (!status.running) {
				process.stdout.write("Daemon is not running\n");
			} else {
				const uptimeS = Math.floor(status.uptime / 1000);
				const mins = Math.floor(uptimeS / 60);
				const secs = uptimeS % 60;
				process.stdout.write(
					`Daemon running (PID ${status.pid})\n` +
						`Uptime: ${mins}m ${secs}s\n` +
						`Commands processed: ${status.commandCount}\n`,
				);
			}
			process.exit(0);
		} catch (err: unknown) {
			process.stderr.write(`${err instanceof Error ? err.message : err}\n`);
			process.exit(1);
		}
	});

daemonCmd
	.command("logs")
	.description("Read event log")
	.option("-f, --follow", "Follow log output")
	.option("-n, --tail <lines>", "Show last N lines", "20")
	.action(async (opts) => {
		const tailN = Number.parseInt(opts.tail, 10);

		try {
			statSync(EVENTS_LOG_PATH);
		} catch {
			process.stderr.write(
				"No log file found. Enable debug logging with: agent-voice config set debug true\n",
			);
			process.exit(1);
		}

		if (!opts.follow) {
			// Read last N lines
			const { readFileSync } = await import("node:fs");
			const content = readFileSync(EVENTS_LOG_PATH, "utf-8");
			const lines = content.trim().split("\n");
			const tail = lines.slice(-tailN);
			for (const line of tail) {
				process.stdout.write(`${line}\n`);
			}
			process.exit(0);
		}

		// Follow mode: read last N lines then tail
		const { readFileSync, watchFile } = await import("node:fs");
		const content = readFileSync(EVENTS_LOG_PATH, "utf-8");
		const lines = content.trim().split("\n");
		const tail = lines.slice(-tailN);
		for (const line of tail) {
			process.stdout.write(`${line}\n`);
		}

		let offset = statSync(EVENTS_LOG_PATH).size;

		watchFile(EVENTS_LOG_PATH, { interval: 200 }, () => {
			const newSize = statSync(EVENTS_LOG_PATH).size;
			if (newSize <= offset) return;
			const stream = createReadStream(EVENTS_LOG_PATH, {
				start: offset,
				encoding: "utf-8",
			});
			stream.on("data", (chunk) => {
				process.stdout.write(chunk);
			});
			stream.on("end", () => {
				offset = newSize;
			});
		});
	});

// --- Say command (daemon-routed) ---

program
	.command("ask")
	.description("Speak a message and listen for a response")
	.option("-m, --message <text>", "Text message to speak")
	.option("--voice <name>", "OpenAI voice", defaultVoice)
	.option("--timeout <seconds>", "Seconds to wait for user speech", "120")
	.option("--ack", "Speak an acknowledgment after the user responds")
	.option(
		"--debug-audio-dir <dir>",
		"Write ask audio debug WAVs to this directory",
	)
	.option("--no-daemon", "Skip daemon, run directly")
	.action(async (opts) => {
		const message = await getMessage(opts.message).catch((err) => {
			process.stderr.write(`${err instanceof Error ? err.message : err}\n`);
			process.exit(1);
		});

		const debug = isDebugEnabled();

		// Try daemon first unless --no-daemon
		if (opts.daemon !== false) {
			try {
				const { daemonAsk } = await import("./daemon-client.js");
				const result = await daemonAsk(
					message,
					opts.voice,
					Number.parseInt(opts.timeout, 10),
					opts.ack ?? false,
					{},
				);
				if (result.ok) {
					if (result.type === "ask") {
						process.stdout.write(`${result.transcript}\n`);
					}
					process.exit(0);
				}
				// Daemon returned error — fall through to direct if daemon failed to connect
				if (result.message.startsWith("Socket error:")) {
					// Fall through to direct execution
				} else {
					// Command-level error (auth, timeout, etc) — report it
					process.stderr.write(`${result.message}\n`);
					process.exit(1);
				}
			} catch {
				// Daemon unavailable, fall through to direct execution
			}
		}

		// Direct execution fallback
		const { ask, writeResult, writeError } = await withSuppressedNativeOutput();
		const id = randomUUID();
		const logger = debug ? createCommandLogger("ask", id) : null;
		const assistantChunks: Buffer[] = [];
		const micChunks: Buffer[] = [];
		const modelInputChunks: Buffer[] = [];
		try {
			const auth = resolveAuth();
			const transcript = await ask(message, {
				voice: opts.voice,
				timeout: Number.parseInt(opts.timeout, 10),
				ack: opts.ack ?? false,
				auth,
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
					logger?.trace(event);
				},
			});
			writeAudioCapture(id, {
				assistant: assistantChunks,
				mic: micChunks,
				"model-input": modelInputChunks,
			});
			if (opts.debugAudioDir) {
				const files = writeDebugAudio(
					opts.debugAudioDir,
					assistantChunks,
					micChunks,
					modelInputChunks,
				);
				writeError(
					`debug audio written:\n${files.assistantFile}\n${files.micFile}\n${files.modelInputFile}`,
				);
			}
			writeResult(transcript);
			process.exit(0);
		} catch (err: unknown) {
			writeAudioCapture(id, {
				assistant: assistantChunks,
				mic: micChunks,
				"model-input": modelInputChunks,
			});
			if (opts.debugAudioDir) {
				try {
					const files = writeDebugAudio(
						opts.debugAudioDir,
						assistantChunks,
						micChunks,
						modelInputChunks,
					);
					writeError(
						`debug audio written:\n${files.assistantFile}\n${files.micFile}\n${files.modelInputFile}`,
					);
				} catch {}
			}
			writeError(`${err instanceof Error ? err.message : err}`);
			process.exit(1);
		}
	});

program
	.command("say")
	.description("Speak a message without listening for a response")
	.option("-m, --message <text>", "Text message to speak")
	.option("--voice <name>", "OpenAI voice", defaultVoice)
	.option(
		"--debug-audio-dir <dir>",
		"Write say audio debug WAV to this directory",
	)
	.option("--no-daemon", "Skip daemon, run directly")
	.action(async (opts) => {
		const message = await getMessage(opts.message).catch((err) => {
			process.stderr.write(`${err instanceof Error ? err.message : err}\n`);
			process.exit(1);
		});

		const debug = isDebugEnabled();

		// Try daemon first unless --no-daemon
		if (opts.daemon !== false) {
			try {
				const { daemonSay } = await import("./daemon-client.js");
				const result = await daemonSay(message, opts.voice);
				if (result.ok) {
					process.exit(0);
				}
				if (result.message.startsWith("Socket error:")) {
					// Fall through to direct execution
				} else {
					process.stderr.write(`${result.message}\n`);
					process.exit(1);
				}
			} catch {
				// Daemon unavailable, fall through to direct execution
			}
		}

		// Direct execution fallback
		const { say, writeError } = await withSuppressedNativeOutput();
		const id = randomUUID();
		const logger = debug ? createCommandLogger("say", id) : null;
		const assistantChunks: Buffer[] = [];
		try {
			const auth = resolveAuth();
			await say(message, {
				voice: opts.voice,
				auth,
				onAssistantAudio(pcm16) {
					assistantChunks.push(Buffer.from(pcm16));
				},
				onTrace(event) {
					logger?.trace(event);
				},
			});
			writeAudioCapture(id, { assistant: assistantChunks });
			if (opts.debugAudioDir) {
				mkdirSync(opts.debugAudioDir, { recursive: true });
				const stamp = new Date().toISOString().replace(/[:.]/g, "-");
				const file = join(
					opts.debugAudioDir,
					`say-${stamp}-assistant-output.wav`,
				);
				writeFileSync(file, createWavBuffer(Buffer.concat(assistantChunks)));
				writeError(`debug audio written:\n${file}`);
			}
			process.exit(0);
		} catch (err: unknown) {
			writeAudioCapture(id, { assistant: assistantChunks });
			if (opts.debugAudioDir && assistantChunks.length > 0) {
				try {
					mkdirSync(opts.debugAudioDir, { recursive: true });
					const stamp = new Date().toISOString().replace(/[:.]/g, "-");
					const file = join(
						opts.debugAudioDir,
						`say-${stamp}-assistant-output.wav`,
					);
					writeFileSync(file, createWavBuffer(Buffer.concat(assistantChunks)));
					writeError(`debug audio written:\n${file}`);
				} catch {}
			}
			writeError(`${err instanceof Error ? err.message : err}`);
			process.exit(1);
		}
	});

program.parse();
