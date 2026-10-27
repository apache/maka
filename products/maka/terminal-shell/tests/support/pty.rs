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

use maka_agent_facts::terminal::TerminalSize;
use maka_process::terminal::Screen;
use std::{
    fs::File,
    io::{Read, Write},
    os::{
        fd::{AsRawFd, FromRawFd},
        unix::process::CommandExt,
    },
    path::Path,
    process::{Child, Command},
    time::{Duration, Instant},
};

/// The production binary owns this actual terminal; Screen only interprets its ANSI.
pub struct Pty {
    child: Child,
    master: File,
    // Retain the slave while draining output after the child exits.
    _slave: File,
    original: libc::termios,
    screen: Screen,
    pending: Vec<u8>,
    output: Vec<u8>,
    sixel: Option<SixelReplies>,
}

#[derive(Default)]
struct SixelReplies {
    attributes: bool,
    cells: bool,
}

impl Pty {
    pub fn spawn(binary: impl AsRef<Path>, root: &Path, session: Option<&str>) -> Self {
        let mut master = -1;
        let mut slave = -1;
        let mut size = libc::winsize {
            ws_row: 40,
            ws_col: 120,
            ws_xpixel: 0,
            ws_ypixel: 0,
        };
        assert_eq!(
            unsafe {
                libc::openpty(
                    &mut master,
                    &mut slave,
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    &raw mut size,
                )
            },
            0
        );
        let master = unsafe { File::from_raw_fd(master) };
        let slave = unsafe { File::from_raw_fd(slave) };
        for fd in [master.as_raw_fd(), slave.as_raw_fd()] {
            assert_ne!(
                unsafe { libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC) },
                -1
            );
        }
        let mut original = unsafe { std::mem::zeroed() };
        assert_eq!(
            unsafe { libc::tcgetattr(slave.as_raw_fd(), &mut original) },
            0
        );
        let mut command = Command::new(binary.as_ref());
        command.args(["--root", root.to_str().unwrap()]);
        if let Some(session) = session {
            command.args(["--session", session]);
        }
        command
            .env("TERM", "xterm-256color")
            .env("COLORTERM", "truecolor")
            .env_remove("NO_COLOR")
            .stdin(slave.try_clone().unwrap())
            .stdout(slave.try_clone().unwrap())
            .stderr(slave.try_clone().unwrap());
        unsafe {
            command.pre_exec(|| {
                if libc::setsid() < 0 || libc::ioctl(0, libc::TIOCSCTTY as _, 0) < 0 {
                    return Err(std::io::Error::last_os_error());
                }
                Ok(())
            });
        }
        let child = command.spawn().unwrap();
        Self {
            child,
            master,
            _slave: slave,
            original,
            screen: Screen::new(TerminalSize::new(120, 40).unwrap()),
            pending: vec![],
            output: vec![],
            sixel: None,
        }
    }
    /// Answer the initial Sixel measurement; later replies are controlled by the case.
    /// Its cell-size reply includes Ctrl+P to exercise mixed keyboard input.
    /// This selects emulator behavior; it does not configure the application.
    pub fn spawn_sixel(binary: impl AsRef<Path>, root: &Path, session: Option<&str>) -> Self {
        let mut terminal = Self::spawn(binary, root, session);
        terminal.sixel = Some(SixelReplies::default());
        terminal
    }
    pub fn wire(&self) -> &[u8] {
        &self.output
    }
    pub fn resize(&mut self, columns: u16, rows: u16) {
        self.screen
            .resize(TerminalSize::new(columns, rows).unwrap())
            .unwrap();
        let size = libc::winsize {
            ws_row: rows,
            ws_col: columns,
            ws_xpixel: 0,
            ws_ypixel: 0,
        };
        assert_eq!(
            unsafe { libc::ioctl(self.master.as_raw_fd(), libc::TIOCSWINSZ as _, &size) },
            0
        );
    }
    pub fn send(&mut self, bytes: &[u8]) {
        self.master.write_all(bytes).unwrap();
    }
    pub fn paste(&mut self, text: &str) {
        self.send(format!("\x1b[200~{text}\x1b[201~").as_bytes());
    }
    pub fn click_text(&mut self, label: &str) {
        self.click_text_in_row(label, "");
    }
    pub fn click_text_in_row(&mut self, label: &str, row_marker: &str) {
        assert!(
            completed_presentation(&self.output),
            "cannot locate a physical click in an incomplete synchronized frame"
        );
        let screen = self.snapshot();
        let (row, line) = screen
            .lines()
            .enumerate()
            .find(|(_, line)| line.contains(label) && line.contains(row_marker))
            .unwrap_or_else(|| {
                panic!("no visible PTY button {label:?} in row {row_marker:?}:\n{screen}")
            });
        let offset = line.find(label).unwrap();
        let column = ratatui::text::Line::from(&line[..offset]).width() + 1;
        let row = row + 1;
        // Both physical events arrive in one write, as a real terminal's input
        // buffer can deliver a quick click. Production admission must keep it.
        self.send(format!("\x1b[<0;{column};{row}M\x1b[<0;{column};{row}m").as_bytes());
    }
    pub async fn click_send(&mut self, model_caption: &str) {
        use maka_agent_facts::terminal::display::Color;
        let started = Instant::now();
        loop {
            self.read();
            if completed_presentation(&self.output) {
                let snapshot = self.snapshot();
                if let Some((row, _)) = snapshot
                    .lines()
                    .enumerate()
                    .filter(|(_, line)| line.contains(model_caption))
                    .last()
                {
                    let viewport = self
                        .screen
                        .viewport(0, usize::from(self.screen.size().rows()))
                        .unwrap();
                    let mut column = 0;
                    let mut primary = None;
                    // Locate the rightmost primary control in this actual
                    // toolbar's presented cells. A disabled Send stays gray,
                    // so an enabled Stop to its left must never admit a click.
                    for run in &viewport.rows[row] {
                        let width = run.columns();
                        let enabled = matches!(
                            run.style.background,
                            Color::Rgb([138, 184, 248] | [182, 211, 255])
                        );
                        if enabled || run.style.background == Color::Rgb([55, 57, 62]) {
                            primary = Some((column + width / 2, enabled));
                        }
                        column += width;
                    }
                    if let Some((column, true)) = primary {
                        let column = column + 1;
                        let row = row + 1;
                        self.send(
                            format!("\x1b[<0;{column};{row}M\x1b[<0;{column};{row}m").as_bytes(),
                        );
                        return;
                    }
                }
            }
            assert!(
                self.child.try_wait().unwrap().is_none(),
                "production terminal exited before its Send control was enabled"
            );
            assert!(
                started.elapsed() < Duration::from_secs(20),
                "the presented Send control did not become enabled:\n{}",
                self.snapshot()
            );
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
    }
    pub fn snapshot(&self) -> String {
        self.screen.text_preview(128 * 1024).screen
    }
    pub fn read(&mut self) {
        let mut poll = libc::pollfd {
            fd: self.master.as_raw_fd(),
            events: libc::POLLIN,
            revents: 0,
        };
        let available = unsafe { libc::poll(&mut poll, 1, 10) };
        if available < 0
            && std::io::Error::last_os_error().kind() == std::io::ErrorKind::Interrupted
        {
            return;
        }
        assert!(available >= 0, "PTY read poll failed");
        if available == 0 {
            return;
        }
        let mut bytes = [0; 8192];
        let length = self.master.read(&mut bytes).unwrap();
        self.output.extend_from_slice(&bytes[..length]);
        self.pending.extend_from_slice(&bytes[..length]);
        let end = match std::str::from_utf8(&self.pending) {
            Ok(_) => self.pending.len(),
            Err(error) if error.error_len().is_none() => error.valid_up_to(),
            Err(error) => panic!("invalid terminal UTF-8: {error}"),
        };
        let mut reply = self
            .screen
            .write(std::str::from_utf8(&self.pending[..end]).unwrap())
            .unwrap();
        self.pending.drain(..end);
        if let Some(sixel) = &mut self.sixel {
            if !sixel.attributes && self.output.windows(3).any(|bytes| bytes == b"\x1b[c") {
                // Screen's ordinary terminal response must not win the first-DA1
                // race and incorrectly advertise this simulated terminal as text-only.
                assert_eq!(reply.matches("\x1b[?6c").count(), 1);
                reply = reply.replace("\x1b[?6c", "\x1b[?62;1;4;22c");
                sixel.attributes = true;
            } else if sixel.attributes {
                // Manual resize measurements must remain unanswered until the
                // case supplies their original replies, including DA1.
                reply = reply.replace("\x1b[?6c", "");
            }
            if !sixel.cells && self.output.windows(5).any(|bytes| bytes == b"\x1b[16t") {
                reply.push_str("\x1b[6;17;9t");
                // A real key in the same OS input write must survive reply demux.
                reply.push('\x10');
                sixel.cells = true;
            }
        }
        if !reply.is_empty() {
            self.send(reply.as_bytes());
        }
    }
    pub async fn wait_for_wire(&mut self, expected: &[u8], after: usize) {
        let started = Instant::now();
        loop {
            self.read();
            if completed_presentation(&self.output)
                && self.output[after..]
                    .windows(expected.len())
                    .any(|bytes| bytes == expected)
            {
                return;
            }
            assert!(
                self.child.try_wait().unwrap().is_none(),
                "production terminal exited before wire sequence {expected:?}"
            );
            assert!(
                started.elapsed() < Duration::from_secs(20),
                "production terminal never emitted {expected:?}:\n{}",
                self.snapshot()
            );
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
    }
    pub async fn wait_for(&mut self, expected: &str) -> String {
        self.wait_for_visibility(expected, true).await
    }
    pub async fn wait_for_absent(&mut self, expected: &str) -> String {
        self.wait_for_visibility(expected, false).await
    }
    async fn wait_for_visibility(&mut self, expected: &str, visible: bool) -> String {
        let started = Instant::now();
        loop {
            self.read();
            let screen = self.screen.text_preview(128 * 1024).screen;
            if completed_presentation(&self.output) && screen.contains(expected) == visible {
                return screen;
            }
            assert!(
                self.child.try_wait().unwrap().is_none(),
                "production terminal exited:\n{}",
                String::from_utf8_lossy(&self.output)
            );
            assert!(
                started.elapsed() < Duration::from_secs(20),
                "production terminal never {} {expected:?}:\n{screen}",
                if visible { "showed" } else { "removed" }
            );
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
    }
    pub async fn finish(&mut self) {
        let started = Instant::now();
        loop {
            self.read();
            if let Some(status) = self.child.try_wait().unwrap() {
                self.read();
                assert!(
                    status.success(),
                    "production terminal exited {status}:\n{}",
                    String::from_utf8_lossy(&self.output)
                );
                break;
            }
            assert!(
                started.elapsed() < Duration::from_secs(15),
                "production terminal did not quit"
            );
            tokio::time::sleep(Duration::from_millis(2)).await;
        }
        assert!(
            !self.screen.display().metadata.alternate_screen,
            "production binary left the alternate screen active"
        );
        let mut current = unsafe { std::mem::zeroed::<libc::termios>() };
        // The child session's hangup makes the slave's terminal attributes
        // unavailable on macOS. The master retains the actual terminal state.
        assert_eq!(
            unsafe { libc::tcgetattr(self.master.as_raw_fd(), &mut current) },
            0
        );
        assert_eq!(
            (
                current.c_iflag,
                current.c_oflag,
                current.c_cflag,
                current.c_lflag
            ),
            (
                self.original.c_iflag,
                self.original.c_oflag,
                self.original.c_cflag,
                self.original.c_lflag
            ),
            "production binary did not restore terminal flags"
        );
        assert_eq!(
            current.c_cc, self.original.c_cc,
            "production binary did not restore terminal control characters"
        );
    }
}
impl Drop for Pty {
    fn drop(&mut self) {
        if self.child.try_wait().ok().flatten().is_none() {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }
}

// Screen persists parser state without a renderer and deliberately flushes
// synchronized updates at parser cuts. A physical terminal instead presents
// the frame at its closing marker; text from a partial PTY read is not ready
// for coordinate-based input.
fn completed_presentation(output: &[u8]) -> bool {
    const BEGIN: &[u8] = b"\x1b[?2026h";
    const END: &[u8] = b"\x1b[?2026l";
    let begin = output
        .windows(BEGIN.len())
        .rposition(|bytes| bytes == BEGIN);
    let end = output.windows(END.len()).rposition(|bytes| bytes == END);
    matches!((begin, end), (Some(begin), Some(end)) if end > begin)
        && !(1..BEGIN.len()).any(|length| output.ends_with(&BEGIN[..length]))
}

#[test]
fn physical_input_waits_for_a_complete_synchronized_presentation() {
    let first = b"\x1b[?2026hClose\x1b[?2026l";
    for cut in 0..first.len() {
        assert!(!completed_presentation(&first[..cut]), "first cut {cut}");
    }
    assert!(completed_presentation(first));

    let mut output = first.to_vec();
    let second = "\x1b[?2026h关闭 · Esc\x1b[?2026l".as_bytes();
    for (index, byte) in second.iter().enumerate() {
        output.push(*byte);
        assert_eq!(
            completed_presentation(&output),
            index + 1 == second.len(),
            "second cut {}",
            index + 1
        );
    }
    output.extend_from_slice(b"\x1b[?25h");
    assert!(completed_presentation(&output));
}
