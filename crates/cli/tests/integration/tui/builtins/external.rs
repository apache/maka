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
use base64::Engine;

const AUTHORIZATION_URL: &str = "https://login.example.invalid/authorize?state=private-fixture";

fn authorization_url_visible(screen: &str) -> bool {
    // Soft wrapping may divide any URL byte, including the private query value.
    screen
        .lines()
        .map(|line| {
            let line = line.trim_end_matches([' ', '│', '┃']);
            line.rsplit('│').next().unwrap_or(line).trim()
        })
        .collect::<String>()
        .contains(AUTHORIZATION_URL)
}

#[test]
fn authorization_url_visibility_ignores_shell_gutter_but_requires_the_exact_query() {
    let captured = "                                   │  Host                    │    https://login.example.invalid/authorize?state=privat  ┃\n                                   │                          │    e-fixture                                             ┃";
    assert!(authorization_url_visible(captured));
    assert!(authorization_url_visible(&captured.replace('┃', "│")));
    assert!(!authorization_url_visible(
        &captured.replace("e-fixture", "e-fixtur")
    ));
    assert!(!authorization_url_visible(
        &captured.replace("e-fixture", "e-changed")
    ));
}

fn copy_authorization_url(tui: &mut Pty) {
    let screen = tui.screen.snapshot().unwrap().screen;
    let (row, column) = screen
        .lines()
        .enumerate()
        .find_map(|(row, line)| {
            line.find("https://login.example.invalid")
                .map(|byte| (row, line[..byte].width()))
        })
        .expect("visible URL reader");
    // Focus the reader's blank area, without selecting any URL text by mouse.
    // Keyboard traversal returns to it; Home selects its source record.
    tui.click_at(row + 3, column);
    tui.output.clear();
    tui.send(b"\x1b[Z\t\x1b[H\x1b[99;6u");
    let encoded = base64::engine::general_purpose::STANDARD.encode(AUTHORIZATION_URL);
    let copied = format!("\x1b]52;c;{encoded}\x07");
    tui.wait_output(copied.as_bytes());
    // Clipboard output precedes draw in the event loop. A later pointer click
    // must use the complete frame after keyboard focus/scroll, not the old one.
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let after_copy = tui
            .output
            .windows(copied.len())
            .position(|bytes| bytes == copied.as_bytes())
            .map(|at| at + copied.len())
            .unwrap();
        let painted = tui.output[after_copy..]
            .windows(8)
            .position(|bytes| bytes == b"\x1b[?2026h")
            .is_some_and(|at| {
                tui.output[after_copy + at + 8..]
                    .windows(8)
                    .any(|bytes| bytes == b"\x1b[?2026l")
            });
        if painted && tui.frames.ready() {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "copy did not publish a complete following frame"
        );
        assert!(
            tui.child.try_wait().unwrap().is_none(),
            "TUI exited before post-copy frame"
        );
        tui.read();
    }
}

#[test]
fn real_host_external_agent_authenticates_cancels_and_executes_after_readiness_check() {
    let fixture = Fixture::new();
    let node = Command::new("node")
        .args(["-p", "process.execPath"])
        .output()
        .unwrap();
    assert!(node.status.success());
    let node = String::from_utf8(node.stdout).unwrap().trim().to_owned();
    let script = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../external-agent/tests/support/tui-auth.mjs")
        .canonicalize()
        .unwrap();
    let trace = fixture.directory.path().join("acp-trace.jsonl");
    let marker = fixture.directory.path().join("synthetic-login");
    let control = fixture
        .runtime
        .block_on(tokio::net::TcpListener::bind("127.0.0.1:0"))
        .unwrap();
    let args = format!(
        "{}\n{}\n{}\n{}",
        script.display(),
        trace.display(),
        control.local_addr().unwrap().port(),
        marker.display()
    );
    let mut tui = fixture.tui();
    category(&mut tui, "External agents", "Add an agent");
    tui.click_page_text("Add an agent");
    tui.wait_for("Identifier");
    edit(&mut tui, "Identifier", "acceptance-acp", "Environment");
    edit(&mut tui, "Name", "Acceptance ACP", "Environment");
    edit(&mut tui, "Executable", &node, "Environment");
    edit(&mut tui, "Arguments", &args, "Environment");
    reveal(&mut tui, "Save");
    tui.click_page_text("Save");
    tui.wait_for("Add an agent");
    let configuration = fixture.read("maka.external-agent", "manage", json!({"kind":"read"}));
    assert!(
        configuration["activationError"].is_null(),
        "{configuration}"
    );
    let agents = configuration["agents"].as_array().unwrap();
    assert_eq!(agents.len(), 1);
    assert_eq!(agents[0]["id"], "acceptance-acp");
    assert_eq!(agents[0]["executable"], node);
    assert_eq!(agents[0]["args"], json!(args.lines().collect::<Vec<_>>()));
    tui.click_page_text("Acceptance ACP");
    tui.wait_for("Check");
    reveal(&mut tui, "Check");
    tui.click_page_text("Check");
    tui.wait_for("It answered:");
    tui.wait_for("fixture-v2 1");
    let requests: Vec<Value> = std::fs::read_to_string(&trace)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(
        requests
            .iter()
            .filter(|value| value["method"] == "initialize")
            .count(),
        1
    );
    assert!(
        !requests
            .iter()
            .any(|value| value["method"] == "session/new" || value["method"] == "auth/login")
    );
    assert_eq!(
        fixture.read("maka.external-agent", "manage", json!({"kind":"read"}))["revision"],
        configuration["revision"]
    );
    let mut checked = process(&fixture, &control);
    closed(&fixture, &mut checked);
    assert!(!marker.exists(), "saving and checking never authenticate");
    for method in ["cancel", "unsafe", "login"] {
        tui.click_page_text("Choose a method");
        tui.wait_for(&format!("○ {method}"));
        tui.click_text(&format!("○ {method}"));
        tui.wait_for(&format!("{method} ▾"));
        tui.click_page_text("Sign in");
        let mut process = process(&fixture, &control);
        if method == "unsafe" {
            tui.wait_for("Sign-in was not confirmed");
            assert!(
                !tui.screen
                    .snapshot()
                    .unwrap()
                    .screen
                    .contains("insecure.example.invalid")
            );
        } else {
            tui.wait_until(authorization_url_visible);
            copy_authorization_url(&mut tui);
            let foreign = fixture.read(
                "maka.external-agent",
                "terminal",
                json!({"kind":"read","route":{"agent":"acceptance-acp"},"locale":"en"}),
            );
            assert!(!foreign.to_string().contains("private-fixture"));
            assert!(!foreign.to_string().contains("Waiting for sign-in"));
            if method == "cancel" {
                tui.click_page_text("Cancel sign-in");
                tui.wait_for("Sign-in cancelled");
            } else {
                fixture.runtime.block_on(async {
                    use tokio::io::AsyncWriteExt;
                    process.get_mut().write_all(b"continue\n").await.unwrap();
                });
                tui.wait_for("Sign-in confirmed by the agent");
            }
        }
        closed(&fixture, &mut process);
        assert_eq!(marker.exists(), method == "login");
        tui.wait_until(|screen| !screen.contains("login.example.invalid"));
    }
    reveal(&mut tui, "Check");
    tui.click_page_text("Check");
    tui.wait_for("fixture-ready 1");
    closed(&fixture, &mut process(&fixture, &control));
    // Authentication is complete only after the agent's acknowledgement.
    // A new process must now accept execution using its own persisted login.
    fixture.runtime.block_on(async {
        fixture.client.create_session(maka_protocol::session::decode_session_create_input(&json!({
            "sessionId":"authenticated-execution","name":"Authenticated execution",
            "workspace":{"kind":"host_path","path":fixture.directory.path()},
            "executorId":"acceptance-acp","sandboxMode":"danger-full-access","approvalPolicy":{"kind":"never"}
        })).unwrap()).await.unwrap();
    });
    tui.command("Open workspace");
    tui.wait_for("Authenticated execution");
    tui.click_text("Authenticated execution");
    tui.wait_for("Message…");
    tui.click_text("Message…");
    tui.send(b"after-auth\r");
    tui.wait_for("answer after-auth");
    let _execution = process(&fixture, &control);
    let requests = std::fs::read_to_string(&trace).unwrap();
    let requests: Vec<Value> = requests
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(
        requests
            .iter()
            .filter(|row| row["method"] == "auth/login")
            .map(|row| row["params"]["methodId"].clone())
            .collect::<Vec<_>>(),
        vec![json!("cancel"), json!("unsafe"), json!("login")]
    );
    assert!(requests.iter().any(|row| row["method"] == "session/prompt"));
    // Settings retains its exact detail location; explicitly return to the list.
    // Close a new live attempt through navigation; the changes stream owns it.
    category(&mut tui, "External agents", "All agents");
    // The cached detail also has this link. Wait for the new document's
    // connected projection: old document-owned check results cannot survive it.
    tui.wait_until(|screen| {
        screen.contains("All agents")
            && screen.contains("Check")
            && !screen.contains("It answered:")
            && !screen.contains("Connecting…")
            && !screen.contains("Loading…")
    });
    tui.click_page_text("All agents");
    tui.wait_for("Add an agent");
    tui.click_page_text("Acceptance ACP");
    // Check may be present in the retained detail while its replacement loads.
    tui.wait_until(|screen| {
        screen.contains("Check") && !screen.contains("Loading…") && !screen.contains("Connecting…")
    });
    reveal(&mut tui, "Check");
    tui.click_page_text("Check");
    tui.wait_for("fixture-ready 1");
    closed(&fixture, &mut process(&fixture, &control));
    tui.click_page_text("Choose a method");
    tui.wait_for("○ cancel");
    tui.click_text("○ cancel");
    tui.wait_for("cancel ▾");
    tui.click_page_text("Sign in");
    tui.wait_until(authorization_url_visible);
    copy_authorization_url(&mut tui);
    let mut cancelled = process(&fixture, &control);
    tui.click_text("Models");
    tui.wait_for("Model connections");
    closed(&fixture, &mut cancelled);
    tui.close_terminal();
    tui.finish();
    let checkpoint = fixture
        .directory
        .path()
        .join("tui-state")
        .join(&fixture.client.identity.root_id)
        .join("default/state.json");
    let saved = std::fs::read_to_string(checkpoint).unwrap();
    assert!(
        !saved.contains("private-fixture"),
        "authentication URLs never reach View checkpoints"
    );
    fixture.client.disconnect();
    let mut host = fixture.host;
    host.retire_registered();
    assert!(host.wait_for_exit().success());
}

fn process(
    fixture: &Fixture,
    listener: &tokio::net::TcpListener,
) -> tokio::io::BufReader<tokio::net::TcpStream> {
    fixture.runtime.block_on(async {
        use tokio::io::AsyncBufReadExt;
        tokio::time::timeout(Duration::from_secs(10), async {
            let mut process = tokio::io::BufReader::new(listener.accept().await.unwrap().0);
            let mut pid = String::new();
            process.read_line(&mut pid).await.unwrap();
            assert!(pid.trim().parse::<u32>().is_ok());
            process
        })
        .await
        .unwrap()
    })
}
fn closed(fixture: &Fixture, process: &mut tokio::io::BufReader<tokio::net::TcpStream>) {
    fixture.runtime.block_on(async {
        use tokio::io::AsyncReadExt;
        let error = tokio::time::timeout(Duration::from_secs(10), process.read_u8())
            .await
            .unwrap()
            .unwrap_err();
        assert!(matches!(
            error.kind(),
            std::io::ErrorKind::UnexpectedEof | std::io::ErrorKind::ConnectionReset
        ));
    });
}
