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

#![cfg(unix)]

mod attachments;
mod board;
mod branch;
mod builtins;
mod changes;
mod cold_startup;
mod connection_test;
mod connections;
mod credentials;
mod enabled_models;
mod environment;
mod extensions;
mod fault_acceptance;
mod forms;
mod frames;
mod goal;
mod imports;
mod input;
mod management;
mod memory_acceptance;
mod model_fetch;
mod model_profiles;
mod models;
mod navigation;
mod oauth;
mod onboarding;
mod plugins;
mod projects;
mod queue;
mod reading;
mod recap;
mod recovery;
mod references;
mod removal;
mod revision;
mod sandbox;
mod scheduler;
mod shutdown;
mod skills;
mod startup;
mod stopping;
mod support;
mod themes;
mod workhub;

use maka_process::terminal::Screen;
use maka_runtime::terminal::TerminalSize;
use std::{
    fs::File,
    io::{Read, Write},
    os::{
        fd::{AsRawFd, FromRawFd},
        unix::process::CommandExt,
    },
    process::{Child, Command, Stdio},
    time::{Duration, Instant},
};
use unicode_width::UnicodeWidthStr;

#[test]
fn default_entry_rejects_pipes_without_control_sequences() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("unused-root");
    for (args, message) in [
        (
            vec!["--root", root.to_str().unwrap()],
            "requires a terminal",
        ),
        (
            vec!["tui", "--root", root.to_str().unwrap()],
            "requires a terminal",
        ),
        (
            vec!["--root", root.to_str().unwrap(), "--locale", "zh-CN"],
            "需要终端输入和输出",
        ),
        (
            vec!["tui", "--root", root.to_str().unwrap(), "--locale", "zh-TW"],
            "需要終端機輸入和輸出",
        ),
    ] {
        let output = Command::new(env!("CARGO_BIN_EXE_maka"))
            .args(args)
            .env("MAKA_LOCALE", "en")
            .stdin(Stdio::null())
            .output()
            .unwrap();
        assert!(!output.status.success());
        assert!(String::from_utf8_lossy(&output.stderr).contains(message));
        assert!(!output.stdout.contains(&0x1b));
        assert!(
            !root.exists(),
            "noninteractive invocations must not initialize a Host"
        );
    }
}

#[test]
fn real_pty_default_entry_routes_mouse_modal_resize_and_restores_terminal() {
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("occupied");
    std::fs::create_dir(&root).unwrap();
    std::fs::write(root.join("keep.txt"), "not a Maka root").unwrap();
    let mut tui = Pty::spawn(&["--root", root.to_str().unwrap()]);
    tui.wait_for("connection failed");
    assert!(!root.join(maka_event_log::root::ROOT_MARKER).exists());
    assert_eq!(
        std::fs::read_to_string(root.join("keep.txt")).unwrap(),
        "not a Maka root"
    );

    tui.click_text("Settings");
    tui.wait_for("Maka dark ▾");
    tui.send(b"\x10"); // Ctrl+P
    tui.wait_for("Search commands…");
    // Outside click closes only the modal, without activating the workspace.
    tui.send(b"\x1b[<0;3;5M\x1b[<0;3;5m");
    tui.wait_until(|screen| !screen.contains("Open workspace") && screen.contains("Maka dark ▾"));
    // Real SGR clicks open the palette chooser and pick each value in turn.
    for palette in [
        "Dusk",
        "Paper",
        "Terminal default",
        "Maka dark",
        "Terminal default",
    ] {
        tui.click_text("◐");
        tui.wait_for(&format!("○ {palette}"));
        tui.click_text(&format!("○ {palette}"));
        tui.wait_for(&format!("{palette} ▾"));
    }

    // Keyboard reaches the language control, then real SGR clicks choose CJK
    // labels. The page, colors and connection survive every change. Left
    // returns from the clicked row to the categories, at the current one.
    tui.send(b"\x1b[D");
    tui.wait_until(|screen| !screen.contains("Choose Palette"));
    tui.send(b"\x1b[B");
    tui.wait_for("English ▾"); // MAKA_LOCALE=en is an explicit preference.
    tui.send(b"\x1b[C");
    tui.wait_for("Choose Language");
    tui.send(b"\r");
    tui.wait_for("○ 简体中文");
    tui.click_text("○ 简体中文");
    tui.wait_for("简体中文 ▾");
    tui.click_text("外观");
    tui.wait_for("终端默认 ▾");
    tui.click_text("界面");
    tui.wait_for("简体中文 ▾");
    tui.click_text("文");
    tui.wait_for("○ 繁體中文");
    tui.click_text("○ 繁體中文");
    tui.wait_for("繁體中文 ▾");
    tui.wait_for("外觀");
    tui.send(b"\r"); // The clicked row keeps keyboard focus.
    tui.wait_for("○ English");
    tui.send(b"\x1b[A\x1b[A\r");
    tui.wait_for("English ▾");

    tui.resize(80, 24);
    // Narrow windows hide the session sidebar; Host details stay one command away.
    tui.wait_until(|screen| !screen.contains("+  New session"));
    tui.host_details();
    tui.wait_for("refusing to initialize a nonempty State Root");
    tui.close_terminal();
    tui.finish();
    let mut termios = unsafe { std::mem::zeroed::<libc::termios>() };
    assert_eq!(
        unsafe { libc::tcgetattr(tui.master.as_ref().unwrap().as_raw_fd(), &mut termios) },
        0
    );
    assert_ne!(
        termios.c_lflag & libc::ICANON,
        0,
        "canonical input was not restored"
    );
    assert_ne!(termios.c_lflag & libc::ECHO, 0, "echo was not restored");
    let snapshot = tui.screen.snapshot().unwrap();
    assert!(!snapshot.alternate_screen);
    assert!(snapshot.cursor.visible);
    for sequence in [b"\x1b[?1004h", b"\x1b[?1004l"] {
        assert!(
            tui.output
                .windows(sequence.len())
                .any(|bytes| bytes == sequence),
            "focus reporting must be enabled and restored"
        );
    }
}

struct Pty {
    child: Child,
    master: Option<File>,
    // Keep one slave descriptor to read the final termios and avoid EIO while draining.
    slave: Option<File>,
    screen: Screen,
    pending: Vec<u8>,
    output: Vec<u8>,
    frames: frames::Frames,
    read_size: usize,
}

#[test]
fn real_host_catalog_subscription_and_remote_updates_reach_clients() {
    use maka_protocol::subscription::{
        ObservationFrame, SessionProjectionFrame, SubscriptionOpenInput, TranscriptPolicy,
    };
    use maka_protocol::{Operation, session::*};
    use serde_json::json;
    let directory = tempfile::tempdir().unwrap();
    let mut host = super::candidate::CandidateFixture::new(directory.path().join("root"));
    host.child = Some(
        Command::new(env!("CARGO_BIN_EXE_maka"))
            .args(["host", "serve", "--root"])
            .arg(&host.root)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::inherit())
            .spawn()
            .unwrap(),
    );
    host.wait_for_registration();
    let runtime = tokio::runtime::Runtime::new().unwrap();
    let approval_file = directory.path().join("approved.txt");
    std::fs::write(&approval_file, "original").unwrap();
    std::fs::write(
        directory.path().join("reference.txt"),
        "tool-group-reference",
    )
    .unwrap();
    let (model_url, finish_model, model_task) =
        runtime.block_on(streaming_model(approval_file.clone()));
    let (client, first, second) = runtime.block_on(async {
        let client = support::model_client(&host.root, &model_url).await;
        for index in 0..34 {
            let input = decode_session_create_input(&json!({
                "sessionId":format!("session-{index:02}"), "name":format!("Session {index:02}"),
                "workspace":{"kind":"host_path","path":directory.path()},
                "sandboxMode":"read-only",
                "modelTarget":{"kind":"default"}
            }))
            .unwrap();
            client.create_session(input).await.unwrap();
        }
        let SessionCatalogQueryResult::Page {
            revision,
            sessions: first,
            next_cursor: Some(cursor),
        } = client
            .session_catalog(SessionCatalogQueryInput::ListStart)
            .await
            .unwrap()
        else {
            panic!("34 sessions must paginate");
        };
        let SessionCatalogQueryResult::Page {
            sessions: second,
            next_cursor: None,
            ..
        } = client
            .session_catalog(SessionCatalogQueryInput::ListContinue { revision, cursor })
            .await
            .unwrap()
        else {
            panic!("second page must finish the catalog");
        };
        assert_eq!(first.len(), 32);
        assert_eq!(second.len(), 2);
        (client, first, second)
    });
    // A production-registry observer shares the Host with the TUI and mutation
    // client. This proves actual snapshot/ready framing, not just mock decoding.
    let (observer, mut observations, subscription) = runtime.block_on(async {
        let discovery = maka_client::local::read_discovery(&host.root).unwrap();
        let stream = maka_client::local::open_stream(&discovery.endpoint)
            .await
            .unwrap();
        let (observer, observations) = maka_client::Client::connect(
            stream,
            &discovery.root_id,
            &discovery.host_epoch,
            maka_client::Operations,
        )
        .await
        .unwrap();
        let opened = observer
            .open_subscription(SubscriptionOpenInput {
                session_id: second[0].id.clone(),
                transcript: TranscriptPolicy::Tail { max_bytes: 16_384 },
            })
            .await
            .unwrap();
        let bootstrap = opened.transcript.unwrap();
        assert_eq!(bootstrap.durable.session_id, second[0].id);
        assert!(bootstrap.durable.fragments.is_empty());
        let page = observer
            .transcript_page(maka_protocol::transcript::SessionTranscriptPageInput {
                subscription_id: opened.subscription_id.clone(),
                direction: maka_protocol::transcript::SessionTranscriptPageDirection::Older,
                through_sequence: bootstrap.durable.through_sequence,
                cursor: None,
                anchor_sequence: None,
                max_bytes: 16_384,
            })
            .await
            .unwrap();
        assert!(page.fragments.is_empty());
        observer
            .ready_subscription(&opened.subscription_id)
            .await
            .unwrap();
        (observer, observations, opened.subscription_id)
    });
    let mut tui = Pty::spawn_at(
        &["--root", host.root.to_str().unwrap()],
        Some(directory.path()),
    );
    tui.wait_for(&first[0].name);
    // Plugin pages pin below the list and change its viewport when they arrive.
    for page in ["WorkHub", "Scheduled tasks", "Recall"] {
        tui.wait_for(page);
    }
    // The sidebar keeps loading older sessions at the end of its list.
    tui.wheel_at(&first[0].name, true, 12);
    tui.wait_for("Load more…");
    tui.click_text("Load more…");
    tui.wait_for(&second[0].name);
    tui.click_text(&second[0].name);
    tui.wait_for("Message…");
    tui.resize(80, 24);
    tui.wait_until(|screen| !screen.contains("+  New session") && screen.contains("Message…"));
    tui.click_text("ⓘ");
    tui.wait_for(&format!("Session ID: {}", second[0].id));
    tui.click_text("Message…");
    // Bracketed paste, grapheme deletion and scoped undo traverse the real event loop.
    tui.send("\x1b[200~草稿 e\u{301}\x1b[201~".as_bytes());
    tui.wait_for("草稿 e\u{301}");
    tui.send(b"\x7f");
    tui.wait_until(|screen| screen.contains("草稿") && !screen.contains("e\u{301}"));
    tui.send(b"\x1a"); // Ctrl+Z must undo inside the editor, not suspend the client.
    tui.wait_for("草稿 e\u{301}");
    tui.send(b"\x1b[23~"); // F11 expands the same session, without replacing its draft.
    tui.wait_until(|screen| screen.contains("⊡"));
    tui.wait_for("草稿 e\u{301}");
    tui.send(b"\x1b[23~\x02"); // Restore, then expand navigation with Ctrl+B.
    tui.wait_for("+  New session");
    tui.send(b"\x1b"); // Escape leaves the composer without leaving the session.
    runtime.block_on(async {
        client
            .request(
                Operation::SessionMetadataUpdate,
                json!({
                    "sessionId":second[0].id, "expectedRevision":second[0].revision,
                    "patch":{"name":"Renamed from another client"}
                }),
            )
            .await
            .unwrap();
    });
    tui.wait_for("Renamed from another client");
    runtime.block_on(async {
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if let Some(maka_client::Notification::Observation(frame)) =
                    observations.recv().await
                {
                    if let ObservationFrame::Projection(frame) = *frame {
                        let SessionProjectionFrame::SessionProjection { snapshot, .. } = *frame;
                        assert_eq!(snapshot.session.session_id, second[0].id);
                        if snapshot.session.metadata_revision > second[0].revision {
                            break;
                        }
                    }
                } else if observations.is_closed() {
                    panic!("observer disconnected before projection update");
                }
            }
        })
        .await
        .unwrap();
        observer.close_subscription(&subscription).await.unwrap();
    });
    tui.wait_for("草稿 e\u{301}"); // Background updates must not replace the draft.
    tui.click_text("ⓘ"); // Close metadata and expose the conversation.
    tui.click_text("➤"); // SGR mouse hits the actual composer send button.
    tui.wait_for("Streamed 中文🦀");
    // A reading tab is not execution ownership. Close it during a live stream,
    // open a second session, then return via the catalog and cycle tabs. The
    // original stream is still running and the other composer's draft survives.
    tui.send(b"\x17"); // Ctrl+W
    tui.wait_until(|screen| screen.contains("Workspace") && !screen.contains("Streamed 中文🦀"));
    tui.send(b"\x1b[H"); // Return to the start of the scrollable session directory.
    tui.wait_for(&first[0].name);
    tui.wait_for(&first[1].name);
    tui.click_text(&first[1].name);
    tui.wait_for("Message…");
    tui.send("\x1b[200~另一份草稿🦀\x1b[201~".as_bytes());
    tui.wait_for("另一份草稿🦀");
    // Straight from the sidebar, where the older page sits below the fold.
    tui.wheel_at(&first[2].name, true, 12);
    // Short sidebars include apps after the sessions. The final app showing
    // means the wheel has reached the end, so rows no longer move under a click.
    tui.wait_until(|screen| {
        screen.contains("Renamed from another")
            && screen.contains(&second[1].name)
            && screen.contains("Recall")
    }); // Long names end in an ellipsis there.
    tui.click_last_text("Renamed from another");
    tui.wait_for("Streamed 中文🦀");
    tui.send(b"\x1b[5;5~"); // Ctrl+PgUp
    tui.wait_for("另一份草稿🦀");
    tui.send(b"\x1b[6;5~"); // Ctrl+PgDn
    tui.wait_for("Streamed 中文🦀");
    finish_model.send(()).unwrap(); // Prove this was visible before completion.
    tui.wait_for("Streamed 中文🦀 · finished");
    tui.wait_for("Run · Waiting for you");
    tui.wait_for("!");
    let approval = runtime.block_on(async {
        let opened = observer
            .open_subscription(SubscriptionOpenInput {
                session_id: second[0].id.clone(),
                transcript: TranscriptPolicy::None,
            })
            .await
            .unwrap();
        let approval = opened.snapshot.interactions.pending()[0].clone();
        observer
            .close_subscription(&opened.subscription_id)
            .await
            .unwrap();
        approval
    });
    assert_eq!(
        std::fs::read_to_string(&approval_file).unwrap(),
        "original",
        "effect must wait for explicit consent"
    );
    tui.click_text("!");
    tui.wait_for("Review request");
    tui.wait_for("Allow once");
    tui.send(b"\r"); // Default is Later, never an approval.
    tui.wait_until(|screen| !screen.contains("Review request"));
    assert_eq!(std::fs::read_to_string(&approval_file).unwrap(), "original");
    tui.send(b"\x01"); // Ctrl+A outside the composer reopens the pinned request.
    tui.wait_for("Review request");
    tui.wait_for("Allow once");
    tui.click_text("Allow once");
    tui.wait_for("Decision recorded by Host.");
    tui.send(b"\x1b");
    // Background output may already contain the next question while the approval
    // is still open. Publish its dismissal before sending another escape-prefixed
    // input sequence; a bare Esc followed by SGR can merge in the terminal parser.
    tui.wait_until(|screen| !screen.contains("Review request"));
    tui.wait_for("Approval complete");
    tui.wait_for("Question · Waiting for you"); // Not the previous approval's still-visible indicator.
    tui.wait_for("!");
    tui.click_text("!");
    tui.wait_for("Pick a destination");
    tui.wait_for("Submit answers");
    tui.click_text("Beta");
    tui.click_text("2 ○");
    tui.wait_for("Explain your choice");
    tui.click_text("Write your own answer");
    tui.send("\x1b[200~自由回答🦀\x1b[201~".as_bytes());
    tui.wait_for("自由回答🦀");
    tui.click_text("3 ○");
    tui.wait_for("Optional detail");
    tui.click_text("Skip this question");
    tui.wait_for("3 / 3 answered");
    tui.click_text("Submit answers");
    tui.wait_for("Decision recorded by Host.");
    tui.send(b"\x1b");
    runtime.block_on(model_task).unwrap();
    assert_eq!(std::fs::read_to_string(&approval_file).unwrap(), "approved");
    let receipt = runtime.block_on(observer.interaction(&approval)).unwrap();
    assert!(receipt.is_answered());
    assert_eq!(
        serde_json::to_value(receipt.outcome()).unwrap()["decision"]["scope"],
        "once"
    );
    tui.resize(120, 50); // Keep the expanded transcript visible after the added tool cycle.
    tui.wait_for("Answers received");
    tui.wait_for("≈9.5k / 128.0k"); // Current usage sits on the composer, not an extra status row.
    tui.click_text("ⓘ");
    tui.wait_for("Last input 9.5k / 128.0k"); // Diagnostics only, not current context occupancy.
    tui.click_text("ⓘ");
    tui.filter_command("Show execution details");
    tui.click_text("Show execution details");
    tui.wait_for("Completed"); // Durable terminal state is available in the opt-in trace.
    tui.filter_command("Hide execution details");
    tui.click_text("Hide execution details");
    tui.wait_until(|screen| !screen.contains("Completed"));
    tui.wait_for("Read × 2 · Search × 1");
    tui.click_text("Read × 2 · Search × 1");
    tui.wait_for("reference.txt");
    tui.click_text("◆ Read"); // Individual call inside the expanded group.
    tui.wait_for("Lines 1–1 of 1");
    tui.click_text("Read × 2 · Search × 1");
    tui.wait_until(|screen| screen.contains("Lines 1–1 of 1") && !screen.contains("reference.txt"));
    tui.click_text("◆ Read");
    tui.wait_until(|screen| !screen.contains("Lines 1–1 of 1"));
    // Keyboard reaches the same nested card in a short, unscrolled conversation.
    tui.send(b"\r");
    tui.wait_for("reference.txt");
    tui.send(b"\x1b[C\r");
    tui.wait_for("Lines 1–1 of 1");
    tui.send(b"\x1b[D\x1b[D ");
    tui.wait_until(|screen| {
        !screen.contains("Lines 1–1 of 1") && !screen.contains("reference.txt")
    });
    tui.wait_for("Foldable detail");
    tui.wait_for("other  │   123"); // Actual terminal cells align the numeric column.
    tui.drag_last_text("中文🦀");
    tui.wait_for("Ctrl+C Copy");
    tui.send(b"\x1b[1;2D\x03"); // Shift+Left removes one complete emoji from the mouse selection.
    tui.wait_output(b"\x1b]52;c;5Lit5paH\x07");
    tui.send(b"\x1b[1;2C\x03"); // Shift+Right restores it without touching the composer.
    tui.wait_output(b"\x1b]52;c;5Lit5paH8J+mgA==\x07");
    tui.wait_for("Copy request sent to terminal");
    assert!(
        tui.output
            .windows(b"\x1b]52;c;5Lit5paH8J+mgA==\x07".len())
            .any(|bytes| bytes == b"\x1b]52;c;5Lit5paH8J+mgA==\x07")
    );
    tui.send(b"\x1b"); // Clear selection, without folding or leaving the session.
    tui.wait_for("↑↓ Select"); // Wait for the cleared selection before sending a mouse escape sequence.
    // A real Host result replaces its owning call card, not a second raw JSON row.
    tui.click_text("◆ Run");
    tui.wait_for("Completed");
    tui.wait_for("Arguments");
    tui.wait_for("additional_permissions:");
    tui.resize(80, 18);
    tui.wait_for("Arguments");
    assert!(
        !tui.screen
            .snapshot()
            .unwrap()
            .screen
            .contains("Answers received")
    );
    tui.drag_text_to_row("Arguments", 16); // Hold beyond the body; no further mouse movement.
    tui.wait_until(|screen| screen.contains("Answers received") && !screen.contains("Arguments"));
    tui.send(b"\x1b[<0;4;17m");
    tui.send(b"\x1b");
    tui.resize(120, 50);
    // Wait for the new bottom row, not a card still present in the old geometry.
    tui.wait_until(|screen| {
        screen
            .lines()
            .nth(49)
            .is_some_and(|line| line.contains("Esc Controls"))
    });
    tui.wait_for("◆ Run");
    tui.click_text("◆ Run");
    tui.wait_until(|screen| !screen.contains("additional_permissions:"));
    tui.send(b"\x06"); // Ctrl+F searches locally, including the folded real tool result.
    tui.wait_for("Loaded");
    tui.send(b"\x1b[200~additional_permissions\x1b[201~");
    tui.wait_for("1/1");
    tui.wait_for("additional_permissions:");
    tui.send(b"\r"); // A search Enter navigates; it must not submit the composer.
    tui.wait_for("1/1");
    tui.send(b"\x1bf"); // Alt+F changes scope without writing into the draft.
    tui.wait_for("∞ History");
    tui.wait_for("1/1");
    tui.wait_for("Arguments");
    tui.wait_for("additional_permissions:");
    tui.send(b"\x1b");
    tui.wait_until(|screen| !screen.contains("∞ History"));
    tui.wait_for("◆ Run"); // The removed search header can arrive before the new body's PTY bytes.
    tui.click_text("◆ Run");
    tui.wait_until(|screen| !screen.contains("additional_permissions:"));
    tui.click_text("  Streamed"); // At rest an answer has no gutter glyph; folding it shows one.
    tui.wait_for("▸ Streamed");
    assert!(
        !tui.screen
            .snapshot()
            .unwrap()
            .screen
            .contains("Foldable detail")
    );
    tui.click_text("▸ Streamed");
    tui.wait_for("Foldable detail");
    tui.send(b"\x1b[H "); // A complete short user line has nothing to disclose.
    tui.wait_for("❯ 草稿");
    assert!(!tui.screen.snapshot().unwrap().screen.contains("▸ 草稿"));
    tui.send(b"\x1b[F"); // End outside the composer restores tail following.
    runtime.block_on(async {
        use maka_protocol::message::ExecutionResolution;
        let opened = observer
            .open_subscription(SubscriptionOpenInput {
                session_id: second[0].id.clone(),
                transcript: TranscriptPolicy::Tail { max_bytes: 16_384 },
            })
            .await
            .unwrap();
        let batch = observer
            .complete_transcript_page(&opened.subscription_id, opened.transcript.unwrap().durable)
            .await
            .unwrap();
        let found = observer
            .transcript_search(maka_protocol::transcript::TranscriptSearchInput {
                subscription_id: opened.subscription_id.clone(),
                through_sequence: batch.through_sequence,
                query: "Streamed 中文".into(),
                include_internal: false,
                cursor: None,
                max_matches: 8,
            })
            .await
            .unwrap();
        assert_eq!(found.matches.len(), 1);
        assert!(found.matches[0].preview.contains("Streamed 中文"));
        let user = &batch
            .rows
            .iter()
            .find(|row| row.value["type"] == "user")
            .unwrap()
            .value;
        let message = user["id"].as_str().unwrap();
        let resolution = observer
            .message_execution(&second[0].id, message)
            .await
            .unwrap();
        assert!(
            matches!(resolution, Some(ExecutionResolution::Owned { message_id, turn_id, .. })
            if message_id == message && turn_id == user["turnId"].as_str().unwrap())
        );
        assert!(matches!(
            observer.message_execution(&second[0].id, "never-submitted").await.unwrap(),
            Some(maka_protocol::message::ExecutionResolution::NotAdmitted { message_id })
                if message_id == "never-submitted"
        ));
        observer
            .close_subscription(&opened.subscription_id)
            .await
            .unwrap();
    });
    observer.disconnect();
    tui.send(b"\x1b"); // Leave transcript focus for composer controls, not the session.
    tui.wait_for("Attachments");
    assert!(
        tui.screen
            .snapshot()
            .unwrap()
            .screen
            .lines()
            .next()
            .is_some_and(|header| header.contains("Renamed from another")),
        "first Esc preserves the session route"
    );
    tui.send(b"\x1b"); // Separate Esc events, not the terminal's Alt+Esc encoding.
    tui.wait_for("另一份草稿🦀"); // Back follows the actual most recent tab visit.
    tui.wait_for("Renamed from another");
    tui.click_text("Renamed from another");
    tui.wait_for("Streamed 中文🦀 · finished"); // Reopened from durable transcript.
    let text = tui.screen.snapshot().unwrap().screen;
    assert_eq!(text.matches("Streamed 中文🦀 · finished").count(), 1);
    tui.send(b"\x0e"); // Ctrl+N from any page creates in this process's workspace.
    tui.wait_for("New conversation");
    tui.wait_for("No messages yet.");
    tui.close_terminal();
    tui.finish();
    assert!(
        runtime
            .block_on(client.session(&second[0].id))
            .unwrap()
            .is_some(),
        "closing a terminal must leave its separately owned Host running"
    );
    client.disconnect();
    host.retire_registered();
    assert!(host.wait_for_exit().success());
}

async fn streaming_model(
    approval_file: std::path::PathBuf,
) -> (
    String,
    tokio::sync::oneshot::Sender<()>,
    tokio::task::JoinHandle<()>,
) {
    use serde_json::json;
    use tokio::io::AsyncWriteExt;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/v1", listener.local_addr().unwrap());
    let (finish, finished) = tokio::sync::oneshot::channel();
    let task = tokio::spawn(async move {
        let (mut stream, body) = model_request(&listener).await;
        assert!(body.to_string().contains("草稿"));
        let headers =
            b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n";
        let chunk = |delta: serde_json::Value, reason: Option<&str>| {
            format!(
                "data: {}\n\n",
                json!({
                    "id":"chat-tui","object":"chat.completion.chunk","model":"fixture-model",
                    "choices":[{"index":0,"delta":delta,"finish_reason":reason}],
                    "usage":reason.map(|_| json!({"prompt_tokens":9500,"completion_tokens":12,"total_tokens":9512}))
                })
            )
        };
        let call = |id: &str, name: &str, arguments: serde_json::Value| {
            json!({"tool_calls":[{
                "index":0,"id":id,"type":"function","function":{"name":name,"arguments":arguments.to_string()}
            }]})
        };
        stream.write_all(headers).await.unwrap();
        stream
            .write_all(chunk(json!({"content":"**Streamed 中文🦀"}), None).as_bytes())
            .await
            .unwrap();
        tokio::time::timeout(Duration::from_secs(15), finished)
            .await
            .unwrap()
            .unwrap();
        stream.write_all(chunk(json!({"content":" · finished**\n\nFoldable detail\n\n| Label | Count |\n| --- | ---: |\n| 中文🦀 | 7 |\n| other | 123 |\n"}),None).as_bytes()).await.unwrap();
        stream.write_all(chunk(call("approve-write","Shell",json!({
            "command":format!("printf approved > '{}'",approval_file.display()),
            "additional_permissions":{"filesystem":[{"path":approval_file,"scope":"exact","access":"write"}],"network":"denied"},
            "justification":"Write only the isolated TUI approval fixture."
        })),Some("tool_calls")).as_bytes()).await.unwrap();
        stream.write_all(b"data: [DONE]\n\n").await.unwrap();
        drop(stream);

        let (mut stream, body) = model_request(&listener).await;
        assert_eq!(
            std::fs::read_to_string(&approval_file).unwrap(),
            "approved",
            "tool response: {body}"
        );
        stream.write_all(headers).await.unwrap();
        stream
            .write_all(chunk(json!({"content":"Approval complete"}), None).as_bytes())
            .await
            .unwrap();
        let workspace = approval_file.parent().unwrap();
        let mut reads = Vec::new();
        for (index, (id, name, args)) in [
            ("read-approved", "Read", json!({"path":approval_file})),
            (
                "read-reference",
                "Read",
                json!({"path":workspace.join("reference.txt")}),
            ),
            (
                "find-files",
                "Glob",
                json!({"pattern":"*.txt","cwd":workspace}),
            ),
        ]
        .into_iter()
        .enumerate()
        {
            let mut tool = call(id, name, args)["tool_calls"][0].clone();
            tool["index"] = json!(index);
            reads.push(tool);
        }
        stream
            .write_all(chunk(json!({"tool_calls":reads}), Some("tool_calls")).as_bytes())
            .await
            .unwrap();
        stream.write_all(b"data: [DONE]\n\n").await.unwrap();
        drop(stream);
        let (mut stream, body) = model_request(&listener).await;
        for (id, expected) in [
            ("read-approved", "approved"),
            ("read-reference", "tool-group-reference"),
            ("find-files", "reference.txt"),
        ] {
            assert!(
                body["messages"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|message| message["tool_call_id"] == id
                        && message["content"]
                            .as_str()
                            .is_some_and(|content| content.contains(expected))),
                "missing real tool result: {body}"
            );
        }
        stream.write_all(headers).await.unwrap();
        stream.write_all(chunk(call("ask-user","AskUserQuestion",json!({"questions":[
            {"question":"Pick a destination","options":[{"label":"Alpha","description":"First choice"},{"label":"Beta"}]},
            {"question":"Explain your choice","options":[{"label":"Fast"},{"label":"Simple"}]},
            {"question":"Optional detail","options":[{"label":"Include"},{"label":"Omit"}]}
        ]})),Some("tool_calls")).as_bytes()).await.unwrap();
        stream.write_all(b"data: [DONE]\n\n").await.unwrap();
        drop(stream);

        let (mut stream, body) = model_request(&listener).await;
        let answer = body["messages"]
            .as_array()
            .unwrap()
            .iter()
            .find(|message| message["tool_call_id"] == "ask-user")
            .unwrap();
        let answer: serde_json::Value =
            serde_json::from_str(answer["content"].as_str().unwrap()).unwrap();
        assert_eq!(
            answer,
            json!({"answers":[
                {"question":"Pick a destination","answer":"Beta"},
                {"question":"Explain your choice","answer":"自由回答🦀"},
                {"question":"Optional detail","answer":null}
            ]})
        );
        stream.write_all(headers).await.unwrap();
        stream
            .write_all(chunk(json!({"content":"Answers received"}), None).as_bytes())
            .await
            .unwrap();
        stream
            .write_all(chunk(json!({}), Some("stop")).as_bytes())
            .await
            .unwrap();
        stream.write_all(b"data: [DONE]\n\n").await.unwrap();
    });
    (url, finish, task)
}

async fn model_request(
    listener: &tokio::net::TcpListener,
) -> (tokio::net::TcpStream, serde_json::Value) {
    let (stream, body, _) = model_request_with_headers(listener).await;
    (stream, body)
}
async fn model_request_with_headers(
    listener: &tokio::net::TcpListener,
) -> (tokio::net::TcpStream, serde_json::Value, String) {
    let (stream, body, head) = model_http_request(listener).await;
    assert_eq!(body["model"], "fixture-model");
    assert_eq!(body["stream"], true);
    (stream, body, head)
}
async fn model_http_request(
    listener: &tokio::net::TcpListener,
) -> (tokio::net::TcpStream, serde_json::Value, String) {
    use tokio::io::AsyncReadExt;
    let (mut stream, _) = tokio::time::timeout(Duration::from_secs(20), listener.accept())
        .await
        .unwrap()
        .unwrap();
    let mut bytes = Vec::new();
    let mut buffer = [0; 4096];
    loop {
        let count = tokio::time::timeout(Duration::from_secs(20), stream.read(&mut buffer))
            .await
            .unwrap()
            .unwrap();
        assert!(count > 0 && bytes.len() < 2 * 1024 * 1024);
        bytes.extend_from_slice(&buffer[..count]);
        if let Some(end) = bytes.windows(4).position(|window| window == b"\r\n\r\n") {
            let head = String::from_utf8(bytes[..end].to_vec()).unwrap();
            assert!(head.starts_with("POST /v1/chat/completions "));
            let length: usize = head
                .lines()
                .find_map(|line| {
                    let (key, value) = line.split_once(':')?;
                    key.eq_ignore_ascii_case("content-length")
                        .then(|| value.trim().parse().unwrap())
                })
                .unwrap();
            if bytes.len() >= end + 4 + length {
                let body: serde_json::Value =
                    serde_json::from_slice(&bytes[end + 4..end + 4 + length]).unwrap();
                return (stream, body, head);
            }
        }
    }
}
impl Pty {
    fn spawn(args: &[&str]) -> Self {
        Self::spawn_at(args, None)
    }
    fn spawn_at(args: &[&str], workspace: Option<&std::path::Path>) -> Self {
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
        let mut command = Command::new(env!("CARGO_BIN_EXE_maka"));
        // Theme fixtures must never read the developer's account-level file.
        command.env_remove("MAKA_TUI_THEME");
        command.env_remove("NO_COLOR");
        if let Some(root) = args.windows(2).find(|pair| pair[0] == "--root") {
            command.env(
                "MAKA_TUI_STATE_DIR",
                std::path::Path::new(root[1])
                    .parent()
                    .unwrap()
                    .join("tui-state"),
            );
        }
        if let Some(workspace) = workspace {
            command.current_dir(workspace);
        }
        command
            .args(args)
            .env("TERM", "xterm-256color")
            .env("MAKA_LOCALE", "en")
            .env("LC_ALL", "en_US.UTF-8")
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
            master: Some(master),
            slave: Some(slave),
            screen: Screen::new(TerminalSize::new(120, 40).unwrap()),
            pending: Vec::new(),
            output: Vec::new(),
            frames: frames::Frames::default(),
            read_size: 8192,
        }
    }
    fn send(&mut self, bytes: &[u8]) {
        self.master.as_mut().unwrap().write_all(bytes).unwrap();
    }
    fn close_terminal(&mut self) {
        // These fixtures own their Host separately. Terminal termination saves
        // local state without requesting whole-Host exit; startup/shutdown tests
        // exercise the interactive Ctrl+Q and command-palette choices explicitly.
        assert_eq!(
            unsafe { libc::kill(self.child.id() as libc::pid_t, libc::SIGTERM) },
            0
        );
    }
    fn filter_command(&mut self, label: &str) {
        self.send(b"\x10");
        self.wait_for("Search commands…");
        self.send(format!("\x1b[200~{}\x1b[201~", label.to_lowercase()).as_bytes());
        // Lowercase query differs from the command's title: await the filtered row.
        self.wait_until(|screen| !screen.contains("Search commands…") && screen.contains(label));
    }
    /// Open a destination the sidebar no longer lists, via the command palette.
    fn command(&mut self, label: &str) {
        self.filter_command(label);
        self.click_text(label);
    }
    fn host_details(&mut self) {
        self.command("Open Host connection");
        self.wait_for("Connection details");
        let screen = self.screen.snapshot().unwrap().screen;
        if screen.contains("▸ Connection details") || screen.contains("> Connection details") {
            self.click_page_text("Connection details");
        }
    }
    /// SGR wheel events over the first occurrence of `text`.
    fn wheel_at(&mut self, text: &str, down: bool, times: usize) {
        let snapshot = self.screen.snapshot().unwrap();
        let (row, col) = snapshot
            .screen
            .lines()
            .enumerate()
            .find_map(|(row, line)| line.find(text).map(|byte| (row, line[..byte].width())))
            .unwrap_or_else(|| panic!("No scrollable text {text:?}\n{}", snapshot.screen));
        let button = if down { 65 } else { 64 };
        for _ in 0..times {
            self.send(format!("\x1b[<{button};{};{}M", col + 1, row + 1).as_bytes());
        }
    }
    fn click_text(&mut self, text: &str) {
        self.click_matching_text(text, false);
    }
    /// A label the sidebar may also show: the first copy right of its border.
    fn click_page_text(&mut self, text: &str) {
        let snapshot = self.screen.snapshot().unwrap();
        let (row, col) = snapshot
            .screen
            .lines()
            .enumerate()
            .find_map(|(row, line)| {
                let border = line.find('│').map_or(0, |byte| byte + '│'.len_utf8());
                line[border..]
                    .find(text)
                    .map(|byte| (row, line[..border + byte].width()))
            })
            .unwrap_or_else(|| panic!("No page text {text:?}\n{}", snapshot.screen));
        self.click_at(row, col);
    }
    fn click_last_text(&mut self, text: &str) {
        self.click_matching_text(text, true);
    }
    fn click_matching_text(&mut self, text: &str, last: bool) {
        let snapshot = self.screen.snapshot().unwrap();
        let mut matches = snapshot
            .screen
            .lines()
            .enumerate()
            .filter_map(|(row, line)| line.find(text).map(|byte| (row, line[..byte].width())));
        let (row, col) = if last { matches.last() } else { matches.next() }
            .unwrap_or_else(|| panic!("No clickable text {text:?}\n{}", snapshot.screen));
        self.click_at(row, col);
    }
    fn click_at(&mut self, row: usize, col: usize) {
        self.send(
            format!(
                "\x1b[<0;{};{}M\x1b[<0;{};{}m",
                col + 1,
                row + 1,
                col + 1,
                row + 1
            )
            .as_bytes(),
        );
    }
    fn resize(&mut self, cols: u16, rows: u16) {
        // Establish the initial viewport before issuing SIGWINCH. Otherwise a
        // child that starts at the new size need not emit a resize clear at all.
        self.wait_until(|_| true);
        let size = libc::winsize {
            ws_row: rows,
            ws_col: cols,
            ws_xpixel: 0,
            ws_ypixel: 0,
        };
        if self.screen.size() != TerminalSize::new(cols, rows).unwrap() {
            self.frames.resize();
        }
        self.screen
            .resize(TerminalSize::new(cols, rows).unwrap())
            .unwrap();
        assert_eq!(
            unsafe {
                libc::ioctl(
                    self.master.as_ref().unwrap().as_raw_fd(),
                    libc::TIOCSWINSZ,
                    &size,
                )
            },
            0
        );
    }
    fn drag_last_text(&mut self, text: &str) {
        let snapshot = self.screen.snapshot().unwrap();
        let (row, col) = snapshot
            .screen
            .lines()
            .enumerate()
            .filter_map(|(row, line)| line.find(text).map(|byte| (row, line[..byte].width())))
            .last()
            .unwrap_or_else(|| panic!("No selectable text {text:?}\n{}", snapshot.screen));
        self.send(
            format!(
                "\x1b[<0;{};{}M\x1b[<32;{};{}M\x1b[<0;{};{}m",
                col + 1,
                row + 1,
                col + text.width(),
                row + 1,
                col + text.width(),
                row + 1
            )
            .as_bytes(),
        );
    }
    fn drag_text_to_row(&mut self, text: &str, target_row: usize) {
        let snapshot = self.screen.snapshot().unwrap();
        let (row, column) = snapshot
            .screen
            .lines()
            .enumerate()
            .find_map(|(row, line)| line.find(text).map(|byte| (row, line[..byte].width())))
            .unwrap_or_else(|| panic!("No drag start {text:?}\n{}", snapshot.screen));
        self.send(
            format!(
                "\x1b[<0;{};{}M\x1b[<32;{};{}M",
                column + 1,
                row + 1,
                column + 1,
                target_row + 1
            )
            .as_bytes(),
        );
    }
    fn read(&mut self) {
        let mut poll = libc::pollfd {
            fd: self.master.as_ref().unwrap().as_raw_fd(),
            events: libc::POLLIN,
            revents: 0,
        };
        let available = unsafe { libc::poll(&mut poll, 1, 50) };
        assert!(available >= 0);
        if available == 0 {
            return;
        }
        let mut buffer = [0; 8192];
        let length = self
            .master
            .as_mut()
            .unwrap()
            .read(&mut buffer[..self.read_size])
            .unwrap();
        self.frames.feed(&buffer[..length]);
        self.output.extend_from_slice(&buffer[..length]);
        if self.output.len() > 1024 * 1024 {
            self.output.drain(..self.output.len() - 1024 * 1024);
        }
        self.pending.extend_from_slice(&buffer[..length]);
        let end = match std::str::from_utf8(&self.pending) {
            Ok(_) => self.pending.len(),
            Err(error) if error.error_len().is_none() => error.valid_up_to(),
            Err(error) => panic!("Invalid terminal UTF-8: {error}"),
        };
        let text = std::str::from_utf8(&self.pending[..end]).unwrap();
        let reply = self.screen.write(text).unwrap();
        self.pending.drain(..end);
        if !reply.is_empty() {
            self.send(reply.as_bytes());
        }
    }
    #[track_caller]
    fn wait_for(&mut self, text: &str) {
        self.wait_until(|screen| screen.contains(text));
    }
    #[track_caller]
    fn wait_output(&mut self, sequence: &[u8]) {
        let deadline = Instant::now() + Duration::from_secs(10);
        while !self
            .output
            .windows(sequence.len())
            .any(|bytes| bytes == sequence)
        {
            self.read();
            assert!(
                Instant::now() < deadline,
                "terminal output sequence missing: {sequence:?}"
            );
            assert!(
                self.child.try_wait().unwrap().is_none(),
                "TUI exited before output"
            );
        }
    }
    #[track_caller]
    fn wait_until(&mut self, predicate: impl Fn(&str) -> bool) {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            self.read();
            let snapshot = self.screen.snapshot().unwrap();
            if self.frames.ready() && predicate(&snapshot.screen) {
                return;
            }
            assert!(
                Instant::now() < deadline,
                "screen condition timed out (pending tty bytes: {}):\n{}",
                {
                    let mut pending = 0;
                    assert_eq!(
                        unsafe {
                            libc::ioctl(
                                self.slave.as_ref().unwrap().as_raw_fd(),
                                libc::FIONREAD,
                                &mut pending,
                            )
                        },
                        0
                    );
                    pending
                },
                snapshot.screen
            );
            assert!(
                self.child.try_wait().unwrap().is_none(),
                "TUI exited:\n{}",
                snapshot.screen
            );
        }
    }
    fn finish(&mut self) {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            self.read();
            if let Some(status) = self.child.try_wait().unwrap() {
                self.read();
                assert!(status.success());
                return;
            }
            assert!(Instant::now() < deadline, "TUI did not exit");
        }
    }
    fn terminate(&mut self) -> std::io::Result<std::process::ExitStatus> {
        self.child.kill()?;
        // Session teardown may need the last parent-held PTY handles released.
        self.master.take();
        self.slave.take();
        self.child.wait()
    }
}
impl Drop for Pty {
    fn drop(&mut self) {
        if std::thread::panicking()
            && let Ok(snapshot) = self.screen.snapshot()
        {
            eprintln!("Final terminal frame:\n{}", snapshot.screen);
        }
        if self.child.try_wait().ok().flatten().is_none() {
            let _ = self.terminate();
        }
    }
}
