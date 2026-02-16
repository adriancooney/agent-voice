import { z } from "zod";

export type DaemonRequest = z.infer<typeof DaemonRequest>;
export const DaemonRequest = z.discriminatedUnion("type", [
	z.object({
		type: z.literal("say"),
		id: z.string(),
		message: z.string(),
		voice: z.string(),
	}),
	z.object({
		type: z.literal("ask"),
		id: z.string(),
		message: z.string(),
		voice: z.string(),
		timeout: z.number(),
		ack: z.boolean(),
	}),
	z.object({ type: z.literal("ping") }),
	z.object({ type: z.literal("shutdown") }),
]);

export type TraceEntry = z.infer<typeof TraceEntry>;
export const TraceEntry = z.object({
	atMs: z.number(),
	event: z.string(),
	detail: z.record(z.unknown()).optional(),
});

export type DaemonResponse = z.infer<typeof DaemonResponse>;
export const DaemonResponse = z.discriminatedUnion("type", [
	z.object({ type: z.literal("say:done"), id: z.string() }),
	z.object({
		type: z.literal("ask:done"),
		id: z.string(),
		transcript: z.string(),
	}),
	z.object({ type: z.literal("error"), id: z.string(), message: z.string() }),
	z.object({
		type: z.literal("pong"),
		uptime: z.number(),
		commandCount: z.number(),
	}),
	z.object({ type: z.literal("log"), id: z.string(), entry: TraceEntry }),
]);

export function encodeMessage(msg: unknown): Buffer {
	const json = JSON.stringify(msg);
	const payload = Buffer.from(`${json}\n`, "utf-8");
	const header = Buffer.alloc(4);
	header.writeUInt32BE(payload.length, 0);
	return Buffer.concat([header, payload]);
}

export function createMessageParser(
	onMessage: (msg: unknown) => void,
): (chunk: Buffer) => void {
	let buffer = Buffer.alloc(0);

	return (chunk: Buffer) => {
		buffer = Buffer.concat([buffer, chunk]);
		while (buffer.length >= 4) {
			const length = buffer.readUInt32BE(0);
			if (buffer.length < 4 + length) break;
			const payload = buffer.subarray(4, 4 + length).toString("utf-8");
			buffer = buffer.subarray(4 + length);
			onMessage(JSON.parse(payload));
		}
	};
}
