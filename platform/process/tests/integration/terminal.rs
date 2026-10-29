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

#[cfg(unix)]
#[tokio::test]
async fn real_pty_queries_and_mode_aware_input_cross_the_screen_cut() {
    use maka_agent_facts::terminal::input::InputAction;
    use maka_agent_facts::terminal::input::encode_actions;
    use maka_process::pty;
    use serde_json::json;
    use std::time::Duration;

    let expected = "\u{1b}OA中\u{1b}[<0;2;2M\u{1b}[<0;2;2m\r";
    let hex = expected
        .bytes()
        .map(|b| format!("{b:02x}"))
        .collect::<String>();
    let mut command = pty::PtyCommand::new("/bin/sh", std::env::current_dir().unwrap());
    command.args([
        "-c",
        &format!(
            r#"
        stty raw -echo
        printf '\033[6n'
        reply=$(dd bs=1 count=6 2>/dev/null | od -An -tx1 | tr -d ' \n')
        test "$reply" = 1b5b313b3152 || exit 3
        printf '\033[?1h\033[?1006h\033[?1002hready'
        input=$(dd bs=1 count={} 2>/dev/null | od -An -tx1 | tr -d ' \n')
        test "$input" = {hex} || exit 4
        printf '\r\nverified'
        exit 42
    "#,
            expected.len()
        ),
    ]);
    let size = TerminalSize::new(80, 24).unwrap();
    let (mut child, io) = pty::spawn(command, size).await.unwrap();
    let mut screen = Screen::new(size);
    let actions = json!([
        {"type":"key","key":"arrow_up"},
        {"type":"text","text":"中"},
        {"type":"mouse","event":"click","button":"left","x":1,"y":1},
        {"type":"key","key":"enter"}
    ])
    .as_array()
    .unwrap()
    .iter()
    .cloned()
    .map(InputAction::parse)
    .collect::<Result<Vec<_>, _>>()
    .unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        let mut sent = false;
        let mut bytes = [0; 1024];
        loop {
            let count = io.read(&mut bytes).await.unwrap();
            if count == 0 {
                break;
            }
            // This fixture emits ASCII; native UTF-8 input is checked by the
            // child byte-for-byte, independent of read chunk boundaries.
            let replies = screen
                .write(std::str::from_utf8(&bytes[..count]).unwrap())
                .unwrap();
            write_pty(&io, replies.as_bytes()).await;
            let cut = screen.preview(50 * 1024).unwrap();
            if !sent && cut.screen.contains("ready") {
                let input = encode_actions(&actions, cut.input, cut.size).unwrap();
                assert_eq!(input, expected);
                write_pty(&io, input.as_bytes()).await;
                sent = true;
            }
        }
        assert!(sent);
        assert_eq!(child.wait().await.unwrap().code(), Some(42));
        assert!(
            screen
                .preview(50 * 1024)
                .unwrap()
                .screen
                .contains("verified")
        );
    })
    .await
    .unwrap();

    async fn write_pty(io: &pty::PtyIo, mut input: &[u8]) {
        while !input.is_empty() {
            let count = io.write(input).await.unwrap();
            assert!(count > 0);
            input = &input[count..];
        }
    }
}

#[test]
fn unicode_modes_alternate_screen_reflow_and_history_are_observable() {
    let mut screen = Screen::new(TerminalSize::new(10, 3).unwrap());
    assert_eq!(
        screen.write("hello 中文😀\r\nnext\x1b[6n").unwrap(),
        "\x1b[3;5R"
    );
    let first = screen.preview(50 * 1024).unwrap();
    assert!(first.screen.contains("中文"));
    screen
        .write("\x1b[?1h\x1b[?1002h\x1b[?1006h\x1b[?25l")
        .unwrap();
    let modes = screen.preview(50 * 1024).unwrap();
    assert!(!modes.cursor.visible);
    assert!(modes.input.application_cursor_keys_mode);
    assert_eq!(
        modes.input.mouse_tracking_mode,
        maka_agent_facts::terminal::MouseTracking::Drag
    );
    screen.write("𝄞e\u{301}").unwrap();
    screen
        .write("\x1b[?1049h\x1b[HALT\r\nsecond\x1b[?1049l")
        .unwrap();
    let restored = screen.preview(50 * 1024).unwrap();
    assert!(!restored.alternate_screen);
    assert_eq!(
        restored.last_alternate_screen.as_deref(),
        Some("ALT\nsecond")
    );
    assert!(restored.screen.contains("next"));
    screen.resize(TerminalSize::new(5, 4).unwrap()).unwrap();
    assert_eq!(screen.preview(50 * 1024).unwrap().size.cols(), 5);
    screen.write("\x1bc").unwrap();
    screen.write(&"line\r\n".repeat(520)).unwrap();
    let history = screen.preview(50 * 1024).unwrap();
    assert!(!history.truncated);
    assert!(history.scrollback.lines().count() > 500);
    assert!(history.screen.contains("line"));

    let mut reflow = Screen::new(TerminalSize::new(6, 3).unwrap());
    reflow.write("abcdefghijkl").unwrap();
    reflow.resize(TerminalSize::new(4, 4).unwrap()).unwrap();
    let resized = reflow.preview(50 * 1024).unwrap();
    assert_eq!(
        format!("{}{}", resized.scrollback, resized.screen).replace('\n', ""),
        "abcdefghijkl"
    );
}

#[test]
fn unicode_cuts_gaps_and_adversarial_streams_preserve_bounded_state() {
    let size = TerminalSize::new(10, 3).unwrap();
    let mut screen = Screen::new(size);
    for c in "中文😀e\u{301}".chars() {
        screen.write(c.encode_utf8(&mut [0; 4])).unwrap();
    }
    assert_eq!(screen.preview(50 * 1024).unwrap().screen, "中文😀e\u{301}");
    screen.write("\x1b]52;c;unterminated").unwrap();
    screen.reset_after_gap();
    screen.write("after").unwrap();
    let snapshot = screen.preview(50 * 1024).unwrap();
    assert_eq!(snapshot.screen, "after");
    assert!(snapshot.truncated);
    screen.write(&"x".repeat(65537)).unwrap();
    assert!(screen.preview(50 * 1024).unwrap().screen.contains("xxxxx"));
    for bytes in [
        b"\x1b]0;"
            .iter()
            .copied()
            .chain(std::iter::repeat_n(b'x', 65540))
            .collect::<Vec<_>>(),
        format!("x{}", "\u{301}".repeat(100)).into_bytes(),
    ] {
        let mut screen = Screen::new(size);
        let mut failed = false;
        for chunk in bytes.chunks(1024) {
            if screen.write(std::str::from_utf8(chunk).unwrap()).is_err() {
                failed = true;
                break;
            }
        }
        assert!(failed, "unbounded sequence accepted");
        assert!(screen.preview(50 * 1024).is_err());
    }
    // Suppressed OSC capabilities cannot emit clipboard data or grow a title stack.
    let mut safe = Screen::new(size);
    assert_eq!(
        safe.write("\x1b]52;c;aGVsbG8=\x07\x1b]52;c;?\x07OK\x1b[5n")
            .unwrap(),
        "\x1b[0n"
    );
    assert_eq!(safe.preview(50 * 1024).unwrap().screen, "OK");

    // Large historical grapheme clusters must not crowd the current viewport
    // out of the bounded snapshot.
    let mut history = Screen::new(TerminalSize::new(240, 4).unwrap());
    let row = format!("{}\r\n", format!("x{}", "\u{301}".repeat(32)).repeat(240));
    for index in 0..150 {
        history
            .write(&row)
            .unwrap_or_else(|error| panic!("row {index}: {error}"));
    }
    history.write("current-frame").unwrap();
    let snapshot = history.preview(50 * 1024).unwrap();
    assert!(snapshot.truncated);
    assert!(snapshot.screen.contains("current-frame"));
    assert!(snapshot.screen.len() + snapshot.scrollback.len() <= 2 * 1024 * 1024);
}

#[test]
fn large_ignored_clipboard_strings_preserve_screen_replies_and_following_output() {
    // A native 64 KiB clipboard copy has an 87 KiB base64 wire payload. It must
    // not consume Screen's OSC accumulator: clipboard effects are not supported.
    let decoded_bytes = 64 * 1024;
    let encoded = "YWFh".repeat(decoded_bytes / 3) + "YQ==";
    for ending in ["\x07", "\x1b\\", "\x18", "\x1a", "\x1b[31m"] {
        let mut screen = Screen::new(TerminalSize::new(20, 3).unwrap());
        screen.write("before").unwrap();
        // Split the command prefix, including an ignored C0, across writes.
        for prefix in ["\x1b", "]", "5", "\0", "2", ";", "c", ";"] {
            assert_eq!(screen.write(prefix).unwrap(), "");
        }
        for chunk in encoded.as_bytes().chunks(8192) {
            assert_eq!(
                screen.write(std::str::from_utf8(chunk).unwrap()).unwrap(),
                ""
            );
        }
        for character in ending.chars() {
            assert_eq!(
                screen.write(character.encode_utf8(&mut [0; 4])).unwrap(),
                ""
            );
        }
        assert_eq!(screen.write("after\x1b[5n").unwrap(), "\x1b[0n");
        assert_eq!(screen.preview(50 * 1024).unwrap().screen, "beforeafter");
        assert_eq!(screen.preview(50 * 1024).unwrap().cursor.x, 11);
    }
}

#[test]
fn large_valid_writes_and_clamped_scrolls_do_not_fail_the_parser() {
    let mut screen = Screen::new(TerminalSize::new(80, 24).unwrap());
    screen.write(&"x".repeat(128 * 1024)).unwrap();
    screen
        .write("x\x1b[65535b\x1b[65535b\x1b[65535S\x1b[Hstill-live")
        .unwrap();
    assert!(
        screen
            .preview(50 * 1024)
            .unwrap()
            .screen
            .contains("still-live")
    );
    assert!(TerminalSize::new(1024, 64).is_ok());
    assert!(TerminalSize::new(64, 1024).is_ok());
    assert!(TerminalSize::new(1024, 65).is_err());
    assert!(TerminalSize::new(1025, 1).is_err());
}

#[test]
fn narrowing_a_full_history_keeps_the_same_cell_allowance_through_reflow() {
    let mut screen = Screen::new(TerminalSize::new(80, 24).unwrap());
    let line = format!("FIRST{}", "x".repeat(75));
    screen
        .write(&format!(
            "{line}\r\n{}",
            format!("{}\r\n", "y".repeat(80)).repeat(9_999)
        ))
        .unwrap();
    let before = screen.display();
    assert_eq!(before.scrollback.first().unwrap()[0].text, line);
    screen.resize(TerminalSize::new(40, 24).unwrap()).unwrap();
    let after = screen.display();
    assert!(after.scrollback.len() > 10_000);
    assert!(after.text(2 * 1024 * 1024).scrollback.starts_with(&line));
    assert!(after.scrollback.len() * 40 <= maka_agent_facts::terminal::HISTORY_CELLS);
}
