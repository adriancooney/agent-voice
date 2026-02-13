# agent-voice-audio

## 0.2.1

### Patch Changes

- Fix `agent-voice say` audio completion timing so short utterances are not cut off early.

  - Use realtime `response.audio.done` as the primary output-complete signal.
  - Add bounded completion fallback and cleanup timer handling in `say`.
  - Update native audio engine stats surface used by playback-completion logic.

## 0.2.0

### Minor Changes

- Switch `agent-voice` to the Rust audio pipeline and remove the legacy PortAudio backend path.

  - Add and publish `agent-voice-audio` as the native duplex audio + AEC backend.
  - Route `ask` and `say` through the Rust backend by default.
  - Remove legacy backend dependencies (`naudiodon2`) and legacy runtime modules.
  - Keep debug audio capture and timeout behavior improvements for `ask`.
  - Update `agent-voice-aec` internals and exports used by the new pipeline.
