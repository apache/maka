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

use crate::support::agent_loop::respond;
use crate::support::code_mode_lifetime as fixture;
use crate::support::http;

use crate::support::native::{FixtureService, NativeFixture};
use maka_agent_api::{
    Configuration, ModelSelection,
    contract::{
        BackendPreference, ContinuationAvailability, ContinuationRejection, ContinuationResult,
        Execution, SendResult,
    },
};
use maka_agent_facts::{
    cells::{CellEvent, CellId, CellOwner},
    configuration::{
        ApiProtocol, CatalogMutationResult, ConnectionCatalogEntryUpdate, ConnectionVersionBasis,
        ModelModalities, ModelModality, ModelOverride, Patch, UpdateCatalogConnectionInput,
    },
    durable::{Fact, RunId, Terminal},
    execution::CodeLanguage,
};
use maka_agent_state::{fold::RunView, queue::MessageResolution};
use maka_capabilities::call::Attachments;
use maka_plugin_core::operation::OperationCleanup;
use serde_json::json;
use std::sync::atomic::Ordering;
use std::time::Duration;
use std::{collections::BTreeMap, path::Path, sync::Arc};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

pub(super) fn configuration(workspace: &Path, names: &[&str]) -> Configuration {
    serde_json::from_value(json!({
        "locale":"en", "workspaceRoots":[{"label":"Workspace","path":workspace}],
        "permissions":{"access":"workspace_write","requestPermissions":false},
        "tools":names.iter().map(|name| json!({
            "name":name,"description":"controlled fixture effect","method":name,
            "target":{"kind":"import","name":"fixture"},"result":"json",
            "confirmation":"preapproved","nestable":true,
        })).collect::<Vec<_>>(),
    }))
    .unwrap()
}

pub(super) fn backend(model: &ModelSelection) -> BackendPreference {
    BackendPreference::Model {
        connection_id: model.connection_id.clone(),
        model_id: model.model_id.clone(),
        thinking_level: None,
    }
}

pub(super) async fn configure_model(
    f: &NativeFixture,
    base: &str,
    responses: bool,
) -> ModelSelection {
    let model = f.configure_model(base, "gpt-4.1", "fixture").await.unwrap();
    let row = f
        .config
        .catalog()
        .await
        .unwrap()
        .connections
        .into_iter()
        .find(|row| row.connection_id == model.connection_id)
        .unwrap();
    let result = f
        .config
        .update_connection(UpdateCatalogConnectionInput {
            expected: ConnectionVersionBasis {
                connection_id: row.connection_id,
                revision: row.revision,
            },
            changes: ConnectionCatalogEntryUpdate {
                name: None,
                configuration: None,
                enabled: None,
                enabled_model_ids: None,
                model_overrides: Patch::Set(BTreeMap::from([(
                    model.model_id.clone(),
                    ModelOverride {
                        code_mode: Some(true),
                        code_mode_language: Some(CodeLanguage::JavaScript),
                        api_protocol: Some(if responses {
                            ApiProtocol::OpenaiResponses
                        } else {
                            ApiProtocol::OpenaiChatCompletions
                        }),
                        modalities: responses.then_some(ModelModalities {
                            input: vec![
                                ModelModality::Text,
                                ModelModality::Image,
                                ModelModality::Audio,
                            ],
                            output: vec![ModelModality::Text],
                        }),
                        ..Default::default()
                    },
                )])),
                request_body_overlay: if responses {
                    Patch::Set(json!({"store":false}))
                } else {
                    Patch::Keep
                },
            },
        })
        .await
        .unwrap();
    assert!(matches!(result, CatalogMutationResult::Committed { .. }));
    model
}

pub(super) async fn send_run(f: &NativeFixture, session: &str, message: &str) -> RunId {
    let mut changes = f.state.subscribe().unwrap();
    match f.send(session, message, None).await.unwrap() {
        SendResult::Started { run_id, .. } => run_id,
        SendResult::Queued { message_id, .. } => loop {
            changes.borrow_and_update();
            match f
                .state
                .queue()
                .resolve_message(session.into(), message_id.clone())
                .await
                .unwrap()
            {
                MessageResolution::Delivered { run, .. } => break run,
                MessageResolution::Pending => changes.changed().await.unwrap(),
                other => panic!("original queued message was not delivered: {other:?}"),
            }
        },
        other => panic!(
            "send did not admit its original message: {}",
            serde_json::to_string(&other).unwrap()
        ),
    }
}

pub(super) async fn message(f: &NativeFixture, session: &str, text: &str) -> RunView {
    f.wait_terminal(send_run(f, session, text).await)
        .await
        .unwrap()
}

async fn continuation_source(f: &NativeFixture, session: &str, run: RunId) -> Execution {
    // Catalog wakes on actual Native custody changes as well as canonical commits.
    let mut catalog = f
        .app
        .client()
        .subscribe(
            f.binding().await.unwrap(),
            "catalog".into(),
            json!({"filter":"all","position":{"kind":"start"}}),
            f.scope(),
            Attachments::new().into(),
        )
        .await
        .unwrap();
    let source = loop {
        catalog
            .recv()
            .await
            .expect("actual Native catalog must remain observable");
        let view = f.state.frontier(run).await.unwrap();
        assert_eq!(view.terminal, Some(Terminal::Cancelled));
        assert_eq!(view.attempts.len(), 1);
        if !view
            .attempts
            .values()
            .all(|attempt| matches!(attempt.cleanup, OperationCleanup::Confirmed))
        {
            continue;
        }
        let availability = f
            .query(
                "continuationAvailability",
                json!({"sessionId":session,"runId":run}),
            )
            .await
            .unwrap();
        match serde_json::from_value(availability).unwrap() {
            ContinuationAvailability::Ready { source } => break source,
            ContinuationAvailability::Rejected {
                reason: ContinuationRejection::Busy,
            } => {}
            other => panic!(
                "original source is not continuable: {}",
                serde_json::to_string(&other).unwrap()
            ),
        }
    };
    catalog.completion().await.cleanup.unwrap();
    source
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn yielded_cell_can_receive_an_answer_and_be_observed_by_the_next_model_step() {
    for continuation in [false, true] {
        tokio::time::timeout(Duration::from_secs(60), verify_yielded(continuation))
            .await
            .expect("yielded cells must continue without cancelling the pending answer");
    }
}

async fn verify_yielded(continuation: bool) {
    let directory = tempfile::tempdir().unwrap();
    let effect = Arc::new(fixture::AnswerEffect::default());
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}/v1", listener.local_addr().unwrap());
    let f = NativeFixture::open_with_service(
        directory.path(),
        configuration(directory.path(), &["slow"]),
        FixtureService::new(fixture::AnswerEffect::contract(), effect.clone()),
    )
    .await
    .unwrap();
    let model = configure_model(&f, &base, false).await;
    let session = f
        .create("yielded", directory.path(), Some(backend(&model)))
        .await
        .unwrap();
    let (source_entered, source_ready) = tokio::sync::oneshot::channel();
    let (source_closed, source_eof) = tokio::sync::oneshot::channel();
    let provider_effect = effect.clone();
    let server = tokio::spawn(async move {
        if continuation {
            let (mut source, _) = listener.accept().await.unwrap();
            http::read_request(&mut source).await;
            source.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n").await.unwrap();
            source_entered.send(()).unwrap();
            let mut bytes = Vec::new();
            let _ = source.read_to_end(&mut bytes).await;
            source_closed.send(()).unwrap();
        }
        let (mut socket, _) = listener.accept().await.unwrap();
        http::read_request(&mut socket).await;
        fixture::tool(
            &mut socket,
            "exec",
            json!({"code":"text(await tools.slow({value:42}));","yield_time_ms":0}),
        )
        .await;
        let (mut socket, _) = listener.accept().await.unwrap();
        let request = http::read_request(&mut socket).await;
        let running: serde_json::Value = serde_json::from_str(
            request["messages"]
                .as_array()
                .unwrap()
                .iter()
                .rev()
                .find(|message| message["role"] == "tool")
                .unwrap()["content"]
                .as_str()
                .unwrap(),
        )
        .unwrap();
        assert_eq!(running["state"], "running");
        provider_effect.entered.notified().await;
        provider_effect.release.notify_one();
        fixture::tool(
            &mut socket,
            "wait",
            json!({"cell_id":running["cell_id"],"yield_time_ms":1000}),
        )
        .await;
        let (mut socket, _) = listener.accept().await.unwrap();
        let request = http::read_request(&mut socket).await;
        let mut output = request["messages"]
            .as_array()
            .unwrap()
            .iter()
            .rev()
            .find(|message| message["role"] == "tool")
            .unwrap()["content"]
            .as_str()
            .unwrap()
            .lines();
        let completed: serde_json::Value = serde_json::from_str(output.next().unwrap()).unwrap();
        assert_eq!(completed["state"], "completed");
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(output.next().unwrap()).unwrap(),
            json!({"value":42})
        );
        respond(&mut socket, false).await;
    });
    let run = if continuation {
        let source = send_run(&f, &session, "original question").await;
        source_ready.await.unwrap();
        let stopped = f
            .mutation_value("stop", json!({"sessionId":session,"runId":source}))
            .await
            .unwrap();
        assert_eq!(stopped["requested"], true);
        assert_eq!(
            f.wait_terminal(source).await.unwrap().terminal,
            Some(Terminal::Cancelled)
        );
        source_eof.await.unwrap();
        let source = continuation_source(&f, &session, source).await;
        let continued = f.mutation_value("continueRun", json!({
            "sessionId":session,"sourceRunId":source.run_id,"sourceHighWater":source.high_water,
            "model":model,"thinkingLevel":null,
        })).await.unwrap();
        let ContinuationResult::Started { execution } = serde_json::from_value(continued).unwrap()
        else {
            panic!("the real cancelled source must admit one explicit continuation")
        };
        execution.run_id
    } else {
        send_run(&f, &session, "question yielded").await
    };
    let view = f.wait_terminal(run).await.unwrap();
    server.await.unwrap();
    assert_eq!(effect.count.load(Ordering::SeqCst), 1);
    assert_eq!(view.terminal, Some(Terminal::Completed));
    let records = f.state.history(run, 0, 256).await.unwrap();
    let cells: Vec<_> = records
        .iter()
        .filter_map(|record| match &record.fact {
            Fact::Cell {
                event:
                    CellEvent::Started {
                        cell,
                        owner: CellOwner::Agent { link, call },
                        ..
                    },
            } => {
                assert_eq!(*cell, CellId::for_agent(*link, call));
                assert_eq!(record.id, cell.started_fact_id());
                Some(*cell)
            }
            _ => None,
        })
        .collect();
    assert_eq!(
        cells.len(),
        1,
        "wait must observe the original Cell, never a replay"
    );
    let cell = f
        .state
        .cells()
        .read(&session, cells[0])
        .await
        .unwrap()
        .unwrap();
    assert!(!cell.pending());
    assert!(cell.physical_cleanup_confirmed());
    f.shutdown().await.unwrap();
}
