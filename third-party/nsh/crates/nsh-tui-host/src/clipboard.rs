//! The host owns terminal output; fields and app clipboard calls share this backend.

use std::{
    io::{self, BufWriter, Write},
    process::{Command, Stdio},
    sync::Mutex,
};

use base64::{Engine as _, engine::general_purpose::STANDARD};
use nsh_core::clipboard::ClipboardBackend;

#[derive(Default)]
pub(crate) struct TerminalClipboard {
    state: Mutex<State>,
}

#[derive(Default)]
struct State {
    copied: Option<String>,
    initialized: bool,
    pending: Option<String>,
}

impl TerminalClipboard {
    pub(crate) fn flush(&self) -> io::Result<()> {
        let pending = self
            .state
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .pending
            .take();
        let Some(encoded) = pending else {
            return Ok(());
        };
        let mut output = BufWriter::new(crate::terminal::Output);
        write!(output, "\x1b]52;c;{encoded}\x07")?;
        output.flush()
    }
}

impl ClipboardBackend for TerminalClipboard {
    fn text(&self) -> Option<String> {
        // OSC 52 addresses the user's terminal, which can be on another machine.
        // A local desktop clipboard must not replace text just copied over SSH.
        let state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if state.initialized {
            return state.copied.clone();
        }
        drop(state);
        system_text()
    }

    fn set_text(&self, text: Option<String>) {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        let encoded = STANDARD.encode(text.as_deref().unwrap_or_default());
        state.copied = text;
        state.initialized = true;
        // Engine calls arrive off the host thread. Flush between terminal frames,
        // so an OSC sequence cannot split a renderer's escape sequence.
        state.pending = Some(encoded);
    }
}

fn system_text() -> Option<String> {
    #[cfg(target_os = "macos")]
    let commands: &[(&str, &[&str])] = &[("pbpaste", &[])];
    #[cfg(target_os = "windows")]
    let commands: &[(&str, &[&str])] = &[(
        "powershell",
        &[
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "Get-Clipboard -Raw",
        ],
    )];
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let commands: &[(&str, &[&str])] = &[
        ("wl-paste", &["--no-newline"]),
        ("xclip", &["-selection", "clipboard", "-out"]),
    ];
    commands.iter().find_map(|(program, args)| {
        let output = Command::new(program)
            .args(*args)
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .output()
            .ok()?;
        output
            .status
            .success()
            .then(|| String::from_utf8(output.stdout).ok())
            .flatten()
    })
}
