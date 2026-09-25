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
fn real_host_external_agent_form_saves_and_checks_the_acp_fixture() {
    let fixture = Fixture::new();
    let node = Command::new("node")
        .args(["-p", "process.execPath"])
        .output()
        .unwrap();
    assert!(node.status.success());
    let node = String::from_utf8(node.stdout).unwrap().trim().to_owned();
    let script = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../runtime-host/tests/support/acp-agent.mjs")
        .canonicalize()
        .unwrap();
    let trace = fixture.directory.path().join("acp-trace.jsonl");
    let control = fixture
        .runtime
        .block_on(tokio::net::TcpListener::bind("127.0.0.1:0"))
        .unwrap();
    let args = format!(
        "{}\n{}\n{}\n2",
        script.display(),
        trace.display(),
        control.local_addr().unwrap().port()
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
    let requests: Vec<Value> = std::fs::read_to_string(trace)
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
    fixture.finish(tui);
}
