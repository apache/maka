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
use maka_agent_facts::tools::{ToolExecutor, ToolFuture};
use rusqlite::OptionalExtension;
use std::{path::PathBuf, sync::Mutex};

struct GapEffect {
    log: Arc<SessionFixture>,
    directory: PathBuf,
    entered: Arc<Notify>,
    release: Arc<Notify>,
    captured: Arc<Mutex<Option<(PathBuf, String)>>>,
}

fn head(directory: PathBuf) -> (PathBuf, String) {
    let mut remaining = vec![directory];
    while let Some(path) = remaining.pop() {
        if path.is_dir() {
            remaining.extend(
                std::fs::read_dir(path)
                    .unwrap()
                    .map(|entry| entry.unwrap().path()),
            );
        } else if path
            .file_name()
            .is_some_and(|name| name == "prepared.sqlite")
        {
            let connection = rusqlite::Connection::open_with_flags(
                &path,
                rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
            )
            .unwrap();
            connection.busy_timeout(Duration::from_secs(2)).unwrap();
            let id: Option<String> = connection
                .query_row(
                    "SELECT build_id FROM context_prepared_heads WHERE session_id='session'",
                    [],
                    |row| row.get(0),
                )
                .optional()
                .unwrap();
            if let Some(id) = id {
                return (path, id);
            }
        }
    }
    panic!("active request must publish a prepared head");
}

async fn replace_head(log: &SessionFixture, policy: &str, current: Option<&str>) {
    let store = log.store();
    let mut selection = store
        .read_model_view(store.id(), current)
        .await
        .unwrap()
        .selection;
    selection.after = selection.through;
    selection.anchor_sequence = None;
    let build = store
        .prepare_model_view(selection, policy, None)
        .await
        .unwrap();
    assert!(
        store
            .prepared_dirty_groups(&build, None, 1)
            .await
            .unwrap()
            .is_empty()
    );
    let view = store.finish_prepared(&build).await.unwrap();
    assert_eq!(view.message_count, 0);
    let wire = store
        .prepare_wire_view(
            &view,
            maka_agent_facts::model::prompt_source::WireFormat::Responses,
            "eviction-fixture",
            None,
        )
        .await
        .unwrap();
    let wire = store.finish_prepared_wire(&wire).await.unwrap();
    assert_eq!(wire.message_count, 0);
}

impl ToolExecutor for GapEffect {
    fn names(&self) -> Vec<String> {
        vec!["echo".into()]
    }

    fn invoke(&self, _name: String, input: Value, _cancellation: CancellationToken) -> ToolFuture {
        let log = self.log.clone();
        let directory = self.directory.clone();
        let entered = self.entered.clone();
        let release = self.release.clone();
        let captured = self.captured.clone();
        Box::pin(async move {
            let original = tokio::task::spawn_blocking(move || head(directory))
                .await
                .unwrap();
            replace_head(&log, "tool-gap-eviction", Some("invocation-retention")).await;
            *captured.lock().unwrap() = Some(original);
            entered.notify_one();
            release.notified().await;
            Ok(input)
        })
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn active_run_reuses_evicted_history_and_releases_it_after_completion_or_cancellation() {
    tokio::time::timeout(Duration::from_secs(30), async {
        for cancel in [false, true] {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let base = format!("http://{}/v1", listener.local_addr().unwrap());
            let directory = tempfile::tempdir().unwrap();
            let path = directory.path().join("events.sqlite");
            let log = Arc::new(SessionFixture::open(&path).await.unwrap());
            let entered = Arc::new(Notify::new());
            let release = Arc::new(Notify::new());
            let captured = Arc::new(Mutex::new(None));
            let effect = Arc::new(GapEffect {
                log: log.clone(),
                directory: path.with_extension("root"),
                entered: entered.clone(),
                release: release.clone(),
                captured: captured.clone(),
            });
            let server_captured = captured.clone();
            let server = tokio::spawn(async move {
                let (mut socket, _) = listener.accept().await.unwrap();
                let first = read_request(&mut socket).await;
                respond(&mut socket, true).await;
                if cancel { return None; }
                let (mut socket, _) = listener.accept().await.unwrap();
                let second = read_request(&mut socket).await;
                let (path, original) = server_captured.lock().unwrap().clone().unwrap();
                let current = tokio::task::spawn_blocking(move || {
                    let connection = rusqlite::Connection::open(path).unwrap();
                    let (current, parent, previous): (String, Option<String>, i64) = connection.query_row(
                        "SELECT b.id,b.parent_id,b.previous_revision FROM context_prepared_heads h JOIN context_prepared_builds b ON b.id=h.build_id WHERE h.session_id='session'",
                        [], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                    ).unwrap();
                    assert_eq!(parent.as_deref(), Some(original.as_str()), "the active Run supplies its evicted generation");
                    assert!(previous > 0, "the next request discovers only the semantic delta");
                    current
                }).await.unwrap();
                let opening = |request: &Value| request["messages"].as_array().unwrap().iter().find(|message| message["role"] == "user").unwrap().clone();
                assert_eq!(opening(&first), json!({"role":"user","content":"question retention"}));
                assert_eq!(opening(&second), opening(&first));
                let tool = second["messages"].as_array().unwrap().iter().find(|message| message["role"] == "tool").unwrap();
                assert_eq!(tool["tool_call_id"], "call-1");
                assert_eq!(serde_json::from_str::<Value>(tool["content"].as_str().unwrap()).unwrap(), json!({"value":42}));
                respond(&mut socket, false).await;
                Some(current)
            });
            let engine = Engine::new(
                ModelExecutor::new(Duration::from_secs(10)).unwrap(),
                CodeExecutor::new(CellLimits::default()).unwrap(),
            ).unwrap();
            let running = engine.start(log.store(), input(&base, "retention", effect), CancellationToken::new()).await.unwrap();
            entered.notified().await;
            if cancel { running.cancel(); }
            release.notify_one();
            let completion = running.completion().await;
            assert!(completion.cleanup.is_ok());
            if cancel {
                assert!(matches!(completion.result, Err(RunError::Cancelled)));
            } else {
                completion.result.unwrap();
            }
            let current = server.await.unwrap();
            replace_head(&log, "completed-run-eviction", None).await;
            let (path, original) = captured.lock().unwrap().clone().unwrap();
            tokio::time::timeout(Duration::from_secs(5), async {
                loop {
                    let path = path.clone();
                    let original = original.clone();
                    let current = current.clone();
                    let retained: i64 = tokio::task::spawn_blocking(move || {
                        let connection = rusqlite::Connection::open(path).unwrap();
                        connection.query_row(
                            "SELECT COUNT(*) FROM context_prepared_builds WHERE id=?1 OR id=?2",
                            rusqlite::params![original, current], |row| row.get(0),
                        ).unwrap()
                    }).await.unwrap();
                    if retained == 0 { break; }
                    tokio::task::yield_now().await;
                }
            }).await.expect("completed and cancelled Runs release their prepared generations");
            engine.drain().await;
        }
    }).await.expect("prepared history retention must make bounded progress");
}
