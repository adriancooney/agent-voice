use std::collections::VecDeque;
use std::sync::{Arc, Mutex};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{FromSample, Sample, SampleFormat, SizedSample, Stream, StreamConfig, SupportedStreamConfig};
use napi::bindgen_prelude::*;
use napi_derive::napi;
use sonora::config::EchoCanceller as SonoraEchoCanceller;
use sonora::{AudioProcessing, Config as SonoraConfig, StreamConfig as SonoraStreamConfig};

const DEFAULT_SAMPLE_RATE: u32 = 24_000;
const DEFAULT_STREAM_DELAY_MS: i32 = 30;
const DEFAULT_MAX_CAPTURE_FRAMES: usize = 400;

#[napi(object)]
pub struct AudioEngineOptions {
    pub sample_rate: Option<u32>,
    pub channels: Option<u32>,
    pub enable_aec: Option<bool>,
    pub stream_delay_ms: Option<i32>,
    pub max_capture_frames: Option<u32>,
}

#[napi(object)]
pub struct AudioEngineStats {
    pub capture_frames: u32,
    pub processed_frames: u32,
    pub playback_underruns: u32,
    pub pending_playback_samples: u32,
    pub dropped_raw_frames: u32,
    pub dropped_processed_frames: u32,
}

#[derive(Default)]
struct Stats {
    capture_frames: u32,
    processed_frames: u32,
    playback_underruns: u32,
    dropped_raw_frames: u32,
    dropped_processed_frames: u32,
}

struct EngineInner {
    target_sample_rate: u32,
    frame_size: usize,
    enable_aec: bool,
    max_capture_frames: usize,
    apm: AudioProcessing,
    stream: SonoraStreamConfig,
    playback_queue: VecDeque<i16>,
    render_accum: Vec<i16>,
    capture_accum: Vec<i16>,
    raw_frames: VecDeque<Vec<u8>>,
    processed_frames: VecDeque<Vec<u8>>,
    playback_device_rate: u32,
    capture_device_rate: u32,
    playback_step_accum: u64,
    capture_step_accum: u64,
    last_playback_sample: i16,
    stats: Stats,
}

unsafe impl Send for EngineInner {}

impl EngineInner {
    fn set_stream_delay(&mut self, delay_ms: i32) {
        let _ = self.apm.set_stream_delay_ms(delay_ms);
    }

    fn set_device_rates(&mut self, playback_rate: u32, capture_rate: u32) {
        self.playback_device_rate = playback_rate.max(1);
        self.capture_device_rate = capture_rate.max(1);
        self.playback_step_accum = self.playback_device_rate as u64;
        self.capture_step_accum = self.capture_device_rate as u64;
    }

    fn queue_playback_bytes(&mut self, pcm16: &[u8]) {
        for chunk in pcm16.chunks_exact(2) {
            self.playback_queue
                .push_back(i16::from_le_bytes([chunk[0], chunk[1]]));
        }
    }

    fn consume_playback_source_sample(&mut self) -> i16 {
        let sample = if let Some(next) = self.playback_queue.pop_front() {
            next
        } else {
            self.stats.playback_underruns = self.stats.playback_underruns.saturating_add(1);
            0
        };
        self.last_playback_sample = sample;
        self.render_accum.push(sample);
        self.process_render_frames();
        sample
    }

    fn next_output_sample(&mut self) -> i16 {
        self.playback_step_accum = self
            .playback_step_accum
            .saturating_add(self.target_sample_rate as u64);

        while self.playback_step_accum >= self.playback_device_rate as u64 {
            self.playback_step_accum -= self.playback_device_rate as u64;
            let _ = self.consume_playback_source_sample();
        }

        self.last_playback_sample
    }

    fn on_captured_device_sample(&mut self, sample: i16) {
        self.capture_step_accum = self
            .capture_step_accum
            .saturating_add(self.target_sample_rate as u64);

        while self.capture_step_accum >= self.capture_device_rate as u64 {
            self.capture_step_accum -= self.capture_device_rate as u64;
            self.capture_accum.push(sample);
        }

        self.process_capture_frames();
    }

    fn process_render_frames(&mut self) {
        while self.render_accum.len() >= self.frame_size {
            let mut frame = vec![0i16; self.frame_size];
            frame.copy_from_slice(&self.render_accum[..self.frame_size]);
            self.render_accum.drain(..self.frame_size);

            let mut out = vec![0i16; self.frame_size];
            let _ = self
                .apm
                .process_render_i16_with_config(&frame, &self.stream, &self.stream, &mut out);
        }
    }

    fn process_capture_frames(&mut self) {
        while self.capture_accum.len() >= self.frame_size {
            let mut frame = vec![0i16; self.frame_size];
            frame.copy_from_slice(&self.capture_accum[..self.frame_size]);
            self.capture_accum.drain(..self.frame_size);
            self.stats.capture_frames = self.stats.capture_frames.saturating_add(1);

            let raw = pcm16_to_bytes(&frame);
            push_frame_with_cap(
                &mut self.raw_frames,
                raw,
                self.max_capture_frames,
                &mut self.stats.dropped_raw_frames,
            );

            let processed = if self.enable_aec {
                let mut out = vec![0i16; self.frame_size];
                let _ = self.apm.process_capture_i16_with_config(
                    &frame,
                    &self.stream,
                    &self.stream,
                    &mut out,
                );
                out
            } else {
                frame
            };

            self.stats.processed_frames = self.stats.processed_frames.saturating_add(1);
            let processed_bytes = pcm16_to_bytes(&processed);
            push_frame_with_cap(
                &mut self.processed_frames,
                processed_bytes,
                self.max_capture_frames,
                &mut self.stats.dropped_processed_frames,
            );
        }
    }

    fn pop_processed_frames(&mut self, limit: usize) -> Vec<Buffer> {
        pop_frames(&mut self.processed_frames, limit)
    }

    fn pop_raw_frames(&mut self, limit: usize) -> Vec<Buffer> {
        pop_frames(&mut self.raw_frames, limit)
    }
}

fn pop_frames(queue: &mut VecDeque<Vec<u8>>, limit: usize) -> Vec<Buffer> {
    let take = limit.min(queue.len());
    let mut out = Vec::with_capacity(take);
    for _ in 0..take {
        if let Some(frame) = queue.pop_front() {
            out.push(Buffer::from(frame));
        }
    }
    out
}

fn push_frame_with_cap(
    queue: &mut VecDeque<Vec<u8>>,
    frame: Vec<u8>,
    cap: usize,
    dropped_counter: &mut u32,
) {
    if queue.len() >= cap {
        queue.pop_front();
        *dropped_counter = dropped_counter.saturating_add(1);
    }
    queue.push_back(frame);
}

fn pcm16_to_bytes(samples: &[i16]) -> Vec<u8> {
    let mut out = vec![0u8; samples.len() * 2];
    for (idx, sample) in samples.iter().enumerate() {
        let [lo, hi] = sample.to_le_bytes();
        out[idx * 2] = lo;
        out[idx * 2 + 1] = hi;
    }
    out
}

fn create_apm(sample_rate: u32, stream_delay_ms: i32) -> Result<(AudioProcessing, SonoraStreamConfig)> {
    let config = SonoraConfig {
        echo_canceller: Some(SonoraEchoCanceller::default()),
        ..Default::default()
    };
    let stream = SonoraStreamConfig::new(sample_rate, 1);
    let mut apm = AudioProcessing::builder()
        .config(config)
        .capture_config(stream)
        .render_config(stream)
        .build();
    apm.set_stream_delay_ms(stream_delay_ms)
        .map_err(|err| Error::from_reason(format!("set_stream_delay_ms failed: {err:?}")))?;
    Ok((apm, stream))
}

#[napi]
pub struct AudioEngine {
    inner: Arc<Mutex<EngineInner>>,
    input_stream: Option<Stream>,
    output_stream: Option<Stream>,
}

unsafe impl Send for AudioEngine {}

#[napi]
impl AudioEngine {
    #[napi(constructor)]
    pub fn new(options: Option<AudioEngineOptions>) -> Result<Self> {
        let sample_rate = options
            .as_ref()
            .and_then(|o| o.sample_rate)
            .unwrap_or(DEFAULT_SAMPLE_RATE)
            .max(8_000);
        let enable_aec = options
            .as_ref()
            .and_then(|o| o.enable_aec)
            .unwrap_or(true);
        let stream_delay_ms = options
            .as_ref()
            .and_then(|o| o.stream_delay_ms)
            .unwrap_or(DEFAULT_STREAM_DELAY_MS);
        let max_capture_frames = options
            .as_ref()
            .and_then(|o| o.max_capture_frames)
            .unwrap_or(DEFAULT_MAX_CAPTURE_FRAMES as u32) as usize;

        let frame_size = (sample_rate / 100) as usize;
        let (apm, stream) = create_apm(sample_rate, stream_delay_ms)?;

        Ok(Self {
            inner: Arc::new(Mutex::new(EngineInner {
                target_sample_rate: sample_rate,
                frame_size,
                enable_aec,
                max_capture_frames,
                apm,
                stream,
                playback_queue: VecDeque::new(),
                render_accum: Vec::with_capacity(frame_size * 2),
                capture_accum: Vec::with_capacity(frame_size * 2),
                raw_frames: VecDeque::new(),
                processed_frames: VecDeque::new(),
                playback_device_rate: sample_rate,
                capture_device_rate: sample_rate,
                playback_step_accum: sample_rate as u64,
                capture_step_accum: sample_rate as u64,
                last_playback_sample: 0,
                stats: Stats::default(),
            })),
            input_stream: None,
            output_stream: None,
        })
    }

    #[napi]
    pub fn start(&mut self) -> Result<()> {
        if self.input_stream.is_some() || self.output_stream.is_some() {
            return Ok(());
        }

        let host = cpal::default_host();
        let input = host
            .default_input_device()
            .ok_or_else(|| Error::from_reason("no default input device"))?;
        let output = host
            .default_output_device()
            .ok_or_else(|| Error::from_reason("no default output device"))?;

        let input_cfg = input
            .default_input_config()
            .map_err(|err| Error::from_reason(format!("default input config failed: {err}")))?;
        let output_cfg = output
            .default_output_config()
            .map_err(|err| Error::from_reason(format!("default output config failed: {err}")))?;

        {
            let mut guard = self
                .inner
                .lock()
                .map_err(|_| Error::from_reason("audio engine lock poisoned"))?;
            guard.set_device_rates(output_cfg.sample_rate().0, input_cfg.sample_rate().0);
        }

        let input_stream = build_input_stream(&input, &input_cfg, Arc::clone(&self.inner))?;
        let output_stream = build_output_stream(&output, &output_cfg, Arc::clone(&self.inner))?;

        input_stream
            .play()
            .map_err(|err| Error::from_reason(format!("input stream play failed: {err}")))?;
        output_stream
            .play()
            .map_err(|err| Error::from_reason(format!("output stream play failed: {err}")))?;

        self.input_stream = Some(input_stream);
        self.output_stream = Some(output_stream);
        Ok(())
    }

    #[napi]
    pub fn stop(&mut self) -> Result<()> {
        self.input_stream.take();
        self.output_stream.take();
        Ok(())
    }

    #[napi]
    pub fn close(&mut self) -> Result<()> {
        self.stop()
    }

    #[napi]
    pub fn play(&self, pcm16: Buffer) -> Result<()> {
        if pcm16.len() % 2 != 0 {
            return Err(Error::from_reason("play() expects 16-bit PCM (even byte length)"));
        }
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| Error::from_reason("audio engine lock poisoned"))?;
        guard.queue_playback_bytes(pcm16.as_ref());
        Ok(())
    }

    #[napi]
    pub fn read_processed_capture(&self, max_frames: Option<u32>) -> Result<Vec<Buffer>> {
        let limit = max_frames.unwrap_or(64) as usize;
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| Error::from_reason("audio engine lock poisoned"))?;
        Ok(guard.pop_processed_frames(limit))
    }

    #[napi]
    pub fn read_raw_capture(&self, max_frames: Option<u32>) -> Result<Vec<Buffer>> {
        let limit = max_frames.unwrap_or(64) as usize;
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| Error::from_reason("audio engine lock poisoned"))?;
        Ok(guard.pop_raw_frames(limit))
    }

    #[napi]
    pub fn set_stream_delay_ms(&self, delay_ms: i32) -> Result<()> {
        let mut guard = self
            .inner
            .lock()
            .map_err(|_| Error::from_reason("audio engine lock poisoned"))?;
        guard.set_stream_delay(delay_ms);
        Ok(())
    }

    #[napi]
    pub fn get_stats(&self) -> Result<AudioEngineStats> {
        let guard = self
            .inner
            .lock()
            .map_err(|_| Error::from_reason("audio engine lock poisoned"))?;
        Ok(AudioEngineStats {
            capture_frames: guard.stats.capture_frames,
            processed_frames: guard.stats.processed_frames,
            playback_underruns: guard.stats.playback_underruns,
            pending_playback_samples: guard.playback_queue.len() as u32,
            dropped_raw_frames: guard.stats.dropped_raw_frames,
            dropped_processed_frames: guard.stats.dropped_processed_frames,
        })
    }
}

fn build_input_stream(
    device: &cpal::Device,
    supported_config: &SupportedStreamConfig,
    inner: Arc<Mutex<EngineInner>>,
) -> Result<Stream> {
    let sample_format = supported_config.sample_format();
    let config: StreamConfig = supported_config.clone().into();

    let err_fn = |err| {
        eprintln!("agent-voice-audio input stream error: {err}");
    };

    match sample_format {
        SampleFormat::I16 => build_input_stream_typed::<i16>(device, &config, inner, err_fn),
        SampleFormat::U16 => build_input_stream_typed::<u16>(device, &config, inner, err_fn),
        SampleFormat::F32 => build_input_stream_typed::<f32>(device, &config, inner, err_fn),
        other => Err(Error::from_reason(format!("unsupported input sample format: {other:?}"))),
    }
}

fn build_input_stream_typed<T>(
    device: &cpal::Device,
    config: &StreamConfig,
    inner: Arc<Mutex<EngineInner>>,
    err_fn: impl FnMut(cpal::StreamError) + Send + 'static,
) -> Result<Stream>
where
    T: SizedSample + Sample,
    i16: FromSample<T>,
{
    let channels = config.channels as usize;
    let stream = device
        .build_input_stream(
            config,
            move |data: &[T], _| {
                if let Ok(mut guard) = inner.lock() {
                    for frame in data.chunks(channels) {
                        if let Some(sample) = frame.first() {
                            guard.on_captured_device_sample(i16::from_sample(*sample));
                        }
                    }
                }
            },
            err_fn,
            None,
        )
        .map_err(|err| Error::from_reason(format!("build input stream failed: {err}")))?;
    Ok(stream)
}

fn build_output_stream(
    device: &cpal::Device,
    supported_config: &SupportedStreamConfig,
    inner: Arc<Mutex<EngineInner>>,
) -> Result<Stream> {
    let sample_format = supported_config.sample_format();
    let config: StreamConfig = supported_config.clone().into();

    let err_fn = |err| {
        eprintln!("agent-voice-audio output stream error: {err}");
    };

    match sample_format {
        SampleFormat::I16 => build_output_stream_typed::<i16>(device, &config, inner, err_fn),
        SampleFormat::U16 => build_output_stream_typed::<u16>(device, &config, inner, err_fn),
        SampleFormat::F32 => build_output_stream_typed::<f32>(device, &config, inner, err_fn),
        other => Err(Error::from_reason(format!("unsupported output sample format: {other:?}"))),
    }
}

fn build_output_stream_typed<T>(
    device: &cpal::Device,
    config: &StreamConfig,
    inner: Arc<Mutex<EngineInner>>,
    err_fn: impl FnMut(cpal::StreamError) + Send + 'static,
) -> Result<Stream>
where
    T: SizedSample + Sample + FromSample<i16>,
{
    let channels = config.channels as usize;
    let stream = device
        .build_output_stream(
            config,
            move |data: &mut [T], _| {
                if let Ok(mut guard) = inner.lock() {
                    for frame in data.chunks_mut(channels) {
                        let sample = guard.next_output_sample();
                        let converted = T::from_sample(sample);
                        for out in frame {
                            *out = converted;
                        }
                    }
                } else {
                    for out in data.iter_mut() {
                        *out = T::from_sample(0i16);
                    }
                }
            },
            err_fn,
            None,
        )
        .map_err(|err| Error::from_reason(format!("build output stream failed: {err}")))?;
    Ok(stream)
}
