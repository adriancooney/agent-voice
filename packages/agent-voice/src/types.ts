export const SAMPLE_RATE = 24000;
export const CHANNELS = 1;
export const BIT_DEPTH = 16;

export const VOICES = [
	"alloy",
	"ash",
	"ballad",
	"coral",
	"echo",
	"fable",
	"nova",
	"onyx",
	"sage",
	"shimmer",
	"verse",
] as const;

export type Voice = (typeof VOICES)[number];
export const DEFAULT_VOICE: Voice = "ash";

export type Mode = "default" | "say";

export type AgentTalkOptions = {
	message: string;
	mode: Mode;
	voice: string;
	timeout: number;
};
