import { describe, expect, it } from "vitest";
import { ask } from "./ask.js";
import {
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
});
