# Agent Voice Rust Audio Stack Plan

## Summary
Replace Node/PortAudio (`naudiodon2`) audio I/O with a Rust-native full-duplex audio engine and keep AEC/NS/AGC in the same Rust processing path. The goal is to eliminate timing drift and echo leakage caused by split clock domains and event-loop coupling.

## Problem Statement
Current behavior issues:
- False transcripts when user is silent (echo leaked into model input).
- Barge-in reliability problems and occasional hangs.
- Timeout behavior inconsistent under certain startup sequences.

Likely root cause:
- Audio playback/capture lifecycle in Node (`naudiodon2`) is decoupled from AEC processing timing in Rust.
- Realtime turn detection reacts to leaked far-end audio before near-end speech is cleanly separated.

## Goals
- Single timing domain for render, capture, and AEC.
- Deterministic 10ms framing end-to-end.
- Reliable barge-in on first attempt.
- No false transcript when user is silent.
- Predictable timeout and cleanup behavior.

## Non-Goals
- Replacing OpenAI Realtime transport.
- Adding new models or changing speech/transcription providers.
- Building full custom VAD from scratch.

## Proposed Architecture
### New package
- `packages/agent-voice-audio` (Rust + N-API)

### Responsibilities
- Device management (input/output selection, default device fallback).
- Full-duplex stream startup/shutdown.
- Fixed 10ms frame scheduler.
- AEC/NS/AGC pipeline using `sonora` (or equivalent WebRTC APM binding).
- Emit two capture streams to JS when needed:
  - `raw_mic`
  - `processed_mic` (post-AEC/NS/AGC)

### JS API (proposed)
- `createAudioEngine(options)`
- `engine.start()`
- `engine.stop()`
- `engine.play(pcm16Frame)`
- `engine.onProcessedCapture(cb)`
- `engine.onRawCapture(cb)` (debug)
- `engine.getStats()` (ERL/ERLE/residual echo, underruns/overruns)
- `engine.setStreamDelayMs(ms)`

### Ask/Say integration
- `ask.ts` and `say.ts` consume `agent-voice-audio` instead of `audio.ts` + standalone AEC.
- Keep existing interfaces in `ask()`/`say()` for compatibility.
- Add internal adapter layer so fallback to legacy stack remains possible behind flag.

## Implementation Phases
### Phase 0: Instrumentation Baseline
- Add objective echo leakage metric in tests (correlation/ERLE proxy).
- Keep current audio path as control baseline.

### Phase 1: Rust Audio Engine Skeleton
- Build N-API module with start/stop/play/onCapture.
- Implement ring buffers and 10ms framing.
- Add robust shutdown semantics (non-hanging close with bounded drain).

### Phase 2: In-engine AEC/NS/AGC
- Integrate `sonora` in the engine loop.
- Wire render->capture reference flow and delay hint controls.
- Expose processing stats.

### Phase 3: Agent Voice Integration
- Replace `createAudioPlayer`/`createAudioRecorder` usage in `ask.ts` and `say.ts`.
- Preserve existing external CLI behavior.
- Add feature flag:
  - `AGENT_VOICE_AUDIO_BACKEND=rust|legacy`

### Phase 4: Reliability + Tuning
- Delay sweep automation using objective metrics.
- Tune defaults for:
  - stream delay
  - guard timings
  - barge-in interrupt threshold

### Phase 5: Rollout
- Default to `rust` backend in development.
- Run A/B CI and local smoke for at least one iteration.
- Flip default to `rust`; keep legacy fallback for one release window.

## Test Plan
### Unit
- Frame sizing, buffer alignment, resampler correctness.
- Start/stop idempotency and no-hang cleanup.

### Integration
- Synthetic echo mix (deterministic):
  - Assert transcript quality with AEC ON.
  - Assert degradation with AEC OFF.
  - Assert leakage reduction threshold.

### E2E Manual
- Real microphone + speakers:
  - `ask` silent-user test (must timeout, no transcript).
  - barge-in test (first attempt success).
  - debug WAV/spectrogram inspection.

## Acceptance Criteria
- Silent-user `ask` produces no false transcript in 20 consecutive runs.
- Barge-in succeeds on first attempt in >= 90% of 20 runs.
- Processed capture leakage metric is at least 10 dB better than legacy baseline.
- No observed hang in `ask`/`say` shutdown across 100 runs.

## Risks and Mitigations
- Device behavior differs across macOS/Linux.
  - Mitigation: explicit device capability probing and fallback modes.
- Native module complexity and distribution burden.
  - Mitigation: keep package boundaries strict; prebuild artifacts in CI.
- Over-aggressive suppression hurting intelligibility.
  - Mitigation: tie tuning decisions to both leakage and transcript-quality metrics.

## Open Decisions
- `cpal` vs `sys-voice` for device layer.
- Whether to expose per-device selection in CLI initially.
- Whether to include NS/AGC by default or only AEC at first cut.

## Immediate Next Steps
1. Scaffold `packages/agent-voice-audio` with N-API bindings and ring-buffered duplex stream.
2. Implement minimal `play + processed capture` pipeline with 10ms framing.
3. Add `AGENT_VOICE_AUDIO_BACKEND` switch and wire `ask.ts` to new backend.
