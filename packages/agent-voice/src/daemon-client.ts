import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { connect } from "node:net";
import { DAEMON_SOCKET_PATH } from "./config.js";
import { startDaemon } from "./daemon-lifecycle.js";
import {
	type DaemonRequest,
	type DaemonResponse,
	createMessageParser,
	encodeMessage,
} from "./daemon-protocol.js";

export type CommandResult =
	| { ok: true; type: "say" }
	| { ok: true; type: "ask"; transcript: string }
	| { ok: false; message: string };

export type DaemonClientOptions = {
	onLog?: (entry: {
		atMs: number;
		event: string;
		detail?: Record<string, unknown>;
	}) => void;
};

async function ensureDaemon(): Promise<void> {
	if (existsSync(DAEMON_SOCKET_PATH)) return;
	await startDaemon();
}

function sendCommand(
	request: DaemonRequest,
	options: DaemonClientOptions = {},
): Promise<CommandResult> {
	return new Promise((resolve, reject) => {
		const socket = connect(DAEMON_SOCKET_PATH);
		let settled = false;

		const timeout = setTimeout(() => {
			if (!settled) {
				settled = true;
				socket.destroy();
				resolve({ ok: false, message: "Daemon command timed out" });
			}
		}, 300_000); // 5 min max

		const parse = createMessageParser((msg) => {
			const response = msg as DaemonResponse;

			if (response.type === "log") {
				options.onLog?.(response.entry);
				return;
			}

			if (response.type === "say:done") {
				if (!settled) {
					settled = true;
					clearTimeout(timeout);
					socket.destroy();
					resolve({ ok: true, type: "say" });
				}
				return;
			}

			if (response.type === "ask:done") {
				if (!settled) {
					settled = true;
					clearTimeout(timeout);
					socket.destroy();
					resolve({ ok: true, type: "ask", transcript: response.transcript });
				}
				return;
			}

			if (response.type === "error") {
				if (!settled) {
					settled = true;
					clearTimeout(timeout);
					socket.destroy();
					resolve({ ok: false, message: response.message });
				}
				return;
			}
		});

		socket.on("data", parse);

		socket.on("error", (err) => {
			if (!settled) {
				settled = true;
				clearTimeout(timeout);
				resolve({ ok: false, message: `Socket error: ${err.message}` });
			}
		});

		socket.on("connect", () => {
			socket.write(encodeMessage(request));
		});
	});
}

export async function daemonSay(
	message: string,
	voice: string,
	options: DaemonClientOptions = {},
): Promise<CommandResult> {
	await ensureDaemon();
	const id = randomUUID();
	return sendCommand({ type: "say", id, message, voice }, options);
}

export async function daemonAsk(
	message: string,
	voice: string,
	timeout: number,
	ack: boolean,
	options: DaemonClientOptions = {},
): Promise<CommandResult> {
	await ensureDaemon();
	const id = randomUUID();
	return sendCommand(
		{ type: "ask", id, message, voice, timeout, ack },
		options,
	);
}
