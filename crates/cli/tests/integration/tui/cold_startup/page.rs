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

use super::*;

pub(super) fn restored_checkpoint(host: &CandidateFixture, target: &str) {
    let mut tui = spawn(host);
    tui.wait_for("No sessions yet");
    if target == "installed_js" {
        tui.wait_for(TITLE);
        tui.click_text(TITLE);
        tui.wait_for("Last-good acceptance content");
        tui.wait_for("Retained record 059");
    } else {
        tui.command("Open settings");
        tui.wait_for("Appearance");
        tui.click_page_text("Appearance");
        tui.wait_for("Maka dark ▾");
    }
    lifecycle::close(&mut tui);
}

pub(super) fn spawn(host: &CandidateFixture) -> Pty {
    Pty::spawn(&[
        "--root",
        host.root.to_str().unwrap(),
        "--profile",
        "startup",
    ])
}

pub(super) fn ready(screen: &str, target: &str) -> bool {
    match target {
        "native" => screen.contains("Maka dark ▾"),
        "installed_js" => {
            screen.contains("Last-good acceptance content")
                && screen.contains("Local draft")
                && screen.contains("Retained record 059")
                && !screen.contains("Loading…")
        }
        "empty" => {
            // An empty checkpoint opens Home, not a session composer. Its
            // central New action is rendered only after Host connection.
            screen.contains("No sessions yet")
                && screen
                    .lines()
                    .any(|line| line.contains("New session") && line.contains("Ctrl+N"))
        }
        _ => unreachable!(),
    }
}

/// Positive connection evidence from a rendered, loaded catalog; native local
/// controls alone deliberately do not imply that the TUI attached to its Host.
pub(super) fn attached(screen: &str) -> bool {
    screen.contains("No sessions yet")
        && !screen.contains("connecting")
        && !screen.contains("connection failed")
        && !screen.contains("not connected")
}

pub(super) fn interact(tui: &mut Pty, meter: &mut measure::Meter, target: &str) -> Value {
    let screen = tui.screen.snapshot().unwrap().screen;
    let (bytes, observed, operation) = match target {
        "native" => (
            fixture::click(&screen, "Maka dark ▾"),
            "○ Dusk",
            "native_palette_chooser",
        ),
        "installed_js" => {
            let mut bytes = fixture::click(&screen, "Local draft");
            bytes.extend_from_slice(b"startupprobe");
            (bytes, "startupprobe", "js_local_draft_edit")
        }
        "empty" => (
            b"\x10startupprobe".to_vec(),
            "startupprobe",
            "native_shell_palette_input",
        ),
        _ => unreachable!(),
    };
    assert!(!screen.contains(observed), "interaction marker must be new");
    let mut row = meter.input(tui, &bytes, |screen| screen.contains(observed));
    row["control"] = json!(operation);
    row["metric"] = json!("input_to_complete_pty_frame_parsed_upper_bound");
    row
}

pub(super) fn reset_interaction(tui: &mut Pty, target: &str) {
    if target == "installed_js" {
        tui.send(b"\x01\x7f");
        tui.wait_until(|screen| !screen.contains("startupprobe") && screen.contains("Local draft"));
    } else {
        tui.send(b"\x1b");
        tui.wait_until(|screen| !screen.contains("○ Dusk") && !screen.contains("startupprobe"));
    }
}
