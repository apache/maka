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
