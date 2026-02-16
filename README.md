# Agent Voice

Hands-free AI agents. `agent-voice` is a CLI that lets AI agents talk to humans using the OpenAI Realtime API (or any compatible provider).

Two primitives: **say** (speak to the user) and **ask** (speak, then listen for a response). That's it.

```bash
agent-voice say -m "Deploying to production now."
agent-voice ask -m "Should I use Postgres or SQLite?"
# → user speaks → "Postgres"
```

## Agent Skill

Agent Voice ships as an [Agent Skill](https://skills.sh/adriancooney/agent-voice) for AI coding agents.

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

Any OpenAI-compatible Realtime API works — provide a custom base URL during `agent-voice auth`.

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
| `--no-daemon` | — | Skip daemon, run directly |

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
| `--timeout` | `120` | Seconds to wait for speech |
| `--ack` | `false` | Speak a brief acknowledgment after the user responds |
| `--no-daemon` | — | Skip daemon, run directly |

### `voices`

```bash
agent-voice voices           # list all voices
agent-voice voices set coral # set default
```

### `config`

```bash
agent-voice config get              # show all config
agent-voice config set debug true   # set a value
agent-voice config reset            # reset to defaults (preserves auth)
```

### `daemon`

```bash
agent-voice daemon start    # start (no-op if running)
agent-voice daemon stop     # stop gracefully
agent-voice daemon restart  # stop + start
agent-voice daemon status   # show PID, uptime, command count
agent-voice daemon logs -f  # follow event log
```

## Daemon

A background process that keeps the audio engine warm between commands, reducing startup latency. Auto-starts on first `say`/`ask` — no manual setup needed.

- Listens on Unix socket at `~/.agent-voice/daemon.sock`
- Executes commands serially (audio hardware is single-consumer)
- Auto-exits after 30 minutes idle (configurable)
- Falls back to direct execution if the daemon can't start

## Debug Logging

```bash
agent-voice config set debug true        # NDJSON event traces
agent-voice config set debug.audio true  # also capture WAV files
```

When enabled, all commands write structured traces to `~/.agent-voice/logs/events.ndjson` and WAV captures (assistant, mic, model input) to `~/.agent-voice/logs/audio/`. Audio files use a ring buffer — last 50 commands kept, oldest auto-deleted.

```bash
agent-voice daemon logs -f       # follow in real-time
agent-voice daemon logs -n 100   # last 100 entries
```

## Node.js API

```bash
npm install agent-voice
```

```typescript
import { say, ask } from "agent-voice";

await say("Deployment complete.");

const answer = await ask("What database should I use?");
// → "Postgres"
```

See the full [API reference](./packages/agent-voice/README.md#nodejs-api) for options including audio callbacks and trace events.

## How it works

Agent Voice connects to the OpenAI Realtime API over WebSocket. Text is sent as a conversation item and read aloud by the model. For `ask`, after the message plays, the microphone opens and audio streams to the API for transcription using `gpt-4o-transcribe` with semantic VAD to know when the user stops talking.

Audio is PCM16 at 24kHz mono, handled through a Rust audio engine with built-in acoustic echo cancellation (AEC) to prevent the assistant from hearing its own playback.

## Packages

| Package | Description |
|---------|-------------|
| [`agent-voice`](./packages/agent-voice) | CLI, Node.js API, daemon, debug logging |
| [`agent-voice-audio`](./packages/agent-voice-audio) | Rust audio engine with AEC |

## License

MIT
