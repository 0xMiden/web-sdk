//! Browser sink for MASM `debug.*` output: forwards to the browser console (the default handler
//! writes to stdout, a no-op on `wasm32-unknown-unknown`).

use alloc::string::String;
use core::fmt;

use wasm_bindgen::JsValue;

/// A [`fmt::Write`] sink forwarding MASM debug output to the browser console. Output arrives
/// fragmented, so lines are flushed on newline and any trailing partial line on drop.
#[derive(Default)]
pub struct ConsoleWriter {
    buffer: String,
}

impl ConsoleWriter {
    fn flush_line(line: &str) {
        let trimmed = line.trim_end_matches(['\r', '\n']);
        web_sys::console::log_1(&JsValue::from_str(trimmed));
    }
}

impl fmt::Write for ConsoleWriter {
    fn write_str(&mut self, s: &str) -> fmt::Result {
        self.buffer.push_str(s);
        while let Some(newline_idx) = self.buffer.find('\n') {
            let line: String = self.buffer.drain(..=newline_idx).collect();
            Self::flush_line(&line);
        }
        Ok(())
    }
}

impl Drop for ConsoleWriter {
    fn drop(&mut self) {
        if !self.buffer.is_empty() {
            let remaining = core::mem::take(&mut self.buffer);
            Self::flush_line(&remaining);
        }
    }
}
