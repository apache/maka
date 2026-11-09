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

use super::pruning;
use crate::support::{
    context as fixture,
    native::{FixtureService, NativeFixture},
};
use maka_agent_api::Configuration;
use maka_agent_facts::{
    artifact::ToolReturn,
    context::ModelPurpose,
    durable::{BackendSpec, ContentRef, Fact, RunId, RunOrigin, Terminal, ToolDecision},
    history::HistoryRowAddress,
    history_snapshot::{HistoricalRole, ImportedPart, RequestSource},
    read::{ReadInput, ReadPage, imported_tool_result_path, parse_imported_tool_result_path},
    tool_output::{AcceptedToolResult, ReturnedToolResult},
};
use maka_agent_state::session_history::snapshot::Snapshot;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, path::Path, time::Duration};
use tokio::net::TcpListener;
use uuid::Uuid;

fn configuration(workspace: &Path, originals: &Path, read: bool) -> Configuration {
    let tools = if read {
        vec![
            json!({"name":"Read","description":"Read an original scoped resource","method":"readText",
        "target":{"kind":"import","name":"fixture"},"result":"json","confirmation":"preapproved"}),
        ]
    } else {
        vec![]
    };
    serde_json::from_value(json!({"locale":"en","automaticTitles":false,"tools":tools,
        "workspaceRoots":[{"label":"Workspace","path":workspace}],
        "importRoots":[{"label":"Original CLI transcripts","path":originals}],
        "permissions":{"access":"workspace_write","requestPermissions":false},
    }))
    .unwrap()
}
fn files() -> FixtureService {
    FixtureService::from_provider(
        maka_workspace_api::files::contract(),
        maka_workspace_api::files::IMPLEMENTATION,
        maka_workspace_api::files::EXPORT,
        maka_files_native::provide,
    )
}
async fn transcript(originals: &Path, rows: &[(String, String)]) {
    let file = originals.join("sessions/2026/rollout-pruning.jsonl");
    tokio::fs::create_dir_all(file.parent().unwrap())
        .await
        .unwrap();
    let mut records = vec![
        json!({"type":"session_meta","payload":{"id":"original-pruning-history","cwd":"/foreign/inert","model_provider":"original-provider"}}),
    ];
    for (id, body) in rows {
        records.extend([
            json!({"type":"turn_context","payload":{"turn_id":id,"model":"original-model"}}),
            json!({"type":"event_msg","payload":{"type":"user_message","message":format!("question-{id}")}}),
            json!({"type":"response_item","payload":{"type":"function_call","call_id":format!("call-{id}"),"name":"Read","arguments":json!({"path":id}).to_string()}}),
            json!({"type":"response_item","payload":{"type":"function_call_output","call_id":format!("call-{id}"),"output":{"content":body}}}),
            json!({"type":"event_msg","payload":{"type":"agent_message","message":format!("completed-{id}")}}),
        ]);
    }
    tokio::fs::write(
        file,
        records
            .into_iter()
            .map(|record| format!("{record}\n"))
            .collect::<String>(),
    )
    .await
    .unwrap();
}
async fn copy(f: &NativeFixture, workspace: &Path) -> String {
    let roots = f
        .query("importDirectories", json!({"kind":"roots"}))
        .await
        .unwrap();
    let sources = f.query("imports", json!({"kind":"sources"})).await.unwrap();
    let saved = if sources["sources"].as_array().unwrap().is_empty() {
        f.mutation_value("import",json!({"kind":"save_source","revision":sources["revision"],"id":null,
            "name":"Original closed CLI history","location":{"kind":"codex","path":roots["roots"][0]["path"]}})).await.unwrap()
    } else {
        sources
    };
    let source = json!({"id":saved["sources"][0]["id"],"revision":saved["revision"]});
    let catalog=f.query("imports",json!({"kind":"catalog","source":source,"query":{"text":"","includeArchived":false,"cursor":null}})).await.unwrap();
    let entries = catalog["entries"].as_array().unwrap();
    assert_eq!(entries.len(), 1);
    let preview = f
        .query(
            "imports",
            json!({"kind":"preview","source":source,
        "entry":{"sessionId":entries[0]["id"],"path":entries[0]["path"]},"digest":null,"after":0}),
        )
        .await
        .unwrap();
    assert_eq!(preview["kind"], "preview");
    let directories = f
        .query("directories", json!({"kind":"roots"}))
        .await
        .unwrap();
    let canonical = tokio::fs::canonicalize(workspace).await.unwrap();
    let destination = directories["roots"]
        .as_array()
        .unwrap()
        .iter()
        .find(|root| root["path"].as_str() == canonical.to_str())
        .unwrap()["path"]
        .clone();
    let copied = f
        .mutation_value(
            "import",
            json!({"kind":"copy","selection":preview["preview"]["selection"],
        "path":destination,"title":"Original tool observations"}),
        )
        .await
        .unwrap();
    assert_eq!(copied["kind"], "imported");
    copied["session"]["id"].as_str().unwrap().into()
}
async fn snapshot(f: &NativeFixture, session: &str) -> (RunId, Snapshot) {
    let runs = f.state.runs(session.into(), None, 32).await.unwrap();
    let mut selected = None;
    for run in runs {
        let view = f.state.frontier(run).await.unwrap();
        if !matches!(view.spec.origin, RunOrigin::Imported { .. }) {
            continue;
        }
        assert!(matches!(view.spec.backend, BackendSpec::Historical {}));
        assert_eq!(view.terminal, Some(Terminal::Completed));
        assert!(view.attempts.is_empty());
        assert!(view.tools.is_empty());
        let history = f.state.session_history(view.spec.owner, session.into());
        let cut = history.capture().await.unwrap();
        assert!(selected.is_none());
        selected = Some((run, history.snapshot(&cut, run).await.unwrap()));
    }
    selected.expect("actual inert imported source marker")
}
async fn original_outputs(source: &Snapshot) -> BTreeMap<String, String> {
    let mut after = None;
    let mut result = BTreeMap::new();
    loop {
        let page = source.imported(after, 128).await.unwrap();
        for (ordinal, message) in page.items {
            if message.role != HistoricalRole::Tool {
                continue;
            }
            for reference in message.parts {
                let part: ImportedPart = source
                    .with_imported_content(ordinal, &reference, |reader| {
                        Ok(serde_json::from_reader(reader)?)
                    })
                    .await
                    .unwrap();
                let ImportedPart::ToolReturn {
                    call_id,
                    result: returned,
                    ..
                } = part
                else {
                    panic!("original ToolReturn part")
                };
                assert!(
                    result
                        .insert(
                            call_id,
                            returned.body.output.into_json()["content"]
                                .as_str()
                                .unwrap()
                                .into()
                        )
                        .is_none()
                );
            }
        }
        match page.next {
            Some(next) => after = Some(next),
            None => return result,
        }
    }
}
fn placeholders(request: &Value) -> Vec<Value> {
    request["messages"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|message| message["role"] == "tool")
        .filter_map(|message| {
            let content = message["content"].as_str().unwrap();
            let value: Value = serde_json::from_str(content).unwrap();
            if value["kind"] != "maka.archived_tool_result" {
                return None;
            }
            assert!(content.encode_utf16().count() <= 7500);
            assert_eq!(value["reason"], "tool_result_pruned");
            Some(value)
        })
        .collect()
}
async fn returned_values(f: &NativeFixture, run: RunId) -> BTreeMap<String, Value> {
    let mut values = BTreeMap::new();
    for record in pruning::facts(f, run).await {
        let Fact::ToolResultAccepted { tool, result, .. } = record.fact else {
            continue;
        };
        let accepted: AcceptedToolResult =
            serde_json::from_slice(&f.state.content(run, result).await.unwrap()).unwrap();
        let reference = match accepted {
            AcceptedToolResult::Local { result }
            | AcceptedToolResult::Operation {
                result: Some(result),
                ..
            } => result,
            other => panic!("actual returned original read: {other:?}"),
        };
        let returned: ToolReturn<ReturnedToolResult> =
            serde_json::from_slice(&f.state.content(run, reference).await.unwrap()).unwrap();
        values.insert(tool.call, returned.body.output.into_json());
    }
    values
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn history_pruning_binds_post_coverage_first_pages_into_summary_after_reopen() {
    tokio::time::timeout(Duration::from_secs(60), async {
        let directory = tempfile::tempdir().unwrap();
        let workspace = directory.path().join("workspace");
        let originals = directory.path().join("originals");
        tokio::fs::create_dir(&workspace).await.unwrap();
        let rows: Vec<_> = ["one", "two", "three"]
            .into_iter()
            .map(|id| (id.into(), format!("body-{id}-").repeat(1500)))
            .collect();
        transcript(&originals, &rows).await;
        let configuration = configuration(&workspace, &originals, false);
        let f = NativeFixture::open_with_service(directory.path(), configuration.clone(), files())
            .await
            .unwrap();
        let session = copy(&f, &workspace).await;
        let (historical, source) = snapshot(&f, &session).await;
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}/v1", listener.local_addr().unwrap());
        let selected = pruning::model(&f, &base, false).await;
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let request = fixture::read_request(&mut socket).await;
            let messages = request["messages"].to_string();
            for id in ["one", "two", "three"] {
                assert!(messages.contains(&format!("body-{id}-")));
            }
            let pages = placeholders(&request);
            assert_eq!(pages.len(), 3);
            fixture::respond(&mut socket, fixture::SUMMARY, "stop").await;
            let (mut socket, _) = listener.accept().await.unwrap();
            let request = fixture::read_request(&mut socket).await;
            let messages = request["messages"].to_string();
            assert!(messages.contains("summary-marker"));
            assert!(!messages.contains("body-two-"));
            fixture::respond(&mut socket, "done", "stop").await;
            pages
        });
        let run = pruning::compact(&f, &session, &selected).await;
        let terminal = f.wait_terminal(run).await.unwrap();
        assert_eq!(terminal.terminal, Some(Terminal::Completed));
        let records = pruning::facts(&f, run).await;
        assert_eq!(
            records
                .iter()
                .filter(|record| matches!(record.fact, Fact::ContextCompacted { .. }))
                .count(),
            1
        );
        let mut summary = None;
        for record in &records {
            let Fact::StepPrepared { step, .. } = record.fact else {
                continue;
            };
            let request = f.state.request(run, step).await.unwrap();
            if request.accounting.purpose == ModelPurpose::Summary {
                assert!(summary.is_none());
                summary = Some((record.revision, request));
            }
        }
        let (prepared, request) = summary.unwrap();
        let capture: RequestSource =
            serde_json::from_slice(&f.state.content(run, request.source_capture).await.unwrap())
                .unwrap();
        assert!(
            prepared > capture.current_revision,
            "derived first-page material is frozen after the original coverage fence"
        );
        assert!(request.effective_source_digest.starts_with("sha256:"));
        let frozen: Value =
            serde_json::from_slice(&f.state.content(run, request.request).await.unwrap()).unwrap();
        assert_eq!(frozen["version"], 2);
        let prompt: ContentRef = serde_json::from_value(frozen["prompt"].clone()).unwrap();
        let persisted = f.state.content(run, prompt).await.unwrap();
        let persisted = String::from_utf8_lossy(&persisted);
        for id in ["one", "two", "three"] {
            assert!(persisted.contains(&format!("body-{id}-")));
        }
        assert!(
            persisted.contains("maka.archived_tool_result"),
            "the actual frozen Summary—not an archive event—owns the first pages"
        );
        let outputs = original_outputs(&source).await;
        for (id, body) in &rows {
            assert_eq!(&outputs[&format!("call-{id}")], body);
        }
        drop(source);
        f.shutdown().await.unwrap();
        let f = NativeFixture::open_with_service(directory.path(), configuration, files())
            .await
            .unwrap();
        let next = pruning::send(&f, &session, "next", &selected).await;
        assert_eq!(
            f.wait_terminal(next).await.unwrap().terminal,
            Some(Terminal::Completed)
        );
        let pages = server.await.unwrap();
        let (_, reopened) = snapshot(&f, &session).await;
        assert_eq!(outputs, original_outputs(&reopened).await);
        for page in pages {
            let address = parse_imported_tool_result_path(page["resourceRef"].as_str().unwrap())
                .unwrap()
                .unwrap();
            let HistoryRowAddress::Imported { path, snapshot, .. } = address else {
                unreachable!()
            };
            assert_eq!(path, vec![historical]);
            assert_eq!(snapshot, reopened.id());
        }
        drop(reopened);
        f.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn small_first_page_does_not_starve_later_large_stale_result() {
    tokio::time::timeout(Duration::from_secs(60), async {
        let directory = tempfile::tempdir().unwrap();
        let workspace = directory.path().join("workspace");
        let originals = directory.path().join("originals");
        tokio::fs::create_dir(&workspace).await.unwrap();
        let mut rows: Vec<_> = (0..128)
            .map(|index| (format!("small-{index}"), format!("body-small-{index}-")))
            .collect();
        rows.extend([
            ("large".into(), "body-large-".repeat(1500)),
            ("protected-one".into(), "body-protected-one-".into()),
            ("protected-two".into(), "body-protected-two-".into()),
        ]);
        transcript(&originals, &rows).await;
        let f = NativeFixture::open_with_service(
            directory.path(),
            configuration(&workspace, &originals, false),
            files(),
        )
        .await
        .unwrap();
        let session = copy(&f, &workspace).await;
        let (_, source) = snapshot(&f, &session).await;
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}/v1", listener.local_addr().unwrap());
        let selected = pruning::model(&f, &base, false).await;
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let request = fixture::read_request(&mut socket).await;
            let messages = request["messages"].to_string();
            for marker in [
                "body-small-0-",
                "body-small-127-",
                "body-large-",
                "body-protected-one-",
                "body-protected-two-",
            ] {
                assert!(messages.contains(marker));
            }
            let pages = placeholders(&request);
            assert_eq!(
                pages.len(),
                1,
                "128 small results must not exhaust a pruning page before the later large one"
            );
            assert!(pages[0].to_string().contains("body-large-"));
            fixture::respond(&mut socket, "done", "stop").await;
        });
        let run = pruning::send(&f, &session, "next", &selected).await;
        assert_eq!(
            f.wait_terminal(run).await.unwrap().terminal,
            Some(Terminal::Completed)
        );
        server.await.unwrap();
        let outputs = original_outputs(&source).await;
        assert_eq!(outputs.len(), 131);
        assert_eq!(outputs["call-large"], "body-large-".repeat(1500));
        drop(source);
        f.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn imported_projection_uri_uses_actual_native_read_scope_and_original_paging() {
    tokio::time::timeout(Duration::from_secs(90), async {
        let directory = tempfile::tempdir().unwrap();
        let workspace = directory.path().join("workspace");
        let originals = directory.path().join("originals");
        tokio::fs::create_dir(&workspace).await.unwrap();
        let lines: Vec<_> = (0..2000)
            .map(|index| format!("line-{index:04}-original-tail\n"))
            .collect();
        let full = lines.concat();
        transcript(&originals, &[("authority".into(), full.clone())]).await;
        let allowed = configuration(&workspace, &originals, true);
        let f = NativeFixture::open_with_service(directory.path(), allowed, files())
            .await
            .unwrap();
        let session = copy(&f, &workspace).await;
        let foreign = copy(&f, &workspace).await;
        assert_ne!(
            session, foreign,
            "the second public copy is a different real target Session"
        );
        let (original_run, original_snapshot) = snapshot(&f, &session).await;
        let (foreign_run, foreign_snapshot) = snapshot(&f, &foreign).await;
        let foreign_snapshot_id = foreign_snapshot.id();
        drop(foreign_snapshot);
        assert_ne!(
            original_snapshot.id(),
            foreign_snapshot_id,
            "foreign snapshot identity comes from the second actual bound capture"
        );
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}/v1", listener.local_addr().unwrap());
        let selected = pruning::model(&f, &base, false).await;
        let (uri_send, uri_recv) = tokio::sync::oneshot::channel();
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let first = fixture::read_request(&mut socket).await;
            let pages = placeholders(&first);
            assert_eq!(pages.len(), 1);
            let header = &pages[0];
            let uri = header["resourceRef"].as_str().unwrap().to_owned();
            let address = parse_imported_tool_result_path(&uri).unwrap().unwrap();
            let HistoryRowAddress::Imported { path, .. } = &address else {
                unreachable!()
            };
            assert_eq!(path, &vec![original_run]);
            let next: ReadInput = serde_json::from_value(header["page"]["next"].clone()).unwrap();
            let mut wrong_hash = next.clone();
            let (prefix, hash) = wrong_hash.path.rsplit_once("sha=").unwrap();
            wrong_hash.path = format!(
                "{prefix}sha={}{}",
                if hash.starts_with('0') { '1' } else { '0' },
                &hash[1..]
            );
            let mut bad_part = address.clone();
            let HistoryRowAddress::Imported { part_ordinal, .. } = &mut bad_part else {
                unreachable!()
            };
            *part_ordinal = 99_999;
            let mut bad_message = address.clone();
            let HistoryRowAddress::Imported {
                message_ordinal, ..
            } = &mut bad_message
            else {
                unreachable!()
            };
            *message_ordinal = 99_999;
            let mut bad_path = address.clone();
            let HistoryRowAddress::Imported { path, .. } = &mut bad_path else {
                unreachable!()
            };
            *path = vec![foreign_run];
            let mut bad_snapshot = address.clone();
            let HistoryRowAddress::Imported { snapshot, .. } = &mut bad_snapshot else {
                unreachable!()
            };
            *snapshot = foreign_snapshot_id;
            let calls = vec![
                super::dynamic_tools::call(
                    "range",
                    "Read",
                    json!({"path":uri,"offset":2,"limit":3}),
                ),
                super::dynamic_tools::call(
                    "tail",
                    "Read",
                    json!({"path":uri,"offset":1999,"limit":1}),
                ),
                super::dynamic_tools::call("follow", "Read", serde_json::to_value(&next).unwrap()),
                super::dynamic_tools::call(
                    "wrong-hash",
                    "Read",
                    serde_json::to_value(&wrong_hash).unwrap(),
                ),
                super::dynamic_tools::call(
                    "wrong-part",
                    "Read",
                    json!({"path":imported_tool_result_path(&bad_part).unwrap()}),
                ),
                super::dynamic_tools::call(
                    "wrong-message",
                    "Read",
                    json!({"path":imported_tool_result_path(&bad_message).unwrap()}),
                ),
                super::dynamic_tools::call(
                    "wrong-path",
                    "Read",
                    json!({"path":imported_tool_result_path(&bad_path).unwrap()}),
                ),
                super::dynamic_tools::call(
                    "foreign-snapshot",
                    "Read",
                    json!({"path":imported_tool_result_path(&bad_snapshot).unwrap()}),
                ),
            ];
            super::dynamic_tools::respond_tools(&mut socket, calls, 200).await;
            let (mut socket, _) = listener.accept().await.unwrap();
            fixture::read_request(&mut socket).await;
            fixture::respond(&mut socket, "read-done", "stop").await;
            uri_send.send(uri.clone()).unwrap();
            let (mut socket, _) = listener.accept().await.unwrap();
            fixture::read_request(&mut socket).await;
            super::dynamic_tools::respond_tools(
                &mut socket,
                vec![super::dynamic_tools::call(
                    "cross-session",
                    "Read",
                    json!({"path":uri}),
                )],
                200,
            )
            .await;
            let (mut socket, _) = listener.accept().await.unwrap();
            fixture::read_request(&mut socket).await;
            fixture::respond(&mut socket, "cross-session-done", "stop").await;
            (
                next,
                header["page"]["content"].as_str().unwrap().to_owned(),
                listener,
            )
        });
        let run = pruning::send(&f, &session, "read the original resource", &selected).await;
        let terminal = f.wait_terminal(run).await.unwrap();
        assert_eq!(terminal.terminal, Some(Terminal::Completed));
        assert_eq!(terminal.tools.len(), 8);
        let values = returned_values(&f, run).await;
        let page = |name: &str| {
            assert_eq!(
                values[name]["kind"], "completed",
                "{name}: {}",
                values[name]
            );
            serde_json::from_value::<ReadPage>(values[name]["value"].clone()).unwrap()
        };
        let range = page("range");
        assert_eq!(range.offset, 2);
        assert_eq!(range.returned_lines, 3);
        assert_eq!(range.total_lines, 2000);
        assert_eq!(range.content, lines[2..5].concat());
        assert!(range.next.is_none());
        let tail = page("tail");
        assert_eq!(tail.offset, 1999);
        assert_eq!(tail.content, lines[1999]);
        assert!(tail.next.is_none());
        let followed = page("follow");
        assert!(followed.offset > 0);
        assert!(followed.content.encode_utf16().count() <= 7500);
        for name in [
            "wrong-hash",
            "wrong-part",
            "wrong-message",
            "wrong-path",
            "foreign-snapshot",
        ] {
            assert_eq!(
                values[name]["kind"], "failed",
                "the actual Native reader must refuse {name}: {}",
                values[name]
            );
            assert!(!values[name].to_string().contains("line-1999-original-tail"));
        }
        let uri = uri_recv.await.unwrap();
        // Real bindings are descriptors. A genuine remote SDK scope is not
        // the Agent's NativeCallContext or its original work custody.
        let client = f.app.client();
        let activation = client
            .activation(&maka_plugin_core::composition::InstanceId(vec![
                Uuid::from_u128(1),
            ]))
            .unwrap();
        let mut bindings = client.bind(activation, "fixture".into()).await.unwrap();
        assert_eq!(bindings.len(), 1);
        match client
            .start(
                bindings.remove(0),
                "readText".into(),
                json!({"path":uri}),
                f.scope(),
                maka_capabilities::call::Attachments::new().into(),
            )
            .await
        {
            Err(_) => {}
            Ok(reply) => assert!(
                reply.result().await.is_err(),
                "a remote caller scope cannot manufacture Native read authority"
            ),
        }
        let other = pruning::send(&f, &foreign, "read a URI from another target", &selected).await;
        assert_eq!(
            f.wait_terminal(other).await.unwrap().terminal,
            Some(Terminal::Completed)
        );
        assert_eq!(
            returned_values(&f, other).await["cross-session"]["kind"],
            "failed"
        );
        let (next, first_page, listener) = server.await.unwrap();
        let hash = hex::encode(Sha256::digest(full.as_bytes()));
        assert_eq!(
            next.path.rsplit_once("sha=").unwrap().1,
            &hash[..32],
            "continuation hashes the complete original display, including its tail"
        );
        assert!(full.starts_with(&(first_page + &followed.content)));
        assert_eq!(
            original_outputs(&original_snapshot).await["call-authority"],
            full
        );
        drop(original_snapshot);
        f.shutdown().await.unwrap();
        // This installation change occurs only after actual application/Scope
        // quiescence. It does not bypass the live permission-edit Busy policy.
        let f = NativeFixture::open_with_service(
            directory.path(),
            configuration(&workspace, &originals, false),
            files(),
        )
        .await
        .unwrap();
        let denied_uri = uri.clone();
        let denied_server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let request = fixture::read_request(&mut socket).await;
            assert!(
                !request["tools"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .any(|tool| tool["function"]["name"] == "Read")
            );
            super::dynamic_tools::respond_tools(
                &mut socket,
                vec![super::dynamic_tools::call(
                    "role-denied",
                    "Read",
                    json!({"path":denied_uri}),
                )],
                200,
            )
            .await;
            let (mut socket, _) = listener.accept().await.unwrap();
            fixture::read_request(&mut socket).await;
            fixture::respond(&mut socket, "role-done", "stop").await;
        });
        let restricted =
            pruning::send(&f, &session, "current installation denies Read", &selected).await;
        let restricted = f.wait_terminal(restricted).await.unwrap();
        assert_eq!(restricted.terminal, Some(Terminal::Completed));
        denied_server.await.unwrap();
        let denied = restricted
            .tools
            .values()
            .find(|tool| tool.call.id == "role-denied")
            .unwrap();
        assert!(matches!(
            denied.decision,
            Some(ToolDecision::Rejected { .. })
        ));
        assert!(!denied.admitted);
        assert!(denied.original.is_none());
        f.shutdown().await.unwrap();
    })
    .await
    .unwrap();
}
