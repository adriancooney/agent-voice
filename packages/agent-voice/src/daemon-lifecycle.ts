import { spawn } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { connect } from "node:net";
import { dirname, join } from "node:path";
import { CONFIG_DIR, DAEMON_PID_PATH, DAEMON_SOCKET_PATH } from "./config.js";
import {
	type DaemonResponse,
	createMessageParser,
	encodeMessage,
} from "./daemon-protocol.js";

export type DaemonStatus =
	| { running: true; pid: number; uptime: number; commandCount: number }
	| { running: false };

export function readDaemonPid(): number | null {
	try {
		const raw = readFileSync(DAEMON_PID_PATH, "utf-8").trim();
		const pid = Number.parseInt(raw, 10);
		return Number.isFinite(pid) ? pid : null;
	} catch {
		return null;
	}
}

export function writeDaemonPid(pid: number): void {
	mkdirSync(dirname(DAEMON_PID_PATH), { recursive: true });
	writeFileSync(DAEMON_PID_PATH, `${pid}\n`);
}

export function removeDaemonPid(): void {
	try {
		rmSync(DAEMON_PID_PATH);
	} catch {}
}

export function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

export function cleanStalePid(): void {
	const pid = readDaemonPid();
	if (pid !== null && !isProcessAlive(pid)) {
		removeDaemonPid();
		try {
			rmSync(DAEMON_SOCKET_PATH);
		} catch {}
	}
}

export async function getDaemonStatus(): Promise<DaemonStatus> {
	cleanStalePid();
	const pid = readDaemonPid();
	if (pid === null || !isProcessAlive(pid)) {
		return { running: false };
	}

	try {
		const pong = await pingDaemon();
		return {
			running: true,
			pid,
			uptime: pong.uptime,
			commandCount: pong.commandCount,
		};
	} catch {
		return { running: false };
	}
}

function pingDaemon(): Promise<{ uptime: number; commandCount: number }> {
	return new Promise((resolve, reject) => {
		const socket = connect(DAEMON_SOCKET_PATH);
		const timeout = setTimeout(() => {
			socket.destroy();
			reject(new Error("Ping timeout"));
		}, 3000);

		const parse = createMessageParser((msg) => {
			const response = msg as DaemonResponse;
			if (response.type === "pong") {
				clearTimeout(timeout);
				socket.destroy();
				resolve({
					uptime: response.uptime,
					commandCount: response.commandCount,
				});
			}
		});

		socket.on("data", parse);
		socket.on("error", (err) => {
			clearTimeout(timeout);
			reject(err);
		});
		socket.on("connect", () => {
			socket.write(encodeMessage({ type: "ping" }));
		});
	});
}

export function startDaemon(): Promise<number> {
	return new Promise((resolve, reject) => {
		cleanStalePid();

		const existingPid = readDaemonPid();
		if (existingPid !== null && isProcessAlive(existingPid)) {
			resolve(existingPid);
			return;
		}

		mkdirSync(CONFIG_DIR, { recursive: true });

		// Resolve the daemon script path relative to this file's dist location
		const daemonScript = join(
			dirname(new URL(import.meta.url).pathname),
			"daemon.js",
		);

		const child = spawn(process.execPath, [daemonScript], {
			detached: true,
			stdio: "ignore",
			env: { ...process.env },
		});

		child.unref();

		const pid = child.pid;
		if (!pid) {
			reject(new Error("Failed to spawn daemon process"));
			return;
		}

		// Wait for socket to appear, indicating the daemon is ready
		const maxWaitMs = 5000;
		const pollIntervalMs = 50;
		let elapsed = 0;

		const poll = setInterval(() => {
			elapsed += pollIntervalMs;
			if (existsSync(DAEMON_SOCKET_PATH)) {
				clearInterval(poll);
				resolve(pid);
				return;
			}
			if (elapsed >= maxWaitMs) {
				clearInterval(poll);
				reject(new Error("Daemon did not start within 5s"));
			}
		}, pollIntervalMs);
	});
}

export async function stopDaemon(): Promise<void> {
	cleanStalePid();
	const pid = readDaemonPid();
	if (pid === null) return;

	// Try graceful shutdown via socket first
	try {
		await sendShutdown();
	} catch {
		// Fall through to SIGTERM
	}

	if (!isProcessAlive(pid)) {
		removeDaemonPid();
		return;
	}

	// SIGTERM
	try {
		process.kill(pid, "SIGTERM");
	} catch {}

	// Wait up to 3s for exit
	const deadline = Date.now() + 3000;
	while (Date.now() < deadline && isProcessAlive(pid)) {
		await new Promise((r) => setTimeout(r, 100));
	}

	// SIGKILL if still alive
	if (isProcessAlive(pid)) {
		try {
			process.kill(pid, "SIGKILL");
		} catch {}
	}

	removeDaemonPid();
	try {
		rmSync(DAEMON_SOCKET_PATH);
	} catch {}
}

function sendShutdown(): Promise<void> {
	return new Promise((resolve, reject) => {
		const socket = connect(DAEMON_SOCKET_PATH);
		const timeout = setTimeout(() => {
			socket.destroy();
			resolve();
		}, 1000);

		socket.on("error", () => {
			clearTimeout(timeout);
			resolve();
		});
		socket.on("connect", () => {
			socket.write(encodeMessage({ type: "shutdown" }));
			clearTimeout(timeout);
			socket.destroy();
			resolve();
		});
	});
}

export async function restartDaemon(): Promise<number> {
	await stopDaemon();
	return startDaemon();
}
