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

fn model_reader(
    driver: &NativeDriver,
) -> Result<maka_host_runtime::application::NativeRequest, String> {
    driver.owner.services.request_with_work(
        maka_capabilities::call::Identity::Agent {
            execution: driver.access.execution().clone(),
            operation_id: None,
        },
        CancellationToken::new(),
        driver.access.custody().clone(),
    )
}
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
pub(super) async fn suppress_history_quotes(
    rig: &Rig,
    session: &str,
    quotes: &[(u64, usize, &str)],
) -> TestResult<()> {
    use super::model_recovery::call;
    let client = rig.client.as_ref().unwrap();
    let scope = json!({"kind":"personal"});
    let saved = call(
        client,
        "agent",
        "changeMemory",
        json!({"scope":scope,"edit":{"kind":"create","body":quotes[0].2}}),
    )
    .await?;
    let id = saved["id"]
        .as_str()
        .ok_or_else(|| format!("memory creation failed: {saved}"))?;
    let mut revision = saved["revision"].clone();
    for &(sequence, start, quote) in quotes {
        let evidence = query(
            rig,
            "memorySource",
            json!({
                "sessionId": session, "sequence": sequence, "itemIndex": 0,
                "start": start, "end": start + quote.len(), "quote": quote,
            }),
        )
        .await?;
        let added = call(
            client,
            "agent",
            "changeMemory",
            json!({"scope":scope,"edit":{"kind":"add_evidence","id":id,
                "expectedRevision":revision,"assertion":1,"reference":evidence}}),
        )
        .await?;
        revision = added["revision"].clone();
    }
    let deleted = call(
        client,
        "agent",
        "changeMemory",
        json!({"scope":scope,"edit":{"kind":"delete","id":id,"expectedRevision":revision}}),
    )
    .await?;
    assert_eq!(deleted["kind"], "deleted", "{deleted}");
    Ok(())
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
async fn citation_history_keeps_readable_bytes_after_memory_deletion() -> TestResult<()> {
    use maka_agent_engine::ports::Preparation;
    use maka_agent_facts::model::ModelSource;

    let mut rig = Rig::new()?;
    let session = rig.start().await?;
    rig.assemble(&session).await?;
    let (_, attempt, _) = rig.record_model_request(Preparation::Initial).await?;
    let title = "项目旧称";
    let url = "https://example.org/project";
    let original = format!("[{title}]({url})");
    rig.append(
        vec![Fact::ModelObserved {
            attempt,
            index: 0,
            part: ModelPart::Source {
                anchor: None,
                source: ModelSource::Url {
                    id: "citation-1".into(),
                    title: Some(title.into()),
                    url: url.into(),
                    provider_options: None,
                },
            },
            continuation: None,
        }],
        vec![],
    )
    .await?;
    rig.finish_model_request(attempt, None).await?;
    let page = live(&rig, &session, wire::Position::Tail).await?;
    let row = page["chunks"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["text"] == original)
        .ok_or("missing citation")?;
    let position = &row["position"];
    suppress_history_quotes(
        &rig,
        &session,
        &[(position["sequence"].as_u64().unwrap(), 1, title)],
    )
    .await?;
    let driver = rig.driver.as_ref().unwrap();
    let reader = model_reader(driver)?;
    let input = json!({"sessionId": session, "through": page["through"], "view":"conversation",
        "position":{"kind":"row","position":position,"field":"body"}});
    let model_page = crate::service::history::read(
        &driver.owner,
        reader.scope(),
        serde_json::from_value(input)?,
    )
    .await?;
    let expected = original.replace(title, &"*".repeat(title.len()));
    assert!(
        serde_json::to_value(model_page)?["chunks"]
            .as_array()
            .unwrap()
            .iter()
            .any(|chunk| chunk["text"] == expected && chunk["citation"].is_null())
    );
    let input = json!({"sessionId":session,"through":page["through"],"source":{"kind":"row","position":position},
        "field":"body","position":{"kind":"start"}});
    let model_source = crate::service::history::source(
        &driver.owner,
        reader.scope(),
        serde_json::from_value(input)?,
    )
    .await?;
    assert_eq!(
        serde_json::to_value(model_source)?["source"]["text"],
        expected
    );
    assert!(
        live(&rig, &session, wire::Position::Tail).await?["chunks"]
            .as_array()
            .unwrap()
            .iter()
            .any(|r| r["text"] == original)
    );
    reader.finish().await?;
    assert!(rig.finish().await.is_empty());
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn model_reads_independent_bytes_of_a_rejected_tool_result() -> TestResult<()> {
    let mut rig = Rig::new()?;
    let session = rig.start().await?;
    rig.assemble(&session).await?;
    let attempt = rig.attempt().await?;
    let (tool, _) = rig.tool(attempt, "Calendar", "meeting", json!({})).await?;
    let quote = "旧会议";
    let rejection = maka_agent_facts::tool_call::ToolRejection::PreparationFailed {
        message: format!("{} {quote} room is available", "a".repeat(8300)),
    };
    let diagnostic = rejection.to_string();
    let content = ContentBlob::json(&AcceptedToolResult::Rejected {
        diagnostic: diagnostic.clone(),
    })?;
    let written = rig
        .append(
            vec![
                Fact::ToolPreventedBeforeHostAdmission {
                    tool: tool.clone(),
                    rejection,
                },
                Fact::ToolResultAccepted {
                    tool,
                    result: content.reference().clone(),
                    outcome: AcceptedResult::Rejected,
                },
            ],
            vec![content],
        )
        .await?;
    let driver = rig.driver.as_ref().unwrap();
    let history = driver
        .state
        .session_history(driver.owner.run_owner(), session.clone());
    let cut = history.capture().await?;
    let id = written.facts.last().unwrap().id;
    let sequence = history
        .fact_sequence(&cut, driver.access.execution().run_id, id)
        .await?
        .ok_or("missing rejection")?;
    let position = wire::HistoryRowAddress::Live {
        sequence,
        fact: id,
        item_index: 0,
    };
    let start = diagnostic.find(quote).unwrap();
    suppress_history_quotes(&rig, &session, &[(sequence, start, quote)]).await?;
    let reader = model_reader(driver)?;
    let expected = diagnostic.replace(quote, &"*".repeat(quote.len()));
    let result = crate::service::history::source(&driver.owner, reader.scope(), serde_json::from_value(json!({
        "sessionId":session,"through":cut.through_sequence,"source":{"kind":"row","position":position},
        "field":"result","position":{"kind":"after","offset":start}
    }))?).await?;
    assert_eq!(
        serde_json::to_value(result)?["source"]["text"],
        &expected[start..]
    );
    let page = crate::service::history::read_page(&driver.owner, reader.scope(), serde_json::from_value(json!({
        "sessionId":session,"through":cut.through_sequence,"position":{"kind":"row","position":position,"field":"body"}
    }))?).await?;
    assert!(
        serde_json::to_value(page)?["chunks"]
            .as_array()
            .unwrap()
            .iter()
            .any(|row| row["position"]["sequence"] == sequence && row["text"] == expected)
    );
    reader.finish().await?;
    assert!(rig.finish().await.is_empty());
    Ok(())
}

async fn assert_partial_result_pages(
    rig: &Rig,
    session: &str,
    fact: FactId,
    field_start: usize,
    body: &str,
    quote: &str,
) -> TestResult<()> {
    let driver = rig.driver.as_ref().unwrap();
    let history = driver
        .state
        .session_history(driver.owner.run_owner(), session.to_owned());
    let cut = history.capture().await?;
    let sequence = history
        .fact_sequence(&cut, driver.access.execution().run_id, fact)
        .await?
        .ok_or("missing tool return")?;
    let position = wire::HistoryRowAddress::Live {
        sequence,
        fact,
        item_index: 0,
    };
    let start = body.find(quote).unwrap();
    let reader = model_reader(driver)?;
    let read = async |input| -> TestResult<Value> {
        let page = driver
            .owner
            .session_read_tool(serde_json::from_value(input)?, reader.scope())
            .await?;
        Ok(serde_json::to_value(page)?)
    };
    let mut input =
        json!({"sessionId":session, "row":{"through":cut.through_sequence,"position":position}});
    let original = read(input.clone()).await?;
    assert!(
        original["transcript"]["items"]
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item["role"] == "tool_result" && item["resultPath"].is_string())
    );
    suppress_history_quotes(rig, session, &[(sequence, field_start + start, quote)]).await?;
    let expected = body.replace(quote, &"*".repeat(quote.len()));
    let source = crate::service::history::source(&driver.owner, reader.scope(), serde_json::from_value(json!({
        "sessionId":session,"through":cut.through_sequence,"source":{"kind":"row","position":position},
        "field":"result","position":{"kind":"after","offset":start}
    }))?).await?;
    assert_eq!(
        serde_json::to_value(source)?["source"]["text"],
        &expected[start..start + 8192]
    );
    for text in [&expected[..32 * 1024], &expected[32 * 1024..]] {
        let page = read(input).await?;
        let result = page["transcript"]["items"]
            .as_array()
            .unwrap()
            .iter()
            .find(|item| item["role"] == "tool_result")
            .ok_or("missing tool result")?;
        assert_eq!(result["text"], text);
        assert!(
            result.get("resultPath").is_none(),
            "a partially readable result must omit the full archive path"
        );
        input = json!({"sessionId":session,"cursor":page["transcript"]["afterCursor"]});
    }
    reader.finish().await?;
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn child_result_text_uses_its_own_offset_in_the_recall_document() -> TestResult<()> {
    use maka_agent_facts::tool_output::DurableToolProjection;
    let mut rig = Rig::new()?;
    let session = rig.start().await?;
    rig.assemble(&session).await?;
    let (_, attempt, _) = rig
        .record_model_request(maka_agent_engine::ports::Preparation::Initial)
        .await?;
    let quote = "旧事项";
    let body = format!(
        "{} {quote} review the schedule {}",
        "a".repeat(9200),
        "b".repeat(25_000)
    );
    let (_, fact, field_start) = record_background_notice(
        &rig,
        attempt,
        "list ready",
        &body,
        "todo_read",
        Some(DurableToolProjection::Text { text: body.clone() }),
    )
    .await?;
    assert_partial_result_pages(&rig, &session, fact, field_start, &body, quote).await?;
    assert!(rig.finish().await.is_empty());
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn external_return_keeps_the_name_of_its_original_call() -> TestResult<()> {
    use maka_agent_facts::external_effects::{
        ExternalEffectDescriptor, ExternalEffectEvent, ExternalEffectKey, ExternalReturn,
    };
    let mut rig = Rig::new()?;
    let session = rig
        .start_configured(None, |config| {
            config["external"] = json!({"runtimes":{"codex":true}});
        })
        .await?;
    rig.assemble_backend(
        &session,
        Budget {
            tokens: None,
            retries: 0,
            deadline: None,
        },
        false,
        true,
    )
    .await?;
    let driver = rig.driver.as_ref().unwrap();
    let task = ExternalTaskId::new();
    let key = ExternalEffectKey {
        task,
        operation: Uuid::new_v4(),
    };
    let binding = maka_agent_facts::executor::Binding {
        executor_id: "external".to_string().try_into()?,
        package_id: "maka.agent".into(),
        entry_id: "maka.agent".into(),
        activation: "fixture".into(),
    };
    let task_descriptor = ContentBlob::json(&maka_agent_facts::executor::TaskDescriptor {
        protocol: maka_agent_facts::executor::NATIVE_TASK_PROTOCOL.into(),
        source: binding.clone(),
        payload: json!({}),
    })?;
    let name = "calendar_lookup";
    let descriptor = ContentBlob::json(&ExternalEffectDescriptor {
        schema_version: SCHEMA_VERSION,
        protocol: "fixture".into(),
        execution: driver.access.execution().clone(),
        key,
        origin: maka_agent_facts::tool_call::ToolOrigin::External {
            task,
            operation: key.operation,
            package_id: binding.package_id,
            entry_id: binding.entry_id,
            activation: binding.activation,
        },
        operation_id: format!("external:{task}:{}", key.operation),
        name: name.into(),
        input: json!({}),
        definition: ToolDefinition {
            name: name.into(),
            description: "Read schedule".into(),
            input_schema: json!({}),
            provider: None,
            freeform: None,
            output_schema: None,
        },
        catalog_digest: maka_agent_engine::digest(&json!({}))?,
        resources: vec![],
    })?;
    let result = ContentBlob::json(&ExternalReturn::Failure {
        settlement: ToolSettlement::Failed,
        diagnostic: "Monday is unavailable".into(),
    })?;
    rig.append(
        vec![
            Fact::ExternalTaskPrepared {
                task,
                descriptor: task_descriptor.reference().clone(),
                live_workspace: true,
            },
            Fact::ExternalTaskAdmitted { task },
        ],
        vec![task_descriptor],
    )
    .await?;
    rig.append(
        vec![
            Fact::ExternalEffect {
                event: ExternalEffectEvent::Prepared {
                    key,
                    descriptor: descriptor.reference().clone(),
                },
            },
            Fact::ExternalEffect {
                event: ExternalEffectEvent::Admitted {
                    key,
                    approval: None,
                },
            },
        ],
        vec![descriptor],
    )
    .await?;
    let written = rig
        .append(
            vec![
                Fact::ExternalEffect {
                    event: ExternalEffectEvent::CleanupObserved {
                        key,
                        cleanup: OperationCleanup::Confirmed,
                    },
                },
                Fact::ExternalEffect {
                    event: ExternalEffectEvent::Returned {
                        key,
                        output: result.reference().clone(),
                        finish_turn: false,
                    },
                },
            ],
            vec![result],
        )
        .await?;
    let history = driver
        .state
        .session_history(driver.owner.run_owner(), session.clone());
    let cut = history.capture().await?;
    let fact = written.facts.last().unwrap().id;
    let sequence = history
        .fact_sequence(&cut, driver.access.execution().run_id, fact)
        .await?
        .ok_or("missing return")?;
    let position = wire::HistoryRowAddress::Live {
        sequence,
        fact,
        item_index: 0,
    };
    let reader = model_reader(driver)?;
    let (before, _) = driver
        .owner
        .render_session_markdown(&session, Some(cut.through_sequence), reader.scope())
        .await?;
    assert!(
        before.contains("[Tool calendar_lookup · error]"),
        "{before}"
    );
    suppress_history_quotes(&rig, &session, &[(sequence, 0, "Monday")]).await?;
    let source = crate::service::history::source(&driver.owner, reader.scope(), serde_json::from_value(json!({
        "sessionId":session,"through":cut.through_sequence,"source":{"kind":"row","position":position},
        "field":"tool_name","position":{"kind":"start"}
    }))?).await?;
    assert_eq!(serde_json::to_value(source)?["source"]["text"], name);
    let mut context = Vec::new();
    crate::service::history::readable_context_into(
        &history,
        &cut,
        None,
        &mut context,
        &CancellationToken::new(),
    )
    .await?;
    assert!(String::from_utf8(context)?.contains("[tool result]\nToolName: calendar_lookup\n"));
    let transcript = driver
        .owner
        .session_read_tool(
            serde_json::from_value(json!({"sessionId":session, "view":"turns"}))?,
            reader.scope(),
        )
        .await?;
    let transcript = serde_json::to_value(transcript)?;
    let call = transcript["transcript"]["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["role"] == "tool" && entry["toolName"] == name)
        .ok_or("missing call entry")?;
    assert!(
        call["status"].is_null(),
        "a hidden result must not be reported as pending"
    );
    assert!(call["resultPath"].is_null());
    let (markdown, _) = driver
        .owner
        .render_session_markdown(&session, Some(cut.through_sequence), reader.scope())
        .await?;
    assert!(markdown.contains("[Tool calendar_lookup]"), "{markdown}");
    reader.finish().await?;
    assert!(rig.finish().await.is_empty());
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn accepted_provider_json_preserves_independent_bytes_across_pages() -> TestResult<()> {
    let mut rig = Rig::new()?;
    let session = rig.start().await?;
    rig.assemble(&session).await?;
    let attempt = rig.attempt().await?;
    let tool = ToolKey {
        attempt,
        call: "forecast".into(),
    };
    let quote = "旧预报";
    let output = json!({"report": format!("{} {quote} for tomorrow {}", "a".repeat(9200), "b".repeat(25_000))});
    let serialized = serde_json::to_string(&output)?;
    let result = ContentBlob::json(&AcceptedToolResult::Provider {
        output: output.clone(),
        is_error: false,
        provider_options: None,
    })?;
    let written = rig
        .append(
            vec![
                Fact::ModelObserved {
                    attempt,
                    index: 0,
                    continuation: None,
                    part: ModelPart::ToolCall {
                        call: ModelToolCall {
                            id: tool.call.clone(),
                            name: "forecast".into(),
                            input: ToolInput::Json(json!({})),
                            provider_options: None,
                            provider_executed: true,
                        },
                    },
                },
                Fact::ModelObserved {
                    attempt,
                    index: 1,
                    continuation: None,
                    part: ModelPart::ToolResult {
                        id: tool.call.clone(),
                        name: "forecast".into(),
                        output,
                        is_error: false,
                        provider_options: None,
                    },
                },
                Fact::ToolResultAccepted {
                    tool,
                    result: result.reference().clone(),
                    outcome: AcceptedResult::Succeeded,
                },
            ],
            vec![result],
        )
        .await?;
    let fact = written.facts.last().unwrap().id;
    assert_partial_result_pages(&rig, &session, fact, 0, &serialized, quote).await?;
    assert!(rig.finish().await.is_empty());
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn goal_history_masks_the_same_objective_bytes_in_body_and_origin() -> TestResult<()> {
    use maka_agent_facts::{
        input::DeliveredMessage,
        message::{MessageDisposition, MessageOrigin, Placement, RootSourceMessage},
    };
    use maka_goal::goal::{Arm, Pending, Repository};

    let mut rig = Rig::new()?;
    let session = rig.start().await?;
    rig.assemble(&session).await?;
    let driver = rig.driver.as_ref().unwrap();
    let goal_id = Uuid::new_v4();
    let hidden = "旧计划";
    let objective = format!("核对{hidden}和日期");
    let (mut goal, _) = Repository::prepare_arm(
        &session,
        Arm {
            operation_id: goal_id,
            objective: objective.clone(),
            grant: (),
            token_budget: None,
            start: true,
            language: Language::ZH_CN,
        },
        Default::default(),
        None,
        None,
        None,
        Default::default(),
    )?;
    goal.note = "previous checkpoint".into();
    assert!(goal.reserve()?);
    let Some(Pending::Dispatch { request }) = goal.pending else {
        return Err("missing Goal dispatch".into());
    };
    let content = request.content;
    let message = RootSourceMessage {
        message: DeliveredMessage {
            origin: Some(MessageOrigin::Goal {
                goal_id: goal_id.to_string(),
                objective: objective.clone(),
            }),
            message_id: Uuid::new_v4().to_string(),
            submitted_content_digest: content.content_digest()?,
            content: content.clone(),
        },
        unprepared_content: content.clone(),
        submitted_placement: Placement::CurrentTurn,
        disposition: MessageDisposition::TurnStarted,
        submitted_intent: None,
    };
    let input = ContentBlob::json(&RunInput::Message {
        content,
        request_fingerprint: None,
        source_messages: vec![message],
    })?;
    let mut spec = driver
        .state
        .frontier(driver.access.execution().run_id)
        .await?
        .spec;
    spec.turn_id = Uuid::new_v4().to_string();
    spec.trigger = Trigger::Goal { goal_id };
    spec.input = input.reference().clone();
    let admitted = driver
        .state
        .admit(Admission::new(spec, at(), vec![input]))
        .await?;
    let claim = driver.state.claim(admitted.facts[0].run).await?;
    driver
        .state
        .append(
            &claim,
            admitted.head,
            vec![Change::new(
                Fact::RunTerminated {
                    terminal: Terminal::Cancelled,
                    diagnostic: None,
                },
                at(),
            )],
            vec![],
        )
        .await?;
    drop(claim);
    let original = live(&rig, &session, wire::Position::Tail).await?;
    let row = original["chunks"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r["origin"]["objective"] == objective)
        .ok_or("missing Goal row")?;
    let position = &row["position"];
    let sequence = position["sequence"].as_u64().unwrap();
    let body = row["text"].as_str().unwrap();
    let reader = model_reader(driver)?;
    for (quote, expected) in [
        ("previous checkpoint", objective.clone()),
        (hidden, objective.replace(hidden, &"*".repeat(hidden.len()))),
    ] {
        suppress_history_quotes(
            &rig,
            &session,
            &[(sequence, body.find(quote).unwrap(), quote)],
        )
        .await?;
        let page_input = json!({
            "sessionId": session, "through": original["through"], "view": "conversation",
            "position": {"kind": "row", "position": position, "field": "body"}
        });
        let page = crate::service::history::read(
            &driver.owner,
            reader.scope(),
            serde_json::from_value(page_input)?,
        )
        .await?;
        let page = serde_json::to_value(page)?;
        let chunk = page["chunks"]
            .as_array()
            .unwrap()
            .iter()
            .find(|r| &r["position"] == position)
            .ok_or("missing model Goal row")?;
        assert_eq!(chunk["origin"]["objective"], expected);
        assert_eq!(chunk["origin"]["goalId"], goal_id.to_string());
        assert!(!chunk["text"].as_str().unwrap().contains(quote));
        let source_input = json!({
            "sessionId": session, "through": original["through"], "field": "body",
            "source": {"kind": "row", "position": position}, "position": {"kind": "tail"}
        });
        let source = crate::service::history::source(
            &driver.owner,
            reader.scope(),
            serde_json::from_value(source_input)?,
        )
        .await?;
        assert_eq!(
            serde_json::to_value(source)?["source"]["origin"]["objective"],
            expected
        );
    }
    assert!(
        live(&rig, &session, wire::Position::Tail)
            .await?
            .to_string()
            .contains(&objective)
    );
    reader.finish().await?;
    let cleanup = rig.finish().await;
    assert!(cleanup.is_empty(), "{cleanup:?}");
    Ok(())
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
        let shown = "paste did not produce an observable change. The call may still be running; its end was not confirmed.";
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
                        reason,
                    },
                    Fact::RunTerminated {
                        terminal: Terminal::Failed,
                        diagnostic: Some(diagnostic.into()),
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
        assert_eq!(failures, [shown]);

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
        let snapshot_tree = maka_agent_state::session_history::source_tree::SourceTree::snapshot(&snapshot).await?;
        let archived =
            maka_agent_state::session_history::source_tree::HistoryDataSource::Snapshot(snapshot);
        assert_eq!(
            archived.recovery_failure_at(&termination).await?.as_deref(),
            Some(shown)
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
        let receipt = &committed.facts[1];
        let Fact::OperationObserved { reply, .. } = &receipt.fact else {
            return Err("missing observed receipt".into());
        };
        let start = serde_json::to_string(reply)?
            .find(diagnostic)
            .ok_or("missing diagnostic")?;
        let cut = history.capture().await?;
        let at = history
            .fact_sequence(&cut, run, receipt.id)
            .await?
            .ok_or("missing receipt address")?;
        suppress_history_quotes(&rig, &session, &[(at, start, diagnostic)]).await?;
        let page = snapshot_tree.find_page(maka_agent_state::session_history::navigation::SourceFind {
            after: None, query: "evaluate".into(), case_sensitive: true, whole_word: true,
            include_internal: true, mask_evidence: true,
        }, CancellationToken::new()).await?;
        assert!(page.matches.iter().any(|hit| hit.field == maka_agent_state::recall::Field::Receipt
            && matches!(hit.position, wire::HistoryRowAddress::Snapshot {sequence, ..} if sequence == at)
            && hit.preview.contains("evaluate") && !hit.preview.contains(diagnostic)));
        assert!(
            history
                .restricted_archives(vec![termination.recorded.id])
                .await?
                .contains_key(&termination.recorded.id)
        );
        let live = maka_agent_state::session_history::source_tree::HistoryDataSource::Live {
            history,
            cut,
        };
        for data in [live, archived] {
            let model = data.recovery_failure_for_reader(&termination, true).await?;
            assert!(model.is_some_and(|message| !message.contains(diagnostic)));
            assert_eq!(
                data.recovery_failure_at(&termination).await?.as_deref(),
                Some(shown)
            );
        }
        Ok::<_, Box<dyn Error + Send + Sync>>(())
    })
    .catch_unwind()
    .await;
    let cleanup = rig.finish().await;
    assert!(matches!(&result, Ok(Ok(()))), "{result:?}");
    assert!(cleanup.is_empty(), "{cleanup:?}");
}

/// Both kinds of ended call: a local tool that returned OutcomeUnknown and a
/// Host operation whose receipt is Unknown with confirmed cleanup.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ended_calls_with_unknown_results_reach_the_model_and_settle_the_run() {
    use maka_agent_engine::{ports::Preparation, preparation};
    use maka_agent_facts::model::prompt_source::source::{
        MessageRecipe, ToolOutputRecipe, json as stream,
    };
    use maka_agent_state::session_history::tool_result_source::ToolResultReader;
    use maka_plugin_core::operation::{Receipt, RecoveryContract, RecoveryProtocol, RecoveryRef};

    let mut rig = Rig::new().unwrap();
    rig.uncertain_tool = true;
    let result = AssertUnwindSafe(async {
        let session = rig.start().await?;
        rig.assemble(&session).await?;
        let (_, attempt, _) = rig.record_model_request(Preparation::Initial).await?;
        let (local, admitted) = rig
            .tool(attempt, "uncertain_local", "uncertain-1", json!({}))
            .await?;
        let (host, _) = rig.tool(attempt, "Computer", "click-1", json!({})).await?;
        rig.finish_model_request(attempt, None).await?;
        let driver = rig.driver.as_ref().unwrap().clone();
        let run = driver.access.execution().run_id;

        let view = driver.state.frontier(run).await?;
        let prepared = driver
            .prepare_tool(
                &view,
                &view.tools[&tool_key(&local)],
                driver.catalog.clone(),
            )
            .await?;
        let released = Arc::new(AtomicBool::new(false));
        rig.begin(
            prepared.tool.effect,
            admitted,
            local.clone(),
            prepared.source,
            driver.original_effects.clone(),
            released.clone(),
        )?;
        let DispatchOutcome::Recorded { fact } = rig.complete().await? else {
            return Err("an unknown local result must be recorded".into());
        };
        assert!(matches!(
            driver
                .state
                .fact(run, fact)
                .await?
                .map(|recorded| recorded.fact),
            Some(Fact::LocalToolReturned {
                settlement: ToolSettlement::Unknown,
                ..
            })
        ));
        // The call returned, so it holds no resources once its return is durable.
        assert!(released.load(Ordering::SeqCst));

        let owner = view.spec.owner.clone();
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
        // What the engine accepts for each call.
        let local_text = "The call ended, but its result is unknown: the server stopped answering.";
        let host_text = "The call ended, but its result is unknown: the click was not confirmed.";
        let local_result = ContentBlob::json(&AcceptedToolResult::OutcomeUnknown {
            diagnostic: local_text.into(),
        })?;
        let host_result = ContentBlob::json(&AcceptedToolResult::OutcomeUnknown {
            diagnostic: host_text.into(),
        })?;
        let committed = rig
            .append(
                vec![
                    Fact::ToolOriginalBound {
                        tool: host.clone(),
                        reference: reference.clone(),
                    },
                    Fact::OperationObserved {
                        tool: host.clone(),
                        reply: maka_agent_facts::operation::RecordedOperationReply {
                            reference,
                            receipt: Receipt::Recorded {
                                outcome: OperationOutcome::Unknown {
                                    diagnostic: "the click was not confirmed".into(),
                                },
                                cleanup: OperationCleanup::Confirmed,
                            },
                        },
                    },
                    Fact::ToolResultAccepted {
                        tool: local,
                        result: local_result.reference().clone(),
                        outcome: AcceptedResult::OutcomeUnknown,
                    },
                    Fact::ToolResultAccepted {
                        tool: host,
                        result: host_result.reference().clone(),
                        outcome: AcceptedResult::OutcomeUnknown,
                    },
                ],
                vec![local_result.clone(), host_result],
            )
            .await?;

        // The next model request carries both diagnostics as tool errors.
        let (request, _, _) = rig
            .record_model_request(Preparation::ToolContinuation { attempt })
            .await?;
        let frozen: Value =
            serde_json::from_slice(&driver.state.content(run, request.request).await?)?;
        let history = driver.state.session_history(owner, session.clone());
        let cut = history.capture().await?;
        let resources = driver.owner.services.model_preparation_resources();
        let prompt = preparation::restore_prompt(
            preparation::PreparationIo::new(&rig.lease.as_ref().unwrap().store())?,
            resources.clone(),
            &history,
            &cut,
            run,
            &serde_json::from_value(frozen["prompt"].clone())?,
            &serde_json::from_value::<Vec<_>>(frozen["promptChunks"].clone())?,
            &serde_json::from_value(frozen["layout"].clone())?,
            &CancellationToken::new(),
        )
        .await?;
        let work = resources.acquire_work().await?;
        let budget = work.budget();
        let mut sent = Vec::new();
        let mut messages = prompt.recipes().ok_or("prompt recipes missing")?.open(0);
        while let Some(message) = messages.next().await? {
            let MessageRecipe::Tool { content, .. } = message else {
                continue;
            };
            let mut results = content.open(0);
            while let Some(result) = results.next().await? {
                let ToolOutputRecipe::ErrorText(text) = result.output else {
                    continue;
                };
                for expected in [local_text, host_text] {
                    if stream::text_eq(&text, expected, budget.clone()).await? {
                        sent.push(expected);
                    }
                }
            }
        }
        assert_eq!(sent, [local_text, host_text]);

        // History reads the diagnostic, not internal evidence.
        let stop = CancellationToken::new();
        let value = ToolResultReader::live(&history, &cut, run, &stop)
            .result(
                &committed.facts[2].fact,
                local_result.reference(),
                budget.clone(),
            )
            .await?
            .value(budget.clone())
            .await?;
        let shown = stream::inspect(&value, budget.clone()).await?.text()?;
        assert!(stream::text_eq(&shown, local_text, budget).await?);

        // Rebuilt indexes agree with the live projection.
        driver.state.rebuild(run).await?;
        let catalog = driver.owner.canonical_catalog()?;
        catalog.rebuild(session.clone()).await?;
        let record = catalog.record(&session).await?.ok_or("missing session")?;
        assert!(!record.status.unknown_effects, "{:?}", record.status);
        Ok::<_, Box<dyn Error + Send + Sync>>(())
    })
    .catch_unwind()
    .await;
    // A call that still holds its resources keeps cleanup waiting.
    let cleanup = tokio::time::timeout(Duration::from_secs(30), rig.finish()).await;
    assert!(matches!(&result, Ok(Ok(()))), "{result:?}");
    assert!(cleanup.as_ref().is_ok_and(Vec::is_empty), "{cleanup:?}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn failed_execution_preserves_readable_cleanup_diagnostic_text() {
    let mut rig = Rig::new().unwrap();
    let result = AssertUnwindSafe(async {
        let session = rig.start().await?;
        rig.assemble(&session).await?;
        let attempt = rig.attempt().await?;
        let (tool, _) = rig.tool(attempt, "Computer", "cleanup", json!({})).await?;
        let driver = rig.driver.as_ref().unwrap();
        let run = driver.access.execution().run_id;
        let history = driver
            .state
            .session_history(driver.owner.run_owner(), session.clone());
        let observation = query(&rig, "observe", json!({"sessionId":session})).await?;
        let active: crate::contract::Run = serde_json::from_value(observation["run"].clone())?;
        let diagnostic = "Printer unavailable; cleanup pending";
        let committed = rig
            .append(
                vec![
                    Fact::Blocked {
                        blocker: BlockerId::new(),
                        reason: BlockerKind::ToolCleanupUnconfirmed {
                            tool,
                            diagnostic: diagnostic.into(),
                        },
                    },
                    Fact::RunTerminated {
                        terminal: Terminal::Failed,
                        diagnostic: Some(diagnostic.into()),
                    },
                ],
                vec![],
            )
            .await?;
        let cut = history.capture().await?;
        let at = history
            .fact_sequence(&cut, run, committed.facts[1].id)
            .await?
            .ok_or("missing terminal diagnostic")?;
        let reader = model_reader(driver)?;
        for restricted in [false, true] {
            if restricted {
                suppress_history_quotes(&rig, &session, &[(at, 0, "Printer")]).await?;
            }
            let input = crate::contract::ExecutionRead {
                session_id: session.clone(),
                run_id: run,
            };
            let projected =
                serde_json::to_value(driver.owner.execution(input, reader.scope()).await?)?;
            let raw = model_recovery::call(
                rig.client.as_ref().unwrap(),
                "agent",
                "execution",
                json!({"sessionId":session,"runId":run}),
            )
            .await?;
            assert_eq!(
                raw["execution"]["state"]["reason"]["diagnostic"],
                diagnostic
            );
            let state = &projected["execution"]["state"];
            assert_eq!(state["kind"], "failed");
            assert_eq!(state["reason"]["kind"], "tool_cleanup_unconfirmed");
            let expected = if restricted {
                "******* unavailable; cleanup pending"
            } else {
                diagnostic
            };
            assert_eq!(state["reason"]["diagnostic"], expected);
            let overview = driver
                .owner
                .session_run_overview(&session, Some(&active), reader.scope())
                .await?
                .ok_or("missing failed Run overview")?;
            assert_eq!(overview.state, "failed");
            assert!(overview.blockers.is_empty());
            assert_eq!(overview.error.as_deref(), Some(expected));
        }
        use maka_agent_state::session_history::{navigation::SourceFind, source_tree::SourceTree};
        let snapshot = history
            .capture_snapshot(
                CaptureRequest {
                    id: SnapshotId::new(),
                    cut: cut.clone(),
                },
                CancellationToken::new(),
            )
            .await?;
        let page = SourceTree::snapshot(&snapshot)
            .await?
            .find_page(
                SourceFind {
                    after: None,
                    query: "cleanup pending".into(),
                    case_sensitive: true,
                    whole_word: false,
                    include_internal: false,
                    mask_evidence: true,
                },
                CancellationToken::new(),
            )
            .await?;
        assert!(page.matches.iter().any(|hit| hit.field
            == maka_agent_state::recall::Field::FailureMessage
            && hit.preview == "******* unavailable; cleanup pending"));
        reader.finish().await?;
        Ok::<_, Box<dyn Error + Send + Sync>>(())
    })
    .catch_unwind()
    .await;
    let cleanup = rig.finish().await;
    assert!(matches!(result, Ok(Ok(()))), "{result:?}");
    assert!(cleanup.is_empty(), "{cleanup:?}");
}

async fn record_background_notice(
    rig: &Rig,
    first: ModelAttemptId,
    notice_text: &str,
    background_quote: &str,
    child_name: &str,
    projection: Option<maka_agent_facts::tool_output::DurableToolProjection>,
) -> TestResult<(CellId, FactId, usize)> {
    let background = super::bounded_risk::running_cell_with_returned_parent(rig, first).await?;
    rig.finish_model_request(first, None).await?;
    let notice = ContentBlob::json(&CellNotification {
        schema_version: 1,
        body: CellNotificationBody::Text {
            text: notice_text.into(),
        },
    })?;
    let input = ContentBlob::json(&json!({}))?;
    let result = ContentBlob::json(&ToolReturn {
        schema_version: SCHEMA_VERSION,
        artifacts: vec![],
        body: CellReturnedResult {
            output: ToolOutput::Text(background_quote.into()),
            projection,
            is_error: false,
        },
    })?;
    let operation = Uuid::new_v4();
    let returned = CellEvent::LocalChildReturned {
        cell: background,
        operation,
        result: result.reference().clone(),
        is_error: false,
        settlement: ToolSettlement::Returned,
    };
    let completed = ContentBlob::json(&CellObservation::Completed {
        cell_id: background,
        content: vec![],
        result: json!(background_quote),
    })?;
    let committed = rig
        .append(
            vec![
                Fact::Cell {
                    event: CellEvent::VmBound {
                        cell: background,
                        binding: CellVmBinding {
                            runtime: "fixture".into(),
                            version: 1,
                            descriptor: input.reference().clone(),
                        },
                    },
                },
                Fact::Cell {
                    event: CellEvent::ChildPrepared {
                        cell: background,
                        operation,
                        name: child_name.into(),
                        semantics: ToolSemantics::Parallel,
                        input: input.reference().clone(),
                        resources: vec![],
                    },
                },
                Fact::Cell {
                    event: CellEvent::ChildAdmitted {
                        cell: background,
                        operation,
                    },
                },
                Fact::Cell {
                    event: returned.clone(),
                },
                Fact::Cell {
                    event: CellEvent::NotificationQueued {
                        cell: background,
                        notification: FactId::new(),
                        content: notice.reference().clone(),
                    },
                },
                Fact::Cell {
                    event: CellEvent::Completed {
                        cell: background,
                        result: completed.reference().clone(),
                        publication: SessionPublication {
                            values: Default::default(),
                            loaded_tools: None,
                        },
                    },
                },
            ],
            vec![input, result, notice, completed],
        )
        .await?;
    let background_result = committed
        .facts
        .iter()
        .find(|f| {
            matches!(
                f.fact,
                Fact::Cell {
                    event: CellEvent::LocalChildReturned { .. }
                }
            )
        })
        .ok_or("missing child result")?
        .id;
    Ok((
        background,
        background_result,
        serde_json::to_string(&returned)?.len() + 1,
    ))
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn wait_archive_uses_the_observed_cell_at_each_return() -> TestResult<()> {
    let mut rig = Rig::new()?;
    let result = AssertUnwindSafe(check_wait_archive(&mut rig))
        .catch_unwind()
        .await;
    let cleanup = rig.finish().await;
    assert!(matches!(&result, Ok(Ok(()))), "{result:?}");
    assert!(cleanup.is_empty(), "{cleanup:?}");
    Ok(())
}

async fn check_wait_archive(rig: &mut Rig) -> TestResult<()> {
    use maka_agent_engine::ports::Preparation;
    use maka_agent_facts::{
        cells::{CellReply, CellReplyState},
        tool_output::{DurableToolProjection, ReturnedToolResult},
    };

    let session = rig.start().await?;
    rig.assemble(&session).await?;
    let (_, first, _) = rig.record_model_request(Preparation::Initial).await?;
    let (cell, _, _) =
        record_background_notice(rig, first, "update", "history result", "Recall", None).await?;
    let (_, attempt, _) = rig
        .record_model_request(Preparation::Notifications { attempt: first })
        .await?;
    let (wait, _) = rig
        .tool(attempt, "wait", "observe", json!({"cell_id":cell}))
        .await?;
    let driver = rig.driver.as_ref().unwrap();
    let run = driver.access.execution().run_id;
    let view = driver.state.frontier(run).await?;
    let history = driver
        .state
        .session_history(view.spec.owner.clone(), session.clone());
    let maka_agent_facts::cells::CellStatus::Completed { result, .. } = &view.cells[&cell].status
    else {
        return Err("missing cell completion".into());
    };
    let returned = ContentBlob::json(&ToolReturn {
        schema_version: SCHEMA_VERSION,
        artifacts: vec![],
        body: ReturnedToolResult {
            display_budget_chars: None,
            output: ToolOutput::Cell(Box::new(CellReply {
                cell,
                state: CellReplyState::Completed {
                    result: result.clone(),
                },
                observation: Value::Null,
            })),
            projection: DurableToolProjection::Text {
                text: "history result".into(),
            },
            is_error: false,
            loaded_tools: Default::default(),
        },
    })?;
    let accepted = ContentBlob::json(&AcceptedToolResult::Local {
        result: returned.reference().clone(),
    })?;
    let waited = rig
        .append(
            vec![
                Fact::LocalToolReturned {
                    tool: wait.clone(),
                    settlement: ToolSettlement::Returned,
                    result: returned.reference().clone(),
                    is_error: false,
                    cell_observation: Some(result.clone()),
                },
                Fact::ToolResultAccepted {
                    tool: wait,
                    result: accepted.reference().clone(),
                    outcome: AcceptedResult::Succeeded,
                },
            ],
            vec![returned, accepted],
        )
        .await?;
    let records = driver.state.history(run, 0, 128).await?;
    let early = records
        .iter()
        .find(|f| matches!(&f.fact, Fact::ToolResultAccepted { tool, .. } if tool.attempt == first))
        .ok_or("missing parent result")?;
    let restricted = history
        .restricted_archives(vec![early.id, waited.facts[0].id, waited.facts[1].id])
        .await?;
    assert!(!restricted.contains_key(&early.id));
    assert!(waited.facts.iter().all(|f| restricted.contains_key(&f.id)));

    let (started, event) = records
        .iter()
        .find_map(|f| match &f.fact {
            Fact::Cell {
                event: event @ CellEvent::Started { cell: id, .. },
            } if *id == cell => Some((f, event)),
            _ => None,
        })
        .ok_or("missing original source")?;
    let (caller, input) = records
        .iter()
        .find_map(|f| match &f.fact {
            Fact::ModelObserved {
                attempt,
                part: ModelPart::ToolCall { call },
                ..
            } if *attempt == first && call.name == "exec" => Some((f, &call.input)),
            _ => None,
        })
        .ok_or("missing original exec")?;
    let ToolInput::Json(args) = input else {
        return Err("missing exec input".into());
    };
    let cut = history.capture().await?;
    let source_sequence = history
        .fact_sequence(&cut, run, started.id)
        .await?
        .ok_or("missing source address")?;
    let caller_sequence = history
        .fact_sequence(&cut, run, caller.id)
        .await?
        .ok_or("missing caller address")?;
    let caller_address = maka_agent_facts::history::HistoryRowAddress::Live {
        sequence: caller_sequence,
        fact: caller.id,
        item_index: 0,
    };
    let start = serde_json::to_string(event)?.len() + 1;
    suppress_history_quotes(rig, &session, &[(source_sequence, start, "logical")]).await?;
    let spans = history
        .read_restrictions(vec![caller_address.clone()])
        .await?;
    let call_body = format!("exec\n{}", serde_json::to_string(args)?);
    let from = call_body.find("logical").ok_or("missing code literal")? as u64;
    assert_eq!(spans[&caller_address], [(from, from + 7)]);
    Ok(())
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
    let listener = tokio::net::TcpListener::from_std(rig.model_listener.try_clone()?)?;
    let server = MockAiBuilder::new()
        .handler_fn(move |req, _| {
            let _ = request.try_send(req.raw_body.clone());
            TurnPlan::text("The click did not run.").with_response_id("followup")
        })
        .start_with_listener(listener)
        .await?;
    let result = AssertUnwindSafe(tokio::time::timeout(Duration::from_secs(30), async {
        let session = rig.start().await?;
        rig.assemble(&session).await?;
        let (_, first, _) = rig.record_model_request(Preparation::Initial).await?;
        let notice_text = "background child update";
        let background_quote = "background child result";
        let (background_cell, background_result, background_start) = record_background_notice(&rig, first, notice_text, background_quote, "list_files", None).await?;
        let (_, attempt, _) = rig.record_model_request(Preparation::Notifications { attempt: first }).await?;
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
        let child_quote = "hidden-child-argument";
        let input = ContentBlob::json(&json!({"value":child_quote}))?;
        let operation = Uuid::new_v4();
        let child = CellEvent::ChildPrepared {
            cell: rec_cell, operation, name: "write_file".into(),
            semantics: ToolSemantics::Parallel, input: input.reference().clone(), resources: vec![],
        };
        let child_id = FactId::new();
        driver.state.append(
            driver.access.claim(),
            (&view).into(),
            vec![
                Change { id: img_cell.started_fact_id(), at: at(), fact: Fact::Cell { event: CellEvent::Started { cell: img_cell, owner: CellOwner::Agent { link, call: img_tool.call.clone() }, source: src.reference().clone() } } },
                Change { id: rec_cell.started_fact_id(), at: at(), fact: Fact::Cell { event: CellEvent::Started { cell: rec_cell, owner: CellOwner::Agent { link, call: cell_tool.call.clone() }, source: src.reference().clone() } } },
                Change::new(Fact::Cell { event: CellEvent::VmBound { cell: rec_cell, binding: maka_agent_facts::cells::CellVmBinding { runtime: "fixture".into(), version: 1, descriptor: src.reference().clone() } } }, at()),
                Change { id: child_id, at: at(), fact: Fact::Cell { event: child.clone() } },
                Change::new(Fact::Cell { event: CellEvent::ChildRejected { cell: rec_cell, operation, reason: maka_agent_facts::tool_call::RejectionKind::Cancelled, diagnostic:"cancelled".into() } }, at()),
                Change::new(Fact::Cell { event: CellEvent::Interrupted { cell: img_cell, report: interrupted.reference().clone() } }, at()),
                Change::new(Fact::Cell { event: CellEvent::Completed { cell: rec_cell, result: completed.reference().clone(), publication: maka_agent_facts::cells::SessionPublication { values: BTreeMap::new(), loaded_tools: None } } }, at()),
            ],
            vec![src, interrupted, completed, input],
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
        let diagnostic = "App identity did not match. Click was not sent.";
        let receipt = driver
            .state
            .observe(
                run,
                vec![Change::new(
                    observed(OperationOutcome::Returned {
                        result: OperationResult::Failure {
                            diagnostic: diagnostic.into(),
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
        let history = driver.state.session_history(view.spec.owner.clone(), session.clone());
        for restricted in [false, true] {
            if restricted {
                let cut = history.capture().await?;
                let fact = &receipt.facts[0];
                let Fact::OperationObserved { reply, .. } = &fact.fact else {
                    return Err("missing observed diagnostic".into());
                };
                let receipt_at = history.fact_sequence(&cut, run, fact.id).await?.ok_or("missing receipt")?;
                let receipt_start = serde_json::to_string(reply)?.find(diagnostic).ok_or("missing diagnostic")?;
                let child_at = history.fact_sequence(&cut, run, child_id).await?.ok_or("missing child")?;
                let child_start = serde_json::to_string(&child)?.len() + "\nvalue\n".len();
                let background_at = history.fact_sequence(&cut, run, background_result).await?.ok_or("missing background result")?;
                suppress_history_quotes(&rig, &session, &[
                    (receipt_at, receipt_start, diagnostic),
                    (child_at, child_start, child_quote),
                    (background_at, background_start, background_quote),
                ]).await?;
            }
            let publications: Vec<_> = driver.state.history(run,0,128).await?.into_iter().filter(|f|
                matches!(&f.fact,Fact::Cell {event: CellEvent::NotificationQueued { cell,.. }|CellEvent::Completed {cell,..}} if *cell == background_cell)
            ).map(|f| f.id).collect();
            assert_eq!(publications.len(),2);
            let visibility = history.restricted_archives(publications.clone()).await?;
            assert!(publications.iter().all(|id| visibility.contains_key(id) == restricted));
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
                        let text = message["content"].as_str().unwrap_or_default();
                        assert_eq!(text.contains(diagnostic), !restricted, "{message}");
                        Some("failure")
                    } else {
                        None
                    }
                })
                .collect();
            assert_eq!(exchange, ["call", "failure"]);
            let req_text = request.to_string();
            assert!(req_text.contains("image/png"), "local_returned lost to RecoveredCell: {req_text}");
            assert_eq!(req_text.contains(child_quote), !restricted, "{req_text}");
            assert_eq!(req_text.contains(notice_text), !restricted, "{req_text}");
            assert_eq!(req_text.contains(background_quote), !restricted, "{req_text}");
            assert_eq!(req_text.contains("recovered-cell-ok"), !restricted, "{req_text}");
            assert_eq!(req_text.contains(diagnostic), !restricted, "{req_text}");
            model_recovery::completed_message(client, &session, &sent["messageId"]).await?;
        }
        Ok::<_, Box<dyn Error + Send + Sync>>(())
    }))
    .catch_unwind()
    .await;
    server.shutdown().await;
    let cleanup = rig.finish().await;
    assert!(matches!(&result, Ok(Ok(Ok(())))), "{result:?}");
    assert!(cleanup.is_empty(), "{cleanup:?}");
    Ok(())
}

async fn assert_restricted_retry_history(
    rig: &Rig,
    session: &str,
    page: &Value,
    diagnostic: &str,
) -> TestResult<()> {
    use maka_agent_state::session_history::source_tree::HistoryDataSource;
    use maka_capabilities::call::Identity;
    use maka_plugin_core::contract::ServiceTarget;

    let chunks = page["chunks"].as_array().unwrap();
    let sequence = chunks.last().unwrap()["position"]["sequence"]
        .as_u64()
        .unwrap();
    let owner = rig.captured.lock().unwrap().clone().unwrap();
    let driver = rig.driver.as_ref().unwrap();
    let history = driver
        .state
        .session_history(owner.run_owner(), session.to_owned());
    let earlier = history
        .capture_snapshot(
            CaptureRequest {
                id: SnapshotId::new(),
                cut: history.capture_at(sequence - 1).await?,
            },
            CancellationToken::new(),
        )
        .await?;
    suppress_history_quotes(rig, session, &[(sequence, 0, "provider failed")]).await?;

    let target = ServiceTarget::Export {
        name: "agent".into(),
    };
    let reader = owner
        .services
        .select_method(&target, "historyRequests")?
        .request_with_work(
            Identity::Agent {
                execution: driver.access.execution().clone(),
                operation_id: None,
            },
            CancellationToken::new(),
            driver.access.custody().clone(),
        )?;
    for through in [sequence - 1, sequence] {
        let input = json!({"sessionId":session,"through":through,"position":chunks[0]["position"]});
        let user = query(rig, "historyRequests", input.clone()).await?;
        let model = reader
            .call_target(&target, "historyRequests".into(), input, Attachments::new())?
            .await?;
        let requests = model["requests"].as_array().unwrap();
        assert_eq!(requests.len(), 2);
        assert_eq!(user["requests"][1]["finished"]["diagnostic"], diagnostic);
        assert_eq!(requests[0]["finished"]["diagnostic"], diagnostic);
        assert_eq!(
            requests[1]["finished"]["diagnostic"],
            diagnostic.replacen("provider failed", "***************", 1)
        );
    }
    reader.finish().await?;

    let traces = HistoryDataSource::Snapshot(earlier)
        .model_request_traces_for_reader(driver.access.execution().run_id, 0, 24, true)
        .await?;
    assert!(!traces.run_terminated);
    assert_eq!(traces.requests.len(), 2);
    for (i, trace) in traces.requests.into_iter().enumerate() {
        let finished = trace.finished.unwrap();
        let expected = if i == 1 {
            diagnostic.replacen("provider failed", "***************", 1)
        } else {
            diagnostic.to_owned()
        };
        assert_eq!(finished.diagnostic, Some(expected));
    }
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn external_effect_ended_unknown_releases_followup_and_projects_history() -> TestResult<()> {
    use maka_agent_facts::external_effects::{
        ExternalEffectDescriptor, ExternalEffectEvent, ExternalEffectKey,
    };
    use maka_agent_state::{SessionObligation, SessionQuiescence};
    use maka_plugin_core::{
        contract::Transport,
        deployment::DeploymentRef,
        operation::{
            OperationOutcome, OperationReply, Receipt, RecoveryContract, RecoveryProtocol,
            RecoveryRef,
        },
    };

    let mut rig = Rig::new()?;
    let result = AssertUnwindSafe(tokio::time::timeout(Duration::from_secs(30), async {
        let session = rig
            .start_configured(None, |config| {
                config["external"] = json!({"runtimes":{"codex":true}});
            })
            .await?;
        rig.assemble_backend(
            &session,
            Budget {
                tokens: None,
                retries: 0,
                deadline: None,
            },
            false,
            true,
        )
        .await?;
        let driver = rig.driver.as_ref().unwrap().clone();
        let run = driver.access.execution().run_id;
        let owner = driver.owner.run_owner();
        let task = ExternalTaskId::new();
        let key = ExternalEffectKey {
            task,
            operation: Uuid::new_v4(),
        };
        let binding = maka_agent_facts::executor::Binding {
            executor_id: "external".to_string().try_into()?,
            package_id: "maka.agent".into(),
            entry_id: "maka.agent".into(),
            activation: "fixture".into(),
        };
        let task_descriptor = ContentBlob::json(&maka_agent_facts::executor::TaskDescriptor {
            protocol: maka_agent_facts::executor::NATIVE_TASK_PROTOCOL.into(),
            source: binding.clone(),
            payload: json!({}),
        })?;
        let descriptor = ContentBlob::json(&ExternalEffectDescriptor {
            schema_version: SCHEMA_VERSION,
            protocol: "fixture".into(),
            execution: driver.access.execution().clone(),
            key,
            origin: maka_agent_facts::tool_call::ToolOrigin::External {
                task,
                operation: key.operation,
                package_id: binding.package_id,
                entry_id: binding.entry_id,
                activation: binding.activation,
            },
            operation_id: format!("external:{task}:{}", key.operation),
            name: "cua_repl".into(),
            input: json!({"code": "await app.paste('hi')"}),
            definition: ToolDefinition {
                name: "cua_repl".into(),
                description: "Computer Use REPL".into(),
                input_schema: json!({}),
                provider: None,
                freeform: None,
                output_schema: None,
            },
            catalog_digest: maka_agent_engine::digest(&json!({}))?,
            resources: vec![],
        })?;
        let digest = format!("sha256-{}", "d".repeat(64));
        let reference = RecoveryRef {
            source: DeploymentRef {
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
                transport: Transport::Remote,
                digest,
            },
            recovery: RecoveryProtocol::JournalV1,
        };
        let diagnostic =
            "paste did not produce an observable change; inspect the UI before trying another action";
        let observed = |cleanup| Fact::ExternalEffect {
            event: ExternalEffectEvent::Observed {
                key,
                observation: OperationReply {
                    reference: reference.clone(),
                    receipt: Receipt::Recorded {
                        outcome: OperationOutcome::Unknown {
                            diagnostic: diagnostic.into(),
                        },
                        cleanup,
                    },
                },
            },
        };
        rig.append(
            vec![
                Fact::ExternalTaskPrepared {
                    task,
                    descriptor: task_descriptor.reference().clone(),
                    live_workspace: true,
                },
                Fact::ExternalTaskAdmitted { task },
            ],
            vec![task_descriptor],
        )
        .await?;
        let committed = rig.append(
            vec![
                Fact::ExternalEffect {
                    event: ExternalEffectEvent::Prepared {
                        key,
                        descriptor: descriptor.reference().clone(),
                    },
                },
                Fact::ExternalEffect {
                    event: ExternalEffectEvent::Admitted {
                        key,
                        approval: None,
                    },
                },
                Fact::ExternalEffect {
                    event: ExternalEffectEvent::Bound {
                        key,
                        reference: reference.clone(),
                    },
                },
                observed(OperationCleanup::Unconfirmed),
                Fact::Blocked {
                    blocker: BlockerId::new(),
                    reason: BlockerKind::ExternalEffectUnknown {
                        task,
                        operation: key.operation,
                    },
                },
                Fact::ExternalTaskCleanupObserved {
                    task,
                    cleanup: OperationCleanup::Confirmed,
                },
                Fact::RunTerminated {
                    terminal: Terminal::Failed,
                    diagnostic: Some(format!(
                        "{diagnostic}. The call may still be running; its end was not confirmed."
                    )),
                },
            ],
            vec![descriptor],
        )
        .await?;
        let prepared_fact_id = committed.facts[0].id;
        let termination_fact_id = committed.facts.last().unwrap().id;

        let page = live(&rig, &session, wire::Position::Tail).await?;
        let failures: Vec<_> = page["chunks"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|row| row["role"] == "failure")
            .map(|row| row["text"].as_str().unwrap())
            .collect();
        assert_eq!(
            failures,
            [
                "paste did not produce an observable change; inspect the UI before trying another action. The call may still be running; its end was not confirmed."
            ]
        );

        let connection_id = driver
            .owner
            .configuration
            .catalog()
            .await?
            .connections
            .into_iter()
            .next()
            .ok_or("missing fixture model connection")?
            .connection_id;
        let client = rig.client.as_ref().unwrap();
        let message = json!({
            "sessionId": session,
            "message": "Continue after inspecting the UI",
            "backend": {"kind": "model", "connectionId": connection_id, "modelId": "llama3.2"},
            "delivery": "queue",
        });
        let blocked = model_recovery::call(client, "agent", "send", message.clone()).await?;
        assert_eq!(blocked["reason"], "original_operation_unsettled", "{blocked}");
        assert_eq!(
            driver.state.session_quiescence(owner.clone(), session.clone()).await?,
            SessionQuiescence::Busy(SessionObligation::ExternalEffect)
        );
        let revision = driver.owner.mutable_session(&session).await?.revision;
        let blocked_fork = model_recovery::call(
            client,
            "agent",
            "fork",
            json!({"sessionId": session, "expectedRevision": revision, "position": {"kind": "end"}, "title": "Blocked fork", "labels": []}),
        )
        .await?;
        assert_ne!(blocked_fork["kind"], "forked", "unconfirmed external effect must block fork: {blocked_fork}");

        let confirmed = driver
            .state
            .observe(run, vec![Change::new(observed(OperationCleanup::Confirmed), at())], vec![])
            .await?;
        let observed_fact_id = confirmed.facts[0].id;

        assert_eq!(
            driver
                .state
                .frontier(run)
                .await?
                .recovery_failure_diagnostic()
                .as_deref(),
            Some(diagnostic)
        );
        let page = live(&rig, &session, wire::Position::Tail).await?;
        let tool_results: Vec<_> = page["chunks"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|row| row["role"] == "tool_result")
            .collect();
        assert_eq!(tool_results.len(), 1, "{page}");
        assert_eq!(tool_results[0]["tool"]["call"]["name"], "cua_repl");
        assert_eq!(tool_results[0]["tool"]["call"]["pending"], false);
        assert_eq!(tool_results[0]["tool"]["result"]["settlement"], "unknown");
        assert_eq!(tool_results[0]["tool"]["result"]["isError"], true);
        let reader = model_reader(&driver)?;
        let detail = serde_json::to_value(
            crate::service::history::source(
                &driver.owner,
                reader.scope(),
                serde_json::from_value(json!({
                    "sessionId": session,
                    "through": page["through"],
                    "source": {"kind": "row", "position": tool_results[0]["position"]},
                    "field": "result",
                    "position": {"kind": "start"},
                }))?,
            )
            .await?,
        )?;
        reader.finish().await?;
        let expected_text = maka_agent_facts::tool_output::ended_unknown_message(diagnostic);
        assert_eq!(detail["source"]["text"], expected_text);

        // Snapshot projection, Recall search, and Session Fork all succeed after cleanup confirms.
        let history = driver.state.session_history(owner.clone(), session.clone());
        let cut = history.capture().await?;
        let snapshot = history
            .capture_snapshot(
                CaptureRequest {
                    id: SnapshotId::new(),
                    cut: cut.clone(),
                },
                CancellationToken::new(),
            )
            .await?;
        let frozen = serde_json::to_value(
            crate::service::history::snapshot_page(
                &snapshot,
                wire::Position::Tail,
                true,
                wire::HistoryView::Conversation,
                &CancellationToken::new(),
            )
            .await?,
        )?;
        assert!(frozen["chunks"].as_array().unwrap().iter().any(|row| {
            row["role"] == "tool_result" && row["tool"]["result"]["settlement"] == "unknown"
        }));

        let find = |query: &str, mask_evidence: bool| {
            maka_agent_state::session_history::navigation::SourceFind {
                after: None,
                query: query.into(),
                case_sensitive: true,
                whole_word: false,
                include_internal: true,
                mask_evidence,
            }
        };
        let live_tree =
            maka_agent_state::session_history::source_tree::SourceTree::live(&history, &cut)
                .await?;
        let snapshot_tree =
            maka_agent_state::session_history::source_tree::SourceTree::snapshot(&snapshot).await?;
        for tree in [&live_tree, &snapshot_tree] {
            let hits = tree.find_page(find(diagnostic, false), CancellationToken::new()).await?;
            assert!(
                hits.matches.iter().any(|hit| {
                    hit.field == maka_agent_state::recall::Field::Result
                        && hit.preview.contains(diagnostic)
                }),
                "Recall search must find ended-unknown observation (got {} hits)",
                hits.matches.len()
            );
        }

        let revision = driver.owner.mutable_session(&session).await?.revision;
        let forked = model_recovery::call(
            client,
            "agent",
            "fork",
            json!({"sessionId": session, "expectedRevision": revision, "position": {"kind": "end"}, "title": "Fork after ended unknown", "labels": []}),
        )
        .await?;
        assert_eq!(forked["kind"], "forked", "ended-unknown external effect must not block fork: {forked}");

        // Restricting the diagnostic hides it from restricted Recall search, paired archive,
        // RunTerminated failure row, and model recovery diagnostic, while audit readers keep it.
        let obs_seq = history
            .fact_sequence(&cut, run, observed_fact_id)
            .await?
            .ok_or("missing observed sequence")?;
        let term_seq = history
            .fact_sequence(&cut, run, termination_fact_id)
            .await?
            .ok_or("missing termination sequence")?;
        let termination = history
            .item(&cut, term_seq)
            .await?
            .ok_or("missing termination item")?;
        let start = expected_text.find(diagnostic).ok_or("missing diagnostic")?;
        suppress_history_quotes(&rig, &session, &[(obs_seq, start, diagnostic)]).await?;

        for tree in [&live_tree, &snapshot_tree] {
            let leaked = tree.find_page(find(diagnostic, true), CancellationToken::new()).await?;
            assert!(leaked.matches.is_empty(), "restricted Recall search leaked diagnostic");
            let masked = tree
                .find_page(find("The call ended", true), CancellationToken::new())
                .await?;
            assert!(masked.matches.iter().any(|hit| {
                hit.field == maka_agent_state::recall::Field::Result
                    && !hit.preview.contains(diagnostic)
            }));
        }
        let restricted = history
            .restricted_archives(vec![prepared_fact_id, termination_fact_id])
            .await?;
        assert!(restricted.contains_key(&prepared_fact_id), "{restricted:?}");
        assert!(restricted.contains_key(&termination_fact_id), "{restricted:?}");
        let live_source = maka_agent_state::session_history::source_tree::HistoryDataSource::Live {
            history,
            cut,
        };
        let archived_source =
            maka_agent_state::session_history::source_tree::HistoryDataSource::Snapshot(snapshot);
        for data in [live_source, archived_source] {
            let model = data.recovery_failure_for_reader(&termination, true).await?;
            assert!(
                model.as_deref() == Some("The operation outcome is unknown."),
                "restricted recovery diagnostic leaked: {model:?}"
            );
            assert_eq!(
                data.recovery_failure_at(&termination).await?.as_deref(),
                Some(format!(
                    "{diagnostic}. The call may still be running; its end was not confirmed."
                ).as_str())
            );
        }

        assert_eq!(
            driver
                .state
                .session_quiescence(owner.clone(), session.clone())
                .await?,
            SessionQuiescence::Quiescent
        );

        let continued = model_recovery::call(
            client,
            "agent",
            "continueRun",
            json!({
                "sessionId": session,
                "sourceRunId": run,
                "sourceHighWater": driver.state.frontier(run).await?.revision,
                "model": {"connectionId": connection_id, "modelId": "llama3.2"},
            }),
        )
        .await?;
        assert_eq!(continued["reason"], "safety_check_failed", "{continued}");

        let sent = model_recovery::call(client, "agent", "send", message).await?;
        assert_eq!(sent["kind"], "queued", "{sent}");
        Ok::<_, Box<dyn Error + Send + Sync>>(())
    }))
    .catch_unwind()
    .await;
    let cleanup = rig.finish().await;
    assert!(matches!(&result, Ok(Ok(Ok(())))), "{result:?}");
    assert!(cleanup.is_empty(), "{cleanup:?}");
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn history_shows_only_the_final_model_failure() -> TestResult<()> {
    use axum::http::StatusCode;
    use maka_agent_engine::DriverExit;

    for (recover, status) in [
        (true, StatusCode::OK),
        (false, StatusCode::OK),
        (false, StatusCode::SERVICE_UNAVAILABLE),
    ] {
        let mut rig = Rig::new()?;
        let listener = tokio::net::TcpListener::from_std(rig.model_listener.try_clone()?)?;
        let server = MockAiBuilder::new()
            .handler_fn(move |_, ctx| {
                if status == StatusCode::SERVICE_UNAVAILABLE {
                    TurnPlan::http_error(HttpErrorSpec::raw(
                        503,
                        json!({"error":{"message":"example unavailable"}}),
                    ))
                } else if recover && ctx.global_turn > 1 {
                    TurnPlan::text("Recovered after retry.").with_response_id("retry")
                } else {
                    TurnPlan::new()
                        .push_sse_comment("stream ended before completion")
                        .push(TurnEvent::TruncateEof)
                }
            })
            .start_with_listener(listener)
            .await?;
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
            } else if status == StatusCode::SERVICE_UNAVAILABLE {
                (
                    "failure",
                    "provider failed (ProviderUnavailable): example unavailable",
                )
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
            if !recover {
                assert_restricted_retry_history(&rig, &session, &page, last.1).await?;
            }
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
        server.shutdown().await;
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
        let mut usage = Usage::new(100, 5);
        usage.cache_read_tokens = reported;
        let listener = tokio::net::TcpListener::from_std(rig.model_listener.try_clone()?)?;
        let server = MockAiBuilder::new()
            .scripted([TurnPlan::new()
                .with_response_id("cache-reply")
                .push_text("Cached turn.")
                .with_usage(usage)
                .finish(FinishReason::Stop)])
            .start_with_listener(listener)
            .await?;
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
            assert_eq!(reply["timing"]["modelTokens"]["input_tokens"], 100);
            assert_eq!(reply["timing"]["modelTokens"]["output_tokens"], 5);
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
        server.shutdown().await;
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
async fn material_history_preserves_the_original_filename_for_the_user() -> TestResult<()> {
    let mut rig = Rig::new()?;
    let session = rig.start().await?;
    rig.assemble(&session).await?;
    let attempt = rig.attempt().await?;
    let filename = "planning-notes.txt";
    rig.tool_with_display(
        attempt,
        "RecallMaterial",
        "material",
        json!({"session_id":session,"artifact_id":"opaque-id"}),
        ToolDisplay {
            title: Some(format!("Read historical attachment · {filename}")),
            presentation: Some("maka.agent.Builtin@1/RecallMaterial".into()),
        },
    )
    .await?;
    let page = live(&rig, &session, wire::Position::Tail).await?;
    assert!(page.to_string().contains(filename));
    let driver = rig.driver.as_ref().unwrap();
    let reader = model_reader(driver)?;
    let model = crate::service::history::read(
        &driver.owner,
        reader.scope(),
        serde_json::from_value(
            json!({"sessionId":session, "position":{"kind":"tail"},"view":"conversation"}),
        )?,
    )
    .await?;
    let model = serde_json::to_value(model)?;
    let calls = tools(&model);
    assert!(calls.iter().any(|tool| {
        tool.call
            .as_ref()
            .is_some_and(|call| call.name == "RecallMaterial")
    }));
    assert!(!model.to_string().contains(filename));
    reader.finish().await?;
    let cleanup = rig.finish().await;
    assert!(cleanup.is_empty(), "{cleanup:?}");
    Ok(())
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
                mask_evidence: false,
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
            maka_agent_facts::language::Language::EN,
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
                    mask_evidence: false,
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
        let wire::HistoryRowAddress::Live {sequence, ..} = displayed[0].call.as_ref().unwrap().position else {
            return Err("missing live tool start".into());
        };
        let quote = "cat config.toml";
        let arguments = serde_json::to_string(&json!({"CommandLine":quote,"toolSummary":"Read configuration"}))?;
        let start = "run_command\n".len() + arguments.find(quote).unwrap();
        suppress_history_quotes(&rig, &session, &[(sequence, start, quote)]).await?;
        let wire::HistoryRowAddress::Live { sequence: answer_sequence, .. } = position else {
            return Err("missing executor answer".into());
        };
        suppress_history_quotes(&rig, &session, &[(answer_sequence, 0, "Written")]).await?;
        let history = driver.state.session_history(original.spec.owner.clone(), session.clone());
        let cut = history.capture().await?;
        let input = "native wait original read failure";
        let prompt_sequence = page["chunks"].as_array().unwrap().iter()
            .filter(|row| row["role"] == "user" && row["text"] == input)
            .filter_map(|row| row["position"]["sequence"].as_u64()).max().ok_or("missing user input")?;
        suppress_history_quotes(&rig, &session, &[(prompt_sequence, 0, "native wait")]).await?;
        let mut transcript = Vec::new();
        crate::service::history::readable_context_into(
            &history, &cut, Some(original.run), &mut transcript, &CancellationToken::new()
        ).await?;
        let transcript = String::from_utf8(transcript)?;
        assert!(transcript.contains(input), "{transcript}");
        assert!(transcript.contains("Written `tmp_test_file.txt` successfully."), "{transcript}");
        assert!(!transcript.contains(quote));
        let reader = model_reader(driver)?;
        let target = maka_plugin_core::contract::ServiceTarget::Export { name: "agent".into() };
        let navigator = driver.owner.services.select_method(&target, "historyLandmarks")?.request_with_work(
            maka_capabilities::call::Identity::Agent { execution: driver.access.execution().clone(), operation_id: None },
            CancellationToken::new(), driver.access.custody().clone()
        )?;
        let landmarks: Value = navigator.call_target(&target, "historyLandmarks".into(),
            json!({"sessionId":session,"through":page["through"]}), Attachments::new())?.await?;
        assert!(landmarks["landmarks"].as_array().unwrap().iter()
            .any(|entry| entry["label"] == "*********** original read failure"), "{landmarks}");
        navigator.finish().await?;
        let model = crate::service::history::read(
            &driver.owner, reader.scope(),
            serde_json::from_value(json!({"sessionId":session,"position":{"kind":"tail"},"view":"conversation"}))?,
        ).await?;
        let source = crate::service::history::source(&driver.owner, reader.scope(),
            serde_json::from_value(json!({"sessionId":session,"through":page["through"],"source":{"kind":"row","position":position},"field":"body","path":[],"position":{"kind":"start"}}))?).await?;
        assert_eq!(serde_json::to_value(source)?["source"]["text"], "******* `tmp_test_file.txt` successfully.");
        let external_result = &displayed[0].result.as_ref().unwrap().position;
        let source = crate::service::history::source(&driver.owner, reader.scope(),
            serde_json::from_value(json!({"sessionId":session,"through":page["through"],"source":{"kind":"row","position":external_result},"field":"result","position":{"kind":"start"}}))?).await?;
        let source = serde_json::to_value(source)?;
        assert_eq!(source["source"]["text"], "File not found");
        assert!(source["source"]["tool"]["call"].is_null());
        assert!(!source.to_string().contains(quote));
        use maka_agent_state::session_history::{navigation::SourceFind, source_tree::SourceTree};
        let snapshot = history.capture_snapshot(
            CaptureRequest { id: SnapshotId::new(), cut: cut.clone() }, CancellationToken::new()
        ).await?;
        for tree in [SourceTree::live(&history, &cut).await?, SourceTree::snapshot(&snapshot).await?] {
            let names = tree.find_page(SourceFind {
                after: None, query: "run_command".into(), case_sensitive: true, whole_word: true,
                include_internal: false, mask_evidence: true,
            }, CancellationToken::new()).await?;
            assert!(names.matches.iter().any(|hit| hit.field == maka_agent_state::recall::Field::ToolName
                && hit.preview.contains("run_command") && !hit.preview.contains(quote)
                && matches!(hit.position, wire::HistoryRowAddress::Live {sequence: s, ..}
                    | wire::HistoryRowAddress::Snapshot {sequence: s, ..} if s == sequence)));
            let arguments = tree.find_page(SourceFind {
                after: None, query: "Read configuration".into(), case_sensitive: true, whole_word: false,
                include_internal: false, mask_evidence: true,
            }, CancellationToken::new()).await?;
            assert!(arguments.matches.iter().any(|hit| hit.field == maka_agent_state::recall::Field::Arguments
                && hit.preview.contains("Read configuration") && !hit.preview.contains(quote)
                && matches!(hit.position, wire::HistoryRowAddress::Live {sequence: s, ..}
                    | wire::HistoryRowAddress::Snapshot {sequence: s, ..} if s == sequence)));
            for (keyword, expected) in [("Written", false), ("tmp_test_file", true)] {
                let found = tree.find_page(SourceFind {
                    after: None, query: keyword.into(), case_sensitive: true, whole_word: false,
                    include_internal: false, mask_evidence: true,
                }, CancellationToken::new()).await?;
                assert_eq!(!found.matches.is_empty(), expected, "{keyword}");
                assert!(found.matches.iter().all(|hit| !hit.preview.contains("Written")));
            }
            let found = tree.find_page(SourceFind {
                after: None, query: "tmp_test_fi".into(), case_sensitive: true, whole_word: false,
                include_internal: false, mask_evidence: true,
            }, CancellationToken::new()).await?;
            assert!(found.matches.iter().any(|hit| hit.field == maka_agent_state::recall::Field::Body
                && hit.preview.contains("tmp_test_fi") && !hit.preview.contains("Written")));
        }
        let start_row = &displayed[0].call.as_ref().unwrap().position;
        let text_page = crate::service::history::read_page(
            &driver.owner, reader.scope(),
            serde_json::from_value(json!({"sessionId":session,"through":page["through"],
                "position":{"kind":"row","position":start_row,"field":"body"}}))?
        ).await?;
        let text_page = serde_json::to_value(text_page)?;
        let masked_args = arguments.replace(quote, &"*".repeat(quote.len()));
        assert!(text_page["chunks"].as_array().unwrap().iter().any(|row|
            row["position"]["sequence"] == sequence && row["text"] == masked_args));
        let transcript = driver.owner.session_read_tool(serde_json::from_value(json!({"sessionId":session,
            "row":{"through":page["through"],"position":start_row}}))?, reader.scope()).await?;
        assert!(serde_json::to_value(transcript)?["transcript"]["items"].as_array().unwrap().iter().any(|row|
            row["role"] == "tool" && row["text"] == masked_args && row["toolName"].is_null()));
        let args = crate::service::history::source(&driver.owner, reader.scope(),
            serde_json::from_value(json!({"sessionId":session,"through":page["through"],"source":{"kind":"row","position":start_row},
                "field":"arguments","position":{"kind":"start"}}))?).await?;
        assert_eq!(serde_json::to_value(args)?["source"]["text"], masked_args);
        let tool_name = |position: &wire::HistoryRowAddress| serde_json::from_value(json!({
            "sessionId":session,"through":page["through"],"source":{"kind":"row","position":position},
            "field":"tool_name","position":{"kind":"start"}
        }));
        let name = crate::service::history::source(&driver.owner, reader.scope(), tool_name(start_row)?).await?;
        assert_eq!(serde_json::to_value(name)?["source"]["text"], "run_command");
        suppress_history_quotes(&rig, &session, &[(sequence, 0, "run_")]).await?;
        let name = crate::service::history::source(&driver.owner, reader.scope(), tool_name(start_row)?).await?;
        assert_eq!(serde_json::to_value(name)?["source"]["text"], "****command");
        let wire::HistoryRowAddress::Live { sequence: result_seq, .. } = external_result else {
            return Err("missing live executor result".into());
        };
        suppress_history_quotes(&rig, &session, &[(*result_seq, 0, "File")]).await?;
        let source = crate::service::history::source(&driver.owner, reader.scope(),
            serde_json::from_value(json!({"sessionId":session,"through":page["through"],"source":{"kind":"row","position":external_result},"field":"result","position":{"kind":"start"}}))?).await?;
        assert_eq!(serde_json::to_value(source)?["source"]["text"], "**** not found");
        let tree = SourceTree::snapshot(&snapshot).await?;
        let found = tree.find_page(SourceFind {
            after: None, query: "not found".into(), case_sensitive: true, whole_word: false,
            include_internal: false, mask_evidence: true,
        }, CancellationToken::new()).await?;
        assert!(found.matches.iter().any(|hit| hit.field == maka_agent_state::recall::Field::Result
            && hit.preview == "**** not found"));
        reader.finish().await?;
        let model = serde_json::to_value(model)?;
        assert!(!model.to_string().contains(quote));
        let results = tools(&model);
        assert!(results.iter().any(|tool| tool.call.is_none() && tool.result.as_ref().is_some_and(|r| r.is_error)));
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
    const PIXEL_PNG: &str = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

    let mut rig = Rig::new()?;
    let base = rig.directory.path().to_path_buf();
    let (requests, mut resumed) = tokio::sync::mpsc::unbounded_channel();
    let mut server = MockAiBuilder::new()
        .interactive_filtered(8, move |req, ctx| {
            assert_eq!(req.protocol, maka_mock_ai::Protocol::OpenaiResponsesWs);
            // Length-limited replies can trigger another request before the Run reaches terminal.
            let plan = match ctx.global_turn {
                1..=6 => return None,
                7 => TurnPlan::new()
                    .with_response_id("r-5")
                    .push_reasoning_encrypted("orphan", "enc-orphan")
                    .push_flush()
                    .with_usage(Usage::new(50, 10))
                    .finish(FinishReason::Length),
                8 => TurnPlan::new()
                    .with_response_id("r-6")
                    .push_text("First half.")
                    .with_usage(Usage::new(50, 10))
                    .finish(FinishReason::Length),
                _ => TurnPlan::new()
                    .with_response_id("r-done")
                    .push_text("Second half.")
                    .with_usage(Usage::new(60, 10))
                    .finish(FinishReason::Stop),
            };
            let _ = requests.send(req.raw_body.clone());
            Some(plan)
        })
        .start()
        .await?;
    let mut boot = model_recovery::bootstrap(&base, server.base_url(), false).await?;
    boot.replay = true;
    model_recovery::attach(&mut rig, &boot).await?;

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
        let initial = server.next_turn().await.ok_or("initial request missing")?;
        initial.send_plan(
            TurnPlan::new().with_response_id("resp-0")
                .push_reasoning_encrypted("thinking", "enc-steer")
                .push_flush().push(TurnEvent::Stall),
        );
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
        let steered = server.next_turn().await.ok_or("steered request missing")?;
        let steered_req = steered.body().to_string();
        assert!(!steered_req.contains("rs_resp-0_0") && !steered_req.contains("enc-steer"), "{steered_req}");
        let code = format!(r#"// @exec: {{"yield_time_ms": 30000}}
image({PIXEL_PNG:?}); text('pixel-ok'); await yield_control();
for (let i = 0; i < 40; i++) {{
  await new Promise((r) => setTimeout(r, 50));
  notify('bg-note');
}}
await new Promise((r) => setTimeout(r, 30000));"#);
        steered.send_plan(
            TurnPlan::new().with_response_id("r-1")
                .push_custom_tool_call("call-2-hold", "exec", code)
                .with_usage(Usage::new(50, 10)).finish(FinishReason::ToolCalls),
        );
        phase.set("provider request after yielding image");
        let step3 = server.next_turn().await.ok_or("post-yield request missing")?;
        let step3_req = step3.body();
        assert!(step3_req.to_string().contains("input_image"), "{step3_req}");
        step3.set_response_id("r-2");
        step3.reasoning_encrypted("bg", "enc-bg").await;
        step3.flush_item().await;
        phase.set("persist background notification");
        while owner.durable.cells().notifications(r1, None, 1).await?.is_empty() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        step3.drop_connection().await;
        phase.set("provider request after background notification");
        let note_req = server.next_turn().await.ok_or("post-notification request missing")?;
        let note_text = note_req.body().to_string();
        note_req.send_plan(TurnPlan::stall());
        assert!(note_text.contains("bg-note"), "{note_text}");
        assert!(!note_text.contains("rs_r-2_0") && !note_text.contains("enc-bg"), "prefix reasoning leaked before notification: {note_text}");
        model_recovery::call(client, "agent", "stop", json!({"sessionId":session,"runId":r1})).await?;
        phase.set("cancel original run");
        let r1_exec = wait_terminal(client, &session, json!(r1)).await?;
        assert_eq!(r1_exec["state"]["kind"], "cancelled");

        let mut source = r1_exec;
        phase.set("cancel two continued runs");
        for _ in 0..2 {
            let next_id = continue_from(source["runId"].clone()).await?;
            server.next_turn().await.ok_or("held continuation request missing")?.send_plan(TurnPlan::stall());
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
        let req2 = resumed.recv().await.ok_or("r4 request missing")?;
        let req2_text = req2.to_string();
        assert!(req2_text.contains("input_image"), "unaccepted tool image lost: {req2_text}");
        assert!(req2_text.contains("call-2-hold"), "unaccepted interrupted cell lost: {req2_text}");
        let r4_exec = wait_terminal(client, &session, r4).await?;

        phase.set("continue after orphan reasoning");
        let r5 = continue_from(r4_exec["runId"].clone()).await?;
        let req3 = resumed.recv().await.ok_or("r5 request missing")?;
        let req3_text = req3.to_string();
        assert!(!req3_text.contains("rs_r-5_0") && !req3_text.contains("enc-orphan"), "orphan reasoning leaked: {req3_text}");
        assert!(!req3_text.contains("Continue from where"), "unexpected cue: {req3_text}");
        let r5_exec = wait_terminal(client, &session, r5).await?;

        phase.set("continue after partial output");
        let r6 = continue_from(r5_exec["runId"].clone()).await?;
        let req4 = resumed.recv().await.ok_or("r6 request missing")?;
        let req4_text = req4.to_string();
        assert!(req4_text.contains("First half."), "{req4_text}");
        assert!(req4_text.contains("Continue from where"), "{req4_text}");
        let r6_exec = wait_terminal(client, &session, r6).await?;
        assert_eq!(r6_exec["state"]["kind"], "completed");
        Ok::<_, Box<dyn Error + Send + Sync>>(())
    }))
    .catch_unwind()
    .await;
    server.shutdown().await;
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

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn stale_snapshot_derived_indexes_rebuild_on_demand_across_all_read_paths() -> TestResult<()>
{
    use maka_agent_state::{
        recall::{ContextWindow, RecallStore, SearchQuery},
        session_catalog::{
            ControlCommand, ControlEdit, Filter, Position as CatalogPosition, SideQuestions,
        },
        session_history::{
            navigation::SourceFind,
            source_tree::{HistoryDataSource, SourceTree},
        },
    };
    use maka_event_log::{
        StoreError,
        connection::Query,
        sessions::{CatalogFilter, CatalogScope},
        writeback::{Notification, Prepared, Statement},
    };

    struct PoisonSnapshot {
        snapshot: SnapshotId,
        nav_version: Option<i64>,
        catalog_version: Option<i64>,
        inject_phantom: bool,
    }
    impl Statement for PoisonSnapshot {
        type Value = ();
        type Output = ();
        fn execute(self, c: &rusqlite::Connection) -> Result<Prepared<()>, StoreError> {
            let id = self.snapshot.to_string();
            match self.nav_version {
                Some(version) => {
                    c.execute(
                        "UPDATE agent_history_snapshot_nav_heads SET version=? WHERE snapshot=?",
                        rusqlite::params![version, &id],
                    )?;
                }
                None => {
                    c.execute(
                        "DELETE FROM agent_history_snapshot_nav_heads WHERE snapshot=?",
                        [&id],
                    )?;
                }
            }
            if self.inject_phantom {
                c.execute(
                    "UPDATE agent_history_snapshot_nav_documents SET label='STALE_V3_LABEL' WHERE snapshot=?",
                    [&id],
                )?;
                let doc: i64 = c.query_row(
                    "SELECT id FROM agent_history_snapshot_nav_documents WHERE snapshot=? ORDER BY id LIMIT 1",
                    [&id],
                    |r| r.get(0),
                )?;
                c.execute(
                    "INSERT INTO agent_history_snapshot_nav_fields(document,ordinal,field,internal,bytes) VALUES(?,999,'\"body\"',0,22)",
                    [doc],
                )?;
                let chunk: i64 = c.query_row(
                    "INSERT INTO agent_history_snapshot_nav_chunks(document,field_ordinal,ordinal,start,body) VALUES(?,999,0,0,'phantom_v3_stale_token') RETURNING id",
                    [doc],
                    |r| r.get(0),
                )?;
                c.execute(
                    "INSERT INTO agent_history_snapshot_nav_terms(rowid,grams) VALUES(?,?)",
                    rusqlite::params![chunk, "pha han ant nto tom om_ m_v _v3 v3_ 3_s _st sta tal ale le_ e_t _to tok oke ken"],
                )?;
            }
            match self.catalog_version {
                Some(version) => {
                    c.execute(
                        "UPDATE agent_history_snapshot_catalog SET summary_json=json_set(summary_json,'$.version',?) WHERE snapshot=?",
                        rusqlite::params![version, &id],
                    )?;
                }
                None => {
                    c.execute(
                        "DELETE FROM agent_history_snapshot_catalog WHERE snapshot=?",
                        [&id],
                    )?;
                }
            }
            Ok(Prepared {
                value: (),
                changed: true,
                notification: Notification::NONE,
            })
        }
        fn committed(_: ()) {}
        fn isolated_rejection(_: &StoreError) -> bool {
            false
        }
    }

    struct ReadVersions(SnapshotId);
    impl Query for ReadVersions {
        type Output = (Option<i64>, Option<i64>);
        fn execute(self, c: &rusqlite::Connection) -> Result<Self::Output, StoreError> {
            use rusqlite::OptionalExtension;
            let id = self.0.to_string();
            let nav = c
                .query_row(
                    "SELECT version FROM agent_history_snapshot_nav_heads WHERE snapshot=?",
                    [&id],
                    |r| r.get::<_, i64>(0),
                )
                .optional()?;
            let catalog = c
                .query_row(
                    "SELECT json_extract(summary_json,'$.version') FROM agent_history_snapshot_catalog WHERE snapshot=?",
                    [&id],
                    |r| r.get::<_, i64>(0),
                )
                .optional()?;
            Ok((nav, catalog))
        }
    }

    let mut rig = Rig::new()?;
    let base = rig.directory.path().to_path_buf();
    let server = MockAiBuilder::new()
        .scripted(vec![
            TurnPlan::new()
                .push_text("Alpha milestone answer.")
                .with_usage(Usage::new(120, 40)),
            TurnPlan::new()
                .push_text("Beta followup answer.")
                .with_usage(Usage::new(180, 50)),
            TurnPlan::new()
                .push_text("Compacted summary preserving alpha and beta.")
                .with_usage(Usage::new(90, 30)),
        ])
        .start()
        .await?;
    let boot = model_recovery::bootstrap(&base, server.base_url(), false).await?;
    model_recovery::attach(&mut rig, &boot).await?;

    let result = AssertUnwindSafe(tokio::time::timeout(Duration::from_secs(60), async {
        let client = rig.client.as_ref().ok_or("client missing")?;
        let owner = rig.captured.lock().unwrap().clone().ok_or("owner missing")?;
        let writer = owner.store.data_writer()?;
        let run_owner = owner.run_owner();

        let catalog_resp =
            model_recovery::call(client, "settings", "connections", json!({"kind": "start"})).await?;
        let created_conn = model_recovery::call(
            client,
            "settings",
            "create",
            json!({
                "expectedCatalogRevision": catalog_resp["revision"],
                "connection": {
                    "slug": "snapshot-rebuild",
                    "name": "Snapshot Rebuild",
                    "provider": {"packageId":"maka.providers","entryId":"maka.providers","scope":"profile","name":"ollama"},
                    "configuration": {"baseUrl": boot.base_url},
                    "enabled": true,
                    "enabledModelIds": ["llama3.2"],
                    "modelOverrides": {"llama3.2": {"apiProtocol": "openai-chat-completions"}}
                }
            }),
        )
        .await?;
        let conn_id = created_conn["connection"]["connectionId"].clone();
        let backend = json!({"kind": "model", "connectionId": conn_id, "modelId": "llama3.2"});

        // Turn 1 on primary session.
        let primary = model_recovery::call(
            client,
            "agent",
            "create",
            json!({
                "title": "Primary Snapshot Source",
                "automaticTitle": false,
                "labels": [],
                "workspace": {"kind": "directory", "path": base.join("workspace")}
            }),
        )
        .await?["session"]["id"]
            .as_str()
            .ok_or("primary session id missing")?
            .to_owned();
        let sent1 = model_recovery::call(
            client,
            "agent",
            "send",
            json!({"sessionId": primary, "message": "Alpha milestone prompt", "backend": backend}),
        )
        .await?;
        let primary_run: RunId =
            model_recovery::completed_message(client, &primary, &sent1["messageId"]).await?;

        // Fork primary twice: one single-hop fork (forked_peer) and one base (forked_a) for a nested fork.
        let fork_session = |source: &str, title: &str| {
            let owner = owner.clone();
            let source = source.to_owned();
            let title = title.to_owned();
            async move {
                let rev = owner.session(&source).await?.revision;
                let forked = model_recovery::call(
                    client,
                    "agent",
                    "fork",
                    json!({
                        "sessionId": source,
                        "expectedRevision": rev,
                        "position": {"kind": "end"},
                        "title": title,
                        "labels": []
                    }),
                )
                .await?;
                assert_eq!(forked["kind"], "forked", "{forked}");
                Ok::<String, Box<dyn Error + Send + Sync>>(
                    forked["session"]["id"]
                        .as_str()
                        .ok_or("forked session id missing")?
                        .to_owned(),
                )
            }
        };
        let forked_peer = fork_session(&primary, "Forked Peer").await?;
        let forked_a = fork_session(&primary, "Forked Chain Base").await?;

        // Turn 2 + manual compaction on forked_a, then fork forked_a -> forked_nested (S0 -> S1 chain).
        let sent2 = model_recovery::call(
            client,
            "agent",
            "send",
            json!({"sessionId": forked_a, "message": "Beta followup prompt", "backend": backend}),
        )
        .await?;
        model_recovery::completed_message(client, &forked_a, &sent2["messageId"]).await?;
        let compact = model_recovery::call(
            client,
            "agent",
            "compact",
            json!({
                "sessionId": forked_a,
                "model": {"connectionId": conn_id, "modelId": "llama3.2"}
            }),
        )
        .await?;
        let compact_run: RunId = serde_json::from_value(compact["execution"]["runId"].clone())?;
        let compact_exec = wait_terminal(client, &forked_a, json!(compact_run)).await?;
        assert_eq!(compact_exec["state"]["kind"], "completed");
        let forked_nested = fork_session(&forked_a, "Forked Nested").await?;

        // Locate adopted snapshot handles for forked_peer (snap_peer) and forked_nested (s0 -> s1).
        let peer_history = owner.durable.session_history(run_owner.clone(), forked_peer.clone());
        let peer_cut = peer_history.capture().await?;
        let peer_tree = SourceTree::live(&peer_history, &peer_cut).await?;
        let snap_peer = match peer_tree.sources().next().map(|(_, s)| s) {
            Some(HistoryDataSource::Snapshot(s)) => s.clone(),
            _ => return Err("forked_peer must adopt a snapshot".into()),
        };

        let nested_history = owner
            .durable
            .session_history(run_owner.clone(), forked_nested.clone());
        let nested_cut = nested_history.capture().await?;
        let nested_tree = SourceTree::live(&nested_history, &nested_cut).await?;
        let nested_snaps: Vec<_> = nested_tree
            .sources()
            .filter_map(|(_, s)| match s {
                HistoryDataSource::Snapshot(snap) => Some(snap.clone()),
                HistoryDataSource::Live { .. } => None,
            })
            .collect();
        assert_eq!(nested_snaps.len(), 2, "nested fork must carry S0 -> S1");
        let (s0, s1) = (nested_snaps[0].clone(), nested_snaps[1].clone());
        let (expected_nav, expected_cat) = writer.query(ReadVersions(snap_peer.id())).await?;
        assert!(expected_nav.is_some() && expected_cat.is_some());

        // Find the adopted compaction sequence inside s1 for compaction_duration_ms coverage.
        let mut s1_compact_seq = None;
        let mut after = 0;
        loop {
            let page = s1.page(after, 64).await?;
            for item in &page.items {
                if item.recorded.run == compact_run
                    && matches!(item.recorded.fact, Fact::ContextCompacted { .. })
                {
                    s1_compact_seq = Some(item.sequence);
                }
            }
            match page.next {
                Some(next) => after = next,
                None => break,
            }
        }
        let s1_compact_seq = s1_compact_seq.ok_or("compaction fact missing in s1")?;

        let poison_nav = |id: SnapshotId, nav_version: Option<i64>, inject_phantom: bool| {
            let writer = writer.clone();
            async move {
                writer
                    .write(PoisonSnapshot {
                        snapshot: id,
                        nav_version,
                        catalog_version: expected_cat,
                        inject_phantom,
                    })
                    .await
            }
        };
        let poison_cat = |id: SnapshotId, catalog_version: Option<i64>| {
            let writer = writer.clone();
            async move {
                writer
                    .write(PoisonSnapshot {
                        snapshot: id,
                        nav_version: expected_nav,
                        catalog_version,
                        inject_phantom: false,
                    })
                    .await
            }
        };

        // 1. Upgrade-compat path: agent.observe on stale v3 snapshot with phantom v3 FTS/label rows.
        poison_nav(snap_peer.id(), Some(3), true).await?;
        let obs = model_recovery::call(client, "agent", "observe", json!({"sessionId": forked_peer})).await?;
        assert_eq!(obs["session"]["id"], forked_peer, "{obs}");
        assert_eq!(obs["metrics"]["contextTokens"], 160, "{obs}");
        assert_eq!(writer.query(ReadVersions(snap_peer.id())).await?, (expected_nav, expected_cat));
        // Reset must have wiped stale v3 chunks & FTS5 nav_terms and restored clean landmark labels.
        let phantom = peer_tree
            .find_page(
                SourceFind {
                    after: None,
                    query: "phantom_v3_stale_token".into(),
                    case_sensitive: false,
                    whole_word: false,
                    include_internal: true,
                    mask_evidence: false,
                },
                CancellationToken::new(),
            )
            .await?;
        assert!(phantom.matches.is_empty(), "stale v3 FTS chunk survived rebuild: {}", phantom.matches.len());
        let landmarks = peer_tree.landmarks(16, CancellationToken::new()).await?;
        assert_eq!(landmarks.len(), 1);
        assert!(landmarks[0].label.contains("Alpha milestone"), "{}", landmarks[0].label);

        // 2. SessionHistory::metrics with deleted nav_heads row.
        poison_nav(snap_peer.id(), None, false).await?;
        assert!(peer_history.metrics(&peer_cut).await?.is_some());
        assert_eq!(writer.query(ReadVersions(snap_peer.id())).await?.0, expected_nav);

        // 3. SessionHistory::current_model_context.
        poison_nav(snap_peer.id(), Some(3), false).await?;
        assert!(peer_history.current_model_context(&peer_cut).await?.is_some());
        assert_eq!(writer.query(ReadVersions(snap_peer.id())).await?.0, expected_nav);

        // 4. SessionHistory::calibration_sample.
        poison_nav(snap_peer.id(), Some(3), false).await?;
        assert!(peer_history.calibration_sample(&peer_cut).await?.is_some());
        assert_eq!(writer.query(ReadVersions(snap_peer.id())).await?.0, expected_nav);

        // 5. HistoryDataSource::model_request_traces on Snapshot.
        poison_nav(snap_peer.id(), Some(3), false).await?;
        let traces = HistoryDataSource::Snapshot(snap_peer.clone())
            .model_request_traces(primary_run, 0, 24)
            .await?;
        assert!(!traces.requests.is_empty());
        assert_eq!(writer.query(ReadVersions(snap_peer.id())).await?.0, expected_nav);

        // 6. SourceTree::find_page on stale snapshot.
        poison_nav(snap_peer.id(), Some(3), true).await?;
        let found = peer_tree
            .find_page(
                SourceFind {
                    after: None,
                    query: "Alpha milestone".into(),
                    case_sensitive: true,
                    whole_word: false,
                    include_internal: false,
                    mask_evidence: false,
                },
                CancellationToken::new(),
            )
            .await?;
        assert!(!found.matches.is_empty());
        assert_eq!(writer.query(ReadVersions(snap_peer.id())).await?.0, expected_nav);

        // 7. SourceTree::landmarks on stale snapshot.
        poison_nav(snap_peer.id(), Some(3), true).await?;
        let landmarks = peer_tree.landmarks(16, CancellationToken::new()).await?;
        assert!(landmarks.iter().any(|l| l.label.contains("Alpha milestone")));
        assert_eq!(writer.query(ReadVersions(snap_peer.id())).await?.0, expected_nav);

        // 8. Snapshot::terminated on stale snapshot.
        poison_nav(snap_peer.id(), Some(3), false).await?;
        let terminated = snap_peer.terminated(primary_run).await?;
        assert!(matches!(terminated, Some((_, Terminal::Completed))), "{terminated:?}");
        assert_eq!(writer.query(ReadVersions(snap_peer.id())).await?.0, expected_nav);

        // 9. HistoryDataSource::compaction_duration_ms on stale snapshot S1.
        poison_nav(s1.id(), Some(3), false).await?;
        let _elapsed = HistoryDataSource::Snapshot(s1.clone())
            .compaction_duration_ms(compact_run, compact_run, StepId::new(), s1_compact_seq)
            .await?;
        assert_eq!(writer.query(ReadVersions(s1.id())).await?.0, expected_nav);

        // 10. Catalog & Recall peer paths on stale catalog version (multi-snapshot batch in SessionCatalog::page).
        let catalog = owner.canonical_catalog()?;
        poison_cat(snap_peer.id(), Some(1)).await?;
        poison_cat(s1.id(), Some(1)).await?;
        let page = catalog
            .page(
                CatalogScope::Profile,
                None,
                CatalogPosition::Start,
                Filter {
                    base: CatalogFilter {
                        roots_only: false,
                        archived_only: false,
                        include_archived: true,
                    },
                    needs_you_only: false,
                    room: None,
                    side: SideQuestions::Any,
                },
                32,
            )
            .await?;
        assert!(page.sessions.iter().any(|r| r.metadata.id == forked_peer));
        assert!(page.sessions.iter().any(|r| r.metadata.id == forked_nested));
        assert_eq!(writer.query(ReadVersions(snap_peer.id())).await?.1, expected_cat);
        assert_eq!(writer.query(ReadVersions(s1.id())).await?.1, expected_cat);

        // Deleted catalog row on SessionCatalog::record.
        poison_cat(snap_peer.id(), None).await?;
        let peer_rec = catalog.record(&forked_peer).await?.ok_or("missing peer record")?;
        let tail_id = peer_rec
            .last_message
            .as_ref()
            .ok_or("missing peer tail message")?
            .tail_message_id
            .clone();
        assert_eq!(writer.query(ReadVersions(snap_peer.id())).await?.1, expected_cat);

        // SessionCatalog::apply(MarkRead) on stale catalog version.
        poison_cat(snap_peer.id(), Some(1)).await?;
        catalog
            .apply(
                forked_peer.clone(),
                ControlCommand {
                    id: FactId::new(),
                    at: UnixMillis(10_000),
                    expected_revision: peer_rec.control_revision,
                    edit: ControlEdit::MarkRead { message_id: tail_id },
                },
            )
            .await?;
        assert_eq!(writer.query(ReadVersions(snap_peer.id())).await?.1, expected_cat);

        // SessionCatalog::planned_adoption on stale catalog version.
        let primary_history = owner.durable.session_history(run_owner.clone(), primary.clone());
        let primary_cut = primary_history.capture().await?;
        let captured = primary_history
            .capture_snapshot(
                CaptureRequest {
                    id: SnapshotId::new(),
                    cut: primary_cut,
                },
                CancellationToken::new(),
            )
            .await?;
        poison_cat(captured.id(), Some(1)).await?;
        let target_id = format!("{}planned-target", owner.prefix);
        let target_history = owner.durable.session_history(run_owner.clone(), target_id.clone());
        let adopt_op = Uuid::now_v7();
        let input_blob = ContentBlob::json(&json!({"kind": "historical"}))?;
        let mut adopt_spec = snap_peer.run_source(primary_run).await?.spec;
        adopt_spec.session_id = target_id;
        adopt_spec.turn_id = format!("turn-{adopt_op}");
        adopt_spec.origin = maka_agent_facts::durable::RunOrigin::Forked {
            source_run: primary_run,
            source: captured.reference().clone(),
        };
        adopt_spec.trigger = Trigger::HistorySource;
        adopt_spec.backend = BackendSpec::Historical {};
        adopt_spec.input = input_blob.reference().clone();
        let adoption = captured.adopt(
            &target_history,
            adopt_op,
            adopt_spec,
            UnixMillis(20_000),
            vec![input_blob],
        )?;
        let _planned = catalog.planned_adoption(&adoption).await?;
        assert_eq!(writer.query(ReadVersions(captured.id())).await?.1, expected_cat);

        // RecallStore::search & RecallStore::context when a matching session's snapshot catalog is stale.
        let recall = RecallStore::new(writer.clone(), run_owner.clone(), owner.prefix.clone())?;
        poison_cat(snap_peer.id(), Some(1)).await?;
        let search_query = SearchQuery {
            terms: vec!["Forked".into()],
            session_id: None,
            since: None,
            until: None,
            exclude: None,
            limit: None,
        };
        let batch = recall.search(search_query, 0, 0, CancellationToken::new()).await?;
        assert!(batch.titles.iter().any(|r| r.metadata.id == forked_peer));
        assert_eq!(writer.query(ReadVersions(snap_peer.id())).await?.1, expected_cat);

        poison_cat(s1.id(), Some(1)).await?;
        let ctx_query = SearchQuery {
            terms: vec!["Beta".into()],
            session_id: Some(forked_a.clone()),
            since: None,
            until: None,
            exclude: None,
            limit: None,
        };
        let found_beta = recall.search(ctx_query, 0, 0, CancellationToken::new()).await?;
        let anchor_id = found_beta
            .hits
            .first()
            .ok_or("missing Beta recall hit")?
            .anchor
            .message_id
            .clone();
        poison_cat(s0.id(), Some(1)).await?;
        let _ctx = recall
            .context(
                forked_a.clone(),
                anchor_id,
                ContextWindow { before: 1, after: 1 },
                None,
                None,
                CancellationToken::new(),
            )
            .await?;
        assert_eq!(writer.query(ReadVersions(s0.id())).await?.1, expected_cat);

        // 11. Nested snapshot chain S0 -> S1: both stale nav + catalog rebuild bottom-up on observe.
        writer
            .write(PoisonSnapshot {
                snapshot: s0.id(),
                nav_version: Some(3),
                catalog_version: Some(1),
                inject_phantom: true,
            })
            .await?;
        writer
            .write(PoisonSnapshot {
                snapshot: s1.id(),
                nav_version: Some(3),
                catalog_version: Some(1),
                inject_phantom: true,
            })
            .await?;
        let nested_obs = model_recovery::call(
            client,
            "agent",
            "observe",
            json!({"sessionId": forked_nested}),
        )
        .await?;
        assert_eq!(nested_obs["session"]["id"], forked_nested, "{nested_obs}");
        assert_eq!(writer.query(ReadVersions(s0.id())).await?, (expected_nav, expected_cat));
        assert_eq!(writer.query(ReadVersions(s1.id())).await?, (expected_nav, expected_cat));

        // 12. Concurrent cold rebuild across all peer paths on the same stale snapshot.
        poison_nav(snap_peer.id(), Some(3), true).await?;
        let snap_peer_source = HistoryDataSource::Snapshot(snap_peer.clone());
        let (r_metrics, r_ctx, r_cal, r_traces, r_find, r_landmarks, r_term) = tokio::join!(
            peer_history.metrics(&peer_cut),
            peer_history.current_model_context(&peer_cut),
            peer_history.calibration_sample(&peer_cut),
            snap_peer_source.model_request_traces(primary_run, 0, 24),
            peer_tree.find_page(
                SourceFind {
                    after: None,
                    query: "Alpha milestone".into(),
                    case_sensitive: true,
                    whole_word: false,
                    include_internal: false,
                    mask_evidence: false,
                },
                CancellationToken::new(),
            ),
            peer_tree.landmarks(16, CancellationToken::new()),
            snap_peer.terminated(primary_run),
        );
        assert!(r_metrics?.is_some());
        assert!(r_ctx?.is_some());
        assert!(r_cal?.is_some());
        assert!(!r_traces?.requests.is_empty());
        assert!(!r_find?.matches.is_empty());
        assert!(!r_landmarks?.is_empty());
        assert!(matches!(r_term?, Some((_, Terminal::Completed))));
        assert_eq!(writer.query(ReadVersions(snap_peer.id())).await?, (expected_nav, expected_cat));

        // 13. Cancelled cold rebuild does not seal a stale snapshot, and a subsequent read succeeds.
        poison_nav(snap_peer.id(), Some(3), false).await?;
        let cancelled = CancellationToken::new();
        cancelled.cancel();
        let err = peer_tree
            .find_page(
                SourceFind {
                    after: None,
                    query: "Alpha milestone".into(),
                    case_sensitive: true,
                    whole_word: false,
                    include_internal: false,
                    mask_evidence: false,
                },
                cancelled,
            )
            .await
            .err()
            .ok_or("cancelled find_page must fail")?;
        assert!(err.to_string().contains("cancelled"), "{err}");
        assert_eq!(writer.query(ReadVersions(snap_peer.id())).await?.0, Some(3));
        let after_cancel = peer_tree
            .find_page(
                SourceFind {
                    after: None,
                    query: "Alpha milestone".into(),
                    case_sensitive: true,
                    whole_word: false,
                    include_internal: false,
                    mask_evidence: false,
                },
                CancellationToken::new(),
            )
            .await?;
        assert!(!after_cancel.matches.is_empty());
        assert_eq!(writer.query(ReadVersions(snap_peer.id())).await?.0, expected_nav);

        Ok::<_, Box<dyn Error + Send + Sync>>(())
    }))
    .catch_unwind()
    .await;
    server.shutdown().await;
    let cleanup = rig.finish().await;
    assert!(matches!(&result, Ok(Ok(Ok(())))), "{result:?}");
    assert!(cleanup.is_empty(), "{cleanup:?}");
    Ok(())
}
