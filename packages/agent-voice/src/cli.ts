import {
	closeSync,
	mkdirSync,
	openSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { join } from "node:path";
import { Command } from "commander";
import { resolveAuth, resolveVoice, writeVoiceConfig } from "./config.js";
import { BIT_DEPTH, CHANNELS, SAMPLE_RATE } from "./types.js";
import { VOICES } from "./types.js";

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
	.action(async (opts) => {
		const { ask, writeResult, writeError } = await withSuppressedNativeOutput();
		const assistantChunks: Buffer[] = [];
		const micChunks: Buffer[] = [];
		const modelInputChunks: Buffer[] = [];
		try {
			const auth = resolveAuth();
			const message = await getMessage(opts.message);
			const transcript = await ask(message, {
				voice: opts.voice,
				timeout: Number.parseInt(opts.timeout, 10),
				ack: opts.ack ?? false,
				auth,
				onAssistantAudio: opts.debugAudioDir
					? (pcm16) => assistantChunks.push(Buffer.from(pcm16))
					: undefined,
				onMicAudio: opts.debugAudioDir
					? (pcm16) => micChunks.push(Buffer.from(pcm16))
					: undefined,
				onAudioFrameSent: opts.debugAudioDir
					? (pcm16) => modelInputChunks.push(Buffer.from(pcm16))
					: undefined,
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
	.action(async (opts) => {
		const { say, writeError } = await withSuppressedNativeOutput();
		try {
			const auth = resolveAuth();
			const message = await getMessage(opts.message);
			await say(message, { voice: opts.voice, auth });
			process.exit(0);
		} catch (err: unknown) {
			writeError(`${err instanceof Error ? err.message : err}`);
			process.exit(1);
		}
	});

program.parse();
