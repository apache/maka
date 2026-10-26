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

use crate::support::{context as fixture, store::SessionFixture};
use maka_agent_engine::RunWork;
use maka_agent_facts::{
    event::Fact,
    tools::{ToolError, ToolExecutor, ToolFuture},
};
use maka_tools::{
    ToolCatalog, ToolDefinition, ToolHandler, ToolNesting, ToolRegistration, ToolSemantics,
};
use serde_json::{Value, json};
use std::{sync::Arc, time::Duration};
use tokio::{net::TcpListener, sync::Semaphore};
use tokio_util::sync::CancellationToken;

struct HeldTools {
    entered: Semaphore,
    release: Semaphore,
    cancelled: Semaphore,
    fail: bool,
}
struct Executor(Arc<HeldTools>);
impl ToolExecutor for Executor {
    fn names(&self) -> Vec<String> {
        vec!["echo".into(), "exclusive".into()]
    }
    fn invoke(&self, _: String, input: Value, cancellation: CancellationToken) -> ToolFuture {
        let gates = self.0.clone();
        Box::pin(async move {
            gates.entered.add_permits(1);
            if gates.fail && input["n"] == 0 {
                gates.release.acquire().await.unwrap().forget();
                return Err(ToolError::CleanupUnconfirmed(
                    "original tool cleanup failed".into(),
                ));
            }
            if gates.fail {
                cancellation.cancelled().await;
                gates.cancelled.add_permits(1);
            }
            gates.release.acquire().await.unwrap().forget();
            Ok(input)
        })
    }
}
fn catalog(gates: Arc<HeldTools>) -> ToolCatalog {
    let executor = Arc::new(Executor(gates));
    ToolCatalog::new(
        [
            ("echo", ToolSemantics::Parallel),
            ("exclusive", ToolSemantics::ExclusiveStep),
        ]
        .map(|(name, semantics)| ToolRegistration {
            definition: ToolDefinition {
                freeform: None,
                output_schema: None,
                provider: None,
                name: name.into(),
                description: name.into(),
                input_schema: json!({"type":"object"}),
            },
            nesting: ToolNesting::Nestable,
            semantics,
            handler: ToolHandler::Immediate(executor.clone()),
        }),
    )
    .unwrap()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn accepted_parallel_calls_overlap_and_preserve_every_result() {
    tokio::time::timeout(Duration::from_secs(30), async {
        const CALLS: usize = 128;
        let directory = tempfile::tempdir().unwrap();
        let log = SessionFixture::open(&directory.path().join("events.sqlite"))
            .await
            .unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}/v1", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            fixture::read_request(&mut socket).await;
            super::dynamic_tools::respond_tools(
                &mut socket,
                (0..CALLS)
                    .map(|n| {
                        super::dynamic_tools::call(&format!("call-{n}"), "echo", json!({"n":n}))
                    })
                    .collect(),
                10,
            )
            .await;
            let (mut socket, _) = listener.accept().await.unwrap();
            let request = fixture::read_request(&mut socket).await;
            fixture::respond(&mut socket, "done", "stop").await;
            request
        });
        let gates = Arc::new(HeldTools {
            entered: Semaphore::new(0),
            release: Semaphore::new(0),
            cancelled: Semaphore::new(0),
            fail: false,
        });
        let mut input = fixture::input(&base, "parallel", false);
        input.work = RunWork::Message {
            allow_prior_unknown: false,
            source_messages: Vec::new(),
            message: "run queries".into(),
            tools: catalog(gates.clone()),
        };
        let engine = fixture::engine();
        let running_engine = engine.clone();
        let store = log.store();
        let running = tokio::spawn(async move {
            running_engine
                .run(store, input, CancellationToken::new())
                .await
        });
        gates
            .entered
            .acquire_many(CALLS as u32)
            .await
            .unwrap()
            .forget();
        let prefix = log.prefix(1024, 1024 * 1024).await.unwrap();
        assert_eq!(
            prefix
                .events
                .iter()
                .filter(|event| matches!(event.event.fact, Fact::ToolDispatched { .. }))
                .count(),
            CALLS,
            "every entered handler already has a durable dispatch"
        );
        assert!(
            !prefix
                .events
                .iter()
                .any(|event| matches!(event.event.fact, Fact::ToolSettled { .. })),
            "all effects remain held"
        );
        gates.release.add_permits(CALLS);
        running.await.unwrap().unwrap();
        engine.drain().await;
        let request = server.await.unwrap();
        let results: Vec<_> = request["messages"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|message| message["role"] == "tool")
            .collect();
        assert_eq!(results.len(), CALLS);
        let by_id: std::collections::BTreeMap<_, _> = results
            .iter()
            .map(|result| (result["tool_call_id"].as_str().unwrap(), *result))
            .collect();
        assert_eq!(by_id.len(), CALLS, "every call has one result");
        for n in 0..CALLS {
            let result = by_id[format!("call-{n}").as_str()];
            assert_eq!(
                serde_json::from_str::<Value>(result["content"].as_str().unwrap()).unwrap(),
                json!({"n":n})
            );
        }
        let prefix = log.prefix(1024, 1024 * 1024).await.unwrap();
        assert_eq!(
            prefix
                .events
                .iter()
                .filter(|event| matches!(event.event.fact, Fact::ToolSettled { .. }))
                .count(),
            CALLS
        );
        drop(engine);
        log.close().await.unwrap();
    })
    .await
    .expect("all accepted queries must enter before their release");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cleanup_failure_cancels_and_drains_already_running_siblings() {
    tokio::time::timeout(Duration::from_secs(30), async {
        let directory = tempfile::tempdir().unwrap();
        let log = SessionFixture::open(&directory.path().join("events.sqlite"))
            .await
            .unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}/v1", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            fixture::read_request(&mut socket).await;
            super::dynamic_tools::respond_tools(
                &mut socket,
                (0..2)
                    .map(|n| {
                        super::dynamic_tools::call(&format!("call-{n}"), "echo", json!({"n":n}))
                    })
                    .collect(),
                10,
            )
            .await;
        });
        let gates = Arc::new(HeldTools {
            entered: Semaphore::new(0),
            release: Semaphore::new(0),
            cancelled: Semaphore::new(0),
            fail: true,
        });
        let mut input = fixture::input(&base, "failed", false);
        input.work = RunWork::Message {
            allow_prior_unknown: false,
            source_messages: Vec::new(),
            message: "run queries".into(),
            tools: catalog(gates.clone()),
        };
        let engine = fixture::engine();
        let running_engine = engine.clone();
        let store = log.store();
        let token = CancellationToken::new();
        let running_token = token.clone();
        let running =
            tokio::spawn(async move { running_engine.run(store, input, running_token).await });
        gates.entered.acquire_many(2).await.unwrap().forget();
        gates.release.add_permits(1);
        gates.cancelled.acquire().await.unwrap().forget();
        assert!(
            !running.is_finished(),
            "cleanup failure cannot drop the live sibling"
        );
        assert!(
            !token.is_cancelled(),
            "tool failure only cancels its child scope"
        );
        gates.release.add_permits(1);
        assert!(running.await.unwrap().is_err());
        engine.drain().await;
        server.await.unwrap();
        assert!(matches!(log.prefix(100, 1024 * 1024).await, Err(maka_event_log::StoreError::ConnectionClosed)),
            "unconfirmed cleanup quarantines the original Root");
        let partitions = directory.path().join("events.root/runtime-partitions");
        let settled = tokio::task::spawn_blocking(move || {
            let mut settled = Vec::new();
            for entry in std::fs::read_dir(partitions).unwrap() {
                let path = entry.unwrap().path();
                if path.extension().is_none_or(|extension| extension != "sqlite") { continue; }
                let db = rusqlite::Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
                let mut query = db.prepare("SELECT event_json FROM runtime_events WHERE invocation_id='invocation-failed' AND kind='tool_settled'").unwrap();
                for json in query.query_map([], |row| row.get::<_, String>(0)).unwrap() {
                    settled.push(serde_json::from_str::<maka_agent_facts::event::RuntimeEvent>(&json.unwrap()).unwrap());
                }
            }
            settled
        }).await.unwrap();
        assert_eq!(settled.len(), 1, "only the drained sibling has a confirmed outcome");
        let Fact::ToolSettled { operation_id, outcome:maka_agent_facts::event::ToolOutcome::Succeeded { model_projection, .. } } = &settled[0].fact else {
            panic!("the drained sibling must publish its actual success");
        };
        assert!(operation_id.ends_with(":call-1"));
        assert_eq!(*model_projection, maka_agent_facts::tool_output::DurableToolProjection::Json { value:json!({"n":1}) });
        drop(engine);
        assert!(log.close().await.is_err(), "physical cleanup failure cannot confirm Root shutdown");
    })
    .await
    .expect("failed tool cleanup must cancel and drain its siblings");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn accepted_exclusive_call_rejects_siblings_in_arrival_order() {
    tokio::time::timeout(Duration::from_secs(30), async {
        let directory = tempfile::tempdir().unwrap();
        let log = SessionFixture::open(&directory.path().join("events.sqlite"))
            .await
            .unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}/v1", listener.local_addr().unwrap());
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            fixture::read_request(&mut socket).await;
            super::dynamic_tools::respond_tools(
                &mut socket,
                vec![
                    super::dynamic_tools::call("first", "exclusive", json!({"n":0})),
                    super::dynamic_tools::call("sibling", "echo", json!({"n":1})),
                ],
                10,
            )
            .await;
            let (mut socket, _) = listener.accept().await.unwrap();
            let request = fixture::read_request(&mut socket).await;
            fixture::respond(&mut socket, "done", "stop").await;
            request
        });
        let gates = Arc::new(HeldTools {
            entered: Semaphore::new(0),
            release: Semaphore::new(0),
            cancelled: Semaphore::new(0),
            fail: false,
        });
        let mut input = fixture::input(&base, "exclusive", false);
        input.work = RunWork::Message {
            allow_prior_unknown: false,
            source_messages: Vec::new(),
            message: "run queries".into(),
            tools: catalog(gates.clone()),
        };
        let engine = fixture::engine();
        let running_engine = engine.clone();
        let store = log.store();
        let running = tokio::spawn(async move {
            running_engine
                .run(store, input, CancellationToken::new())
                .await
        });
        gates.entered.acquire().await.unwrap().forget();
        gates.release.add_permits(2);
        running.await.unwrap().unwrap();
        engine.drain().await;
        let request = server.await.unwrap();
        let results: Vec<_> = request["messages"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|message| message["role"] == "tool")
            .collect();
        assert_eq!(results.len(), 2);
        let first = results
            .iter()
            .find(|result| result["tool_call_id"] == "first")
            .unwrap();
        let sibling = results
            .iter()
            .find(|result| result["tool_call_id"] == "sibling")
            .unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(first["content"].as_str().unwrap()).unwrap(),
            json!({"n":0})
        );
        assert!(
            sibling["content"].as_str().unwrap().contains(
                &maka_agent_facts::tool_call::ToolRejection::ExclusiveConflict.to_string()
            )
        );
        assert_eq!(
            gates.entered.available_permits(),
            0,
            "only the first call entered its handler"
        );
        let prefix = log.prefix(100, 1024 * 1024).await.unwrap();
        assert!(prefix.events.iter().any(|stored| matches!(
            &stored.event.fact,
            Fact::ToolRejected {
                reason: maka_agent_facts::tool_call::ToolRejection::ExclusiveConflict,
                ..
            }
        )));
        drop(engine);
        log.close().await.unwrap();
    })
    .await
    .expect("exclusive admission must retain call order");
}
