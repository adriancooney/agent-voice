---
name: voice
description: Starts a voice conversation with the user via the agent-voice CLI. Use when the user invokes /voice. The user is not looking at the screen — they are listening and speaking. All agent output and input goes through voice until the conversation ends.
allowed-tools: Bash(agent-voice:*)
---

# Voice Mode

The user wants to have a voice conversation. They are **not looking at the screen**. They are listening to you speak and replying verbally. Treat this like a phone call.

Voice mode is a **session**. It starts when this skill activates and ends when the user signals they're done — either by typing text in the terminal or by saying something like "that's all", "goodbye", "stop", "end voice", or similar. When the conversation ends, say goodbye and stop using voice commands. Resume normal text interaction.

## Activation

When this skill activates, **immediately start the voice conversation** before doing anything else.

- **No prior context** (fresh conversation, `/voice` with no preceding messages): use `ask` to greet and get intent in one step. E.g. `agent-voice ask -m "Hey, what are we working on?"`
- **Existing context** (mid-conversation, user was already working on something): use your judgment. You might `say` a status update and continue, or `ask` a clarifying question — whatever fits the flow.

## Setup

The `agent-voice` CLI must be installed globally. If it is not installed or a command fails with "command not found", install it:

```bash
npm install -g agent-voice
```

If authentication fails, tell the user to run `agent-voice auth` in a separate terminal to configure their API key, then stop. Do not attempt to run the auth flow yourself — it requires interactive input.

## Commands

### Say — inform the user

Use `say` whenever you want to tell the user something: status updates, progress, results, explanations, acknowledgments. This is one-way — the user hears you but does not respond.

```bash
agent-voice say -m "I'm setting up the project now."
```

### Ask — get input from the user

Use `ask` whenever you need input, confirmation, a decision, or clarification. The user hears your question, then speaks their answer. The transcribed response is printed to stdout — just read the command output directly.

```bash
agent-voice ask -m "Should I use Postgres or SQLite for this project?"
```

Options:
- `--timeout <seconds>` — how long to wait for the user to speak (default: 30)

**After every `ask`, use `say` to acknowledge what the user said** before moving on. A brief confirmation so they know you heard them: "Got it", "Okay, I'll do that", "Makes sense, starting on it now", etc.

## Latency

This is a real-time conversation. The user is waiting in silence between each voice interaction. **Minimize the time between hearing the user and responding.** Every second of silence feels long.

- Respond to the user **immediately** after an `ask` — acknowledge first, think later.
- If you need to do heavy work (searching the codebase, reading files, planning), **say so first**: `agent-voice say -m "Let me look into that."` Then do the work. Then follow up with results.
- Never leave the user hanging in silence while you explore files or reason through a problem. A quick acknowledgment buys you time.
- Keep `say` messages short. Fewer words = less TTS latency.

## Rules

1. **Always use `agent-voice say`** instead of printing text output when communicating with the user. The user cannot see your text responses.
2. **Always use `agent-voice ask`** instead of the AskUserQuestion tool. The user is not at the keyboard.
3. **Never use the AskUserQuestion tool.** All user interaction goes through voice.
4. **Keep messages concise and conversational.** Speak like a human on a phone call. No markdown, no bullet lists, no code blocks in speech. Summarize; don't recite.
5. **Say before you do.** Before starting a task, tell the user what you're about to do. Before finishing, tell them what you did.
6. **Acknowledge after every ask.** Use `say` to confirm you understood the user's response before continuing.
7. **Ask don't assume.** When you need a decision, ask. Don't guess and don't skip the question.
8. **Batch your updates.** Don't `say` after every single file edit. Group progress into meaningful checkpoints.
9. **Speak errors plainly.** If something fails, explain what went wrong in plain language. Don't read stack traces aloud.
10. **Confirm before one-way doors.** Destructive actions, architectural decisions, deployments — always ask first.
11. **End gracefully.** When the user signals the conversation is over, say goodbye and stop using voice commands.

## Example Flow

```bash
# Greet and get intent in one step
agent-voice ask -m "Hey, what are we working on?"

# Acknowledge
agent-voice say -m "Got it, I'll start on that now."

# ... do work ...

# Report progress
agent-voice say -m "I've created the database schema and the API routes. Moving on to the frontend."

# Ask a question when needed
agent-voice ask -m "Do you want me to use a modal dialog or a full page for the settings?"

# Acknowledge
agent-voice say -m "Okay, full page it is."

# ... more work ...

# Finish up
agent-voice say -m "All done. I've committed everything to a new branch called feat/settings-page. Anything else?"

# User says "no, that's all"
agent-voice say -m "Alright, talk to you later."
# Voice mode ends — resume normal text interaction
```
