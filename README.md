# Agent Voice

Hands-free AI agents. A CLI and Node.js library that lets AI agents talk to humans using the OpenAI Realtime API.

Two primitives: **say** (speak to the user) and **ask** (speak, then listen for a response). That's it.

```bash
npm install -g agent-voice
agent-voice say -m "Deploying to production now."
agent-voice ask -m "Should I use Postgres or SQLite?"
# → user speaks → "Postgres"
```

## Packages

| Package | Description |
|---------|-------------|
| [`agent-voice`](./packages/agent-voice) | CLI, Node.js API, daemon, debug logging |
| [`agent-voice-audio`](./packages/agent-voice-audio) | Rust audio engine with acoustic echo cancellation |

## Agent Skill

Works with [Claude Code](https://docs.anthropic.com/en/docs/claude-code) and other agents that support [Agent Skills](https://agentskills.io):

```bash
npx skills add adriancooney/agent-voice
```

The `/voice` skill starts a hands-free voice conversation. The agent uses `say` to talk and `ask` to listen — no screen required.

## Documentation

See the [agent-voice README](./packages/agent-voice/README.md) for CLI reference, Node.js API, daemon lifecycle, debug logging, and configuration.

## License

MIT
