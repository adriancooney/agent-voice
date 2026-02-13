import { OpenAIRealtimeWS } from "openai/beta/realtime/ws";
import type { AuthConfig } from "./config.js";
import type { Mode } from "./types.js";

const SYSTEM_INSTRUCTIONS = `
# Role
Voice relay between an AI agent and a human.

# Instructions
- When given a text message, read it aloud EXACTLY as written. Do not add, remove, or rephrase anything.
- After the human responds, acknowledge briefly — a few words only. Vary your phrasing.
- NEVER repeat back what the user said verbatim.
- NEVER ask follow-up questions.
- Keep every response under one sentence.

# Tone
- Calm, neutral, concise.
`.trim();

export type RealtimeSessionOptions = {
	voice: string;
	mode: Mode;
	ack: boolean;
	auth?: AuthConfig;
	onAudioDelta: (pcm16: Buffer) => void;
	onAudioDone?: () => void;
	onTranscript: (text: string) => void;
	onSpeechStarted: () => void;
	onInitialResponseDone: () => void;
	onDone: () => void;
	onError: (error: string) => void;
};

export type RealtimeSession = {
	connect(): Promise<void>;
	sendMessage(text: string): void;
	sendAudio(pcm16: Buffer): void;
	close(): void;
};

export function createRealtimeSession(
	options: RealtimeSessionOptions,
): RealtimeSession {
	let rt: OpenAIRealtimeWS;
	let responseCount = 0;

	function configureSession() {
		const turnDetection =
			options.mode === "say"
				? undefined
				: {
						type: "semantic_vad" as const,
						eagerness: "medium" as const,
						create_response: options.ack,
						interrupt_response: true,
					};

		rt.send({
			type: "session.update",
			session: {
				instructions: SYSTEM_INSTRUCTIONS,
				voice: options.voice,
				input_audio_format: "pcm16",
				output_audio_format: "pcm16",
				input_audio_transcription: { model: "gpt-4o-transcribe" },
				turn_detection: turnDetection,
			},
		});
	}

	function bindEvents() {
		rt.on("response.audio.delta", (event) => {
			const pcm16 = Buffer.from(event.delta, "base64");
			options.onAudioDelta(pcm16);
		});
		rt.on("response.audio.done", () => {
			options.onAudioDone?.();
		});

		rt.on("conversation.item.input_audio_transcription.completed", (event) => {
			options.onTranscript(event.transcript);
		});

		rt.on("input_audio_buffer.speech_started", () => {
			options.onSpeechStarted();
		});

		rt.on("response.done", () => {
			responseCount++;
			if (responseCount === 1) {
				options.onInitialResponseDone();
			} else if (responseCount === 2) {
				options.onDone();
			}
		});

		rt.on("error", (event) => {
			options.onError(event.error?.message ?? "Unknown realtime error");
		});
	}

	return {
		connect() {
			return new Promise<void>((resolve, reject) => {
				const client = options.auth
					? {
							apiKey: options.auth.apiKey,
							baseURL: options.auth.baseUrl ?? "https://api.openai.com/v1",
						}
					: undefined;
				rt = new OpenAIRealtimeWS({ model: "gpt-4o-realtime-preview" }, client);

				rt.socket.on("open", () => {
					configureSession();
					bindEvents();
					resolve();
				});

				rt.socket.on("error", (err) => {
					reject(new Error(`WebSocket connection failed: ${err.message}`));
				});
			});
		},

		sendMessage(text: string) {
			rt.send({
				type: "conversation.item.create",
				item: {
					type: "message",
					role: "user",
					content: [
						{
							type: "input_text",
							text: `Read this aloud exactly as written, word for word. Do not add, remove, or change anything:\n\n${text}`,
						},
					],
				},
			});
			rt.send({ type: "response.create" });
		},

		sendAudio(pcm16: Buffer) {
			rt.send({
				type: "input_audio_buffer.append",
				audio: pcm16.toString("base64"),
			});
		},

		close() {
			rt?.close();
		},
	};
}
