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
        let frozen_child = tools(&serde_json::to_value(snapshot)?)
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
    use maka_agent_state::session_history::tool_result_source::{
        ToolProjectionSource, ToolResultReader, ToolResultSource,
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
            method: "write".into(),
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
                Fact::ToolOriginalBound { tool: tool.clone(), reference },
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
        let exported = captured.export(tempfile::tempfile()?).await?;
        let destination = tempfile::tempdir()?;
        let base = destination.path();
        let root = RootOwner::create(
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
        let root = RootStore::open(Arc::new(root), &migrations).await?;
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

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn executor_progress_and_failed_result_keep_the_original_call() {
    use maka_agent_facts::executor::{Output, Selection, Settings};
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
        let descriptor = ContentBlob::json(&json!({"fixture":"executor"}))?;
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
            selection: Selection {
                executor: "fixture".into(),
                settings: Settings::default(),
            },
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
        let outputs = [
            Output::ToolStart {
                tool_call_id: "read/config".into(),
                name: "Read configuration".into(),
                input: json!({"path":"config.toml"}),
            },
            Output::ToolProgress {
                tool_call_id: "read/config".into(),
                text: "Reading configuration".into(),
            },
            Output::ToolResult {
                tool_call_id: "read/config".into(),
                text: "File not found".into(),
                is_error: true,
            },
        ];
        let facts =
            [
                Fact::ExternalTaskPrepared {
                    task,
                    descriptor: descriptor.reference().clone(),
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
                facts.map(|fact| Change::new(fact, at())).collect(),
                vec![],
            )
            .await?;
        let page = live(&rig, &session, wire::Position::Tail).await?;
        let displayed = tools(&page);
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
            assert_eq!(
                tool.call.as_ref().map(|call| call.name.as_str()),
                Some("Read configuration")
            );
            assert!(tool.result.as_ref().is_some_and(|result| result.is_error));
            assert_eq!(tool.tool_use_id, displayed[0].tool_use_id);
            assert_eq!(
                tool.call.as_ref().unwrap().position,
                displayed[0].call.as_ref().unwrap().position
            );
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
