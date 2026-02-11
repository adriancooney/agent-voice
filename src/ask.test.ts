import { describe, expect, it } from "vitest";
import { ask } from "./ask.js";
import {
	createDelayedFakeRecorder,
	createFakePlayer,
	createFakeRecorder,
	evaluateSimilarity,
	generateSpeech,
} from "./testing.js";

const SIMILARITY_THRESHOLD = 0.7;

describe.skipIf(!process.env.OPENAI_API_KEY)(ask, () => {
	it("transcribes user speech and returns transcript", async () => {
		const prompt = "Listen to what I say and repeat it back to me.";
		const userSpeechText = "My favorite color is blue";

		const speechAudio = await generateSpeech(userSpeechText);

		const transcript = await ask(prompt, {
			timeout: 30,
			createPlayer: createFakePlayer,
			createRecorder: createFakeRecorder(speechAudio),
		});

		const result = await evaluateSimilarity(userSpeechText, transcript);

		console.log(`ask — expected: "${userSpeechText}"`);
		console.log(`ask — transcript: "${transcript}"`);
		console.log(`ask — similarity: ${result.score} (${result.reasoning})`);

		expect(result.score).toBeGreaterThan(SIMILARITY_THRESHOLD);
	});

	it("transcribes when speech starts after a delay", async () => {
		const prompt = "Listen to what I say and repeat it back to me.";
		const userSpeechText = "The weather is nice today";

		const speechAudio = await generateSpeech(userSpeechText);

		const transcript = await ask(prompt, {
			timeout: 30,
			createPlayer: createFakePlayer,
			createRecorder: createDelayedFakeRecorder(speechAudio, 5000),
		});

		const result = await evaluateSimilarity(userSpeechText, transcript);

		console.log(`delayed — expected: "${userSpeechText}"`);
		console.log(`delayed — transcript: "${transcript}"`);
		console.log(`delayed — similarity: ${result.score} (${result.reasoning})`);

		expect(result.score).toBeGreaterThan(SIMILARITY_THRESHOLD);
	});
});
