use napi::bindgen_prelude::*;
use napi_derive::napi;
use std::ptr;

use aec_rs_sys::{
    speex_echo_capture, speex_echo_ctl, speex_echo_playback, speex_echo_state_destroy,
    speex_echo_state_init, speex_echo_state_reset, SpeexEchoState, SPEEX_ECHO_SET_SAMPLING_RATE,
};

#[napi]
pub struct EchoCanceller {
    state: *mut SpeexEchoState,
    frame_size: usize,
}

unsafe impl Send for EchoCanceller {}

#[napi]
impl EchoCanceller {
    #[napi(constructor)]
    pub fn new(frame_size: i32, filter_length: i32, sample_rate: i32) -> Result<Self> {
        if frame_size <= 0 || filter_length <= 0 || sample_rate <= 0 {
            return Err(Error::from_reason(
                "frame_size, filter_length, and sample_rate must be positive",
            ));
        }

        let state = unsafe { speex_echo_state_init(frame_size, filter_length) };
        if state.is_null() {
            return Err(Error::from_reason(
                "Failed to initialize SpeexDSP echo state",
            ));
        }

        let mut rate = sample_rate;
        unsafe {
            speex_echo_ctl(
                state,
                SPEEX_ECHO_SET_SAMPLING_RATE as i32,
                &mut rate as *mut i32 as *mut _,
            );
        }

        Ok(Self {
            state,
            frame_size: frame_size as usize,
        })
    }

    /// Feed a far-end (speaker) frame to the echo canceller.
    /// Buffer must contain exactly frame_size * 2 bytes (16-bit PCM).
    #[napi]
    pub fn playback(&self, frame: Buffer) -> Result<()> {
        let expected_bytes = self.frame_size * 2;
        if frame.len() != expected_bytes {
            return Err(Error::from_reason(format!(
                "playback frame must be {} bytes, got {}",
                expected_bytes,
                frame.len()
            )));
        }

        unsafe {
            speex_echo_playback(self.state, frame.as_ptr() as *const i16);
        }
        Ok(())
    }

    /// Process a near-end (microphone) frame and return echo-cancelled output.
    /// Buffer must contain exactly frame_size * 2 bytes (16-bit PCM).
    #[napi]
    pub fn capture(&self, frame: Buffer) -> Result<Buffer> {
        let expected_bytes = self.frame_size * 2;
        if frame.len() != expected_bytes {
            return Err(Error::from_reason(format!(
                "capture frame must be {} bytes, got {}",
                expected_bytes,
                frame.len()
            )));
        }

        let mut output = vec![0i16; self.frame_size];
        unsafe {
            speex_echo_capture(
                self.state,
                frame.as_ptr() as *const i16,
                output.as_mut_ptr(),
            );
        }

        let out_bytes =
            unsafe { std::slice::from_raw_parts(output.as_ptr() as *const u8, expected_bytes) };
        Ok(Buffer::from(out_bytes))
    }

    /// Reset the echo canceller state.
    #[napi]
    pub fn reset(&self) {
        unsafe {
            speex_echo_state_reset(self.state);
        }
    }
}

impl Drop for EchoCanceller {
    fn drop(&mut self) {
        if !self.state.is_null() {
            unsafe {
                speex_echo_state_destroy(self.state);
            }
            self.state = ptr::null_mut();
        }
    }
}
