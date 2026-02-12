import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { auth } from "./auth.js";

vi.mock("@inquirer/prompts", () => ({
	input: vi.fn(),
	password: vi.fn(),
}));

vi.mock("./config.js", () => ({
	writeAuthConfig: vi.fn(),
}));

const mockModelsList = vi.fn().mockResolvedValue({ data: [] });

vi.mock("openai", () => {
	return {
		default: class MockOpenAI {
			models = { list: mockModelsList };
			constructor(public opts: Record<string, unknown>) {}
		},
	};
});

const { writeAuthConfig } = await import("./config.js");
const { input, password } = await import("@inquirer/prompts");

describe(auth, () => {
	beforeEach(() => {
		vi.spyOn(process.stderr, "write").mockImplementation(() => true);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("saves with default URL when only --api-key is provided", async () => {
		await auth({ apiKey: "sk-test", noVerify: true });

		expect(writeAuthConfig).toHaveBeenCalledWith({ apiKey: "sk-test" });
	});

	it("saves custom URL when --api-url and --api-key are provided", async () => {
		await auth({
			apiUrl: "https://example.com/v1",
			apiKey: "test123",
			noVerify: true,
		});

		expect(writeAuthConfig).toHaveBeenCalledWith({
			apiKey: "test123",
			baseUrl: "https://example.com/v1",
		});
	});

	it("reads key from stdin when --api-url is provided without --api-key", async () => {
		const fakeStdin = Readable.from([Buffer.from("secret-key\n")]);
		vi.spyOn(process, "stdin", "get").mockReturnValue(
			fakeStdin as typeof process.stdin,
		);

		await auth({ apiUrl: "https://example.com/v1", noVerify: true });

		expect(writeAuthConfig).toHaveBeenCalledWith({
			apiKey: "secret-key",
			baseUrl: "https://example.com/v1",
		});
	});

	it("throws when stdin is empty and no --api-key", async () => {
		const fakeStdin = Readable.from([]);
		vi.spyOn(process, "stdin", "get").mockReturnValue(
			fakeStdin as typeof process.stdin,
		);

		await expect(
			auth({ apiUrl: "https://example.com/v1", noVerify: true }),
		).rejects.toThrow("No API key provided");
	});

	it("skips verification when --no-verify is set", async () => {
		mockModelsList.mockClear();

		await auth({ apiKey: "sk-test", noVerify: true });

		expect(mockModelsList).not.toHaveBeenCalled();
	});

	it("verifies by default in non-interactive mode", async () => {
		mockModelsList.mockClear();

		await auth({ apiKey: "sk-test" });

		expect(mockModelsList).toHaveBeenCalled();
	});

	it("falls back to interactive prompts when no flags are provided", async () => {
		vi.mocked(input).mockResolvedValue("https://api.openai.com/v1");
		vi.mocked(password).mockResolvedValue("sk-interactive");

		await auth();

		expect(input).toHaveBeenCalled();
		expect(password).toHaveBeenCalled();
		expect(writeAuthConfig).toHaveBeenCalledWith({ apiKey: "sk-interactive" });
	});
});
