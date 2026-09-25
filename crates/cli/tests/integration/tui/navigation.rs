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

#[test]
fn restart_keeps_forward_history_and_keyboard_control_without_replaying_actions() {
    let directory = tempfile::tempdir().unwrap();
    let mut host = super::super::candidate::CandidateFixture::new(directory.path().join("root"));
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
    let mut tui = Pty::spawn(&["--root", host.root.to_str().unwrap()]);
    tui.wait_for("No sessions yet");
    tui.click_text("Settings");
    tui.wait_for("Maka dark ▾");
    // Interface category, its first row, then Icons; the footer names the focus.
    tui.send(b"\x1b[B");
    tui.wait_for("Unicode ▾");
    tui.send(b"\x1b[C");
    tui.wait_for("Choose Language");
    tui.send(b"\x1b[B");
    tui.wait_for("Choose Icons");
    tui.send(b"\x1bOP"); // F1 Help.
    tui.wait_for("Move focus between controls");
    tui.send(b"\x1b"); // Help closes without becoming a navigation entry.
    tui.wait_until(|screen| !screen.contains("Move focus between controls"));
    tui.command("Open workspace");
    // The sidebar already says "No sessions yet" on Settings. Observe the
    // destination before sending Back, or an old frame can satisfy both waits.
    tui.wait_until(|screen| screen.contains("No sessions yet") && !screen.contains("Unicode ▾"));
    tui.send(b"\x1b[1;3D"); // A real destination leaves forward history.
    tui.wait_for("Unicode ▾");
    tui.close_terminal();
    tui.finish();

    let mut reopened = Pty::spawn(&["--root", host.root.to_str().unwrap()]);
    reopened.wait_for("Unicode ▾"); // Restoring must not change the focused control.
    reopened.send(b"\r");
    reopened.wait_for("○ ASCII"); // Same control's chooser, not the first Palette row.
    reopened.send(b"\x1b[B\r");
    reopened.wait_for("ASCII v");
    reopened.send(b"\x1b[1;3C");
    reopened.wait_until(|screen| screen.contains("No sessions yet") && !screen.contains("ASCII v"));
    reopened.send(b"\x1b[1;3D");
    reopened.wait_for("ASCII v");
    reopened.send(b"\x1b[1;3D");
    reopened.wait_for("No sessions yet");
    reopened.host_details();
    reopened.wait_for("Host epoch:");
    reopened.send(b"\x1b[1;3C"); // New destination replaces the previous forward branch.
    reopened.close_terminal();
    reopened.finish();

    let mut branched = Pty::spawn(&["--root", host.root.to_str().unwrap()]);
    branched.wait_for("Connection details");
    branched.send(b"\x1b[1;3C");
    branched.wait_for("Connection details");
    branched.send(b"\x1b[1;3D");
    branched.wait_for("No sessions yet");
    branched.close_terminal();
    branched.finish();
    host.retire_registered();
}
