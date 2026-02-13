/* eslint-disable */
const { platform, arch } = process;

if (platform !== "darwin" || arch !== "arm64") {
	throw new Error(
		`Unsupported platform for agent-voice-audio: ${platform}-${arch}. Supported: darwin-arm64`,
	);
}

module.exports = require("./audio.darwin-arm64.node");
