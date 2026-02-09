export const SAMPLE_RATE = 24000;
export const CHANNELS = 1;
export const BIT_DEPTH = 16;

export type Mode = "default" | "say";

export type AgentTalkOptions = {
	message: string;
	mode: Mode;
	voice: string;
	timeout: number;
};
