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
use maka_agent_facts::{
    artifact::ToolReturn,
    cells::{
        CellEvent, CellId, CellNotification, CellNotificationBody, CellObservation, CellOwner,
        CellReturnedResult, CellVmBinding, SessionPublication,
    },
    history_snapshot::SnapshotId,
    tool_output::{AcceptedToolResult, CellFinalEvidence, ToolOutput},
};
use maka_agent_ports::session::history as wire;
use maka_agent_state::session_history::snapshot::CaptureRequest;

async fn query(rig: &Rig, method: &str, input: Value) -> TestResult<Value> {
    let mut call = rig
        .client
        .as_ref()
        .unwrap()
        .call("agent", method.into(), input, Attachments::new())
        .await?;
    call.start().await?;
    let Reply::Finished { result, cleanup } = call.receive().await? else {
        return Err("query did not finish".into());
    };
    cleanup?;
    let value = result?;
    call.close().await?;
    Ok(value)
}
async fn live(rig: &Rig, session: &str, position: wire::Position) -> TestResult<Value> {
    query(rig,"history",json!({"sessionId":session,"through":null,"position":position,"includeThinking":true,"view":"conversation"})).await
}
fn tools(page: &Value) -> Vec<wire::Tool> {
    page["chunks"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|&chunk| !chunk["tool"].is_null())
        .map(|chunk| serde_json::from_value(chunk["tool"].clone()).unwrap())
        .collect()
}
fn timing(page: &Value) -> wire::TurnTiming {
    let mut timings = page["chunks"].as_array().unwrap().iter().map(|chunk| {
        serde_json::from_value::<Option<wire::TurnTiming>>(chunk["timing"].clone()).unwrap()
    });
    let first = timings
        .next()
        .unwrap()
        .expect("a native Turn row has timing");
    assert!(timings.all(|timing| timing.as_ref() == Some(&first)));
    first
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn history_recognizes_hosted_search_independently_of_the_local_tool_name() -> TestResult<()> {
    use maka_agent_facts::model::ModelToolCall;

    let mut rig = Rig::new()?;
    let result = AssertUnwindSafe(async {
        let session = rig.start().await?;
        rig.assemble(&session).await?;
        let attempt = rig.attempt().await?;
        let mut parts = vec![
            ModelPart::ToolCall {
                call: ModelToolCall {
                    id: "hosted".into(),
                    name: "SearchAlias".into(),
                    input: json!({}).into(),
                    provider_options: None,
                    provider_executed: true,
                },
            },
            ModelPart::ToolResult {
                id: "hosted".into(),
                name: "SearchAlias".into(),
                is_error: false,
                output: json!({"action": {"query": "query from result"}}),
                provider_options: Some(json!({
                    "openai": {"responsesReplay": {"fields": {"type": "web_search_call"}}}
                })),
            },
            ModelPart::ToolCall {
                call: ModelToolCall {
                    id: "local".into(),
                    name: "WebSearch".into(),
                    input: json!({"query": "local query"}).into(),
                    provider_options: None,
                    provider_executed: false,
                },
            },
        ];
        let aliases = [
            "web.run",
            "openai.webSearchPreview",
            "web_search_20250305",
            "deepseek-web-search",
            "browser.search",
            "google_search",
        ];
        for name in aliases {
            parts.push(ModelPart::ToolCall {
                call: ModelToolCall {
                    id: name.into(),
                    name: name.into(),
                    input: json!({"search_query":[{"q":"another query"}]}).into(),
                    provider_options: None,
                    provider_executed: true,
                },
            });
        }
        let facts = parts
            .into_iter()
            .enumerate()
            .map(|(index, part)| Fact::ModelObserved {
                attempt,
                index: index as u64,
                part,
                continuation: None,
            })
            .collect();
        rig.append(facts, vec![]).await?;

        let mut page = live(&rig, &session, wire::Position::Start).await?;
        let mut rows = tools(&page);
        while !page["after"].is_null() {
            page = query(
                &rig,
                "history",
                json!({
                    "sessionId": session, "through": page["through"],
                    "position": {"kind": "after", "cursor": page["after"]},
                    "includeThinking": true, "view": "conversation"
                }),
            )
            .await?;
            rows.extend(tools(&page));
        }
        let hosted: Vec<_> = rows
            .iter()
            .filter_map(|row| row.call.as_ref())
            .filter(|call| call.name == "SearchAlias")
            .collect();
        assert_eq!(
            hosted.len(),
            2,
            "both the call and its receipt reference the search"
        );
        for call in hosted {
            assert_eq!(call.presentation.as_deref(), Some("provider.web_search"));
            assert_eq!(call.title.as_ref().unwrap().fallback, "query from result");
        }
        for name in aliases {
            let call = rows
                .iter()
                .filter_map(|row| row.call.as_ref())
                .find(|call| call.name == name)
                .unwrap();
            assert_eq!(
                call.presentation.as_deref(),
                Some("provider.web_search"),
                "{name}"
            );
            assert_eq!(call.title.as_ref().unwrap().fallback, "another query");
        }
        let local = rows
            .iter()
            .filter_map(|row| row.call.as_ref())
            .find(|call| call.name == "WebSearch")
            .unwrap();
        assert!(local.presentation.is_none());

        let owner = rig.captured.lock().unwrap().clone().unwrap();
        let history = rig
            .driver
            .as_ref()
            .unwrap()
            .state
            .session_history(owner.run_owner(), session);
        let stop = CancellationToken::new();
        let frozen = history
            .capture_snapshot(
                CaptureRequest {
                    id: SnapshotId::new(),
                    cut: history.capture().await?,
                },
                stop.clone(),
            )
            .await?;
        let chat = |position| {
            crate::service::history::snapshot_page(
                &frozen,
                position,
                true,
                wire::HistoryView::Chat,
                &stop,
            )
        };
        let wire::Page::Ready { chunks, .. } = chat(wire::Position::Tail).await?;
        let group = chunks
            .last()
            .and_then(|row| row.work.as_ref())
            .ok_or("missing tool group")?;
        assert_eq!(group.tools, aliases.len() as u64 + 2);
        let wire::Page::Ready { chunks, .. } = chat(wire::Position::Row {
            position: group.end.position.clone(),
            field: group.end.field,
        })
        .await?;
        assert_eq!(
            chunks.first().and_then(|row| row.work.as_ref()),
            Some(group)
        );
        Ok::<_, Box<dyn Error + Send + Sync>>(())
    })
    .catch_unwind()
    .await;
    let cleanup = rig.finish().await;
    result.expect("hosted search projection assertion failed")?;
    assert!(cleanup.is_empty(), "{cleanup:?}");
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn history_preserves_citation_targets_and_legacy_sources() -> TestResult<()> {
    use maka_agent_facts::model::{CitationAnchor, ModelSource, TextKind};

    let mut rig = Rig::new()?;
    let result = AssertUnwindSafe(async {
        let session = rig.start().await?;
        rig.assemble(&session).await?;
        let attempt = rig.attempt().await?;
        let label = "A [source]";
        let url = "https://example.com/a(b)";
        let parts = [
            ModelPart::Text {
                text_kind: TextKind::Text,
                text: "🦀资料".into(),
                provider_options: None,
            },
            ModelPart::Source {
                source: ModelSource::Url {
                    id: "url".into(),
                    url: url.into(),
                    title: Some(label.into()),
                    provider_options: None,
                },
                anchor: Some(CitationAnchor::Range {
                    part: 0,
                    start: 1,
                    end: 3,
                }),
            },
            serde_json::from_value(json!({
                "kind": "source",
                "source": {
                    "kind": "document", "id": "doc", "media_type": "text/plain",
                    "title": "Report", "filename": "report.txt"
                }
            }))?,
        ];
        let facts = parts
            .into_iter()
            .enumerate()
            .map(|(index, part)| Fact::ModelObserved {
                attempt,
                index: index as u64,
                part,
                continuation: None,
            })
            .collect();
        rig.append(facts, vec![]).await?;

        let page = live(&rig, &session, wire::Position::Tail).await?;
        let owner = rig.captured.lock().unwrap().clone().unwrap();
        let history = rig
            .driver
            .as_ref()
            .unwrap()
            .state
            .session_history(owner.run_owner(), session);
        let stop = CancellationToken::new();
        let frozen = history
            .capture_snapshot(
                CaptureRequest {
                    id: SnapshotId::new(),
                    cut: history.capture().await?,
                },
                stop.clone(),
            )
            .await?;
        let snapshot = crate::service::history::snapshot_page(
            &frozen,
            wire::Position::Tail,
            true,
            wire::HistoryView::Conversation,
            &stop,
        )
        .await?;
        for page in [page, serde_json::to_value(snapshot)?] {
            let rows = page["chunks"].as_array().unwrap();
            let text = rows.iter().find(|r| r["text"] == "🦀资料").unwrap();
            assert!(text.get("citation").is_none());
            let sources: Vec<_> = rows
                .iter()
                .filter(|r| r["sourceCitation"] == true)
                .collect();
            assert_eq!(sources.len(), 2);
            assert_eq!(
                sources[0]["citation"],
                json!({"kind":"url","url":url,"title":label})
            );
            assert_eq!(
                sources[0]["citationAnchor"],
                json!({"kind":"range","part":text["modelPart"]["ordinal"],"start":1,"end":3})
            );
            assert_eq!(
                sources[0]["modelPart"]["attemptId"],
                text["modelPart"]["attemptId"]
            );
            assert_eq!(
                sources[1]["citation"],
                json!({"kind":"document","title":"Report","filename":"report.txt"})
            );
            assert!(sources[1].get("citationAnchor").is_none());
        }
        Ok::<_, Box<dyn Error + Send + Sync>>(())
    })
    .catch_unwind()
    .await;
    let cleanup = rig.finish().await;
    result.expect("citation projection assertion failed")?;
    assert!(cleanup.is_empty(), "{cleanup:?}");
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn unknown_tool_effect_releases_followup_only_after_cleanup() {
    use maka_plugin_core::operation::{Receipt, RecoveryContract, RecoveryProtocol, RecoveryRef};

    let mut rig = Rig::new().unwrap();
    let result = AssertUnwindSafe(async {
        let session = rig.start().await?;
        rig.assemble(&session).await?;
        let attempt = rig.attempt().await?;
        let (tool, _) = rig.tool(attempt, "Computer", "click", json!({})).await?;
        rig.finish_model_request(attempt, None).await?;
        let driver = rig.driver.as_ref().unwrap();
        let run = driver.access.execution().run_id;
        let owner = driver.state.frontier(run).await?.spec.owner;
        let digest = format!("sha256-{}", "a".repeat(64));
        let reference = RecoveryRef {
            source: maka_plugin_core::deployment::DeploymentRef {
                state_domain: "b".repeat(64),
                deployment: owner.deployment,
                revision: 1,
            },
            namespace: owner.namespace.clone(),
            export: "computer".into(),
            method: "evaluate".into(),
            operation: Uuid::new_v4(),
            fingerprint: digest.clone(),
            contract: RecoveryContract {
                name: "maka.workspace.Computer".into(),
                version: 1,
                transport: maka_plugin_core::contract::Transport::Remote,
                digest,
            },
            recovery: RecoveryProtocol::JournalV1,
        };
        let reason = BlockerKind::OperationUnknown {
            tool: tool.clone(),
            reference: reference.clone(),
        };
        let diagnostic = "paste did not produce an observable change";
        let observed = |cleanup| Fact::OperationObserved {
            tool: tool.clone(),
            reply: maka_agent_facts::operation::RecordedOperationReply {
                reference: reference.clone(),
                receipt: Receipt::Recorded {
                    outcome: OperationOutcome::Unknown { diagnostic: diagnostic.into() },
                    cleanup,
                },
            },
        };
        let committed = rig
            .append(
                vec![
                    Fact::ToolOriginalBound {
                        tool: tool.clone(),
                        reference: reference.clone(),
                    },
                    observed(OperationCleanup::Unconfirmed),
                    Fact::Blocked {
                        blocker: BlockerId::new(),
                        reason: reason.clone(),
                    },
                    Fact::RunTerminated {
                        terminal: Terminal::Failed,
                        diagnostic: Some(format!("{reason:?}")),
                    },
                ],
                vec![],
            )
            .await?;

        let page = live(&rig, &session, wire::Position::Tail).await?;
        let failures: Vec<_> = page["chunks"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|row| row["role"] == "failure")
            .map(|row| row["text"].as_str().unwrap())
            .collect();
        assert_eq!(failures, [diagnostic]);

        let history = driver.state.session_history(owner, session.clone());
        let cut = history.capture().await?;
        let sequence = history
            .fact_sequence(&cut, run, committed.facts.last().unwrap().id)
            .await?
            .ok_or("missing termination position")?;
        let snapshot = history
            .capture_snapshot(
                CaptureRequest {
                    id: SnapshotId::new(),
                    cut,
                },
                CancellationToken::new(),
            )
            .await?;
        let termination = snapshot
            .item(sequence)
            .await?
            .ok_or("missing archived termination")?;
        let archived =
            maka_agent_state::session_history::source_tree::HistoryDataSource::Snapshot(snapshot);
        assert_eq!(
            archived.recovery_failure_at(&termination).await?.as_deref(),
            Some(diagnostic)
        );
        let BackendSpec::Model { binding, .. } = driver.state.frontier(run).await?.spec.backend
        else {
            return Err("fixture model binding missing".into());
        };
        let client = rig.client.as_ref().unwrap();
        let message = json!({
            "sessionId": session, "message": "What happened?",
            "backend": {"kind":"model", "connectionId": binding.connection_id, "modelId": binding.model},
            "delivery": "queue",
        });
        let blocked = model_recovery::call(client, "agent", "send", message.clone()).await?;
        assert_eq!(blocked["reason"], "original_operation_unsettled", "{blocked}");

        driver.state.observe(
            run,
            vec![Change::new(observed(OperationCleanup::Confirmed), at())],
            vec![],
        ).await?;
        let continued = model_recovery::call(client, "agent", "continueRun", json!({
            "sessionId": session, "sourceRunId": run, "sourceHighWater": driver.state.frontier(run).await?.revision,
            "model": {"connectionId": binding.connection_id, "modelId": binding.model},
        })).await?;
        assert_eq!(continued["reason"], "safety_check_failed", "{continued}");
        let sent = model_recovery::call(client, "agent", "send", message).await?;
        assert_eq!(sent["kind"], "queued", "{sent}");
        let successor = tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let work = model_recovery::call(client, "agent", "work", json!({
                    "sessionId": session, "target": {"kind": "message", "messageId": sent["messageId"]},
                })).await?;
                if let Some(id) = work["execution"]["runId"].as_str() {
                    return Ok::<RunId, Box<dyn Error + Send + Sync>>(serde_json::from_value(Value::String(id.into()))?);
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        }).await.map_err(|_| "queued follow-up did not start")??;
        assert_ne!(successor, run);
        Ok::<_, Box<dyn Error + Send + Sync>>(())
    })
    .catch_unwind()
    .await;
    let cleanup = rig.finish().await;
    assert!(matches!(&result, Ok(Ok(()))), "{result:?}");
    assert!(cleanup.is_empty(), "{cleanup:?}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn followup_pairs_tool_call_with_failure_observed_after_run_termination() -> TestResult<()> {
    use maka_agent_engine::ports::Preparation;
    use maka_agent_facts::operation::inline_reply;
    use maka_plugin_core::operation::{
        OperationReply, Receipt, RecoveryContract, RecoveryProtocol, RecoveryRef,
    };

    let mut rig = Rig::new()?;
    rig.model_overrides = json!({"llama3.2": {"codeMode": false, "vision": true, "apiProtocol": "openai-chat-completions"}});
    let (request, mut captured) = tokio::sync::mpsc::channel(1);
    let app = axum::Router::new().route(
        "/v1/chat/completions",
        axum::routing::post(move |body: axum::body::Bytes| {
            let request = request.clone();
            async move {
                let _ = request.try_send(serde_json::from_slice::<Value>(&body).expect("model request JSON"));
                ([( "content-type", "text/event-stream")], concat!(
                    "data: {\"id\":\"followup\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"The click did not run.\"},\"finish_reason\":null}]}\n\n",
                    "data: {\"id\":\"followup\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n",
                    "data: [DONE]\n\n",
                ))
            }
        }),
    );
    let listener = tokio::net::TcpListener::from_std(rig.model_listener.try_clone()?)?;
    let stop = CancellationToken::new();
    let server_stop = stop.clone();
    let server = tokio::spawn(async move {
        axum::serve(listener, app)
            .with_graceful_shutdown(server_stop.cancelled_owned())
            .await
    });
    let result = AssertUnwindSafe(tokio::time::timeout(Duration::from_secs(30), async {
        let session = rig.start().await?;
        rig.assemble(&session).await?;
        let (_, attempt, _) = rig.record_model_request(Preparation::Initial).await?;
        let (img_tool, _) = rig.tool(attempt, "exec", "snap-1", json!({"code":"1"})).await?;
        let (cell_tool, _) = rig.tool(attempt, "exec", "cell-1", json!({"code":"1"})).await?;
        let (tool, _) = rig.tool(attempt, "computer", "click-1", json!({})).await?;
        let driver = rig.driver.as_ref().unwrap();
        let view = driver.state.frontier(driver.access.execution().run_id).await?;
        let link = AgentStepLink { run: view.run, step: view.attempts[&attempt].step, attempt };
        let img_cell = CellId::for_agent(link, &img_tool.call);
        let rec_cell = CellId::for_agent(link, &cell_tool.call);
        let src = ContentBlob::new(b"1".to_vec());
        let interrupted = ContentBlob::json(&maka_agent_facts::cells::CellInterruption {
            cell: img_cell,
            diagnostic: "post-yield stop".into(),
            children: Default::default(),
            prior_output: None,
        })?;
        let completed = ContentBlob::json(&CellObservation::Completed {
            cell_id: rec_cell,
            content: vec![],
            result: json!({"ok":"recovered-cell-ok"}),
        })?;
        driver.state.append(
            driver.access.claim(),
            (&view).into(),
            vec![
                Change { id: img_cell.started_fact_id(), at: at(), fact: Fact::Cell { event: CellEvent::Started { cell: img_cell, owner: CellOwner::Agent { link, call: img_tool.call.clone() }, source: src.reference().clone() } } },
                Change { id: rec_cell.started_fact_id(), at: at(), fact: Fact::Cell { event: CellEvent::Started { cell: rec_cell, owner: CellOwner::Agent { link, call: cell_tool.call.clone() }, source: src.reference().clone() } } },
                Change::new(Fact::Cell { event: CellEvent::VmBound { cell: rec_cell, binding: maka_agent_facts::cells::CellVmBinding { runtime: "fixture".into(), version: 1, descriptor: src.reference().clone() } } }, at()),
                Change::new(Fact::Cell { event: CellEvent::Interrupted { cell: img_cell, report: interrupted.reference().clone() } }, at()),
                Change::new(Fact::Cell { event: CellEvent::Completed { cell: rec_cell, result: completed.reference().clone(), publication: maka_agent_facts::cells::SessionPublication { values: BTreeMap::new(), loaded_tools: None } } }, at()),
            ],
            vec![src, interrupted, completed],
        ).await?;
        rig.finish_model_request(attempt, None).await?;
        super::super::effects::publish_return_for_test(
            &driver.state,
            &driver.access,
            &img_tool,
            maka_agent_facts::tool_output::ToolSuccess::from(ToolOutput::Mcp(
                maka_agent_facts::capability::CallResult {
                    content: vec![maka_agent_facts::capability::ContentBlock::Image {
                        data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=".into(),
                        mime_type: "image/png".into(),
                    }],
                    structured_content: None,
                },
            )),
            None,
        )
        .await?;
        let run = driver.access.execution().run_id;
        let owner = driver.state.frontier(run).await?.spec.owner;
        let digest = format!("sha256-{}", "a".repeat(64));
        let reference = RecoveryRef {
            source: maka_plugin_core::deployment::DeploymentRef {
                state_domain: "b".repeat(64),
                deployment: owner.deployment,
                revision: 1,
            },
            namespace: owner.namespace,
            export: "computer".into(),
            method: "evaluate".into(),
            operation: Uuid::new_v4(),
            fingerprint: digest.clone(),
            contract: RecoveryContract {
                name: "maka.workspace.Computer".into(),
                version: 1,
                transport: maka_plugin_core::contract::Transport::Remote,
                digest,
            },
            recovery: RecoveryProtocol::JournalV1,
        };
        let observed = |outcome| Fact::OperationObserved {
            tool: tool.clone(),
            reply: inline_reply(OperationReply {
                reference: reference.clone(),
                receipt: Receipt::Recorded {
                    outcome,
                    cleanup: OperationCleanup::Confirmed,
                },
            }),
        };
        rig.append(
            vec![
                Fact::ToolOriginalBound {
                    tool: tool.clone(),
                    reference: reference.clone(),
                },
                observed(OperationOutcome::Unknown {
                    diagnostic: "Original launch uncertain".into(),
                }),
                Fact::Blocked {
                    blocker: BlockerId::new(),
                    reason: BlockerKind::OperationUnknown {
                        tool: tool.clone(),
                        reference: reference.clone(),
                    },
                },
                Fact::RunTerminated {
                    terminal: Terminal::Failed,
                    diagnostic: Some("Original launch uncertain".into()),
                },
            ],
            vec![],
        )
        .await?;
        driver
            .state
            .observe(
                run,
                vec![Change::new(
                    observed(OperationOutcome::Returned {
                        result: OperationResult::Failure {
                            diagnostic: "App identity did not match. Click was not sent.".into(),
                        },
                    }),
                    at(),
                )],
                vec![],
            )
            .await?;

        let client = rig.client.as_ref().unwrap();
        let BackendSpec::Model { binding, .. } = driver.state.frontier(run).await?.spec.backend
        else {
            return Err("fixture model binding missing".into());
        };
        let sent = model_recovery::call(client, "agent", "send", json!({
            "sessionId":session, "message":"Did the click run?",
            "backend":{"kind":"model","connectionId":binding.connection_id,"modelId":binding.model},
            "delivery":"queue",
        })).await?;
        assert_eq!(sent["kind"], "queued", "{sent}");
        let request = captured
            .recv()
            .await
            .ok_or("follow-up did not reach the model")?;
        let messages = request["messages"]
            .as_array()
            .ok_or("model messages missing")?;
        let exchange: Vec<_> = messages
            .iter()
            .filter_map(|message| {
                if message["tool_calls"]
                    .as_array()
                    .is_some_and(|calls| calls.iter().any(|call| call["id"] == "click-1"))
                {
                    Some("call")
                } else if message["role"] == "tool" && message["tool_call_id"] == "click-1" {
                    assert!(
                        message["content"]
                            .as_str()
                            .unwrap_or_default()
                            .contains("App identity did not match. Click was not sent.")
                    );
                    Some("failure")
                } else {
                    None
                }
            })
            .collect();
        assert_eq!(exchange, ["call", "failure"]);
        let req_text = request.to_string();
        assert!(req_text.contains("image/png"), "local_returned lost to RecoveredCell: {req_text}");
        assert!(req_text.contains("recovered-cell-ok"), "RecoveredCell fallback missing: {req_text}");
        model_recovery::completed_message(client, &session, &sent["messageId"]).await?;
        Ok::<_, Box<dyn Error + Send + Sync>>(())
    }))
    .catch_unwind()
    .await;
    stop.cancel();
    server.await??;
    let cleanup = rig.finish().await;
    assert!(matches!(&result, Ok(Ok(Ok(())))), "{result:?}");
    assert!(cleanup.is_empty(), "{cleanup:?}");
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn history_shows_only_the_final_model_failure() -> TestResult<()> {
    use maka_agent_engine::DriverExit;

    for recover in [true, false] {
        let mut rig = Rig::new()?;
        let first_request = Arc::new(AtomicBool::new(true));
        let app = axum::Router::new().route(
            "/v1/chat/completions",
            axum::routing::post(move |_: axum::body::Bytes| {
                let first = first_request.swap(false, Ordering::SeqCst);
                async move {
                    let body = if recover && !first {
                        concat!(
                            "data: {\"id\":\"retry\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"Recovered after retry.\"},\"finish_reason\":null}]}\n\n",
                            "data: {\"id\":\"retry\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n",
                            "data: [DONE]\n\n",
                        )
                    } else {
                        ": stream ended before completion\n\n"
                    };
                    ([("content-type", "text/event-stream")], body)
                }
            }),
        );
        let listener = tokio::net::TcpListener::from_std(rig.model_listener.try_clone()?)?;
        let stop = CancellationToken::new();
        let server_stop = stop.clone();
        let server = tokio::spawn(async move {
            axum::serve(listener, app)
                .with_graceful_shutdown(server_stop.cancelled_owned())
                .await
        });
        let result = AssertUnwindSafe(tokio::time::timeout(Duration::from_secs(30), async {
            let session = rig.start().await?;
            let budget = Budget {
                tokens: None,
                retries: 1,
                deadline: None,
            };
            rig.assemble_model(&session, budget, false).await?;
            let driver = rig.driver.as_ref().unwrap();
            let engine = maka_agent_engine::Engine::new(driver.state.clone());
            let advance = || async {
                let mut changes = driver.state.subscribe()?;
                loop {
                    changes.borrow_and_update();
                    let exit = engine
                        .drive(
                            driver.access.claim().clone(),
                            driver.clone(),
                            CancellationToken::new(),
                        )
                        .await?;
                    if !matches!(exit, DriverExit::Waiting { due_at: None, .. }) {
                        return Ok::<_, Box<dyn Error + Send + Sync>>(exit);
                    }
                    changes.changed().await?;
                }
            };

            let waiting = advance().await?;
            let DriverExit::Waiting {
                due_at: Some(due), ..
            } = waiting
            else {
                return Err(format!("Expected a retry wait, got {waiting:?}").into());
            };
            let pending = live(&rig, &session, wire::Position::Tail).await?;
            let roles: Vec<_> = pending["chunks"]
                .as_array()
                .unwrap()
                .iter()
                .map(|chunk| chunk["role"].as_str().unwrap())
                .collect();
            assert_eq!(roles, ["user"]);
            let running = timing(&pending);
            assert!(running.finished.is_none(), "{running:?}");

            tokio::time::sleep(Duration::from_millis(
                due.0.saturating_sub(at().0).max(0) as u64
            ))
            .await;
            let expected = if recover {
                Terminal::Completed
            } else {
                Terminal::Failed
            };
            let exit = advance().await?;
            assert!(
                matches!(&exit, DriverExit::Terminal { terminal, .. } if *terminal == expected),
                "{exit:?}"
            );
            let page = live(&rig, &session, wire::Position::Tail).await?;
            let transcript: Vec<_> = page["chunks"]
                .as_array()
                .unwrap()
                .iter()
                .map(|chunk| {
                    (
                        chunk["role"].as_str().unwrap(),
                        chunk["text"].as_str().unwrap(),
                    )
                })
                .collect();
            let last = if recover {
                ("assistant", "Recovered after retry.")
            } else {
                (
                    "failure",
                    "provider failed (StreamTruncated): model stream ended without finish",
                )
            };
            assert_eq!(
                transcript,
                [("user", "native wait original read failure"), last]
            );
            let ended = timing(&page);
            assert_eq!(ended.started_at, running.started_at);
            let finished = ended
                .finished
                .clone()
                .expect("a terminated Turn has an end");
            assert!(finished.at >= ended.started_at);
            assert_eq!(
                finished.outcome,
                if recover {
                    wire::TurnOutcome::Completed
                } else {
                    wire::TurnOutcome::Failed
                }
            );
            let owner = rig.captured.lock().unwrap().clone().unwrap();
            let history = driver
                .state
                .session_history(owner.run_owner(), session.clone());
            let frozen = history
                .capture_snapshot(
                    CaptureRequest {
                        id: SnapshotId::new(),
                        cut: history.capture().await?,
                    },
                    CancellationToken::new(),
                )
                .await?;
            let frozen = crate::service::history::snapshot_page(
                &frozen,
                wire::Position::Tail,
                true,
                wire::HistoryView::Conversation,
                &CancellationToken::new(),
            )
            .await?;
            assert_eq!(timing(&serde_json::to_value(frozen)?), ended);
            Ok::<_, Box<dyn Error + Send + Sync>>(())
        }))
        .catch_unwind()
        .await;
        stop.cancel();
        server.await??;
        assert_eq!(rig.finish().await, Vec::<String>::new());
        result.expect("retry history assertion failed")??;
    }
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn history_exposes_only_reported_prompt_cache_usage() -> TestResult<()> {
    use maka_agent_engine::DriverExit;

    for reported in [Some(60), Some(0), None] {
        let mut rig = Rig::new()?;
        let mut usage = json!({"prompt_tokens": 100, "completion_tokens": 5});
        if let Some(read) = reported {
            usage["prompt_tokens_details"] = json!({"cached_tokens": read});
        }
        let event = json!({
            "id":"cache-reply",
            "choices":[{"index":0,"delta":{"role":"assistant","content":"Cached turn."},"finish_reason":"stop"}],
            "usage":usage,
        });
        let body = format!("data: {event}\n\ndata: [DONE]\n\n");
        let app = axum::Router::new().route(
            "/v1/chat/completions",
            axum::routing::post(
                move || async move { ([("content-type", "text/event-stream")], body) },
            ),
        );
        let listener = tokio::net::TcpListener::from_std(rig.model_listener.try_clone()?)?;
        let stop = CancellationToken::new();
        let server_stop = stop.clone();
        let server = tokio::spawn(async move {
            axum::serve(listener, app)
                .with_graceful_shutdown(server_stop.cancelled_owned())
                .await
        });
        let result = AssertUnwindSafe(tokio::time::timeout(Duration::from_secs(30), async {
            let session = rig.start().await?;
            rig.assemble_model(
                &session,
                Budget {
                    tokens: None,
                    retries: 0,
                    deadline: None,
                },
                false,
            )
            .await?;
            let driver = rig.driver.as_ref().unwrap();
            let engine = maka_agent_engine::Engine::new(driver.state.clone());
            let mut changes = driver.state.subscribe()?;
            loop {
                changes.borrow_and_update();
                let exit = engine
                    .drive(
                        driver.access.claim().clone(),
                        driver.clone(),
                        CancellationToken::new(),
                    )
                    .await?;
                if matches!(exit, DriverExit::Waiting { due_at: None, .. }) {
                    changes.changed().await?;
                    continue;
                }
                assert!(
                    matches!(
                        exit,
                        DriverExit::Terminal {
                            terminal: Terminal::Completed,
                            ..
                        }
                    ),
                    "{exit:?}"
                );
                break;
            }
            let page = live(&rig, &session, wire::Position::Tail).await?;
            let reply = page["chunks"]
                .as_array()
                .unwrap()
                .iter()
                .find(|chunk| chunk["finalOutput"] == true)
                .expect("completed reply");
            assert_eq!(reply["text"], "Cached turn.");
            let observed = query(&rig, "observe", json!({"sessionId":session})).await?;
            assert!(
                observed["metrics"]["outputTokensPerSecond"]
                    .as_f64()
                    .is_some_and(|rate| rate > 0.0)
            );
            assert_eq!(
                reply["timing"].get("promptCache").cloned(),
                reported.map(|read| json!({"inputTokens":100,"readTokens":read})),
            );
            Ok::<_, Box<dyn Error + Send + Sync>>(())
        }))
        .catch_unwind()
        .await;
        stop.cancel();
        server.await??;
        assert_eq!(rig.finish().await, Vec::<String>::new());
        result.expect("prompt cache history assertion failed")??;
    }
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn named_cell_tools_survive_receipt_only_pages_and_frozen_history() {
    let mut rig = Rig::new().unwrap();
    let result = AssertUnwindSafe(tokio::time::timeout(Duration::from_secs(60), async {
        let session = rig.start().await?;
        rig.assemble(&session).await?;
        let attempt = rig.attempt().await?;
        let (parent, _) = rig
            .tool(
                attempt,
                "exec",
                "script",
                json!({"code":"tools.Recall({query: 'cargo'})"}),
            )
            .await?;
        let driver = rig.driver.as_ref().unwrap();
        let view = driver
            .state
            .frontier(driver.access.execution().run_id)
            .await?;
        let link = AgentStepLink {
            run: view.run,
            step: view.attempts[&attempt].step,
            attempt,
        };
        let cell = CellId::for_agent(link, &parent.call);
        let source = ContentBlob::new(b"tools.Recall({query: 'cargo'})".to_vec());
        driver
            .state
            .append(
                driver.access.claim(),
                (&view).into(),
                vec![Change {
                    id: cell.started_fact_id(),
                    at: at(),
                    fact: Fact::Cell {
                        event: CellEvent::Started {
                            cell,
                            owner: CellOwner::Agent {
                                link,
                                call: parent.call.clone(),
                            },
                            source: source.reference().clone(),
                        },
                    },
                }],
                vec![source],
            )
            .await?;
        let input = ContentBlob::json(&json!({"query":"cargo"}))?;
        let operation = Uuid::new_v4();
        rig.append(
            vec![
                Fact::Cell {
                    event: CellEvent::VmBound {
                        cell,
                        binding: CellVmBinding {
                            runtime: "fixture".into(),
                            version: 1,
                            descriptor: input.reference().clone(),
                        },
                    },
                },
                Fact::Cell {
                    event: CellEvent::ChildPrepared {
                        cell,
                        operation,
                        name: "Recall".into(),
                        semantics: ToolSemantics::Parallel,
                        input: input.reference().clone(),
                        resources: vec![],
                    },
                },
                Fact::Cell {
                    event: CellEvent::ChildDisplayRecorded {
                        cell, operation, display: ToolDisplay {
                            title: Some("Find earlier compiler failures".into()),
                            presentation: Some("example.history/recall".into()),
                        },
                    },
                },
                Fact::Cell {
                    event: CellEvent::ChildAdmitted { cell, operation },
                },
            ],
            vec![input],
        )
        .await?;
        // More bookkeeping than a raw history query batch, after the actual call.
        let notice = ContentBlob::json(&CellNotification {
            schema_version: 1,
            body: CellNotificationBody::Text {
                text: "background progress".into(),
            },
        })?;
        rig.append(
            (0..40)
                .map(|_| Fact::Cell {
                    event: CellEvent::NotificationQueued {
                        cell,
                        notification: FactId::new(),
                        content: notice.reference().clone(),
                    },
                })
                .collect(),
            vec![notice],
        )
        .await?;
        let running = live(&rig, &session, wire::Position::Tail).await?;
        let child = tools(&running)
            .into_iter()
            .find(|tool| tool.call.as_ref().is_some_and(|call| call.name == "Recall"))
            .ok_or("named child missing behind lifecycle events")?;
        assert!(child.call.as_ref().unwrap().pending);
        assert_eq!(child.call.as_ref().unwrap().title.as_ref().unwrap().fallback, "Find earlier compiler failures");
        assert_eq!(child.call.as_ref().unwrap().presentation.as_deref(), Some("example.history/recall"));
        assert_eq!(
            child.call.as_ref().unwrap().origin,
            wire::ToolCallOrigin::CodeMode
        );
        assert_eq!(
            child.call.as_ref().unwrap().ancestor_tool_use_ids,
            vec![maka_agent_facts::tool_call::tool_use_id(
                link.run,
                &format!("{}:{}", parent.attempt, parent.call)
            )]
        );
        let jump = live(&rig, &session, wire::Position::Event { sequence:running["through"].as_u64().unwrap() }).await?;
        assert!(tools(&jump).iter().any(|tool| tool.call.as_ref().is_some_and(|call| call.name == "Recall")), "navigation to a lifecycle event lands on actual work");
        let search = query(&rig,"search",json!({"sessionId":session,"through":running["through"],"after":null,"query":"background progress","caseSensitive":false,"wholeWord":false,"includeInternal":true})).await?;
        assert!(search["matches"].as_array().unwrap().is_empty(), "transcript search does not navigate to hidden bookkeeping");
        assert!(search["nextAfter"].is_null(), "a bookkeeping-only match page is not a false end of search");
        let owner = rig.captured.lock().unwrap().clone().unwrap();
        let history = rig
            .driver
            .as_ref()
            .unwrap()
            .state
            .session_history(owner.run_owner(), session.clone());
        let frozen = history
            .capture_snapshot(
                CaptureRequest {
                    id: SnapshotId::new(),
                    cut: history.capture().await?,
                },
                CancellationToken::new(),
            )
            .await?;
        let unknown = ContentBlob::json(&ToolReturn {
            schema_version: SCHEMA_VERSION,
            artifacts: vec![],
            body: CellReturnedResult {
                output: ToolOutput::Text("No receipt yet".into()),
                projection: None,
                is_error: true,
            },
        })?;
        rig.append(
            vec![Fact::Cell {
                event: CellEvent::LocalChildReturned {
                    cell,
                    operation,
                    result: unknown.reference().clone(),
                    is_error: true,
                    settlement: ToolSettlement::Unknown,
                },
            }],
            vec![unknown],
        )
        .await?;
        let uncertain = live(&rig, &session, wire::Position::Tail).await?;
        let uncertain_child = tools(&uncertain).into_iter().find(|tool| tool.call.as_ref().is_some_and(|call| call.name == "Recall")).ok_or("uncertain child disappeared")?;
        assert_eq!(uncertain_child.result.as_ref().map(|result| result.settlement),Some(Some(ToolSettlement::Unknown)),"unknown outcomes remain visible until evidence arrives");
        let returned = ContentBlob::json(&ToolReturn {
            schema_version: SCHEMA_VERSION,
            artifacts: vec![],
            body: CellReturnedResult {
                output: ToolOutput::Text("Internal service response".into()),
                projection: Some(maka_agent_facts::tool_output::DurableToolProjection::Text {
                    text: "Found the previous cargo failure".into(),
                }),
                is_error: false,
            },
        })?;
        let completed = ContentBlob::json(&CellObservation::Completed {
            cell_id: cell,
            content: vec![],
            result: json!({"done":true}),
        })?;
        let accepted = ContentBlob::json(&AcceptedToolResult::RecoveredCell {
            cell,
            evidence: CellFinalEvidence::Completed {
                result: completed.reference().clone(),
            },
        })?;
        rig.append(
            vec![
                Fact::Cell {
                    event: CellEvent::LocalChildReturned {
                        cell,
                        operation,
                        result: returned.reference().clone(),
                        is_error: false,
                        settlement: ToolSettlement::Returned,
                    },
                },
                Fact::Cell {
                    event: CellEvent::Completed {
                        cell,
                        result: completed.reference().clone(),
                        publication: SessionPublication {
                            values: BTreeMap::new(),
                            loaded_tools: None,
                        },
                    },
                },
                Fact::ToolResultAccepted {
                    tool: parent,
                    result: accepted.reference().clone(),
                    outcome: AcceptedResult::CellRecovered { cell },
                },
            ],
            vec![returned, completed, accepted],
        )
        .await?;
        let stale = ContentBlob::json(&ToolReturn {
            schema_version: SCHEMA_VERSION,
            artifacts: vec![],
            body: CellReturnedResult {
                output: ToolOutput::Text("Delayed uncertain observation".into()),
                projection: None,
                is_error: true,
            },
        })?;
        rig.append(
            vec![Fact::Cell {
                event: CellEvent::LocalChildReturned {
                    cell,
                    operation,
                    result: stale.reference().clone(),
                    is_error: true,
                    settlement: ToolSettlement::Unknown,
                },
            }],
            vec![stale],
        )
        .await?;
        let done = live(&rig, &session, wire::Position::Tail).await?;
        let done_tools = tools(&done);
        assert!(
            done_tools.iter().all(|tool| tool.call.is_some()),
            "results keep the original tool name and argument reference"
        );
        assert!(
            done_tools
                .iter()
                .all(|tool| tool.result.as_ref().is_some_and(|result| !result.is_error)),
            "completed recovery is successful"
        );
        let child = done_tools
            .iter()
            .find(|tool| tool.call.as_ref().unwrap().name == "Recall")
            .unwrap();
        assert!(!child.call.as_ref().unwrap().pending);
        assert_eq!(
            child.result.as_ref().unwrap().settlement,
            Some(ToolSettlement::Returned)
        );
        for (field, position, expected) in [
            ("arguments", &child.call.as_ref().unwrap().position, "cargo"),
            ("result", &child.result.as_ref().unwrap().position, "Found the previous cargo failure"),
        ] {
            let source = query(&rig,"source",json!({"sessionId":session,"through":done["through"],"source":{"kind":"row","position":position},"field":field,"path":null,"position":{"kind":"start"}})).await?;
            assert_eq!(source["source"]["tool"], serde_json::to_value(child)?, "opening the card preserves its paired source identity");
            assert!(source["source"]["text"].as_str().unwrap().contains(expected));
        }
        let snapshot = crate::service::history::snapshot_page(
            &frozen,
            wire::Position::Tail,
            true,
            wire::HistoryView::Conversation,
            &CancellationToken::new(),
        )
        .await?;
        let snapshot = serde_json::to_value(snapshot)?;
        assert_eq!(timing(&snapshot), timing(&done));
        let frozen_child = tools(&snapshot)
            .into_iter()
            .find(|tool| tool.call.as_ref().is_some_and(|call| call.name == "Recall"))
            .unwrap();
        assert!(
            frozen_child.call.as_ref().unwrap().pending,
            "frozen history must not acquire later results"
        );
        assert!(frozen_child.result.is_none());
        assert_eq!(frozen_child.call.as_ref().unwrap().title, child.call.as_ref().unwrap().title);
        assert_eq!(frozen_child.call.as_ref().unwrap().presentation, child.call.as_ref().unwrap().presentation);
        let chunks = done["chunks"].as_array().unwrap();
        assert!(
            chunks
                .iter()
                .all(|chunk| chunk["role"] == "user" || !chunk["tool"].is_null()),
            "internal receipts never become anonymous tool rows"
        );
        assert!(
            done["before"].is_null() && done["after"].is_null(),
            "hidden receipts cannot create phantom pages"
        );
        Ok::<_, Box<dyn Error + Send + Sync>>(())
    }))
    .catch_unwind()
    .await;
    let cleanup = rig.finish().await;
    assert!(
        matches!(&result, Ok(Ok(Ok(())))),
        "tool history regression: {result:?}"
    );
    assert!(cleanup.is_empty(), "fixture cleanup: {cleanup:?}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn compact_cell_tool_result_reads_the_original_observation() {
    use maka_agent_facts::{
        cells::{CellReply, CellReplyState},
        model::prompt_source::source::json as stream,
        tool_output::DurableToolProjection,
    };
    use maka_agent_state::session_history::tool_result_source::ToolResultReader;

    let mut rig = Rig::new().unwrap();
    let result = AssertUnwindSafe(tokio::time::timeout(Duration::from_secs(60), async {
        let session = rig.start().await?;
        rig.assemble(&session).await?;
        let attempt = rig.attempt().await?;
        let (tool, _) = rig
            .tool(attempt, "exec", "script", json!({"code":"1"}))
            .await?;
        let driver = rig.driver.as_ref().unwrap();
        let run = driver.access.execution().run_id;
        let view = driver.state.frontier(run).await?;
        let history = driver
            .state
            .session_history(view.spec.owner.clone(), session);
        let resources = driver.owner.services.model_preparation_resources();
        let cell = CellId::for_agent(
            AgentStepLink {
                run,
                step: view.attempts[&attempt].step,
                attempt,
            },
            &tool.call,
        );
        let observed = CellObservation::Completed {
            cell_id: cell,
            content: vec![],
            result: json!({"answer":"original evidence"}),
        };
        let observation = ContentBlob::json(&observed)?;
        let success = ToolSuccess::projected(
            ToolOutput::Cell(Box::new(CellReply {
                cell,
                state: CellReplyState::Completed {
                    result: observation.reference().clone(),
                },
                observation: serde_json::to_value(observed)?,
            })),
            DurableToolProjection::Text {
                text: "Done".into(),
            },
        );
        let fact = super::super::effects::publish_return_for_test(
            &driver.state,
            &driver.access,
            &tool,
            success,
            Some(observation),
        )
        .await?;
        let Fact::LocalToolReturned {
            result: reference, ..
        } = &fact
        else {
            return Err("missing local return".into());
        };
        let persisted = driver.state.content(run, reference.clone()).await?;
        assert!(!String::from_utf8(persisted)?.contains("original evidence"));
        let stop = CancellationToken::new();
        let cut = history.capture().await?;
        let reader = ToolResultReader::live(&history, &cut, run, &stop);
        let work = resources.acquire_work().await?;
        let budget = work.budget();
        let value = reader
            .result(&fact, reference, budget.clone())
            .await?
            .value(budget.clone())
            .await?;
        let answer = stream::field(&value, &["observation", "result", "answer"], budget.clone())
            .await?
            .ok_or("missing original observation")?;
        assert!(stream::text_eq(&answer.text()?, "original evidence", budget.clone()).await?);

        Ok::<_, Box<dyn Error + Send + Sync>>(())
    }))
    .catch_unwind()
    .await;
    let cleanup = rig.finish().await;
    assert!(
        matches!(&result, Ok(Ok(Ok(())))),
        "Cell history regression: {result:?}"
    );
    assert!(cleanup.is_empty(), "fixture cleanup: {cleanup:?}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn shared_operation_receipt_survives_snapshot_transfer() {
    use maka_agent_facts::{
        model::prompt_source::source::json as stream, tool_output::DurableToolProjection,
    };
    use maka_agent_state::{
        recall::Field,
        session_history::{
            navigation::SourceFind,
            source_tree::SourceTree,
            tool_result_source::{ToolProjectionSource, ToolResultReader, ToolResultSource},
        },
    };
    use maka_plugin_core::operation::{
        OperationReply, Receipt, RecoveryContract, RecoveryProtocol, RecoveryRef,
    };

    let mut rig = Rig::new().unwrap();
    let result = AssertUnwindSafe(tokio::time::timeout(Duration::from_secs(60), async {
        let session = rig.start().await?;
        rig.assemble(&session).await?;
        let attempt = rig.attempt().await?;
        let (tool, _) = rig
            .tool(attempt, "exec", "script", json!({"code":"1"}))
            .await?;
        let driver = rig.driver.as_ref().unwrap();
        let run = driver.access.execution().run_id;
        let owner = driver.state.frontier(run).await?.spec.owner.clone();
        let history = driver.state.session_history(owner.clone(), session);
        let digest = format!("sha256-{}", "b".repeat(64));
        let reference = RecoveryRef {
            source: maka_plugin_core::deployment::DeploymentRef {
                state_domain: "a".repeat(64),
                deployment: owner.deployment,
                revision: 1,
            },
            namespace: owner.namespace.clone(),
            export: "history".into(),
            method: "original_host_method".into(),
            operation: Uuid::new_v4(),
            fingerprint: digest.clone(),
            contract: RecoveryContract {
                name: "history".into(),
                version: 1,
                transport: maka_plugin_core::contract::Transport::Local,
                digest,
            },
            recovery: RecoveryProtocol::JournalV1,
        };
        let value = json!({"answer":"shared operation evidence"});
        let outcome = OperationResult::Success {
            value: value.clone(),
        };
        let reply = OperationReply {
            reference: reference.clone(),
            receipt: Receipt::Recorded {
                outcome: OperationOutcome::Returned {
                    result: outcome.clone(),
                },
                cleanup: OperationCleanup::Confirmed,
            },
        };
        let mut legacy: maka_agent_facts::operation::RecordedOperationReply =
            serde_json::from_value(serde_json::to_value(&reply)?)?;
        let Receipt::Recorded { cleanup, .. } = &mut legacy.receipt else {
            unreachable!()
        };
        *cleanup = OperationCleanup::Unconfirmed;
        rig.append(
            vec![
                Fact::ToolOriginalBound { tool: tool.clone(), reference: reference.clone() },
                Fact::OperationObserved { tool: tool.clone(), reply: legacy },
            ],
            vec![],
        ).await?;
        let success = ToolSuccess::projected(
            ToolOutput::Operation(Box::new(reply)),
            DurableToolProjection::Json { value },
        );
        let fact = super::super::effects::publish_return_for_test(
            &driver.state, &driver.access, &tool, success, None,
        ).await?;
        let Fact::HostToolResultRecorded { result, .. } = &fact else {
            return Err("missing Host return".into());
        };
        let persisted = driver.state.content(run, result.clone()).await?;
        assert!(!String::from_utf8(persisted)?.contains("shared operation evidence"));
        let view = driver.state.frontier(run).await?;
        let expected = ContentBlob::json(&outcome)?;
        assert!(matches!(
            &view.tools[&maka_agent_state::fold::tool_key(&tool)].receipt,
            Some(Receipt::Recorded {
                outcome: OperationOutcome::Returned {
                    result: maka_agent_facts::operation::RecordedOperationResult::Referenced { content, is_error: false },
                },
                cleanup: OperationCleanup::Confirmed,
            }) if content == expected.reference()
        ));

        let host = ContentBlob::json(&AcceptedToolResult::Host { result: result.clone() })?;
        let (observed, _) = rig.tool(attempt, "exec", "receipt-only", json!({})).await?;
        let (reply, material) = maka_agent_state::operation::record_reply(OperationReply {
            reference: RecoveryRef { operation: Uuid::new_v4(), method: "recovery".into(), ..reference },
            receipt: Receipt::Recorded {
                outcome: OperationOutcome::Returned {
                    result: OperationResult::Success { value: json!("receipt-only evidence") },
                },
                cleanup: OperationCleanup::Confirmed,
            },
        })?;
        let receipt = ContentBlob::json(&AcceptedToolResult::ObservedOperation { reply: reply.clone() })?;
        rig.append(
            vec![
                Fact::ToolResultAccepted {
                    tool: tool.clone(), result: host.reference().clone(), outcome: AcceptedResult::Succeeded,
                },
                Fact::ToolOriginalBound { tool: observed.clone(), reference: reply.reference.clone() },
                Fact::OperationObserved { tool: observed.clone(), reply },
                Fact::ToolResultAccepted {
                    tool: observed, result: receipt.reference().clone(), outcome: AcceptedResult::Succeeded,
                },
            ],
            [host, receipt].into_iter().chain(material).collect(),
        ).await?;

        let stop = CancellationToken::new();
        let captured = history
            .capture_snapshot(
                CaptureRequest {
                    id: SnapshotId::new(),
                    cut: history.capture().await?,
                },
                stop.clone(),
            )
            .await?;
        let (_destination, root, imported) = transfer_snapshot(&captured, owner, &stop).await?;
        let reader = ToolResultReader::snapshot(&imported, run, &stop);
        let resources = driver.owner.services.model_preparation_resources();
        let work = resources.acquire_work().await?;
        let budget = work.budget();
        let ToolResultSource::Returned(returned) = reader.result(&fact, result, budget.clone()).await? else {
            return Err("missing shared return".into());
        };
        let fields = returned.fields(budget.clone()).await?;
        let output = fields.value(budget.clone()).await?;
        let Some(ToolProjectionSource::Json(projection)) = fields.projection(budget.clone()).await? else {
            return Err("missing shared projection".into());
        };
        for (source, path) in [
            (output, &["receipt", "outcome", "result", "value", "answer"][..]),
            (projection.value(budget.clone()).await?, &["answer"][..]),
        ] {
            let answer = stream::field(&source, path, budget.clone()).await?.ok_or("missing shared result")?;
            assert!(stream::text_eq(&answer.text()?, "shared operation evidence", budget.clone()).await?);
        }
        let tree = SourceTree::snapshot(&imported).await?;
        for query in ["receipt-only evidence", "original_host_method"] {
            let found = tree.find_page(SourceFind {
                after: None,
                query: query.into(),
                case_sensitive: true,
                whole_word: false,
                include_internal: true,
            }, stop.clone()).await?;
            assert!(found.matches.iter().any(|item| item.field == Field::Receipt), "receipt missing for {query}");
            assert!(found.matches.iter().any(|item| item.field == Field::Result), "accepted result missing for {query}");
        }
        root.shutdown().await?;
        Ok::<_, Box<dyn Error + Send + Sync>>(())
    }))
    .catch_unwind()
    .await;
    let cleanup = rig.finish().await;
    assert!(
        matches!(&result, Ok(Ok(Ok(())))),
        "operation history regression: {result:?}"
    );
    assert!(cleanup.is_empty(), "fixture cleanup: {cleanup:?}");
}

async fn transfer_snapshot(
    captured: &maka_agent_state::session_history::snapshot::Snapshot,
    owner: RunOwner,
    stop: &CancellationToken,
) -> TestResult<(
    tempfile::TempDir,
    RootStore,
    maka_agent_state::session_history::snapshot::Snapshot,
)> {
    let exported = captured.export(tempfile::tempfile()?).await?;
    let destination = tempfile::tempdir()?;
    let base = destination.path();
    let owner_root = RootOwner::create(
        &base.join("root"),
        &RootNamespaces {
            ownership: base.join("owners"),
            control: base.join("control"),
        },
    )?;
    let migrations = [
        maka_event_log::ROOT_MIGRATIONS,
        maka_agent_state::MIGRATIONS,
    ]
    .concat();
    let root = RootStore::open(Arc::new(owner_root), &migrations).await?;
    let writer = root.data_writer()?;
    let imported = Store::new(writer.clone(), DriverDomain::new(writer)?)?
        .session_history(owner, "destination".into())
        .import_snapshot(
            Uuid::new_v4(),
            exported.history,
            exported.file,
            stop.clone(),
        )
        .await?;
    Ok((destination, root, imported))
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn shared_cell_child_receipt_survives_snapshot_transfer() {
    use maka_agent_facts::{
        cells::{CellInterruption, CellReply, CellReplyState},
        model::prompt_source::source::json as stream,
        operation::inline_reply,
        tool_output::DurableToolProjection,
    };
    use maka_agent_state::{
        recall::Field,
        session_history::{
            navigation::SourceFind,
            source_tree::SourceTree,
            tool_result_source::{ToolProjectionSource, ToolResultReader, ToolResultSource},
        },
    };
    use maka_plugin_core::operation::{
        OperationReply, Receipt, RecoveryContract, RecoveryProtocol, RecoveryRef,
    };

    let mut rig = Rig::new().unwrap();
    let result = AssertUnwindSafe(tokio::time::timeout(Duration::from_secs(60), async {
        let session = rig.start().await?;
        rig.assemble(&session).await?;
        let attempt = rig.attempt().await?;
        let (parent, _) = rig
            .tool(attempt, "exec", "script", json!({"code":"1"}))
            .await?;
        let driver = rig.driver.as_ref().unwrap();
        let run = driver.access.execution().run_id;
        let view = driver.state.frontier(run).await?;
        let owner = view.spec.owner.clone();
        let link = AgentStepLink {
            run,
            step: view.attempts[&attempt].step,
            attempt,
        };
        let cell = CellId::for_agent(link, &parent.call);
        let source = ContentBlob::new(b"fixture Cell program".to_vec());
        let owner_cell = CellOwner::Agent {
            link,
            call: parent.call.clone(),
        };
        driver
            .state
            .append(
                driver.access.claim(),
                (&view).into(),
                vec![Change {
                    id: cell.started_fact_id(),
                    at: at(),
                    fact: Fact::Cell {
                        event: CellEvent::Started {
                            cell,
                            owner: owner_cell,
                            source: source.reference().clone(),
                        },
                    },
                }],
                vec![source],
            )
            .await?;
        let operation = Uuid::new_v4();
        let input = ContentBlob::json(&json!({"query":"fixture"}))?;
        let digest = format!("sha256-{}", "b".repeat(64));
        let payload = format!("shared child evidence {}", "x".repeat(64 * 1024));
        let reply = OperationReply {
            reference: RecoveryRef {
                source: maka_plugin_core::deployment::DeploymentRef {
                    state_domain: "a".repeat(64),
                    deployment: owner.deployment,
                    revision: 1,
                },
                namespace: owner.namespace.clone(),
                export: "history".into(),
                method: "query".into(),
                operation,
                fingerprint: digest.clone(),
                contract: RecoveryContract {
                    name: "history".into(),
                    version: 1,
                    transport: maka_plugin_core::contract::Transport::Local,
                    digest,
                },
                recovery: RecoveryProtocol::JournalV1,
            },
            receipt: Receipt::Recorded {
                outcome: OperationOutcome::Returned {
                    result: OperationResult::Success {
                        value: json!(&payload),
                    },
                },
                cleanup: OperationCleanup::Confirmed,
            },
        };
        let prepared = crate::owner::driver_cells::prepare_child_return(
            ToolSuccess::projected(
                ToolOutput::Operation(Box::new(reply.clone())),
                DurableToolProjection::Json {
                    value: json!(&payload),
                },
            ),
            driver.access.execution(),
            cell,
            operation,
        )?;
        let mut legacy = inline_reply(reply.clone());
        let Receipt::Recorded { cleanup, .. } = &mut legacy.receipt else {
            unreachable!()
        };
        *cleanup = OperationCleanup::Unconfirmed;
        let observation = prepared.observed.ok_or("missing compact observation")?;
        let receipt_ref = maka_agent_facts::operation::result_reference(&observation)
            .ok_or("missing payload reference")?
            .clone();
        let material = prepared.material.ok_or("missing payload material")?;
        assert_eq!(receipt_ref, *material.reference());
        let result = prepared.blob.reference().clone();
        let returned = CellEvent::ChildResultRecorded {
            cell,
            operation,
            result: result.clone(),
            is_error: prepared.is_error,
        };
        rig.append(
            vec![
                CellEvent::VmBound {
                    cell,
                    binding: CellVmBinding {
                        runtime: "fixture".into(),
                        version: 1,
                        descriptor: input.reference().clone(),
                    },
                },
                CellEvent::ChildPrepared {
                    cell,
                    operation,
                    name: "Recall".into(),
                    semantics: ToolSemantics::Parallel,
                    input: input.reference().clone(),
                    resources: vec![],
                },
                CellEvent::ChildAdmitted { cell, operation },
                CellEvent::ChildBound {
                    cell,
                    operation,
                    reference: reply.reference.clone(),
                },
                CellEvent::ChildObserved {
                    cell,
                    operation,
                    reply: legacy,
                },
                CellEvent::ChildObserved {
                    cell,
                    operation,
                    reply: observation.clone(),
                },
                returned.clone(),
            ]
            .into_iter()
            .map(|event| Fact::Cell { event })
            .collect(),
            vec![input, prepared.blob, material],
        )
        .await?;
        let bytes = driver.state.content(run, result.clone()).await?;
        assert!(!String::from_utf8(bytes)?.contains("shared child evidence"));
        let cells = driver.state.cells();
        let child = cells
            .read(&session, cell)
            .await?
            .unwrap()
            .children
            .remove(&operation)
            .unwrap();
        assert_eq!(child.reply.as_ref(), Some(&observation));
        assert_eq!(
            cells
                .operation_reply(&session, cell, child.reply.unwrap())
                .await?,
            reply
        );

        let canonical = cells.read(&session, cell).await?.unwrap();
        let history = driver.state.session_history(owner.clone(), session.clone());
        let stop = CancellationToken::new();
        let through = history.capture().await?.through_sequence;
        let resources =
            maka_model::ModelPreparationResources::new(maka_model::PreparationPolicy {
                staging_bytes: payload.len() * 3,
                ..Default::default()
            })?;
        let (knowledge, dependencies) = maka_agent_engine::preparation::project_cell_knowledge(
            maka_agent_engine::preparation::NotificationSource::Live(&driver.state),
            &history,
            &maka_agent_state::artifacts::ArtifactScope {
                owner: owner.clone(),
                session,
                run,
                through,
            },
            cell,
            &canonical.children,
            maka_agent_facts::language::Language::En,
            false,
            &resources,
            &stop,
        )
        .await?;
        let knowledge = serde_json::to_string(&knowledge)?;
        assert_eq!(knowledge.matches("shared child evidence").count(), 1);
        for field in ["fingerprint", "approvals", "receipt", "through"] {
            assert!(
                !knowledge.contains(field),
                "{field} leaked into model context"
            );
        }
        assert!(dependencies.contains(&receipt_ref));
        let mut report = CellInterruption {
            cell,
            diagnostic: "fixture interruption".into(),
            children: canonical.children,
            prior_output: None,
        };
        let report_blob = ContentBlob::json(&report)?;
        let report_ref = report_blob.reference().clone();
        rig.append(
            vec![Fact::Cell {
                event: CellEvent::Interrupted {
                    cell,
                    report: report_ref.clone(),
                },
            }],
            vec![report_blob],
        )
        .await?;
        report.children.get_mut(&operation).unwrap().reply = Some(inline_reply(reply));
        let interrupted = CellObservation::Interrupted {
            cell_id: cell,
            report: serde_json::to_value(report)?,
        };
        let parent_return = super::super::effects::publish_return_for_test(
            &driver.state,
            &driver.access,
            &parent,
            ToolSuccess::projected(
                ToolOutput::Cell(Box::new(CellReply {
                    cell,
                    state: CellReplyState::Interrupted { report: report_ref },
                    observation: serde_json::to_value(interrupted)?,
                })),
                DurableToolProjection::Text {
                    text: "fixture interruption".into(),
                },
            )
            .reporting_error(true),
            None,
        )
        .await?;
        let Fact::LocalToolReturned {
            result: parent_result,
            ..
        } = &parent_return
        else {
            return Err("missing parent result".into());
        };
        assert!(
            !String::from_utf8(driver.state.content(run, parent_result.clone()).await?)?
                .contains("shared child evidence")
        );

        let captured = history
            .capture_snapshot(
                CaptureRequest {
                    id: SnapshotId::new(),
                    cut: history.capture().await?,
                },
                stop.clone(),
            )
            .await?;
        let (_destination, root, snapshot) = transfer_snapshot(&captured, owner, &stop).await?;
        let work = driver
            .owner
            .services
            .model_preparation_resources()
            .acquire_work()
            .await?;
        let budget = work.budget();
        let reader = ToolResultReader::snapshot(&snapshot, run, &stop);
        let ToolResultSource::Returned(source) = reader
            .result(&Fact::Cell { event: returned }, &result, budget.clone())
            .await?
        else {
            return Err("missing child return".into());
        };
        let Some(ToolProjectionSource::Json(projection)) = source
            .fields(budget.clone())
            .await?
            .projection(budget.clone())
            .await?
        else {
            return Err("missing child projection".into());
        };
        let projection =
            stream::inspect(&projection.value(budget.clone()).await?, budget.clone()).await?;
        assert!(stream::text_eq(&projection.text()?, &payload, budget.clone()).await?);
        let parent = reader
            .result(&parent_return, parent_result, budget.clone())
            .await?
            .value(budget.clone())
            .await?;
        let operation = operation.to_string();
        let restored = stream::field(
            &parent,
            &[
                "observation",
                "report",
                "children",
                &operation,
                "reply",
                "receipt",
                "outcome",
                "result",
                "value",
            ],
            budget.clone(),
        )
        .await?
        .ok_or("missing original interruption payload")?;
        assert!(stream::text_eq(&restored.text()?, &payload, budget).await?);
        let tree = SourceTree::snapshot(&snapshot).await?;
        let found = tree
            .find_page(
                SourceFind {
                    after: None,
                    query: "shared child evidence".into(),
                    case_sensitive: true,
                    whole_word: false,
                    include_internal: true,
                },
                stop,
            )
            .await?;
        assert_eq!(
            found
                .matches
                .iter()
                .filter(|entry| entry.field == Field::Receipt)
                .count(),
            2
        );
        assert!(
            found
                .matches
                .iter()
                .any(|entry| entry.field == Field::Result)
        );
        root.shutdown().await?;
        Ok::<_, Box<dyn Error + Send + Sync>>(())
    }))
    .catch_unwind()
    .await;
    let cleanup = rig.finish().await;
    assert!(
        matches!(&result, Ok(Ok(Ok(())))),
        "Cell child history regression: {result:?}"
    );
    assert!(cleanup.is_empty(), "fixture cleanup: {cleanup:?}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn executor_history_keeps_message_boundaries_and_tool_results() {
    use maka_agent_facts::executor::{Output, Selection, Settings, ToolResultDetails, TurnUsage};
    let mut rig = Rig::new().unwrap();
    let result = AssertUnwindSafe(tokio::time::timeout(Duration::from_secs(60), async {
        let session = rig.start().await?;
        rig.assemble(&session).await?;
        let driver = rig.driver.as_ref().unwrap();
        let original = driver
            .state
            .frontier(driver.access.execution().run_id)
            .await?;
        let mut spec = original.spec.clone();
        let selection = Selection {
            executor: "external".into(),
            settings: Settings {
                runtime: Some("antigravity".into()),
                ..Settings::default()
            },
        };
        let descriptor = ContentBlob::json(&json!({
            "selection":selection,"import":"fixture","member":0,"basis":"fixture"
        }))?;
        let mut contents = vec![descriptor.clone()];
        for reference in [&spec.input, &spec.system_prompt, &spec.tool_selection] {
            contents.push(ContentBlob::new(
                driver
                    .state
                    .content(original.run, reference.clone())
                    .await?,
            ));
        }
        spec.turn_id = Uuid::new_v4().to_string();
        spec.trigger = Trigger::Message {
            message_id: Uuid::new_v4().to_string(),
        };
        spec.backend = BackendSpec::Executor {
            selection,
            descriptor: descriptor.reference().clone(),
        };
        let admitted = driver
            .state
            .admit(Admission::new(spec, at(), contents))
            .await?;
        let run = admitted.facts[0].run;
        let claim = driver.state.claim(run).await?;
        let task = ExternalTaskId::new();
        let view = driver.state.frontier(run).await?;
        let message_id = "native-reply".to_owned();
        let outputs = [
            Output::MessageStart {
                message_id: message_id.clone(),
            },
            Output::OutputDelta {
                message_id: message_id.clone(),
                text: "Written `tmp_test_fi".into(),
            },
            Output::ToolStart {
                tool_call_id: "read/config".into(),
                name: "run_command".into(),
                input: json!({"CommandLine":"cat config.toml", "toolSummary":"Read configuration"}),
            },
            Output::ToolProgress {
                tool_call_id: "read/config".into(),
                text: "Reading configuration".into(),
            },
            Output::ToolResult {
                tool_call_id: "read/config".into(),
                text: "File not found".into(),
                is_error: true,
                details: Some(ToolResultDetails {
                    exit_code: Some(1),
                    duration_ms: Some(512),
                }),
            },
            Output::ToolStart {
                tool_call_id: "write".into(),
                name: "write_file".into(),
                input: json!({"Path":"tmp_test_file.txt"}),
            },
            Output::ToolResult {
                tool_call_id: "write".into(),
                text: String::new(),
                is_error: false,
                details: None,
            },
            Output::OutputDelta {
                message_id: message_id.clone(),
                text: "le.txt` successfully.".into(),
            },
            Output::ContextUsage(maka_agent_facts::executor::ContextUsage {
                used: 0,
                window: 1_048_576u64.try_into().unwrap(),
                model: Some("test-model".into()),
            }),
            Output::TurnUsage {
                usage: TurnUsage {
                    tokens: maka_agent_facts::model::ModelUsage {
                        input_tokens: Some(150),
                        output_tokens: Some(25),
                        cache_read_tokens: Some(50),
                        cache_write_tokens: Some(25),
                        ..Default::default()
                    },
                    total_tokens: Some(250),
                    duration_ms: Some(700),
                },
            },
            Output::MessageEnd {
                message_id: message_id.clone(),
            },
        ];
        let mut facts =
            [
                Fact::ExternalTaskPrepared {
                    task,
                    descriptor: descriptor.reference().clone(),
                    live_workspace: true,
                },
                Fact::ExternalTaskAdmitted { task },
            ]
            .into_iter()
            .chain(outputs.into_iter().enumerate().map(|(index, output)| {
                Fact::ExternalTaskObserved {
                    task,
                    index: index as u64,
                    model_time_ms: matches!(&output, Output::TurnUsage { .. }).then_some(250),
                    output,
                }
            }));
        driver
            .state
            .append(
                &claim,
                (&view).into(),
                facts
                    .by_ref()
                    .take(5)
                    .map(|fact| Change::new(fact, at()))
                    .collect(),
                vec![],
            )
            .await?;
        let observed = query(&rig, "observe", json!({"sessionId":session})).await?;
        let streaming = live(&rig, &session, wire::Position::Tail).await?;
        let first = streaming["chunks"]
            .as_array()
            .unwrap()
            .iter()
            .find(|chunk| chunk["role"] == "assistant")
            .unwrap();
        assert_eq!(first["text"], "Written `tmp_test_fi");
        assert!(first["finalOutput"].is_null());
        let position: wire::HistoryRowAddress = serde_json::from_value(first["position"].clone())?;
        let active = tools(&streaming);
        assert_eq!(observed["toolSeeds"][0]["toolUseId"], active[0].tool_use_id);
        assert_eq!(
            active[0]
                .call
                .as_ref()
                .unwrap()
                .title
                .as_ref()
                .unwrap()
                .fallback,
            "Read configuration"
        );
        let view = driver.state.frontier(run).await?;
        let end = driver
            .state
            .append(
                &claim,
                (&view).into(),
                facts.map(|fact| Change::new(fact, at())).collect(),
                vec![],
            )
            .await?
            .facts
            .last()
            .unwrap()
            .id;
        let view = driver.state.frontier(run).await?;
        driver
            .state
            .append(
                &claim,
                (&view).into(),
                vec![Change::new(
                    Fact::ExternalTaskClosed {
                        task,
                        outcome: Terminal::Completed,
                        diagnostic: None,
                        final_message: Some(ExternalFinalMessage { message_id, end }),
                    },
                    at(),
                )],
                vec![],
            )
            .await?;
        let observed = query(&rig, "observe", json!({"sessionId":session})).await?;
        assert_eq!(observed["metrics"]["modelId"], "test-model");
        assert_eq!(observed["metrics"]["contextTokens"], 0);
        assert_eq!(observed["metrics"]["contextWindow"], 1_048_576);
        assert_eq!(observed["metrics"]["outputTokensPerSecond"], 100.0);
        assert_eq!(observed["toolSeeds"], json!([]));
        let page = live(&rig, &session, wire::Position::Tail).await?;
        let mut replies = page["chunks"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|chunk| chunk["role"] == "assistant");
        let reply = replies.next().unwrap();
        assert_eq!(reply["position"], first["position"]);
        assert_eq!(reply["messageId"], first["messageId"]);
        assert_eq!(reply["text"], "Written `tmp_test_file.txt` successfully.");
        assert_eq!(reply["finalOutput"], true);
        assert!(replies.next().is_none());
        let body = query(
            &rig,
            "source",
            json!({
                "sessionId":session, "through":page["through"],
                "source":{"kind":"row","position":position}, "field":"body",
                "position":{"kind":"start"}
            }),
        )
        .await?;
        assert_eq!(body["source"]["text"], reply["text"]);
        let displayed = tools(&page);
        let (writes, displayed): (Vec<_>, Vec<_>) = displayed.into_iter().partition(|tool| {
            tool.call
                .as_ref()
                .is_some_and(|call| call.name == "write_file")
        });
        assert_eq!(writes.len(), 2);
        assert!(writes.iter().all(|tool| {
            let call = tool.call.as_ref().unwrap();
            call.title
                .as_ref()
                .is_some_and(|title| title.fallback == "Write file · tmp_test_file.txt")
                && tool.result.as_ref().is_some_and(|result| !result.is_error)
        }));
        let usage = page["chunks"]
            .as_array()
            .unwrap()
            .iter()
            .find_map(|chunk| chunk["timing"].get("executorUsage"))
            .unwrap();
        assert_eq!(usage["totalTokens"], 250);
        assert_eq!(usage["tokens"]["input_tokens"], 225);
        assert_eq!(
            reply["timing"]["promptCache"],
            json!({"inputTokens":225,"readTokens":50})
        );
        assert_eq!(usage["tokens"]["cache_read_tokens"], 50);
        assert!(
            page["chunks"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|chunk| chunk["role"] == "tool_call" || chunk["role"] == "tool_result")
                .all(|chunk| !chunk["tool"].is_null()),
            "executor tool observations never become anonymous rows"
        );
        assert!(
            displayed
                .iter()
                .any(|tool| tool.result.as_ref().is_some_and(|result| result.is_error))
        );
        for tool in &displayed {
            let call = tool.call.as_ref().unwrap();
            assert_eq!(call.name, "run_command");
            assert_eq!(
                call.external_target.as_deref(),
                Some(&wire::ExternalToolTarget::Command {
                    command: "cat config.toml".into(),
                    cwd: None
                }),
            );
            assert_eq!(
                call.title.as_ref().map(|title| title.fallback.as_str()),
                Some("Read configuration")
            );
            assert!(tool.result.as_ref().is_some_and(|result| result.is_error));
            assert_eq!(
                tool.result
                    .as_ref()
                    .unwrap()
                    .details
                    .as_ref()
                    .unwrap()
                    .exit_code,
                Some(1)
            );
            assert_eq!(tool.tool_use_id, displayed[0].tool_use_id);
            assert_eq!(call.position, displayed[0].call.as_ref().unwrap().position);
        }
        Ok::<_, Box<dyn Error + Send + Sync>>(())
    }))
    .catch_unwind()
    .await;
    let cleanup = rig.finish().await;
    assert!(
        matches!(&result, Ok(Ok(Ok(())))),
        "executor tool history regression: {result:?}"
    );
    assert!(cleanup.is_empty(), "fixture cleanup: {cleanup:?}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn continue_run_recovers_across_interrupted_boundaries() -> TestResult<()> {
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::Message as WsMessage;

    const PIXEL_PNG: &str = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

    let mut rig = Rig::new()?;
    let base = rig.directory.path().to_path_buf();
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await?;
    let mut boot = model_recovery::bootstrap(
        &base,
        format!("http://{}/v1", listener.local_addr()?),
        false,
    )
    .await?;
    boot.replay = true;
    model_recovery::attach(&mut rig, &boot).await?;

    let (req_tx, mut req_rx) = tokio::sync::mpsc::channel::<Value>(8);
    let steer_ready = Arc::new(tokio::sync::Notify::new());
    let steer_signal = steer_ready.clone();
    let note_ready = Arc::new(tokio::sync::Notify::new());
    let note_signal = note_ready.clone();
    let stop = CancellationToken::new();
    let ws_stop = stop.clone();
    let server = tokio::spawn(async move {
        let step = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let mut conns = tokio::task::JoinSet::<TestResult<()>>::new();
        loop {
            let (tcp, _) = tokio::select! {
                _ = ws_stop.cancelled() => break,
                accepted = listener.accept() => accepted?,
            };
            let (req_tx, steer_signal, note_signal, ws_stop, step) = (
                req_tx.clone(),
                steer_signal.clone(),
                note_signal.clone(),
                ws_stop.clone(),
                step.clone(),
            );
            conns.spawn(async move {
                let mut ws = tokio_tungstenite::accept_async(tcp).await?;
                loop {
                    let frame = tokio::select! {
                        _ = ws_stop.cancelled() => return Ok(()),
                        frame = ws.next() => frame,
                    };
                    let text = match frame {
                        Some(Ok(WsMessage::Text(text))) => text,
                        Some(Ok(WsMessage::Ping(_) | WsMessage::Pong(_))) => continue,
                        _ => return Ok(()),
                    };
                    let idx = step.fetch_add(1, Ordering::SeqCst);
                    req_tx.send(serde_json::from_str(&text)?).await?;
                    let events = match idx {
                        0 => {
                            for ev in [
                                json!({"type":"response.created","response":{"id":"resp-0"}}),
                                json!({
                                    "type": "response.output_item.done",
                                    "item": {"type":"reasoning","id":"rs-steer","encrypted_content":"enc-steer","summary":[{"type":"summary_text","text":"thinking"}]}
                                }),
                            ] {
                                ws.send(WsMessage::text(ev.to_string())).await?;
                            }
                            steer_signal.notify_one();
                            continue;
                        }
                        1 => {
                            let hold_call = json!({
                                "type": "custom_tool_call",
                                "id": "fc-hold",
                                "call_id": "call-2-hold",
                                "name": "exec",
                                "input": format!(
                                    r#"// @exec: {{"yield_time_ms": 30000}}
image({PIXEL_PNG:?}); text('pixel-ok'); await yield_control();
for (let i = 0; i < 40; i++) {{
  await new Promise((r) => setTimeout(r, 50));
  notify('bg-note');
}}
await new Promise((r) => setTimeout(r, 30000));"#
                                )
                            });
                            vec![
                                json!({"type":"response.created","response":{"id":"r-1"}}),
                                json!({"type":"response.output_item.done","item":hold_call}),
                                json!({"type":"response.completed","response":{"id":"r-1","model":"llama3.2","output":[hold_call],"usage":{"input_tokens":50,"output_tokens":10}}}),
                            ]
                        }
                        2 => {
                            for ev in [
                                json!({"type":"response.created","response":{"id":"r-2"}}),
                                json!({"type":"response.output_item.done","item":{"type":"reasoning","id":"rs-bg-prefix","encrypted_content":"enc-bg","summary":[{"type":"summary_text","text":"bg"}]}}),
                            ] {
                                ws.send(WsMessage::text(ev.to_string())).await?;
                            }
                            tokio::select! {
                                _ = ws_stop.cancelled() => {}
                                _ = note_signal.notified() => {}
                            }
                            return Ok(());
                        }
                        3..=5 => continue,
                        6 => vec![
                            json!({"type":"response.created","response":{"id":"r-5"}}),
                            json!({"type":"response.output_item.done","item":{"type":"reasoning","id":"rs-orphan","encrypted_content":"enc-orphan","summary":[{"type":"summary_text","text":"orphan"}]}}),
                            json!({"type":"response.incomplete","response":{"id":"r-5","model":"llama3.2","incomplete_details":{"reason":"max_output_tokens"},"usage":{"input_tokens":50,"output_tokens":10}}}),
                        ],
                        7 => vec![
                            json!({"type":"response.created","response":{"id":"r-6"}}),
                            json!({"type":"response.output_item.done","item":{"type":"message","id":"m-half","role":"assistant","content":[{"type":"output_text","text":"First half."}]}}),
                            json!({"type":"response.incomplete","response":{"id":"r-6","model":"llama3.2","incomplete_details":{"reason":"max_output_tokens"},"usage":{"input_tokens":50,"output_tokens":10}}}),
                        ],
                        _ => {
                            let msg = json!({"type":"message","id":"m-done","role":"assistant","content":[{"type":"output_text","text":"Second half."}]});
                            vec![
                                json!({"type":"response.created","response":{"id":"r-done"}}),
                                json!({"type":"response.output_item.done","item":msg}),
                                json!({"type":"response.completed","response":{"id":"r-done","model":"llama3.2","output":[msg],"usage":{"input_tokens":60,"output_tokens":10}}}),
                            ]
                        }
                    };
                    for event in events {
                        ws.send(WsMessage::text(event.to_string())).await?;
                    }
                }
            });
        }
        while let Some(joined) = conns.join_next().await {
            let _ = joined?;
        }
        Ok::<_, Box<dyn Error + Send + Sync>>(())
    });

    let phase = std::cell::Cell::new("configure connection and session");
    let result = AssertUnwindSafe(tokio::time::timeout(Duration::from_secs(60), async {
        let client = rig.client.as_ref().ok_or("client missing")?;
        let owner = rig.captured.lock().unwrap().clone().ok_or("owner missing")?;
        let catalog = model_recovery::call(client, "settings", "connections", json!({"kind":"start"})).await?;
        let created_conn = model_recovery::call(client, "settings", "create", json!({
            "expectedCatalogRevision": catalog["revision"],
            "connection": {
                "slug": "replay-same",
                "name": "Replay Same",
                "provider": {"packageId":"maka.providers","entryId":"maka.providers","scope":"profile","name":"ollama"},
                "configuration": {"baseUrl": boot.base_url},
                "enabled": true,
                "enabledModelIds": ["llama3.2"],
                "modelOverrides": {"llama3.2": {"codeMode": true, "vision": true, "apiProtocol": "openai-chat-completions"}}
            }
        })).await?;
        let conn_id = created_conn["connection"]["connectionId"].clone();
        let session_resp = model_recovery::call(client, "agent", "create", json!({
            "title": "Resilient continuation",
            "automaticTitle": false,
            "labels": [],
            "workspace": {"kind": "directory", "path": base.join("workspace")}
        })).await?;
        let session = session_resp["session"]["id"].as_str().ok_or("session missing")?.to_owned();
        let backend = json!({"kind":"model","connectionId":conn_id,"modelId":"llama3.2"});
        let continue_from = |run_id: Value| {
            let (session, conn_id) = (&session, &conn_id);
            async move {
                // A terminal outcome can precede the final durable updates.
                let target = json!({"kind":"run","runId":run_id});
                loop {
                    let readiness = model_recovery::call(client, "agent", "workReadiness", json!({
                        "sessionId":session, "target":target
                    })).await?;
                    match readiness["kind"].as_str() {
                        Some("ready") => break,
                        Some("pending") => tokio::time::sleep(Duration::from_millis(10)).await,
                        _ => return Err(format!("run {run_id} unavailable: {readiness}").into()),
                    }
                }
                let availability = model_recovery::call(client, "agent", "continuationAvailability", json!({
                    "sessionId":session, "runId":run_id
                })).await?;
                assert_eq!(availability["kind"], "ready", "run {run_id}: {availability}");
                let source = &availability["source"];
                assert_eq!(source["runId"], run_id);
                let started = model_recovery::call(client, "agent", "continueRun", json!({
                    "sessionId": session,
                    "sourceRunId": run_id,
                    "sourceHighWater": source["highWater"],
                    "model": {"connectionId": conn_id, "modelId": "llama3.2"}
                })).await?;
                assert_eq!(started["kind"], "started", "continue {run_id}: {started}");
                Ok::<_, Box<dyn Error + Send + Sync>>(started["execution"]["runId"].clone())
            }
        };

        model_recovery::call(client, "agent", "send", json!({
            "sessionId": session,
            "message": "Inspect pixel.",
            "backend": backend
        })).await?;
        phase.set("initial provider request");
        let _ = req_rx.recv().await.ok_or("initial request missing")?;
        steer_ready.notified().await;
        phase.set("persist interrupted reasoning");
        let r1: RunId = loop {
            let obs = model_recovery::call(client, "agent", "observe", json!({"sessionId":session})).await?;
            if !obs["run"]["runId"].is_null() {
                break serde_json::from_value(obs["run"]["runId"].clone())?;
            }
            tokio::task::yield_now().await;
        };
        loop {
            let view = owner.durable.frontier(r1).await?;
            if view.attempts.values().any(|a| a.observed > 0) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        model_recovery::call(client, "agent", "send", json!({
            "sessionId": session,
            "message": "Also verify.",
            "delivery": "steer",
            "backend": backend
        })).await?;
        phase.set("steered provider request");
        let steered_req = req_rx.recv().await.ok_or("steered request missing")?;
        assert!(!steered_req.to_string().contains("rs-steer"), "{steered_req}");
        phase.set("provider request after yielding image");
        let step3_req = req_rx.recv().await.ok_or("post-yield request missing")?;
        assert!(step3_req.to_string().contains("input_image"), "{step3_req}");
        phase.set("persist background notification");
        while owner.durable.cells().notifications(r1, None, 1).await?.is_empty() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        note_ready.notify_one();
        phase.set("provider request after background notification");
        let note_req = req_rx.recv().await.ok_or("post-notification request missing")?;
        let note_text = note_req.to_string();
        assert!(note_text.contains("bg-note"), "{note_text}");
        assert!(!note_text.contains("rs-bg-prefix"), "prefix reasoning leaked before notification: {note_text}");
        model_recovery::call(client, "agent", "stop", json!({"sessionId":session,"runId":r1})).await?;
        phase.set("cancel original run");
        let r1_exec = wait_terminal(client, &session, json!(r1)).await?;
        assert_eq!(r1_exec["state"]["kind"], "cancelled");

        let mut source = r1_exec;
        phase.set("cancel two continued runs");
        for _ in 0..2 {
            let next_id = continue_from(source["runId"].clone()).await?;
            let _ = req_rx.recv().await.ok_or("held continuation request missing")?;
            model_recovery::call(client, "agent", "stop", json!({"sessionId":session,"runId":next_id})).await?;
            source = wait_terminal(client, &session, next_id.clone()).await?;
            assert_eq!(source["state"]["kind"], "cancelled");
            let observed = model_recovery::call(client, "agent", "observe", json!({"sessionId":session})).await?;
            assert_eq!(observed["latestRunId"], next_id);
        }
        assert_eq!(
            model_recovery::call(client, "agent", "continuationAvailability", json!({"sessionId":session,"runId":r1})).await?["kind"],
            "rejected"
        );

        phase.set("continue with the unaccepted image");
        let r4 = continue_from(source["runId"].clone()).await?;
        let req2 = req_rx.recv().await.ok_or("r4 request missing")?;
        let req2_text = req2.to_string();
        assert!(req2_text.contains("input_image"), "unaccepted tool image lost: {req2_text}");
        assert!(req2_text.contains("call-2-hold"), "unaccepted interrupted cell lost: {req2_text}");
        let r4_exec = wait_terminal(client, &session, r4).await?;

        phase.set("continue after orphan reasoning");
        let r5 = continue_from(r4_exec["runId"].clone()).await?;
        let req3 = req_rx.recv().await.ok_or("r5 request missing")?;
        let req3_text = req3.to_string();
        assert!(!req3_text.contains("rs-orphan"), "orphan reasoning leaked: {req3_text}");
        assert!(!req3_text.contains("Continue from where"), "unexpected cue: {req3_text}");
        let r5_exec = wait_terminal(client, &session, r5).await?;

        phase.set("continue after partial output");
        let r6 = continue_from(r5_exec["runId"].clone()).await?;
        let req4 = req_rx.recv().await.ok_or("r6 request missing")?;
        let req4_text = req4.to_string();
        assert!(req4_text.contains("First half."), "{req4_text}");
        assert!(req4_text.contains("Continue from where"), "{req4_text}");
        let r6_exec = wait_terminal(client, &session, r6).await?;
        assert_eq!(r6_exec["state"]["kind"], "completed");
        Ok::<_, Box<dyn Error + Send + Sync>>(())
    }))
    .catch_unwind()
    .await;
    stop.cancel();
    server.await??;
    let cleanup = rig.finish().await;
    assert!(
        matches!(&result, Ok(Ok(Ok(())))),
        "{}: {result:?}",
        phase.get()
    );
    assert!(cleanup.is_empty(), "{cleanup:?}");
    Ok(())
}

async fn wait_terminal(client: &HostClient, session: &str, run_id: Value) -> TestResult<Value> {
    let target = json!({"kind": "run", "runId": run_id});
    loop {
        let work = model_recovery::call(
            client,
            "agent",
            "work",
            json!({"sessionId": session, "target": target}),
        )
        .await?;
        if matches!(
            work["execution"]["state"]["kind"].as_str(),
            Some("completed" | "failed" | "cancelled")
        ) {
            return Ok(work["execution"].clone());
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}
