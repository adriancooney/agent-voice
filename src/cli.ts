import { closeSync, openSync, writeSync } from "node:fs";
import { Command } from "commander";

// Save original stdout fd and redirect C-level stdout (fd 1) to stderr
// before native modules load, so PortAudio's printf noise goes to stderr.
const savedStdoutFd = openSync("/dev/fd/1", "w");
closeSync(1);
openSync("/dev/fd/2", "w"); // fd 1 now points to stderr

function writeResult(text: string) {
	writeSync(savedStdoutFd, `${text}\n`);
	closeSync(savedStdoutFd);
}

// Now safe to import modules that load native addons
const { ask } = await import("./ask.js");
const { say } = await import("./say.js");
const { version } = await import("../package.json", {
	with: { type: "json" },
});

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

process.stderr.write(`agent-voice v${version}\n`);

const program = new Command()
	.name("agent-voice")
	.description("AI agent voice interaction CLI");

program
	.command("ask")
	.description("Speak a message and listen for a response")
	.option("-m, --message <text>", "Text message to speak")
	.option("--voice <name>", "OpenAI voice", "ash")
	.option("--timeout <seconds>", "Seconds to wait for user speech", "30")
	.option("--ack", "Speak an acknowledgment after the user responds")
	.action(async (opts) => {
		try {
			const message = await getMessage(opts.message);
			const transcript = await ask(message, {
				voice: opts.voice,
				timeout: Number.parseInt(opts.timeout, 10),
				ack: opts.ack ?? false,
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
	.option("--voice <name>", "OpenAI voice", "ash")
	.action(async (opts) => {
		try {
			const message = await getMessage(opts.message);
			await say(message, { voice: opts.voice });
			process.exit(0);
		} catch (err: unknown) {
			process.stderr.write(`${err instanceof Error ? err.message : err}\n`);
			process.exit(1);
		}
	});

if (!process.env.OPENAI_API_KEY) {
	process.stderr.write("OPENAI_API_KEY environment variable is required\n");
	process.exit(1);
}

program.parse();
