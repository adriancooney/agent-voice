import { closeSync, openSync, writeSync } from "node:fs";
import { Command } from "commander";
import { resolveAuth, resolveVoice, writeVoiceConfig } from "./config.js";
import { VOICES } from "./types.js";

// Redirect C-level stdout (fd 1) to /dev/null so PortAudio's printf noise
// is suppressed, then dynamically import audio-dependent modules.
// Returns a writeResult function that writes to the real stdout.
async function withSuppressedStdout() {
	const savedFd = openSync("/dev/fd/1", "w");
	closeSync(1);
	openSync("/dev/null", "w"); // fd 1 now points to /dev/null

	const { ask } = await import("./ask.js");
	const { say } = await import("./say.js");

	function writeResult(text: string) {
		writeSync(savedFd, `${text}\n`);
		closeSync(savedFd);
	}

	return { ask, say, writeResult };
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

const program = new Command()
	.name("agent-voice")
	.description("AI agent voice interaction CLI");

program
	.command("auth")
	.description("Configure API key and base URL")
	.action(async () => {
		try {
			const { auth } = await import("./auth.js");
			await auth();
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
	.option("--timeout <seconds>", "Seconds to wait for user speech", "30")
	.option("--ack", "Speak an acknowledgment after the user responds")
	.action(async (opts) => {
		try {
			const { ask, writeResult } = await withSuppressedStdout();
			const auth = resolveAuth();
			const message = await getMessage(opts.message);
			const transcript = await ask(message, {
				voice: opts.voice,
				timeout: Number.parseInt(opts.timeout, 10),
				ack: opts.ack ?? false,
				auth,
			});
			writeResult(transcript);
			process.exit(0);
		} catch (err: unknown) {
			process.stderr.write(`${err instanceof Error ? err.message : err}\n`);
			process.exit(1);
		}
	});

program
	.command("say")
	.description("Speak a message without listening for a response")
	.option("-m, --message <text>", "Text message to speak")
	.option("--voice <name>", "OpenAI voice", defaultVoice)
	.action(async (opts) => {
		try {
			const { say } = await withSuppressedStdout();
			const auth = resolveAuth();
			const message = await getMessage(opts.message);
			await say(message, { voice: opts.voice, auth });
			process.exit(0);
		} catch (err: unknown) {
			process.stderr.write(`${err instanceof Error ? err.message : err}\n`);
			process.exit(1);
		}
	});

program.parse();
