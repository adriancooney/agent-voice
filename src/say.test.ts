import { describe, expect, it } from "vitest";
import { say } from "./say.js";
import {
	createFakePlayer,
	evaluateSimilarity,
	transcribeAudio,
} from "./testing.js";

const SIMILARITY_THRESHOLD = 0.7;

describe.skipIf(!process.env.OPENAI_API_KEY)(say, () => {
	it("outputs audio matching the input message", async () => {
		const message = "The quick brown fox jumps over the lazy dog";
		const player = createFakePlayer();

		await say(message, {
			createPlayer: () => player,
		});

		const audio = Buffer.concat(player.chunks);
		expect(audio.length).toBeGreaterThan(0);

		const transcript = await transcribeAudio(audio);
		const result = await evaluateSimilarity(message, transcript);

		console.log(`say — expected: "${message}"`);
		console.log(`say — transcript: "${transcript}"`);
		console.log(`say — similarity: ${result.score} (${result.reasoning})`);

		expect(result.score).toBeGreaterThan(SIMILARITY_THRESHOLD);
	});
});
