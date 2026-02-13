# agent-voice

## 0.2.3

### Patch Changes

- Tune `ask` near-end speech evidence defaults for quieter real-world microphones while preserving self-hearing protection.

  - Lower default speech evidence RMS thresholds.
  - Use directional pre/post evidence windows around `speech_started` instead of a symmetric age window.
  - Keep barge-in self-hearing safeguards with improved acceptance for normal-volume responses.

## 0.2.2

### Patch Changes

- Improve voice reliability under real-world timing and echo conditions.

  - Prevent `say` from cutting off output by waiting for playback drain with progress-based deadlines.
  - Add deterministic regression tests for `say` truncation and fallback completion behavior.
  - Harden `ask` against self-heard assistant audio by requiring near-end mic evidence before accepting transcripts after barge-in.
  - Add deterministic regression tests for `ask` self-hearing false positives, including a 20-run jitter sweep.

## 0.2.1

### Patch Changes

- Fix `agent-voice say` audio completion timing so short utterances are not cut off early.

  - Use realtime `response.audio.done` as the primary output-complete signal.
  - Add bounded completion fallback and cleanup timer handling in `say`.
  - Update native audio engine stats surface used by playback-completion logic.

- Updated dependencies
  - agent-voice-audio@0.2.1

## 0.2.0

### Minor Changes

- Switch `agent-voice` to the Rust audio pipeline and remove the legacy PortAudio backend path.

  - Add and publish `agent-voice-audio` as the native duplex audio + AEC backend.
  - Route `ask` and `say` through the Rust backend by default.
  - Remove legacy backend dependencies (`naudiodon2`) and legacy runtime modules.
  - Keep debug audio capture and timeout behavior improvements for `ask`.
  - Update `agent-voice-aec` internals and exports used by the new pipeline.

### Patch Changes

- Updated dependencies
  - agent-voice-audio@0.2.0

## 0.1.3

### Patch Changes

- Restructure as pnpm + Turborepo monorepo
- Updated dependencies
  - agent-voice-aec@0.1.1

## 0.1.2

### Patch Changes

- Fix auth and voices commands hanging due to global stdout suppression

## 0.1.1

### Patch Changes

- Fix --help producing no output by routing Commander output to stderr
