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
fn real_host_import_and_recall_open_the_exact_imported_session() {
    const SOURCE_ID: &str = "foreign-acceptance";
    let fixture = Fixture::new();
    let source = fixture.directory.path().join("synthetic-codex");
    let destination = fixture.directory.path().join("destination");
    std::fs::create_dir_all(source.join("sessions")).unwrap();
    std::fs::create_dir(&destination).unwrap();
    let transcript = [
        json!({"type":"session_meta","payload":{"id":SOURCE_ID,"cwd":fixture.directory.path(),"source":"cli"}}),
        json!({"type":"event_msg","payload":{"type":"user_message","message":"Amberquartz import acceptance"}}),
        json!({"type":"event_msg","payload":{"type":"agent_message","message":"The amberquartz source answer"}}),
    ].iter().map(Value::to_string).collect::<Vec<_>>().join("\n") + "\n";
    // Codex catalog admission binds the filename suffix to session_meta.id.
    let relative = format!("sessions/rollout-{SOURCE_ID}.jsonl");
    let rollout = source.join(&relative);
    std::fs::write(&rollout, &transcript).unwrap();
    let mut tui = fixture.tui();
    category(&mut tui, "Conversation import", "Add a source");
    tui.click_page_text("Add a source");
    tui.wait_for("Location");
    edit(&mut tui, "Name", "Isolated Codex", "Location");
    edit(&mut tui, "Location", source.to_str().unwrap(), "Location");
    tui.click_page_text("Save");
    tui.wait_for("Add a source");
    let sources = fixture.read("maka.session-import", "manage", json!({"kind":"sources"}));
    let configured = sources["snapshot"]["configuration"]["sources"]
        .as_array()
        .unwrap();
    assert_eq!(configured.len(), 1);
    assert_eq!(
        configured[0]["location"],
        json!({"kind":"codex","root":source})
    );
    let catalog = fixture.read(
        "maka.session-import",
        "manage",
        json!({"kind":"catalog","sourceId":configured[0]["id"],
            "revision":sources["snapshot"]["revision"],
            "query":{"cwd":null,"text":"","includeArchived":false,"limit":20,"cursor":null}}),
    );
    let entries = catalog["page"]["entries"].as_array().unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0]["id"], SOURCE_ID);
    assert_eq!(entries[0]["path"], relative);
    tui.click_page_text("Isolated Codex");
    tui.wait_for("Amberquartz import acceptance");
    tui.click_page_text("Amberquartz import acceptance");
    tui.wait_for("Folder");
    edit(&mut tui, "Folder", destination.to_str().unwrap(), "Folder");
    tui.click_last_text("Import");
    tui.wait_for("Add a source");
    let copies = fixture.read(
        "maka.session-import",
        "manage",
        json!({"kind":"copies","after":null}),
    );
    let copies = copies["page"]["copies"].as_array().unwrap();
    assert_eq!(copies.len(), 1);
    assert_eq!(copies[0]["sourceId"], configured[0]["id"]);
    assert_eq!(copies[0]["sourceSessionId"], SOURCE_ID);
    assert_eq!(copies[0]["receipt"]["state"], "published");
    let imported = copies[0]["receipt"]["sessionId"].as_str().unwrap();
    let session = fixture
        .runtime
        .block_on(fixture.client.session(imported))
        .unwrap()
        .unwrap();
    assert_eq!(
        serde_json::to_value(&session).unwrap()["workspace"]["target"],
        json!({"kind":"host_path","path":destination})
    );
    assert_eq!(std::fs::read_to_string(&rollout).unwrap(), transcript);

    tui.command("Plugin pages");
    tui.wait_for("maka.recall");
    tui.click_page_text("Recall");
    tui.wait_for("Find what was said");
    edit(&mut tui, "Find", "nonexistentacceptanceword", "Find");
    tui.wait_for("nonexistentacceptanceword");
    // The field caption and button share a row. Submit the focused one-line
    // Editor's primary action instead of clicking the caption's first match.
    tui.send(b"\r");
    tui.wait_for("Nothing matched.");
    edit(&mut tui, "Find", "amberquartz", "Find");
    tui.wait_for("amberquartz");
    tui.send(b"\r");
    tui.wait_for("Amberquartz import acceptance");
    let found = fixture.read(
        "maka.recall",
        "search",
        json!({"terms":["amberquartz"],"limit":20}),
    );
    let matches = found["matches"].as_array().unwrap();
    assert!(!matches.is_empty());
    assert!(matches.iter().all(|row| row["sessionId"] == imported));
    tui.click_page_text("Amberquartz import acceptance");
    tui.wait_for("The amberquartz source answer");
    tui.close_terminal();
    tui.finish();
    let checkpoint = fixture
        .directory
        .path()
        .join("tui-state")
        .join(&fixture.client.identity.root_id)
        .join("default/state.json");
    let saved: Value = serde_json::from_slice(&std::fs::read(checkpoint).unwrap()).unwrap();
    let cursor = saved["navigation"]["cursor"].as_u64().unwrap() as usize;
    assert_eq!(
        saved["navigation"]["entries"][cursor]["route"]["id"],
        imported
    );
    fixture.client.disconnect();
    let mut host = fixture.host;
    host.retire_registered();
    assert!(host.wait_for_exit().success());
}
