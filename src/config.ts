import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type AuthConfig = {
	apiKey: string;
	baseUrl?: string;
};

export type Config = {
	auth?: AuthConfig;
};

const CONFIG_DIR = join(homedir(), ".agent-voice");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");

export function readConfig(): Config {
	try {
		return JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
	} catch {
		return {};
	}
}

export function writeAuthConfig(auth: AuthConfig): void {
	const config = readConfig();
	config.auth = auth;
	mkdirSync(CONFIG_DIR, { recursive: true });
	writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, {
		mode: 0o600,
	});
	chmodSync(CONFIG_PATH, 0o600);
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
