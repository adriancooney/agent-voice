import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let testDir: string;

vi.mock("./config.js", () => {
	let configDir = "";
	let pidPath = "";
	let socketPath = "";

	return {
		get CONFIG_DIR() {
			return configDir;
		},
		get DAEMON_PID_PATH() {
			return pidPath;
		},
		get DAEMON_SOCKET_PATH() {
			return socketPath;
		},
		__setTestPaths(base: string) {
			configDir = base;
			pidPath = join(base, "daemon.pid");
			socketPath = join(base, "daemon.sock");
		},
	};
});

let configMock: { __setTestPaths(base: string): void };
let mod: typeof import("./daemon-lifecycle.js");

beforeEach(async () => {
	testDir = mkdtempSync(join(tmpdir(), "daemon-lifecycle-test-"));
	mkdirSync(testDir, { recursive: true });
	configMock = (await import("./config.js")) as unknown as typeof configMock;
	configMock.__setTestPaths(testDir);
	mod = await import("./daemon-lifecycle.js");
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("PID file operations", () => {
	it("returns null when no PID file exists", () => {
		expect(mod.readDaemonPid()).toBeNull();
	});

	it("writes and reads PID", () => {
		mod.writeDaemonPid(12345);
		expect(mod.readDaemonPid()).toBe(12345);
	});

	it("removes PID file", () => {
		mod.writeDaemonPid(12345);
		mod.removeDaemonPid();
		expect(mod.readDaemonPid()).toBeNull();
	});

	it("handles corrupt PID file", () => {
		writeFileSync(join(testDir, "daemon.pid"), "not-a-number\n");
		expect(mod.readDaemonPid()).toBeNull();
	});
});

describe("isProcessAlive", () => {
	it("returns true for current process", () => {
		expect(mod.isProcessAlive(process.pid)).toBe(true);
	});

	it("returns false for non-existent PID", () => {
		// Use a very high PID unlikely to exist
		expect(mod.isProcessAlive(999999999)).toBe(false);
	});
});

describe("cleanStalePid", () => {
	it("removes stale PID file for dead process", () => {
		writeFileSync(join(testDir, "daemon.pid"), "999999999\n");
		mod.cleanStalePid();
		expect(mod.readDaemonPid()).toBeNull();
	});

	it("preserves PID file for live process", () => {
		mod.writeDaemonPid(process.pid);
		mod.cleanStalePid();
		expect(mod.readDaemonPid()).toBe(process.pid);
	});
});
