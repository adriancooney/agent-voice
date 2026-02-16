import { mkdtempSync, rmSync } from "node:fs";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	DaemonRequest,
	type DaemonResponse,
	createMessageParser,
	encodeMessage,
} from "./daemon-protocol.js";

function createTestClient(socketPath: string) {
	return {
		send(msg: unknown): Promise<DaemonResponse[]> {
			return new Promise((resolve, reject) => {
				const socket = connect(socketPath);
				const responses: DaemonResponse[] = [];
				const timeout = setTimeout(() => {
					socket.destroy();
					resolve(responses);
				}, 5000);

				const parse = createMessageParser((raw) => {
					const response = raw as DaemonResponse;
					responses.push(response);

					if (
						response.type === "say:done" ||
						response.type === "ask:done" ||
						response.type === "error" ||
						response.type === "pong"
					) {
						clearTimeout(timeout);
						socket.destroy();
						resolve(responses);
					}
				});

				socket.on("data", parse);
				socket.on("error", (err) => {
					clearTimeout(timeout);
					reject(err);
				});
				socket.on("connect", () => {
					socket.write(encodeMessage(msg));
				});
			});
		},
	};
}

describe("daemon protocol integration", () => {
	it("responds to ping with pong", async () => {
		const testDir = mkdtempSync(join(tmpdir(), "daemon-test-"));
		const socketPath = join(testDir, "test.sock");
		const startedAt = Date.now();
		const commandCount = 0;

		const server = createServer((socket) => {
			const parse = createMessageParser((msg) => {
				const req = msg as { type: string };
				if (req.type === "ping") {
					const response: DaemonResponse = {
						type: "pong",
						uptime: Date.now() - startedAt,
						commandCount,
					};
					socket.write(encodeMessage(response));
				}
			});
			socket.on("data", parse);
			socket.on("error", () => {});
		});

		await new Promise<void>((resolve) => server.listen(socketPath, resolve));

		const client = createTestClient(socketPath);
		const responses = await client.send({ type: "ping" });

		expect(responses).toHaveLength(1);
		expect(responses[0].type).toBe("pong");
		if (responses[0].type === "pong") {
			expect(responses[0].commandCount).toBe(0);
			expect(responses[0].uptime).toBeGreaterThanOrEqual(0);
		}

		server.close();
		rmSync(testDir, { recursive: true });
	});

	it("returns error for invalid request", async () => {
		const testDir = mkdtempSync(join(tmpdir(), "daemon-test-"));
		const socketPath = join(testDir, "test.sock");

		const server = createServer((socket) => {
			const parse = createMessageParser((msg) => {
				const result = DaemonRequest.safeParse(msg);
				if (!result.success) {
					socket.write(
						encodeMessage({
							type: "error",
							id: "unknown",
							message: `Invalid request: ${result.error.message}`,
						}),
					);
				}
			});
			socket.on("data", parse);
			socket.on("error", () => {});
		});

		await new Promise<void>((resolve) => server.listen(socketPath, resolve));

		const client = createTestClient(socketPath);
		const responses = await client.send({ type: "bogus" });

		expect(responses).toHaveLength(1);
		expect(responses[0].type).toBe("error");

		server.close();
		rmSync(testDir, { recursive: true });
	});
});
