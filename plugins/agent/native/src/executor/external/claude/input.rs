/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

//! Native screen-reader input. Terminal observations acknowledge input, never model completion.
use super::*;
use tokio::sync::watch;

#[derive(Clone, Default)]
pub(super) struct Screen {
    end: u64,
    bytes: Vec<u8>,
}
impl Screen {
    fn after(&self, mark: u64) -> String {
        let start = self.end - self.bytes.len() as u64;
        let at = mark.saturating_sub(start).min(self.bytes.len() as u64) as usize;
        String::from_utf8_lossy(&self.bytes[at..]).into_owned()
    }
}
#[derive(Default)]
enum Escape {
    #[default]
    Text,
    Start,
    Csi,
    Osc,
    OscEnd,
}
#[derive(Default)]
pub(super) struct Decoder {
    escape: Escape,
}
impl Decoder {
    pub fn push(&mut self, screen: &mut Screen, bytes: &[u8]) {
        for &byte in bytes {
            match self.escape {
                Escape::Text => match byte {
                    27 => self.escape = Escape::Start,
                    b'\r' => {}
                    b'\n' | b'\t' | 32..=255 => {
                        screen.bytes.push(byte);
                        screen.end += 1;
                    }
                    _ => {}
                },
                Escape::Start => {
                    self.escape = match byte {
                        b'[' => Escape::Csi,
                        b']' => Escape::Osc,
                        _ => Escape::Text,
                    }
                }
                Escape::Csi => {
                    if (0x40..=0x7e).contains(&byte) {
                        self.escape = Escape::Text;
                    }
                }
                Escape::Osc => match byte {
                    7 => self.escape = Escape::Text,
                    27 => self.escape = Escape::OscEnd,
                    _ => {}
                },
                Escape::OscEnd => {
                    self.escape = if byte == b'\\' {
                        Escape::Text
                    } else {
                        Escape::Osc
                    }
                }
            }
        }
        // Only a rolling terminal observation, not a prompt, attachment, or transcript limit.
        // One MiB is hundreds of screens at this PTY's 120×40 viewport.
        if screen.bytes.len() > 1024 * 1024 {
            screen.bytes.drain(..screen.bytes.len() - 1024 * 1024);
        }
    }
}
pub(super) fn text(prompt: &str) -> String {
    let mut out = String::with_capacity(prompt.len());
    let mut chars = prompt.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\r' => {
                if chars.peek() == Some(&'\n') {
                    chars.next();
                }
                out.push('\n');
            }
            '\n' | '\t' => out.push(c),
            c if c.is_control() => {
                use std::fmt::Write;
                write!(out, "\\u{{{:x}}}", c as u32).expect("write to String");
            }
            c => out.push(c),
        }
    }
    out
}
async fn write(io: &maka_process::pty::PtyIo, mut bytes: &[u8]) -> Result<(), Error> {
    while !bytes.is_empty() {
        let accepted = io
            .write(bytes)
            .await
            .map_err(|e| Error::Provider(format!("Claude PTY input failed: {e}")))?;
        if accepted == 0 {
            return Err(Error::Provider("Claude PTY accepted no input".into()));
        }
        bytes = &bytes[accepted..];
    }
    Ok(())
}
async fn paste(io: &maka_process::pty::PtyIo, text: &str) -> Result<(), Error> {
    write(io, b"\x1b[200~").await?;
    write(io, text.as_bytes()).await?;
    write(io, b"\x1b[201~").await
}
async fn changed(screen: &mut watch::Receiver<Screen>) -> Result<(), Error> {
    screen
        .changed()
        .await
        .map_err(|_| Error::Provider("Claude closed before interactive input was accepted".into()))
}
enum Startup<'a> {
    Wait,
    Ready,
    Answer(&'a [u8]),
}
fn startup<'a>(text: &str, cwd: &str) -> Result<Startup<'a>, Error> {
    let lower = text.to_lowercase();
    if lower.contains("select login method") || lower.contains("log in with your claude account") {
        return Err(Error::Invalid("Claude native login is required".into()));
    }
    if lower.contains("yes, i trust this folder") && lower.contains("enter y/n:") {
        let path = text
            .split("Permission Required: Accessing workspace:")
            .nth(1)
            .and_then(|s| s.lines().find(|line| !line.trim().is_empty()))
            .map(str::trim);
        if path != Some(cwd) {
            return Err(Error::Invalid(
                "Claude requested trust outside this invocation's workspace".into(),
            ));
        }
        return Ok(Startup::Answer(b"y\r"));
    }
    if lower.contains("choose the text style") && lower.contains("enter") {
        return Ok(Startup::Answer(b"\r"));
    }
    if lower.contains("security notes:") && lower.contains("press enter") {
        return Ok(Startup::Answer(b"\r"));
    }
    if lower.contains("terminal setup?") && lower.contains("esc to skip") {
        return Ok(Startup::Answer(b"\x1b"));
    }
    if lower.contains("bypass permissions mode") && lower.contains("yes, i accept") {
        // Native highest-permission mode was explicitly selected in the captured runtime configuration.
        if lower.contains("y. yes, i accept") && lower.contains("enter y/n:") {
            return Ok(Startup::Answer(b"y\r"));
        }
        if lower.contains("2. yes, i accept") && lower.contains("enter") {
            return Ok(Startup::Answer(b"2\r"));
        }
    }
    if text.lines().last().is_some_and(|line| line.trim() == "$") {
        return Ok(Startup::Ready);
    }
    Ok(Startup::Wait)
}
pub(super) async fn submit(
    io: &maka_process::pty::PtyIo,
    screen: &mut watch::Receiver<Screen>,
    cwd: &str,
    prompt: &str,
    images: &[Value],
    bridge: &mcp::Bridge,
    start: &mut Start,
) -> Result<(), Error> {
    let ready = async {
        let mut mark = 0;
        loop {
            let (text, end) = {
                let s = screen.borrow();
                (s.after(mark), s.end)
            };
            match startup(&text, cwd)? {
                Startup::Ready => break,
                Startup::Answer(key) => {
                    mark = end;
                    write(io, key).await?;
                }
                Startup::Wait => changed(screen).await?,
            }
        }
        // The prompt can draw before MCP discovery ends. Do not race the first tool-bearing turn.
        bridge.listed.cancelled().await;
        bridge.admit()?;
        Ok::<_, Error>(())
    };
    tokio::time::timeout(runtime::SETUP_TIMEOUT,ready).await
        .map_err(|_| Error::Provider("Claude interactive startup or Host MCP discovery did not finish within five minutes".into()))??;
    for (index, image) in images.iter().enumerate() {
        let path = runtime::string(image, "/path")?;
        let mark = screen.borrow().end;
        paste(io, path).await?;
        let marker = format!("[Image #{}]", index + 1);
        let accepted = async {
            loop {
                if screen.borrow().after(mark).contains(&marker) {
                    return Ok::<_, Error>(());
                }
                changed(screen).await?;
            }
        };
        tokio::time::timeout(runtime::SETUP_TIMEOUT, accepted)
            .await
            .map_err(|_| Error::Provider(format!("Claude did not accept image {}", index + 1)))??;
    }
    let mark = screen.borrow().end;
    paste(io, prompt).await?;
    let visible = prompt.split_whitespace().collect::<Vec<_>>().join(" ");
    let echoed = async {
        loop {
            let text = screen.borrow().after(mark);
            // Claude replaces large pastes by a numbered placeholder, preserving the actual text.
            if text.contains("[Pasted text")
                || text
                    .split_whitespace()
                    .collect::<Vec<_>>()
                    .join(" ")
                    .contains(&visible)
            {
                return Ok::<_, Error>(());
            }
            changed(screen).await?;
        }
    };
    let budget = runtime::SETUP_TIMEOUT + Duration::from_secs(prompt.len() as u64 / (32 * 1024));
    tokio::time::timeout(budget, echoed)
        .await
        .map_err(|_| Error::Provider("Claude did not acknowledge the pasted prompt".into()))??;
    *start = Start::Submitted;
    // Enter is sent only after every attachment and the text have been acknowledged.
    write(io, b"\r").await
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn trust_is_only_for_the_captured_workspace_and_control_bytes_are_not_keys() {
        let prompt = "Permission Required: Accessing workspace:\n/work\nQuick safety check\ny. Yes, I trust this folder\nn. No, exit\nEnter y/n:\nEnter to confirm";
        assert!(matches!(
            startup(prompt, "/work").unwrap(),
            Startup::Answer(b"y\r")
        ));
        assert!(startup(prompt, "/work-other").is_err());
        assert!(startup(&prompt.replace("/work", "/work/subdir"), "/work").is_err());
        assert_eq!(text("literal\x1b[201~\rnext"), "literal\\u{1b}[201~\nnext");
        assert_eq!(text("a\r\nb"), "a\nb");
        let mut decoder = Decoder::default();
        let mut screen = Screen::default();
        decoder.push(&mut screen, b"\x1b[31m[Image #");
        decoder.push(&mut screen, b"2]\x1b[0m");
        assert_eq!(screen.after(0), "[Image #2]");
    }
}
