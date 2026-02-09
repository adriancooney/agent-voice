import { input, password } from "@inquirer/prompts";
import OpenAI from "openai";
import { type AuthConfig, writeAuthConfig } from "./config.js";

const DEFAULT_BASE_URL = "https://api.openai.com/v1";

async function verifyAuth(apiKey: string, baseURL: string): Promise<void> {
	const client = new OpenAI({ apiKey, baseURL });
	await client.models.list();
}

export async function auth(): Promise<void> {
	const baseUrl = await input({
		message: "Base URL",
		default: DEFAULT_BASE_URL,
	});

	const apiKey = await password({
		message: "API key",
	});

	if (!apiKey) {
		throw new Error("API key is required.");
	}

	process.stderr.write("Verifying...\n");
	await verifyAuth(apiKey, baseUrl);

	const config: AuthConfig = { apiKey };
	if (baseUrl !== DEFAULT_BASE_URL) {
		config.baseUrl = baseUrl;
	}

	writeAuthConfig(config);
	process.stderr.write("Auth config saved to ~/.agent-voice/config.json\n");
}
