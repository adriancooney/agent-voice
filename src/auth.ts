import { input, password } from "@inquirer/prompts";
import OpenAI from "openai";
import { type AuthConfig, writeAuthConfig } from "./config.js";

const DEFAULT_BASE_URL = "https://api.openai.com/v1";

export type AuthFlags = {
	apiUrl?: string;
	apiKey?: string;
	noVerify?: boolean;
};

async function verifyAuth(apiKey: string, baseURL: string): Promise<void> {
	const client = new OpenAI({ apiKey, baseURL });
	await client.models.list();
}

async function readKeyFromStdin(): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) chunks.push(chunk);
	return Buffer.concat(chunks).toString("utf-8").trim();
}

export async function auth(flags: AuthFlags = {}): Promise<void> {
	const nonInteractive =
		flags.apiUrl != null || flags.apiKey != null || flags.noVerify === true;

	let baseUrl: string;
	let apiKey: string;

	if (nonInteractive) {
		baseUrl = flags.apiUrl ?? DEFAULT_BASE_URL;

		if (flags.apiKey) {
			apiKey = flags.apiKey;
		} else {
			apiKey = await readKeyFromStdin();
			if (!apiKey) {
				throw new Error(
					"No API key provided. Pass --api-key or pipe via stdin.",
				);
			}
		}

		if (!flags.noVerify) {
			process.stderr.write("Verifying...\n");
			await verifyAuth(apiKey, baseUrl);
		}
	} else {
		baseUrl = await input({
			message: "Base URL",
			default: DEFAULT_BASE_URL,
		});

		apiKey = await password({
			message: "API key",
		});

		if (!apiKey) {
			throw new Error("API key is required.");
		}

		process.stderr.write("Verifying...\n");
		await verifyAuth(apiKey, baseUrl);
	}

	const config: AuthConfig = { apiKey };
	if (baseUrl !== DEFAULT_BASE_URL) {
		config.baseUrl = baseUrl;
	}

	writeAuthConfig(config);
	process.stderr.write("Auth config saved to ~/.agent-voice/config.json\n");
}
