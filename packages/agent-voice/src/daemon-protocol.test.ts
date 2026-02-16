import { describe, expect, it } from "vitest";
import {
	DaemonRequest,
	DaemonResponse,
	createMessageParser,
	encodeMessage,
} from "./daemon-protocol.js";

describe("DaemonRequest", () => {
	it("parses say request", () => {
		const result = DaemonRequest.safeParse({
			type: "say",
			id: "abc",
			message: "hello",
			voice: "ash",
		});
		expect(result.success).toBe(true);
	});

	it("parses ask request", () => {
		const result = DaemonRequest.safeParse({
			type: "ask",
			id: "abc",
			message: "hello",
			voice: "ash",
			timeout: 30,
			ack: false,
		});
		expect(result.success).toBe(true);
	});

	it("parses ping", () => {
		expect(DaemonRequest.safeParse({ type: "ping" }).success).toBe(true);
	});

	it("parses shutdown", () => {
		expect(DaemonRequest.safeParse({ type: "shutdown" }).success).toBe(true);
	});

	it("rejects unknown type", () => {
		expect(DaemonRequest.safeParse({ type: "unknown" }).success).toBe(false);
	});

	it("rejects say without message", () => {
		expect(
			DaemonRequest.safeParse({ type: "say", id: "abc", voice: "ash" }).success,
		).toBe(false);
	});
});

describe("DaemonResponse", () => {
	it("parses say:done", () => {
		expect(
			DaemonResponse.safeParse({ type: "say:done", id: "abc" }).success,
		).toBe(true);
	});

	it("parses ask:done", () => {
		expect(
			DaemonResponse.safeParse({
				type: "ask:done",
				id: "abc",
				transcript: "yes",
			}).success,
		).toBe(true);
	});

	it("parses error", () => {
		expect(
			DaemonResponse.safeParse({
				type: "error",
				id: "abc",
				message: "bad",
			}).success,
		).toBe(true);
	});

	it("parses pong", () => {
		expect(
			DaemonResponse.safeParse({
				type: "pong",
				uptime: 1000,
				commandCount: 5,
			}).success,
		).toBe(true);
	});

	it("parses log", () => {
		expect(
			DaemonResponse.safeParse({
				type: "log",
				id: "abc",
				entry: { atMs: 100, event: "start" },
			}).success,
		).toBe(true);
	});
});

describe("message framing", () => {
	it("round-trips a single message", () => {
		const original = { type: "ping" };
		const encoded = encodeMessage(original);
		const received: unknown[] = [];
		const parse = createMessageParser((msg) => received.push(msg));
		parse(encoded);
		expect(received).toEqual([original]);
	});

	it("round-trips multiple messages", () => {
		const messages = [
			{ type: "ping" },
			{ type: "say", id: "1", message: "hi", voice: "ash" },
			{ type: "shutdown" },
		];
		const encoded = Buffer.concat(messages.map(encodeMessage));
		const received: unknown[] = [];
		const parse = createMessageParser((msg) => received.push(msg));
		parse(encoded);
		expect(received).toEqual(messages);
	});

	it("handles chunked delivery", () => {
		const original = { type: "pong", uptime: 5000, commandCount: 3 };
		const encoded = encodeMessage(original);
		const received: unknown[] = [];
		const parse = createMessageParser((msg) => received.push(msg));

		// Feed byte by byte
		for (let i = 0; i < encoded.length; i++) {
			parse(encoded.subarray(i, i + 1));
		}
		expect(received).toEqual([original]);
	});

	it("handles multiple messages in one chunk then partial next", () => {
		const m1 = encodeMessage({ a: 1 });
		const m2 = encodeMessage({ b: 2 });
		const combined = Buffer.concat([m1, m2]);

		const received: unknown[] = [];
		const parse = createMessageParser((msg) => received.push(msg));

		// Send first message + partial second
		parse(combined.subarray(0, m1.length + 2));
		expect(received).toEqual([{ a: 1 }]);

		// Send rest
		parse(combined.subarray(m1.length + 2));
		expect(received).toEqual([{ a: 1 }, { b: 2 }]);
	});
});
