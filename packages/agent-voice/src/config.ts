import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DEFAULT_VOICE } from "./types.js";

export type AuthConfig = {
	apiKey: string;
	baseUrl?: string;
};

export type DaemonConfig = {
	idleTimeoutMinutes?: number;
	audioRingBufferSize?: number;
};

export type Config = {
	auth?: AuthConfig;
	voice?: string;
	debug?: boolean;
	"debug.audio"?: boolean;
	daemon?: DaemonConfig;
};

export const CONFIG_DIR = join(homedir(), ".agent-voice");
export const CONFIG_PATH = join(CONFIG_DIR, "config.json");
export const DAEMON_SOCKET_PATH = join(CONFIG_DIR, "daemon.sock");
export const DAEMON_PID_PATH = join(CONFIG_DIR, "daemon.pid");
export const LOG_DIR = join(CONFIG_DIR, "logs");
export const AUDIO_LOG_DIR = join(LOG_DIR, "audio");
export const EVENTS_LOG_PATH = join(LOG_DIR, "events.ndjson");

const DAEMON_DEFAULTS: Required<DaemonConfig> = {
	idleTimeoutMinutes: 30,
	audioRingBufferSize: 50,
};

export function readConfig(): Config {
	try {
		return JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
	} catch {
		return {};
	}
}

function writeConfig(config: Config): void {
	mkdirSync(CONFIG_DIR, { recursive: true });
	writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, {
		mode: 0o600,
	});
	chmodSync(CONFIG_PATH, 0o600);
}

export function writeAuthConfig(auth: AuthConfig): void {
	const config = readConfig();
	config.auth = auth;
	writeConfig(config);
}

export function resolveAuth(): AuthConfig {
	const config = readConfig();
	if (config.auth?.apiKey) {
		return config.auth;
	}
	if (process.env.OPENAI_API_KEY) {
		return { apiKey: process.env.OPENAI_API_KEY };
	}
	throw new Error(
		"No API key found. Run `agent-voice auth` or set OPENAI_API_KEY.",
	);
}

export function writeVoiceConfig(voice: string): void {
	const config = readConfig();
	config.voice = voice;
	writeConfig(config);
}

export function resolveVoice(): string {
	const config = readConfig();
	return config.voice ?? DEFAULT_VOICE;
}

export function getConfigValue(key: string): unknown {
	const config = readConfig();
	if (key.startsWith("daemon.")) {
		const subKey = key.slice(7) as keyof DaemonConfig;
		return config.daemon?.[subKey] ?? DAEMON_DEFAULTS[subKey];
	}
	if (key === "auth") return config.auth;
	if (key === "voice") return config.voice ?? DEFAULT_VOICE;
	if (key === "debug") return config.debug ?? false;
	if (key === "debug.audio") return config["debug.audio"] ?? false;
	if (key === "daemon") return { ...DAEMON_DEFAULTS, ...config.daemon };
	return undefined;
}

export function setConfigValue(key: string, value: string): void {
	const config = readConfig();
	if (key.startsWith("daemon.")) {
		const subKey = key.slice(7);
		if (!config.daemon) config.daemon = {};
		(config.daemon as Record<string, unknown>)[subKey] =
			parseConfigValue(value);
	} else {
		(config as Record<string, unknown>)[key] = parseConfigValue(value);
	}
	writeConfig(config);
}

export function resetConfig(key?: string): void {
	if (!key) {
		const config = readConfig();
		const reset: Config = config.auth ? { auth: config.auth } : {};
		writeConfig(reset);
		return;
	}
	const config = readConfig();
	if (key.startsWith("daemon.")) {
		const subKey = key.slice(7);
		if (config.daemon) {
			delete (config.daemon as Record<string, unknown>)[subKey];
		}
	} else {
		delete (config as Record<string, unknown>)[key];
	}
	writeConfig(config);
}

function parseConfigValue(raw: string): unknown {
	if (raw === "true") return true;
	if (raw === "false") return false;
	const num = Number(raw);
	if (!Number.isNaN(num) && raw.trim() !== "") return num;
	return raw;
}

export function isDebugEnabled(): boolean {
	if (process.env.AGENT_VOICE_DEBUG === "1") return true;
	return readConfig().debug === true;
}

export function isDebugAudioEnabled(): boolean {
	if (process.env.AGENT_VOICE_DEBUG_AUDIO === "1") return true;
	return readConfig()["debug.audio"] === true;
}

export function resolveDaemonConfig(): Required<DaemonConfig> {
	const config = readConfig();
	return {
		idleTimeoutMinutes:
			config.daemon?.idleTimeoutMinutes ?? DAEMON_DEFAULTS.idleTimeoutMinutes,
		audioRingBufferSize:
			config.daemon?.audioRingBufferSize ?? DAEMON_DEFAULTS.audioRingBufferSize,
	};
}
