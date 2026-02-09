# Agent Voice

Hands-free AI agents. `agent-voice` is a CLI and Node.js library that lets AI agents talk to humans using the OpenAI Realtime API (or any compatible provider).

Two primitives: **say** (speak to the user) and **ask** (speak, then listen for a response). That's it.

```bash
agent-voice say -m "Deploying to production now."
agent-voice ask -m "Should I use Postgres or SQLite?"
# → user speaks → "Postgres"
```

## Agent Skill

Agent Voice ships with a skill for Claude Code and other agents that support the [Agent Skills](https://agentskills.io) format.

```bash
npx skills add adriancooney/agent-voice
```

The `/voice` skill starts a hands-free voice conversation. The agent uses `say` to talk and `ask` to listen — no screen required.

## Install

```bash
npm install -g agent-voice
```

## Setup

Agent Voice needs an OpenAI-compatible Realtime API key. Run the auth wizard:

```bash
agent-voice auth
```

This saves your credentials to `~/.agent-voice/config.json` (mode `0600`). You can also set the `OPENAI_API_KEY` environment variable — the CLI checks both, preferring the config file.

### Custom endpoints

Any OpenAI-compatible Realtime API works. During `agent-voice auth`, you can provide a custom base URL for providers that expose a compatible WebSocket endpoint.

## CLI

### `say`

Speak a message. No microphone, no response — fire and forget.

```bash
agent-voice say -m "Build complete. No errors."
```

| Flag | Default | Description |
|------|---------|-------------|
| `-m, --message` | — | Text to speak (or pipe via stdin) |
| `--voice` | `ash` | Voice to use |

### `ask`

Speak a message, then listen for the user's spoken response. Prints the transcription to stdout.

```bash
agent-voice ask -m "What should I name this component?"
# stdout: SearchBar
```

| Flag | Default | Description |
|------|---------|-------------|
| `-m, --message` | — | Text to speak (or pipe via stdin) |
| `--voice` | `ash` | Voice to use |
| `--timeout` | `30` | Seconds to wait for speech |
| `--ack` | `false` | Speak a brief acknowledgment after the user responds |

### `voices`

List or set the default voice.

```bash
agent-voice voices           # list all voices
agent-voice voices set coral # set default
```

Available voices: `alloy`, `ash`, `ballad`, `coral`, `echo`, `fable`, `nova`, `onyx`, `sage`, `shimmer`, `verse`.

### `auth`

Interactive setup for API key and base URL.

```bash
agent-voice auth
```

## Node.js API

```bash
npm install agent-voice
```

### `say(message, options?)`

Speak a message aloud. Returns when playback finishes.

```typescript
import { say } from "agent-voice";

await say("Deployment complete.");
```

**Options:**

```typescript
type SayOptions = {
  voice?: string;       // OpenAI voice (default: "ash")
  auth?: AuthConfig;    // { apiKey: string; baseUrl?: string }
};
```

### `ask(message, options?)`

Speak a message, then record and transcribe the user's response.

```typescript
import { ask } from "agent-voice";

const answer = await ask("What database should I use?");
console.log(answer); // "Postgres"
```

**Options:**

```typescript
type AskOptions = {
  voice?: string;       // OpenAI voice (default: "ash")
  timeout?: number;     // Seconds to wait for speech (default: 30)
  ack?: boolean;        // Acknowledge after user responds (default: false)
  auth?: AuthConfig;    // { apiKey: string; baseUrl?: string }
};
```

### Other exports

```typescript
import {
  resolveAuth,    // Resolve auth from config file or env
  resolveVoice,   // Resolve voice from config file or default
  VOICES,         // All available voice names
  DEFAULT_VOICE,  // "ash"
} from "agent-voice";

import type { Voice, AuthConfig } from "agent-voice";
```

## Config

All configuration lives in `~/.agent-voice/config.json`:

```json
{
  "auth": {
    "apiKey": "sk-...",
    "baseUrl": "https://api.openai.com/v1"
  },
  "voice": "ash"
}
```

The file is created with `0600` permissions. Auth resolution order:

1. Config file (`~/.agent-voice/config.json`)
2. `OPENAI_API_KEY` environment variable

## How it works

Agent Voice connects to the OpenAI Realtime API over WebSocket. Text is sent as a conversation item and read aloud by the model. For `ask`, after the message plays, the microphone opens and audio streams to the API for transcription using `gpt-4o-transcribe` with semantic VAD (voice activity detection) to know when the user stops talking.

Audio is PCM16 at 24kHz mono, handled through PortAudio via native bindings.

## License

MIT
