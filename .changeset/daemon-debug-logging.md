---
"agent-voice": minor
---

Add daemon lifecycle, debug logging, and fix long-speech evidence bug

- Persistent background daemon keeps AudioEngine warm across say/ask invocations
- Debug logging writes NDJSON traces and WAV audio captures to ~/.agent-voice/logs/
- New CLI commands: config get/set/reset, daemon start/stop/restart/status/logs
- Fix near-end evidence rejection for long utterances
