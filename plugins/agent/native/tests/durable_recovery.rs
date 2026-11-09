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

#[path = "support/cold_host.rs"]
mod cold_host;
#[path = "../../engine/tests/integration/support/native.rs"]
mod native;

use axum::{
    Router, body::Bytes, extract::State, http::header, response::IntoResponse, routing::post,
};
use cold_host::{ColdHost, Result};
use futures_util::{FutureExt, future::BoxFuture};
use maka_agent_api::{
    Configuration,
    contract::{BackendPreference, SendResult},
};
use maka_agent_facts::{
    artifact::ToolReturn,
    durable::{ContentRef, Fact, RecordedFact, RunId, StepId, Terminal, ToolDecision, ToolKey},
    model::ModelPart,
    tool_output::{AcceptedToolResult, DurableToolProjection, ReturnedToolResult, ToolOutput},
};
use maka_agent_state::{Store, queue::MessageResolution};
use maka_event_log::{
    StoreError,
    applications::intents::CallerIntent,
    connection::Query,
    root_store::RootStore,
    writeback::{Notification, Prepared, Statement},
};
use maka_host_runtime::application::{
    Context, Handler, HandlerError, HandlerResult, HandlerValue, NativeOwner,
};
use maka_plugin_core::{
    contract::{Contract, Interface, Method, MethodMode, Transport},
    operation::{
        OperationCleanup, OperationOutcome, OperationReply, OperationResult, Receipt, RecoveryRef,
    },
};
use native::{FixtureService, NativeFixture};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    net::SocketAddr,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    sync::mpsc,
};

const CALL: &str = "counter-original-call";
const QUESTION: &str = "Perform the counter mutation once, then report its original receipt.";
const ANSWER: &str = "Recovered the original counter receipt without repeating the effect.";

fn arguments() -> Value {
    json!({"amount":7,"label":"original π\nline\u{0}tail"})
}
fn result_value() -> Value {
    json!({"receipt":"external-counter:1","input":arguments()})
}

#[derive(Serialize, Deserialize)]
struct Boot {
    directory: PathBuf,
    workspace: PathBuf,
    http: SocketAddr,
    phase: Phase,
}
#[derive(Serialize, Deserialize)]
enum Phase {
    First,
    Recover(Box<Boundary>),
    CellFirst,
    CellRecover(Box<cell_composite::Boundary>),
    CellReopen(Box<cell_composite::Reconciled>),
    CellUnknownFirst,
    CellUnknownRecover(Box<cell_composite::UnknownBoundary>),
    CellUnknownReopen(Box<cell_composite::Unresolved>),
    PythonFirst,
    PythonRecover(Box<cell_composite::Boundary>),
    PythonReopen(Box<cell_composite::Reconciled>),
    StopFirst,
    StopRecover(Box<cell_composite::StopBoundary>),
    StopReopen(Box<cell_composite::StoppedEvidence>),
    GoalFirst(goal_budget::Usage),
    GoalMiddle(Box<goal_budget::Boundary>),
    GoalLast(Box<goal_budget::Boundary>),
    FutureFirst,
    FutureRead(Box<cell_composite::FutureBoundary>),
    PackageInstall(Box<cell_composite::UnknownBoundary>),
    PackageRecover(Box<cell_composite::PackageBoundary>),
}
#[derive(Clone, Debug, Serialize, Deserialize)]
struct FrozenBytes {
    reference: ContentRef,
    bytes: Vec<u8>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
struct Boundary {
    session: String,
    run: RunId,
    step: StepId,
    tool: ToolKey,
    facts: Vec<RecordedFact>,
    blobs: Vec<FrozenBytes>,
    intent: CallerIntent,
    reply: OperationReply,
    sdk: SdkRecord,
}
#[derive(Serialize, Deserialize)]
struct Recovered {
    run: RunId,
    step: StepId,
    tool: ToolKey,
    reply: OperationReply,
    returned: ContentRef,
    returned_bytes: Vec<u8>,
}

/// The fault lives on the real Root writer, not on a second SQLite connection.
/// TEMP makes it disappear only when the first Host's process/connection dies.
struct HoldAgentT2;
impl Statement for HoldAgentT2 {
    type Value = ();
    type Output = ();
    fn execute(
        self,
        connection: &rusqlite::Connection,
    ) -> std::result::Result<Prepared<()>, StoreError> {
        connection.execute_batch(
            "CREATE TEMP TRIGGER durable_recovery_hold_t2 BEFORE INSERT ON agent_facts
             WHEN json_extract((SELECT payload FROM contents WHERE id=NEW.body_content_id),
                               '$.fact.kind')='operation_observed'
             BEGIN SELECT RAISE(ABORT,'cold Host fixture holds original Agent T2'); END;",
        )?;
        Ok(Prepared {
            value: (),
            changed: true,
            notification: Notification::NONE,
        })
    }
    fn committed((): ()) {}
    fn isolated_rejection(_: &StoreError) -> bool {
        false
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
struct SdkRecord {
    request: Vec<u8>,
    outcome: Vec<u8>,
    result: Vec<u8>,
    cleanup: Vec<u8>,
}
struct OriginalRecord(RecoveryRef);
impl Query for OriginalRecord {
    type Output = SdkRecord;
    fn execute(
        self,
        connection: &rusqlite::Connection,
    ) -> std::result::Result<SdkRecord, StoreError> {
        Ok(connection.query_row(
            "SELECT CAST(o.request_json AS BLOB),CAST(o.outcome_json AS BLOB),
                    c.payload,CAST(o.cleanup_json AS BLOB)
             FROM application_operations o JOIN contents c ON c.id=o.outcome_content_id
             WHERE o.deployment=?1 AND o.namespace=?2 AND o.operation=?3",
            rusqlite::params![
                self.0.source.deployment.to_string(),
                serde_json::to_string(&self.0.namespace)?,
                self.0.operation.to_string(),
            ],
            |row| {
                Ok(SdkRecord {
                    request: row.get(0)?,
                    outcome: row.get(1)?,
                    result: row.get(2)?,
                    cleanup: row.get(3)?,
                })
            },
        )?)
    }
}

struct Counter {
    http: SocketAddr,
    entered: mpsc::UnboundedSender<RecoveryRef>,
    expected: Value,
}
impl Handler for Counter {
    fn call(
        &self,
        method: String,
        input: Value,
        context: Context,
    ) -> BoxFuture<'static, HandlerResult> {
        assert_eq!(method, "increment");
        assert_eq!(input, self.expected);
        let reference = context
            .operation()
            .expect("the effect needs a real SDK mutation claim")
            .clone();
        self.entered
            .send(reference.clone())
            .expect("worker owns the original-reference observer");
        let http = self.http;
        Box::pin(async move {
            let value = external_effect(http, &reference, input)
                .await
                .map_err(|error| HandlerError::Unknown {
                    diagnostic: error.to_string(),
                })?;
            Ok(HandlerValue::Json(value))
        })
    }
}
impl NativeOwner for Counter {
    fn close(&self) -> BoxFuture<'static, std::result::Result<(), String>> {
        Box::pin(async { Ok(()) })
    }
}
fn service(http: SocketAddr, entered: mpsc::UnboundedSender<RecoveryRef>) -> FixtureService {
    FixtureService::new(
        Contract {
            name: "fixture.ColdCounter".into(),
            version: 1,
            transport: Transport::Remote,
            interface: Interface::Service {
                methods: BTreeMap::from([(
                    "increment".into(),
                    Method {
                        mode: MethodMode::Mutation,
                        input: json!({"type":"object","required":["amount","label"],"properties":{
                "amount":{"type":"integer"},"label":{"type":"string"}
            },"additionalProperties":false})
                        .into(),
                        output: json!({"type":"object"}).into(),
                        resources: BTreeMap::new(),
                        progress: None,
                    },
                )]),
            },
        },
        Arc::new(Counter {
            http,
            entered,
            expected: arguments(),
        }),
    )
}
fn configuration(workspace: &Path) -> Configuration {
    serde_json::from_value(json!({
        "locale":"en", "workspaceRoots":[{"label":"Owned fixture workspace","path":workspace}],
        "permissions":{"access":"workspace_write","requestPermissions":false},
        "tools":[{
            "name":"counter","description":"Record one external counter receipt.",
            "method":"increment","nestable":true,
            "target":{"kind":"import","name":"fixture"},"result":"json","confirmation":"preapproved"
        }]
    }))
    .expect("public Native configuration")
}

async fn external_effect(http: SocketAddr, reference: &RecoveryRef, input: Value) -> Result<Value> {
    let body = serde_json::to_vec(&json!({"reference":reference,"input":input}))?;
    let mut socket = TcpStream::connect(http).await?;
    socket.write_all(format!(
        "POST /effect HTTP/1.1\r\nHost: {http}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    ).as_bytes()).await?;
    socket.write_all(&body).await?;
    let mut response = Vec::new();
    socket.read_to_end(&mut response).await?;
    let boundary = response
        .windows(4)
        .position(|bytes| bytes == b"\r\n\r\n")
        .ok_or("external counter response has no HTTP header terminator")?
        + 4;
    assert!(response.starts_with(b"HTTP/1.1 200 "));
    Ok(serde_json::from_slice(&response[boundary..])?)
}

async fn delivered(state: &Store, session: &str, accepted: SendResult) -> Result<RunId> {
    let message = match accepted {
        SendResult::Started { run_id, .. } => return Ok(run_id),
        SendResult::Queued { message_id, .. } => message_id,
        _ => return Err("the actual send did not admit the original message".into()),
    };
    let mut changes = state.subscribe()?;
    loop {
        changes.borrow_and_update();
        match state
            .queue()
            .resolve_message(session.into(), message.clone())
            .await?
        {
            MessageResolution::Delivered { run, shared: false } => return Ok(run),
            MessageResolution::Pending => changes.changed().await?,
            other => {
                return Err(format!("original message was not delivered once: {other:?}").into());
            }
        }
    }
}

async fn history(state: &Store, run: RunId) -> Result<Vec<RecordedFact>> {
    let through = state.frontier(run).await?.revision;
    let mut after = 0;
    let mut facts = Vec::new();
    while after < through {
        let page = state.history(run, after, 128).await?;
        if page.is_empty() {
            return Err("canonical Run history ended before its captured revision".into());
        }
        for fact in page {
            if fact.revision > through {
                break;
            }
            after = fact.revision;
            facts.push(fact);
        }
    }
    Ok(facts)
}

async fn original_intent(root: &RootStore, reference: &RecoveryRef) -> Result<CallerIntent> {
    let mut after = 0;
    let mut found = None;
    loop {
        let page = root
            .application_deployment_intents(reference.source.deployment, after, 64)
            .await?;
        if page.is_empty() {
            return found
                .ok_or_else(|| "the real provider call has no original caller intent".into());
        }
        for intent in page {
            after = intent.cursor;
            if intent.reference == *reference {
                assert!(
                    found.is_none(),
                    "the original SDK mutation has only one caller intent"
                );
                found = Some(intent);
            }
        }
    }
}

async fn returned(root: &RootStore, reference: &RecoveryRef) -> Result<OperationReply> {
    let mut changes = root.data_writer()?.subscribe_changes()?;
    let operation = root.operation(reference)?;
    loop {
        changes.borrow_and_update();
        if let Some(observation) = operation.operation_observation().await? {
            if matches!(&observation.outcome, OperationOutcome::Returned { .. })
                && observation.cleanup == OperationCleanup::Confirmed
            {
                return Ok(OperationReply {
                    reference: observation.reference,
                    receipt: Receipt::Recorded {
                        outcome: observation.outcome,
                        cleanup: observation.cleanup,
                    },
                });
            }
            assert!(
                matches!(
                    &observation.outcome,
                    OperationOutcome::Unresolved | OperationOutcome::Returned { .. }
                ),
                "Unknown or NotExecuted is not a known provider return"
            );
        }
        changes.changed().await?;
    }
}

fn success(reply: &OperationReply) -> &Value {
    match &reply.receipt {
        Receipt::Recorded {
            outcome:
                OperationOutcome::Returned {
                    result: OperationResult::Success { value },
                },
            cleanup: OperationCleanup::Confirmed,
        } => value,
        receipt => {
            panic!("expected the original known, physically settled provider return: {receipt:?}")
        }
    }
}

async fn freeze(
    fixture: &NativeFixture,
    session: String,
    run: RunId,
    reply: OperationReply,
) -> Result<Boundary> {
    let mut changes = fixture.state.subscribe()?;
    let first = history(&fixture.state, run).await?;
    let tool = first
        .iter()
        .find_map(|record| match &record.fact {
            Fact::ToolAdmitted { tool } if tool.call == CALL => Some(tool.clone()),
            _ => None,
        })
        .ok_or("the actual provider effect has no canonical T1")?;
    let facts = loop {
        changes.borrow_and_update();
        let facts = history(&fixture.state, run).await?;
        if facts.iter().any(|record| {
            matches!(&record.fact,
            Fact::ModelClosed { attempt, .. } if *attempt == tool.attempt)
        }) {
            break facts;
        }
        changes.changed().await?;
    };
    let step = facts
        .iter()
        .find_map(|record| match &record.fact {
            Fact::ModelAttemptPrepared { attempt, step } if *attempt == tool.attempt => Some(*step),
            _ => None,
        })
        .ok_or("the original tool has no actual prepared Main step")?;
    assert_eq!(
        facts
            .iter()
            .filter(|record| matches!(&record.fact,
        Fact::ToolAdmitted { tool: key } if key == &tool))
            .count(),
        1
    );
    assert_eq!(
        facts
            .iter()
            .filter(|record| matches!(&record.fact, Fact::ModelAttemptAdmitted { .. }))
            .count(),
        1
    );
    assert!(
        !facts.iter().any(|record| matches!(
            &record.fact,
            Fact::OperationObserved { .. }
                | Fact::HostToolResultRecorded { .. }
                | Fact::ToolResultAccepted { .. }
        )),
        "the writer fault must prevent the actual Agent T2, not seed a completed one"
    );
    let input = facts
        .iter()
        .find_map(|record| match &record.fact {
            Fact::ToolDecided {
                tool: key,
                decision:
                    ToolDecision::Approved {
                        input,
                        approval: None,
                        ..
                    },
            } if key == &tool => Some(input.clone()),
            _ => None,
        })
        .ok_or("the original input and preapproval must be canonical before provider dispatch")?;
    assert_eq!(
        serde_json::from_slice::<Value>(&fixture.state.content(run, input).await?)?,
        arguments()
    );
    let request = fixture.state.request(run, step).await?;
    assert_eq!(
        request.accounting.purpose,
        maka_agent_facts::context::ModelPurpose::Main
    );
    let view = fixture.state.frontier(run).await?;
    assert!(
        view.terminal.is_none(),
        "the original unfinished T2 must remain resumable"
    );
    let mut references: Vec<ContentRef> = view.spec.content_refs().into_iter().cloned().collect();
    references.extend(request.content_refs().into_iter().cloned());
    for record in &facts {
        references.extend(record.fact.content_refs().into_iter().cloned());
    }
    let mut blobs: Vec<FrozenBytes> = Vec::new();
    for reference in references {
        if !blobs.iter().any(|blob| blob.reference == reference) {
            let bytes = fixture.state.content(run, reference.clone()).await?;
            blobs.push(FrozenBytes { reference, bytes });
        }
    }
    let intent = original_intent(&fixture.root, &reply.reference).await?;
    let sdk = fixture
        .root
        .data_writer()?
        .query(OriginalRecord(reply.reference.clone()))
        .await?;
    assert_eq!(
        serde_json::from_slice::<Value>(&sdk.request)?["input"],
        arguments()
    );
    assert_eq!(success(&reply), &result_value());
    Ok(Boundary {
        session,
        run,
        step,
        tool,
        facts,
        blobs,
        intent,
        reply,
        sdk,
    })
}

async fn recover(fixture: &NativeFixture, original: &Boundary) -> Result<Recovered> {
    let terminal = fixture.wait_terminal(original.run).await?;
    assert_eq!(terminal.terminal, Some(Terminal::Completed));
    assert_eq!(
        fixture
            .state
            .runs(original.session.clone(), None, 8)
            .await?,
        vec![original.run]
    );
    let facts = history(&fixture.state, original.run).await?;
    assert_eq!(
        &facts[..original.facts.len()],
        original.facts.as_slice(),
        "cold recovery must preserve the original facts, IDs, order and timestamps"
    );
    for blob in &original.blobs {
        assert_eq!(
            fixture
                .state
                .content(original.run, blob.reference.clone())
                .await?,
            blob.bytes,
            "exact original input/request/source/provenance bytes must survive the killed Host"
        );
    }
    assert_eq!(
        original_intent(&fixture.root, &original.reply.reference).await?,
        original.intent
    );
    assert_eq!(
        fixture
            .root
            .data_writer()?
            .query(OriginalRecord(original.reply.reference.clone()))
            .await?,
        original.sdk,
        "the immutable SDK request/result bytes and original receipt axes must not change"
    );
    let reply = returned(&fixture.root, &original.reply.reference).await?;
    assert_eq!(
        serde_json::to_value(&reply)?,
        serde_json::to_value(&original.reply)?
    );
    assert_eq!(
        facts
            .iter()
            .filter(|record| matches!(&record.fact,
        Fact::ToolAdmitted { tool } if tool == &original.tool))
            .count(),
        1
    );
    assert_eq!(
        facts
            .iter()
            .filter(|record| matches!(&record.fact,
        Fact::ToolDecided { tool, .. } if tool == &original.tool))
            .count(),
        1,
        "a saved original return must not require another authorization decision"
    );
    assert_eq!(facts.iter().filter(|record| matches!(&record.fact,
        Fact::ToolOriginalBound { tool, reference } if tool == &original.tool && reference == &original.reply.reference)).count(), 1);
    assert_eq!(
        facts
            .iter()
            .filter(|record| matches!(&record.fact,
        Fact::OperationObserved { tool, reply: observed } if tool == &original.tool
            && serde_json::to_value(observed).unwrap() == serde_json::to_value(&reply).unwrap()))
            .count(),
        1
    );
    assert_eq!(
        facts
            .iter()
            .filter(|record| matches!(&record.fact,
        Fact::ToolResultAccepted { tool, .. } if tool == &original.tool))
            .count(),
        1
    );
    assert_eq!(
        facts
            .iter()
            .filter(|record| matches!(&record.fact, Fact::ModelAttemptAdmitted { .. }))
            .count(),
        2,
        "the original Main is not replayed; exactly one next Main follows T2"
    );
    assert_eq!(
        facts
            .iter()
            .filter(|record| matches!(&record.fact, Fact::StepPrepared { .. }))
            .count(),
        2
    );
    assert_eq!(
        facts
            .iter()
            .filter(|record| matches!(&record.fact,
        Fact::ModelObserved { part: ModelPart::Text { text, .. }, .. }
            if text.chunks().collect::<String>() == ANSWER))
            .count(),
        1
    );
    assert_eq!(
        facts
            .iter()
            .filter(|record| matches!(&record.fact,
        Fact::HostToolResultRecorded { tool, .. } if tool == &original.tool))
            .count(),
        0,
        "a cold receipt observation is not the killed native worker's normalized return"
    );
    let results: Vec<_> = facts
        .iter()
        .filter_map(|record| match &record.fact {
            Fact::ToolResultAccepted {
                tool,
                result,
                outcome: maka_agent_facts::durable::AcceptedResult::Succeeded,
            } if tool == &original.tool => Some(result.clone()),
            _ => None,
        })
        .collect();
    assert_eq!(results.len(), 1);
    let reference = results.into_iter().next().unwrap();
    let bytes = fixture
        .state
        .content(original.run, reference.clone())
        .await?;
    let accepted: AcceptedToolResult = serde_json::from_slice(&bytes)?;
    let expected = AcceptedToolResult::Operation {
        reply: original.reply.clone(),
        result: None,
    };
    assert_eq!(accepted, expected);
    let canonical = maka_agent_state::ContentBlob::json(&expected)?;
    assert_eq!(&reference, canonical.reference());
    assert_eq!(bytes, serde_json::to_vec(&expected)?);
    let AcceptedToolResult::Operation {
        reply: observed,
        result: None,
    } = &accepted
    else {
        panic!("cold SDK T2 must retain exactly Operation(original reply, None)");
    };
    assert_eq!(
        serde_json::to_value(observed)?,
        serde_json::to_value(&reply)?
    );
    assert_eq!(success(observed), &result_value());
    assert_eq!(
        serde_json::to_vec(success(observed))?,
        serde_json::to_vec(&result_value())?
    );
    Ok(Recovered {
        run: original.run,
        step: original.step,
        tool: original.tool.clone(),
        reply,
        returned: reference,
        returned_bytes: bytes,
    })
}

#[test]
fn cold_host_worker() -> Result<()> {
    tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()?
        .block_on(async {
            let Some(mut control) = cold_host::worker_channel().await? else {
                return Ok(());
            };
            let boot: Boot = control.receive().await?;
            if matches!(&boot.phase, Phase::FutureRead(_)) {
                return cell_composite::future_read(boot, &mut control).await;
            }
            if matches!(&boot.phase, Phase::PackageInstall(_)) {
                return cell_composite::install_package(boot, &mut control).await;
            }
            if matches!(
                &boot.phase,
                Phase::GoalFirst(_) | Phase::GoalMiddle(_) | Phase::GoalLast(_)
            ) {
                return goal_budget::worker(boot, &mut control).await;
            }
            if matches!(
                &boot.phase,
                Phase::CellFirst
                    | Phase::CellRecover(_)
                    | Phase::CellReopen(_)
                    | Phase::CellUnknownFirst
                    | Phase::CellUnknownRecover(_)
                    | Phase::CellUnknownReopen(_)
                    | Phase::PythonFirst
                    | Phase::PythonRecover(_)
                    | Phase::PythonReopen(_)
                    | Phase::StopFirst
                    | Phase::StopRecover(_)
                    | Phase::StopReopen(_)
                    | Phase::FutureFirst
                    | Phase::PackageRecover(_)
            ) {
                return cell_composite::worker(boot, &mut control).await;
            }
            let (entered, mut references) = mpsc::unbounded_channel();
            let fixture = NativeFixture::open_with_service(
                &boot.directory,
                configuration(&boot.workspace),
                service(boot.http, entered),
            )
            .await?;
            match boot.phase {
                Phase::First => {
                    fixture.root.data_writer()?.write(HoldAgentT2).await?;
                    let model = fixture
                        .configure_model(
                            &format!("http://{}/v1", boot.http),
                            "gpt-4.1",
                            "cold-fixture-key",
                        )
                        .await?;
                    let session = fixture
                        .create(
                            "Cold provider recovery",
                            &boot.workspace,
                            Some(BackendPreference::Model {
                                connection_id: model.connection_id,
                                model_id: model.model_id,
                                thinking_level: None,
                            }),
                        )
                        .await?;
                    let accepted = fixture.send(&session, QUESTION, None).await?;
                    let run = delivered(&fixture.state, &session, accepted).await?;
                    let reference = references
                        .recv()
                        .await
                        .ok_or("provider never entered its real SDK handler")?;
                    let reply = returned(&fixture.root, &reference).await?;
                    let evidence = freeze(&fixture, session, run, reply).await?;
                    control.send(&evidence).await?;
                    // Only the parent's forcible kill may end this original Host.
                    control.receive::<()>().await?;
                    return Err("the first Host must be killed, never gracefully released".into());
                }
                Phase::Recover(original) => {
                    // No create/send/admit/mutate: app startup resumes the original Run.
                    let recovered = recover(&fixture, &original).await?;
                    control.send(&recovered).await?;
                    control.receive::<()>().await?;
                    fixture.shutdown().await?;
                }
                Phase::CellFirst
                | Phase::CellRecover(_)
                | Phase::CellReopen(_)
                | Phase::CellUnknownFirst
                | Phase::CellUnknownRecover(_)
                | Phase::CellUnknownReopen(_)
                | Phase::PythonFirst
                | Phase::PythonRecover(_)
                | Phase::PythonReopen(_)
                | Phase::StopFirst
                | Phase::StopRecover(_)
                | Phase::StopReopen(_)
                | Phase::GoalFirst(_)
                | Phase::GoalMiddle(_)
                | Phase::GoalLast(_)
                | Phase::FutureFirst
                | Phase::FutureRead(_)
                | Phase::PackageInstall(_)
                | Phase::PackageRecover(_) => {
                    unreachable!("specialized phases have their original worker branch")
                }
            }
            Ok(())
        })
}

#[derive(Default)]
struct Observations {
    effects: Vec<Value>,
    models: Vec<Value>,
}
type SharedObservations = Arc<Mutex<Observations>>;

async fn counter(State(observed): State<SharedObservations>, body: Bytes) -> impl IntoResponse {
    let input: Value = serde_json::from_slice(&body).expect("counter HTTP JSON");
    let count = {
        let mut observed = observed.lock().unwrap();
        observed.effects.push(input.clone());
        observed.effects.len()
    };
    (
        [(header::CONTENT_TYPE, "application/json")],
        serde_json::to_vec(&json!({
            "receipt":format!("external-counter:{count}"),"input":input["input"]
        }))
        .unwrap(),
    )
}

async fn model(State(observed): State<SharedObservations>, body: Bytes) -> impl IntoResponse {
    let input: Value = serde_json::from_slice(&body).expect("model HTTP JSON");
    let first = {
        let mut observed = observed.lock().unwrap();
        observed.models.push(input);
        observed.models.len() == 1
    };
    let delta = if first {
        json!({"tool_calls":[{"index":0,"id":CALL,"type":"function","function":{
            "name":"counter","arguments":serde_json::to_string(&arguments()).unwrap()
        }}]})
    } else {
        json!({"content":ANSWER})
    };
    let start = json!({"id":"cold-reply","object":"chat.completion.chunk","created":1,"model":"gpt-4.1",
        "choices":[{"index":0,"delta":delta,"finish_reason":null}]});
    let end = json!({"id":"cold-reply","object":"chat.completion.chunk","created":1,"model":"gpt-4.1",
        "choices":[{"index":0,"delta":{},"finish_reason":if first {"tool_calls"} else {"stop"}}],
        "usage":{"prompt_tokens":4,"completion_tokens":3,"total_tokens":7}});
    (
        [(header::CONTENT_TYPE, "text/event-stream")],
        format!("data: {start}\n\ndata: {end}\n\ndata: [DONE]\n\n"),
    )
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn provider_returned_before_agent_t2_survives_a_killed_host_without_repeating_the_effect()
-> Result<()> {
    let directory = tempfile::tempdir()?;
    let workspace = directory.path().join("workspace");
    tokio::fs::create_dir(&workspace).await?;
    let listener = TcpListener::bind("127.0.0.1:0").await?;
    let http = listener.local_addr()?;
    let observed = SharedObservations::default();
    let router = Router::new()
        .route("/effect", post(counter))
        .route("/v1/chat/completions", post(model))
        .with_state(observed.clone());
    let (stop, stopping) = tokio::sync::oneshot::channel();
    let server = tokio::spawn(async move {
        axum::serve(listener, router)
            .with_graceful_shutdown(async {
                let _ = stopping.await;
            })
            .await
    });
    // These owners stay outside the cancelable case future, so timeout or an
    // assertion panic can still kill and join both processes before Root removal.
    let mut first = None;
    let mut fresh = None;
    let outcome = std::panic::AssertUnwindSafe(tokio::time::timeout(Duration::from_secs(90), async {
        first = Some(ColdHost::spawn(&Boot {
            directory: directory.path().into(), workspace: workspace.clone(), http, phase: Phase::First,
        }).await?);
        let before: Boundary = first.as_mut().unwrap().receive().await?;
        eprintln!("ProviderReturned before Agent T2: {}", json!({
            "run":before.run,"step":before.step,"tool":before.tool,
            "reference":before.reply.reference,"receipt":before.reply.receipt,
            "originalCallerIntentCursor":before.intent.cursor
        }));
        {
            let observed = observed.lock().unwrap();
            assert_eq!(observed.effects, vec![json!({"reference":before.reply.reference,"input":arguments()})]);
            assert_eq!(observed.models.len(), 1);
            assert_eq!(observed.models[0]["model"], "gpt-4.1");
        }
        first.as_mut().unwrap().kill().await?;
        fresh = Some(ColdHost::spawn(&Boot {
            directory: directory.path().into(), workspace, http, phase: Phase::Recover(Box::new(before.clone())),
        }).await?);
        let after: Recovered = fresh.as_mut().unwrap().receive().await?;
        assert_eq!(after.run, before.run);
        assert_eq!(after.step, before.step);
        assert_eq!(after.tool, before.tool);
        assert_eq!(serde_json::to_value(&after.reply)?, serde_json::to_value(&before.reply)?);
        assert_eq!(after.returned.bytes, after.returned_bytes.len() as u64);
        let accepted: AcceptedToolResult = serde_json::from_slice(&after.returned_bytes)?;
        let AcceptedToolResult::Operation { reply: accepted_reply, result: None } = accepted else {
            panic!("the received canonical T2 must be exactly Operation(original reply, None)");
        };
        assert_eq!(serde_json::to_value(&accepted_reply)?, serde_json::to_value(&before.reply)?);
        fresh.as_mut().unwrap().finish().await?;
        {
            let observed = observed.lock().unwrap();
            assert_eq!(observed.effects, vec![json!({"reference":before.reply.reference,"input":arguments()})],
                "the independent parent counter must remain exactly one after every Host RAM owner is gone");
            assert_eq!(observed.models.len(), 2, "exactly one next Main, not a replay of the first");
            let tool_messages: Vec<_> = observed.models[1]["messages"].as_array().unwrap().iter()
                .filter(|message| message["role"] == "tool").collect();
            assert_eq!(tool_messages.len(), 1);
            assert_eq!(tool_messages[0]["tool_call_id"], CALL);
            let result = tool_messages[0]["content"].as_str().expect("textual tool result");
            assert_eq!(serde_json::from_str::<Value>(result)?, result_value());
            assert_eq!(serde_json::to_vec(&serde_json::from_str::<Value>(result)?)?,
                serde_json::to_vec(success(&accepted_reply))?,
                "the actual next Main projection must carry the value from the same canonical T2");
        }
        Ok::<(), Box<dyn std::error::Error + Send + Sync>>(())
    })).catch_unwind().await;
    let mut cleanup_error = None;
    for host in [&mut first, &mut fresh].into_iter().flatten() {
        if let Err(error) = host.terminate().await {
            cleanup_error.get_or_insert(error);
        }
    }
    let stop_result = stop.send(());
    let server_result = server.await;
    match outcome {
        Err(panic) => {
            if let Some(error) = cleanup_error {
                eprintln!("cold Host cleanup also failed: {error}");
            }
            if let Err(error) = server_result {
                eprintln!("external server also failed: {error}");
            }
            std::panic::resume_unwind(panic)
        }
        Ok(result) => {
            if let Some(error) = cleanup_error {
                return Err(error);
            }
            stop_result.map_err(|_| "external model/counter server exited before shutdown")?;
            server_result??;
            result.map_err(
                |_| "cold Host recovery deadline expired; workers were killed and joined",
            )?
        }
    }
}

mod goal_budget {
    use super::*;
    use maka_agent_api::contract::GoalView;

    #[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
    pub(super) enum Usage {
        Known,
        Missing,
    }
    impl Usage {
        fn initial(self) -> u64 {
            match self {
                Self::Known => 3,
                Self::Missing => 6,
            }
        }
        fn raised(self) -> u64 {
            match self {
                Self::Known => 6,
                Self::Missing => 9,
            }
        }
        fn iterations(self, raised: bool) -> u64 {
            if self == Self::Known && raised { 2 } else { 1 }
        }
    }
    #[derive(Clone, Debug, Serialize, Deserialize)]
    struct ReceiptCut {
        reply: OperationReply,
        value: Value,
        sdk: SdkRecord,
        intent: CallerIntent,
    }
    #[derive(Clone, Debug, Serialize, Deserialize)]
    struct RunCut {
        run: RunId,
        facts: Vec<RecordedFact>,
        blobs: Vec<FrozenBytes>,
    }
    #[derive(Clone, Debug, Serialize, Deserialize)]
    pub(super) struct Boundary {
        usage: Usage,
        session: String,
        detail: Value,
        receipts: Vec<ReceiptCut>,
        runs: Vec<RunCut>,
    }
    fn config(workspace: &Path) -> Configuration {
        let mut value = serde_json::to_value(configuration(workspace)).unwrap();
        value["goals"] = json!(true);
        value["automaticTitles"] = json!(false);
        serde_json::from_value(value).unwrap()
    }
    async fn current(f: &NativeFixture, session: &str) -> Result<Value> {
        let value = f.query("goal", json!({"sessionId":session})).await?;
        let typed: GoalView = serde_json::from_value(value)?;
        assert!(typed.enabled);
        Ok(serde_json::to_value(
            typed
                .current
                .ok_or("the original public Goal disappeared")?,
        )?)
    }
    fn limited(value: &Value, usage: Usage, raised: bool) {
        let cap = if raised {
            usage.raised()
        } else {
            usage.initial()
        };
        assert_eq!(value["status"], "budget_limited");
        assert_eq!(value["pending"], false);
        assert_eq!(value["tokenBudget"], cap);
        assert_eq!(value["iterations"], usage.iterations(raised));
        match usage {
            Usage::Known => {
                assert_eq!(value["consumed"], json!({"known":cap,"missing":0}));
                assert_eq!(value["remainingTokens"], 0);
            }
            Usage::Missing => {
                assert_eq!(value["consumed"], json!({"known":0,"missing":2}));
                assert_eq!(value["remainingTokens"], Value::Null);
            }
        }
    }
    async fn wait_limited(
        f: &NativeFixture,
        session: &str,
        id: &Value,
        after: u64,
        usage: Usage,
        raised: bool,
    ) -> Result<Value> {
        let mut changes = f.root.data_writer()?.subscribe_changes()?;
        loop {
            changes.borrow_and_update();
            let goal = current(f, session).await?;
            assert_eq!(&goal["id"], id);
            if goal["status"] == "budget_limited"
                && goal["pending"] == false
                && goal["revision"].as_u64().unwrap() > after
            {
                limited(&goal, usage, raised);
                return Ok(goal);
            }
            changes.changed().await?;
        }
    }
    async fn change(f: &NativeFixture, input: Value) -> Result<ReceiptCut> {
        let observed = f
            .mutation("changeGoal", input, uuid::Uuid::new_v4())
            .await?;
        let reply = returned(&f.root, &observed.reference).await?;
        let value = success(&reply).clone();
        assert_eq!(
            value["kind"], "committed",
            "finite Goal control was not committed"
        );
        let sdk = f
            .root
            .data_writer()?
            .query(OriginalRecord(reply.reference.clone()))
            .await?;
        let intent = original_intent(&f.root, &reply.reference).await?;
        assert_eq!(
            f.query("goalReceipt", json!({"reference":reply.reference}))
                .await?,
            value
        );
        Ok(ReceiptCut {
            reply,
            value,
            sdk,
            intent,
        })
    }
    async fn preserve(f: &NativeFixture, boundary: &Boundary) -> Result<()> {
        let goal = current(f, &boundary.session).await?;
        for key in [
            "id",
            "createdAt",
            "objective",
            "tokenBudget",
            "iterations",
            "consumed",
            "remainingTokens",
            "status",
            "pending",
        ] {
            assert_eq!(
                goal[key], boundary.detail[key],
                "cold Goal changed its original {key}"
            );
        }
        assert!(
            goal["revision"].as_u64().unwrap() >= boundary.detail["revision"].as_u64().unwrap()
        );
        for receipt in &boundary.receipts {
            assert_eq!(
                f.query("goalReceipt", json!({"reference":receipt.reply.reference}))
                    .await?,
                receipt.value
            );
            assert_eq!(
                f.root
                    .data_writer()?
                    .query(OriginalRecord(receipt.reply.reference.clone()))
                    .await?,
                receipt.sdk
            );
            assert_eq!(
                original_intent(&f.root, &receipt.reply.reference).await?,
                receipt.intent
            );
            assert_eq!(
                serde_json::to_value(returned(&f.root, &receipt.reply.reference).await?)?,
                serde_json::to_value(&receipt.reply)?
            );
        }
        let runs = f.state.runs(boundary.session.clone(), None, 16).await?;
        assert_eq!(
            runs.len(),
            boundary.runs.len(),
            "budget state cannot admit a new iteration on Root open"
        );
        for prior in &boundary.runs {
            assert!(runs.contains(&prior.run));
            let facts = history(&f.state, prior.run).await?;
            assert_eq!(&facts[..prior.facts.len()], prior.facts.as_slice());
            for blob in &prior.blobs {
                assert_eq!(
                    f.state.content(prior.run, blob.reference.clone()).await?,
                    blob.bytes
                );
            }
        }
        Ok(())
    }
    async fn capture(
        f: &NativeFixture,
        usage: Usage,
        session: String,
        detail: Value,
        receipts: Vec<ReceiptCut>,
    ) -> Result<Boundary> {
        let ids = f.state.runs(session.clone(), None, 16).await?;
        assert_eq!(ids.len() as u64, detail["iterations"].as_u64().unwrap());
        let mut runs = Vec::new();
        for run in ids {
            let view = f.state.frontier(run).await?;
            assert!(
                view.terminal.is_some(),
                "pending false must refer to a settled original iteration"
            );
            assert!(
                !view.stopped,
                "budget exhaustion is not a synthetic user Stop"
            );
            let facts = history(&f.state, run).await?;
            assert!(
                facts
                    .iter()
                    .any(|record| matches!(&record.fact, Fact::ModelClosed { .. }))
            );
            assert!(
                !facts
                    .iter()
                    .any(|record| matches!(&record.fact, Fact::StopRequested { .. }))
            );
            let mut refs: Vec<_> = view.spec.content_refs().into_iter().cloned().collect();
            for record in &facts {
                refs.extend(record.fact.content_refs().into_iter().cloned());
                if let Fact::StepPrepared { step, .. } = &record.fact {
                    refs.extend(
                        f.state
                            .request(run, *step)
                            .await?
                            .content_refs()
                            .into_iter()
                            .cloned(),
                    );
                }
            }
            let mut blobs: Vec<FrozenBytes> = Vec::new();
            for reference in refs {
                if !blobs.iter().any(|blob| blob.reference == reference) {
                    blobs.push(FrozenBytes {
                        bytes: f.state.content(run, reference.clone()).await?,
                        reference,
                    });
                }
            }
            runs.push(RunCut { run, facts, blobs });
        }
        Ok(Boundary {
            usage,
            session,
            detail,
            receipts,
            runs,
        })
    }
    async fn resume(
        f: &NativeFixture,
        boundary: &Boundary,
        cap: u64,
        raised: bool,
    ) -> Result<(Value, ReceiptCut)> {
        let before = current(f, &boundary.session).await?;
        let receipt = change(f, json!({"kind":"control","sessionId":boundary.session,
            "goalId":before["id"],"revision":before["revision"],"action":"resume","budget":{"tokenBudget":cap}})).await?;
        let committed = receipt.value["revision"]
            .as_u64()
            .ok_or("Goal control has no committed revision")?;
        // This strictly newer limited revision is the real background meter/
        // admission barrier. App.ready or an absence of HTTP is not a tick ACK.
        let goal = wait_limited(
            f,
            &boundary.session,
            &boundary.detail["id"],
            committed,
            boundary.usage,
            raised,
        )
        .await?;
        Ok((goal, receipt))
    }
    pub(super) async fn worker(boot: Boot, control: &mut cold_host::Channel) -> Result<()> {
        let (entered, _references) = mpsc::unbounded_channel();
        let fixture = NativeFixture::open_with_service(
            &boot.directory,
            config(&boot.workspace),
            service(boot.http, entered),
        )
        .await?;
        let boundary = match boot.phase {
            Phase::GoalFirst(usage) => {
                let model = fixture
                    .configure_model(
                        &format!("http://{}/v1", boot.http),
                        "gpt-4.1",
                        "cold-goal-key",
                    )
                    .await?;
                let session = fixture
                    .create(
                        "Finite Goal cold meter",
                        &boot.workspace,
                        Some(BackendPreference::Model {
                            connection_id: model.connection_id.clone(),
                            model_id: model.model_id.clone(),
                            thinking_level: None,
                        }),
                    )
                    .await?;
                let observed = fixture
                    .query("observe", json!({"sessionId":session}))
                    .await?;
                let selected = &observed["session"];
                assert_eq!(selected["id"], session);
                let approval = json!({"target":{"sessionId":session,"workspace":selected["workspace"],
                    "permissions":selected["permissions"],"boundaryRevision":selected["boundaryRevision"],
                    "binding":selected["binding"]},"model":model,"thinkingLevel":null});
                let receipt = change(&fixture, json!({"kind":"create","sessionId":session,
                    "objective":"Budget checkpoint π😀","tokenBudget":usage.initial(),"start":true,"approval":approval})).await?;
                let detail = wait_limited(
                    &fixture,
                    &session,
                    &receipt.value["goalId"],
                    receipt.value["revision"].as_u64().unwrap(),
                    usage,
                    false,
                )
                .await?;
                capture(&fixture, usage, session, detail, vec![receipt]).await?
            }
            Phase::GoalMiddle(prior) => {
                preserve(&fixture, &prior).await?;
                limited(&prior.detail, prior.usage, false);
                let (same, receipt) =
                    resume(&fixture, &prior, prior.usage.initial(), false).await?;
                assert_eq!(
                    fixture
                        .state
                        .runs(prior.session.clone(), None, 16)
                        .await?
                        .len(),
                    prior.runs.len()
                );
                assert_eq!(same["consumed"], prior.detail["consumed"]);
                let mut receipts = prior.receipts.clone();
                receipts.push(receipt);
                let baseline =
                    capture(&fixture, prior.usage, prior.session.clone(), same, receipts).await?;
                let (raised, receipt) =
                    resume(&fixture, &baseline, prior.usage.raised(), true).await?;
                let mut receipts = baseline.receipts;
                receipts.push(receipt);
                capture(
                    &fixture,
                    prior.usage,
                    prior.session.clone(),
                    raised,
                    receipts,
                )
                .await?
            }
            Phase::GoalLast(prior) => {
                preserve(&fixture, &prior).await?;
                limited(&prior.detail, prior.usage, true);
                let (same, receipt) = resume(&fixture, &prior, prior.usage.raised(), true).await?;
                assert_eq!(
                    fixture
                        .state
                        .runs(prior.session.clone(), None, 16)
                        .await?
                        .len(),
                    prior.runs.len()
                );
                assert_eq!(same["consumed"], prior.detail["consumed"]);
                let mut receipts = prior.receipts.clone();
                receipts.push(receipt);
                capture(&fixture, prior.usage, prior.session.clone(), same, receipts).await?
            }
            _ => return Err("invalid finite Goal worker phase".into()),
        };
        control.send(&boundary).await?;
        control.receive::<()>().await?;
        Err("the finite-budget Host is cold-killed after its positive public meter barrier".into())
    }

    struct Model {
        usage: Usage,
        requests: Mutex<Vec<Value>>,
    }
    async fn model(State(server): State<Arc<Model>>, body: Bytes) -> impl IntoResponse {
        let request: Value = serde_json::from_slice(&body).unwrap();
        let index = {
            let mut requests = server.requests.lock().unwrap();
            requests.push(request);
            requests.len()
        };
        let chunk = json!({"id":format!("goal-budget-{index}"),"object":"chat.completion.chunk","created":1,"model":"gpt-4.1",
            "choices":[{"index":0,"delta":{"content":"A real finite iteration checkpoint."},"finish_reason":null}]});
        let mut end = json!({"id":format!("goal-budget-{index}"),"object":"chat.completion.chunk","created":1,"model":"gpt-4.1",
            "choices":[{"index":0,"delta":{},"finish_reason":"stop"}]});
        if server.usage == Usage::Known {
            end["usage"] = json!({"prompt_tokens":1,"completion_tokens":2,"total_tokens":3});
        }
        (
            [(header::CONTENT_TYPE, "text/event-stream")],
            format!("data: {chunk}\n\ndata: {end}\n\ndata: [DONE]\n\n"),
        )
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn finite_goal_budget_and_missing_usage_survive_positive_meter_checks_in_three_cold_roots()
    -> Result<()> {
        for usage in [Usage::Known, Usage::Missing] {
            let directory = tempfile::tempdir()?;
            let workspace = directory.path().join("workspace");
            tokio::fs::create_dir(&workspace).await?;
            let listener = TcpListener::bind("127.0.0.1:0").await?;
            let http = listener.local_addr()?;
            let server = Arc::new(Model {
                usage,
                requests: Mutex::new(Vec::new()),
            });
            let router = Router::new()
                .route("/v1/chat/completions", post(model))
                .with_state(server.clone());
            let (stop, stopped) = tokio::sync::oneshot::channel();
            let http_task = tokio::spawn(async move {
                axum::serve(listener, router)
                    .with_graceful_shutdown(async {
                        let _ = stopped.await;
                    })
                    .await
            });
            let mut hosts: [Option<ColdHost>; 3] = [None, None, None];
            let outcome = std::panic::AssertUnwindSafe(tokio::time::timeout(
                Duration::from_secs(90),
                async {
                    hosts[0] = Some(
                        ColdHost::spawn(&Boot {
                            directory: directory.path().into(),
                            workspace: workspace.clone(),
                            http,
                            phase: Phase::GoalFirst(usage),
                        })
                        .await?,
                    );
                    let first: Boundary = hosts[0].as_mut().unwrap().receive().await?;
                    limited(&first.detail, usage, false);
                    assert_eq!(server.requests.lock().unwrap().len(), 1);
                    hosts[0].as_mut().unwrap().kill().await?;
                    hosts[1] = Some(
                        ColdHost::spawn(&Boot {
                            directory: directory.path().into(),
                            workspace: workspace.clone(),
                            http,
                            phase: Phase::GoalMiddle(Box::new(first.clone())),
                        })
                        .await?,
                    );
                    let second: Boundary = hosts[1].as_mut().unwrap().receive().await?;
                    assert_eq!(second.detail["id"], first.detail["id"]);
                    limited(&second.detail, usage, true);
                    assert_eq!(
                        server.requests.lock().unwrap().len() as u64,
                        usage.iterations(true)
                    );
                    hosts[1].as_mut().unwrap().kill().await?;
                    hosts[2] = Some(
                        ColdHost::spawn(&Boot {
                            directory: directory.path().into(),
                            workspace,
                            http,
                            phase: Phase::GoalLast(Box::new(second.clone())),
                        })
                        .await?,
                    );
                    let last: Boundary = hosts[2].as_mut().unwrap().receive().await?;
                    assert_eq!(last.detail["id"], first.detail["id"]);
                    limited(&last.detail, usage, true);
                    assert_eq!(last.receipts.len(), 4);
                    assert_eq!(
                        server.requests.lock().unwrap().len() as u64,
                        usage.iterations(true)
                    );
                    hosts[2].as_mut().unwrap().kill().await?;
                    Ok::<(), Box<dyn std::error::Error + Send + Sync>>(())
                },
            ))
            .catch_unwind()
            .await;
            let mut cleanup = None;
            for host in hosts.iter_mut().flatten() {
                if let Err(error) = host.terminate().await {
                    cleanup.get_or_insert(error);
                }
            }
            let stop_result = stop.send(());
            let server_result = http_task.await;
            match outcome {
                Err(panic) => {
                    if let Some(error) = cleanup {
                        eprintln!("finite Goal cold worker cleanup also failed: {error}");
                    }
                    std::panic::resume_unwind(panic)
                }
                Ok(result) => {
                    if let Some(error) = cleanup {
                        return Err(error);
                    }
                    stop_result.map_err(|_| "finite Goal HTTP server ended before shutdown")?;
                    server_result??;
                    result.map_err(
                        |_| "finite Goal recovery deadline expired; workers were killed and joined",
                    )??;
                }
            }
        }
        Ok(())
    }
}

mod cell_composite {
    use super::*;
    use maka_agent_facts::{
        cells::{CellEvent, CellId, CellInterruption, CellOwner, CellReplyState, CellStatus},
        configuration::{
            ApiProtocol, CatalogMutationResult, ConnectionCatalogEntryUpdate,
            ConnectionVersionBasis, ModelOverride, Patch, UpdateCatalogConnectionInput,
        },
        durable::{AttemptRecovery, BlockerId, BlockerKind, FactId, ModelAttemptId, RequestSpec},
        execution::CodeLanguage,
    };
    use std::sync::{
        Condvar,
        atomic::{AtomicUsize, Ordering},
    };
    use tokio::sync::{oneshot, watch};
    use uuid::Uuid;

    const FIRST: &str = "accepted-cell";
    const SECOND: &str = "running-cell";
    const WAIT: &str = "wait-original-cell";
    const VERIFY: &str = "verify-new-heap";
    const SETUP: &str = "const t = ALL_TOOLS.find(t => t.name === 'describe'); text(t.description); text(await tools.describe({})); store('a', 1);";
    const DRAFT: &str = "text(await tools.draft_describe({draft:true})); store('a', 2); store('b', 3); globalThis.coldHeapMarker = 'old-live-vm'; text(await tools.counter({amount:5,label:globalThis.coldHeapMarker}));";
    const CHECK: &str = "text({cellFixtureVmObservation:{a:load('a'),bMissing:load('b') === undefined,oldHeapMissing:typeof globalThis.coldHeapMarker === 'undefined',catalog:ALL_TOOLS.filter(t => t.name === 'describe' || t.name === 'draft_describe').map(t => ({name:t.name,description:t.description}))}});";
    const FINAL: &str = "The interrupted Cell was observed, not replayed.";
    const PY_SETUP: &str = "text(await tools.describe({}))\nstore('a',1)\ntext({'cellFixtureVmObservation':{'catalog':[{'name':t.name,'description':t.description} for t in ALL_TOOLS if t.name == 'describe' or t.name == 'draft_describe']}})";
    const PY_DRAFT: &str = "text(await tools.draft_describe({'draft':True}))\nstore('a',2)\nstore('b',3)\ncold_heap_marker='old-live-vm'\ntext(await tools.counter({'amount':5,'label':cold_heap_marker}))";
    const PY_CHECK: &str = "try:\n    cold_heap_marker\n    old_heap_missing = False\nexcept NameError:\n    old_heap_missing = True\ntext({'cellFixtureVmObservation':{'a':load('a'),'bMissing':load('b') is None,'oldHeapMissing':old_heap_missing,'catalog':[{'name':t.name,'description':t.description} for t in ALL_TOOLS if t.name == 'describe' or t.name == 'draft_describe']}})";

    fn child_input() -> Value {
        json!({"amount":5,"label":"old-live-vm"})
    }

    #[derive(Clone, Debug, Serialize, Deserialize)]
    pub(super) struct Boundary {
        session: String,
        run: RunId,
        accepted: CellId,
        running: CellId,
        child: Uuid,
        vm: maka_code_runtime::VmBinding,
        facts: Vec<RecordedFact>,
        blobs: Vec<FrozenBytes>,
        reply: OperationReply,
        intent: CallerIntent,
        sdk: SdkRecord,
        describe_calls: usize,
        draft_describe_calls: usize,
    }
    #[derive(Clone, Debug, Serialize, Deserialize)]
    pub(super) struct Reconciled {
        original: Boundary,
        facts: Vec<RecordedFact>,
        report: ContentRef,
        report_bytes: Vec<u8>,
        notification: FactId,
    }

    struct Effects {
        counter: Counter,
        counter_release: Mutex<Option<oneshot::Receiver<()>>>,
        descriptions: AtomicUsize,
        draft_descriptions: AtomicUsize,
    }
    impl Handler for Effects {
        fn call(
            &self,
            method: String,
            input: Value,
            context: Context,
        ) -> BoxFuture<'static, HandlerResult> {
            if method != "describe" {
                let original = self.counter.call(method, input, context);
                let Some(release) = self.counter_release.lock().unwrap().take() else {
                    return original;
                };
                return Box::pin(async move {
                    let result = original.await?;
                    release.await.map_err(|_| HandlerError::Unknown {
                        diagnostic: "fixture model cleanup gate closed before the counter return"
                            .into(),
                    })?;
                    Ok(result)
                });
            }
            assert!(
                context.operation().is_none(),
                "describe is a real finite Query, not an SDK mutation"
            );
            assert!(context.work_custody().is_some());
            if input == json!({}) {
                self.descriptions.fetch_add(1, Ordering::SeqCst);
            } else {
                assert_eq!(input, json!({"draft":true}));
                self.draft_descriptions.fetch_add(1, Ordering::SeqCst);
            }
            Box::pin(async {
                Ok(HandlerValue::Json(
                    json!({"name":"counter","method":"increment"}),
                ))
            })
        }
    }
    impl NativeOwner for Effects {
        fn execution_basis(&self) -> Option<Value> {
            Some(json!({
                "counter":{"http":self.counter.http.to_string(),"expected":self.counter.expected},
                "describe":{"version":1,"response":{"name":"counter","method":"increment"}}
            }))
        }
        fn close(&self) -> BoxFuture<'static, std::result::Result<(), String>> {
            Box::pin(async { Ok(()) })
        }
    }
    impl Effects {
        fn service(self: &Arc<Self>) -> FixtureService {
            FixtureService::new(Self::contract(), self.clone())
        }
        fn contract() -> Contract {
            Contract {
                name: "fixture.ColdCellCounter".into(), version: 1, transport: Transport::Remote,
                interface: Interface::Service { methods: BTreeMap::from([
                    ("increment".into(), Method {
                        mode: MethodMode::Mutation,
                        input: json!({"type":"object","required":["amount","label"],"properties":{
                            "amount":{"type":"integer"},"label":{"type":"string"}
                        },"additionalProperties":false}).into(),
                        output: json!({"type":"object"}).into(), resources: BTreeMap::new(), progress: None,
                    }),
                    ("describe".into(), Method {
                        mode: MethodMode::Query, input: json!({"type":"object","properties":{"draft":{"type":"boolean"}},"additionalProperties":false}).into(),
                        output: json!({"type":"object"}).into(), resources: BTreeMap::new(), progress: None,
                    }),
                ]) },
            }
        }
    }

    struct HoldChildT2(oneshot::Sender<()>);
    fn until_killed() -> rusqlite::Result<i64> {
        let changed = Condvar::new();
        let mutex = Mutex::new(());
        let mut guard = mutex.lock().unwrap();
        loop {
            guard = changed.wait(guard).unwrap();
        }
    }
    impl Statement for HoldChildT2 {
        type Value = ();
        type Output = ();
        fn execute(
            self,
            connection: &rusqlite::Connection,
        ) -> std::result::Result<Prepared<()>, StoreError> {
            let entered = Mutex::new(Some(self.0));
            connection.create_scalar_function(
                "cold_hold_child_t2",
                0,
                rusqlite::functions::FunctionFlags::SQLITE_UTF8,
                move |_| {
                    if let Some(entered) = entered.lock().unwrap().take() {
                        entered.send(()).map_err(|_| {
                            rusqlite::Error::UserFunctionError(Box::new(std::io::Error::other(
                                "cold Host barrier observer disappeared",
                            )))
                        })?;
                    }
                    // In-process control only: no writer-thread network/file I/O,
                    // no timer and no business effect escapes this uncommitted T2.
                    until_killed()
                },
            )?;
            connection.execute_batch(
                "CREATE TEMP TRIGGER cold_hold_original_child BEFORE INSERT ON agent_facts
                 WHEN json_extract((SELECT payload FROM contents WHERE id=NEW.body_content_id),'$.fact.kind')='cell'
                  AND json_extract((SELECT payload FROM contents WHERE id=NEW.body_content_id),'$.fact.event.kind')='child_observed'
                 BEGIN SELECT cold_hold_child_t2(); END;"
            )?;
            Ok(Prepared {
                value: (),
                changed: true,
                notification: Notification::NONE,
            })
        }
        fn committed((): ()) {}
        fn isolated_rejection(_: &StoreError) -> bool {
            false
        }
    }

    fn config(workspace: &Path) -> Configuration {
        let mut value = serde_json::to_value(configuration(workspace)).unwrap();
        value["toolDiscovery"] = json!(true);
        value["tools"].as_array_mut().unwrap().push(json!({
            "name":"describe","description":"Describe the registered counter method.","method":"describe",
            "nestable":true,"target":{"kind":"import","name":"fixture"},"result":"json","confirmation":"preapproved"
        }));
        value["tools"].as_array_mut().unwrap().push(json!({
            "name":"draft_describe","description":"Read the registered method from the unaccepted Cell.","method":"describe",
            "nestable":true,"target":{"kind":"import","name":"fixture"},"result":"json","confirmation":"preapproved"
        }));
        serde_json::from_value(value).unwrap()
    }
    async fn code_model(
        f: &NativeFixture,
        http: SocketAddr,
    ) -> Result<maka_agent_api::ModelSelection> {
        code_model_language(f, http, CodeLanguage::JavaScript).await
    }
    async fn code_model_language(
        f: &NativeFixture,
        http: SocketAddr,
        language: CodeLanguage,
    ) -> Result<maka_agent_api::ModelSelection> {
        let model = f
            .configure_model(&format!("http://{http}/v1"), "gpt-4.1", "cold-fixture-key")
            .await?;
        let row = f
            .config
            .catalog()
            .await?
            .connections
            .into_iter()
            .find(|row| row.connection_id == model.connection_id)
            .ok_or("original model connection is missing")?;
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
                            code_mode_language: Some(language),
                            api_protocol: Some(ApiProtocol::OpenaiChatCompletions),
                            ..Default::default()
                        },
                    )])),
                    request_body_overlay: Patch::Keep,
                },
            })
            .await?;
        assert!(matches!(result, CatalogMutationResult::Committed { .. }));
        Ok(model)
    }

    async fn values(f: &NativeFixture, session: &str) -> Result<()> {
        assert_eq!(
            f.state.cells().value(session, "a").await?,
            Some(b"1".to_vec())
        );
        assert_eq!(f.state.cells().value(session, "b").await?, None);
        assert_eq!(
            f.state.cells().loaded(session).await?,
            std::collections::BTreeSet::from(["describe".to_owned()])
        );
        Ok(())
    }

    async fn capture(
        f: &NativeFixture,
        effects: &Effects,
        session: String,
        run: RunId,
        reference: RecoveryRef,
    ) -> Result<Boundary> {
        capture_vm(
            f,
            effects,
            session,
            run,
            reference,
            maka_code_runtime::JAVASCRIPT_VM,
        )
        .await
    }
    async fn capture_vm(
        f: &NativeFixture,
        effects: &Effects,
        session: String,
        run: RunId,
        reference: RecoveryRef,
        runtime: &str,
    ) -> Result<Boundary> {
        // Every read below uses the existing independent read lanes. The writer
        // is inside the trigger: query_barrier/flush here would self-deadlock.
        let observation = f
            .root
            .operation(&reference)?
            .operation_observation()
            .await?
            .ok_or("original SDK operation is not committed before the child T2 barrier")?;
        let reply = OperationReply {
            reference: observation.reference,
            receipt: Receipt::Recorded {
                outcome: observation.outcome,
                cleanup: observation.cleanup,
            },
        };
        assert_eq!(
            success(&reply),
            &json!({"receipt":"external-counter:1","input":child_input()})
        );
        let facts = history(&f.state, run).await?;
        let cell = |name: &str| {
            facts.iter().find_map(|record| match &record.fact {
                Fact::Cell {
                    event:
                        CellEvent::Started {
                            cell,
                            owner: CellOwner::Agent { link, call },
                            ..
                        },
                } if link.run == run && call == name => Some(*cell),
                _ => None,
            })
        };
        let accepted = cell(FIRST).ok_or("the accepted first Cell is missing")?;
        let running = cell(SECOND).ok_or("the live second Cell is missing")?;
        assert_ne!(accepted, running);
        let first = f
            .state
            .cells()
            .read(&session, accepted)
            .await?
            .ok_or("first Cell read is missing")?;
        assert!(matches!(
            first.status,
            CellStatus::Completed { accepted: true, .. }
        ));
        let second = f
            .state
            .cells()
            .read(&session, running)
            .await?
            .ok_or("second Cell read is missing")?;
        assert!(matches!(second.status, CellStatus::Running));
        assert!(second.vm_uncertainty.is_none());
        assert_eq!(second.children.len(), 2);
        let pending: Vec<_> = second
            .children
            .iter()
            .filter(|(_, child)| child.reply.is_none() && child.local_result.is_none())
            .collect();
        assert_eq!(pending.len(), 1);
        let (&child, pending) = pending[0];
        assert!(pending.admitted && pending.reply.is_none() && pending.local_result.is_none());
        assert_eq!(
            second
                .children
                .values()
                .filter(|child| child.known() && child.physical_cleanup_confirmed())
                .count(),
            1,
            "the finite draft Query completed before the original counter await"
        );
        let parent = facts
            .iter()
            .find_map(|record| match &record.fact {
                Fact::ToolAdmitted { tool } if tool.call == SECOND => Some(tool.clone()),
                _ => None,
            })
            .ok_or("the original exec parent was not admitted")?;
        assert!(matches!(&second.owner,
            CellOwner::Agent { link, call }
                if link.run == run && link.attempt == parent.attempt && call == &parent.call));
        assert!(
            !facts.iter().any(|record| matches!(&record.fact,
            Fact::ToolResultAccepted { tool, .. } | Fact::LocalToolReturned { tool, .. }
                if tool == &parent)),
            "the original exec parent has no committed T2"
        );
        assert!(
            !facts.iter().any(|record| matches!(&record.fact,
            Fact::Cell { event: CellEvent::ChildObserved { cell, operation, .. } }
                if *cell == running && *operation == child)),
            "the original counter receipt has not entered Cell T2"
        );
        let attempts: Vec<_> = facts
            .iter()
            .filter_map(|record| match &record.fact {
                Fact::ModelAttemptPrepared { attempt, .. } => Some(*attempt),
                _ => None,
            })
            .collect();
        assert_eq!(attempts.len(), 2);
        assert_eq!(
            facts
                .iter()
                .filter(|record| matches!(&record.fact, Fact::ModelAttemptAdmitted { .. }))
                .count(),
            2
        );
        for attempt in attempts {
            assert_eq!(
                facts.iter().filter(|record| matches!(&record.fact,
                    Fact::ModelClosed { attempt: closed, outcome: maka_agent_facts::accounting::Outcome::Success, diagnostic: None, .. }
                        if *closed == attempt)).count(),
                1,
                "both finite original model attempts must have canonical successful closure"
            );
            assert_eq!(
                facts.iter().filter(|record| matches!(&record.fact,
                    Fact::ModelCleanupObserved { attempt: cleaned, cleanup: OperationCleanup::Confirmed }
                        if *cleaned == attempt)).count(),
                1,
                "both original model cleanups committed before the counter T2 barrier"
            );
        }
        let binding = second.vm.ok_or("the actual live VM has no binding")?;
        let vm = maka_code_runtime::VmBinding {
            runtime: binding.runtime,
            version: binding.version,
            descriptor: serde_json::from_slice(
                &f.state
                    .cells()
                    .content(&session, running, binding.descriptor)
                    .await?,
            )?,
        };
        assert_eq!(vm.runtime, runtime);
        assert_eq!(vm.version, maka_code_runtime::VM_BINDING_VERSION);
        assert!(matches!(
            maka_code_runtime::observe_binding(&vm).await,
            maka_code_runtime::RuntimeVmObservation::Alive
        ));
        values(f, &session).await?;
        let view = f.state.frontier(run).await?;
        assert!(view.terminal.is_none() && view.blockers.is_empty());
        let mut refs: Vec<ContentRef> = view.spec.content_refs().into_iter().cloned().collect();
        for record in &facts {
            refs.extend(record.fact.content_refs().into_iter().cloned());
            if let Fact::StepPrepared { step, .. } = &record.fact {
                refs.extend(
                    f.state
                        .request(run, *step)
                        .await?
                        .content_refs()
                        .into_iter()
                        .cloned(),
                );
            }
        }
        let mut blobs: Vec<FrozenBytes> = Vec::new();
        for reference in refs {
            if !blobs.iter().any(|blob| blob.reference == reference) {
                let bytes = f.state.content(run, reference.clone()).await?;
                blobs.push(FrozenBytes { reference, bytes });
            }
        }
        let intent = original_intent(&f.root, &reference).await?;
        let sdk = f
            .root
            .data_writer()?
            .query(OriginalRecord(reference))
            .await?;
        assert_eq!(
            serde_json::from_slice::<Value>(&sdk.request)?["input"],
            child_input()
        );
        let describe_calls = effects.descriptions.load(Ordering::SeqCst);
        assert_eq!(
            describe_calls, 1,
            "the accepted Cell called the real finite Query once"
        );
        let draft_describe_calls = effects.draft_descriptions.load(Ordering::SeqCst);
        assert_eq!(
            draft_describe_calls, 1,
            "the abandoned Cell actually staged a distinct loaded name before counter"
        );
        Ok(Boundary {
            session,
            run,
            accepted,
            running,
            child,
            vm,
            facts,
            blobs,
            reply,
            intent,
            sdk,
            describe_calls,
            draft_describe_calls,
        })
    }

    async fn reconcile(f: &NativeFixture, original: Boundary) -> Result<Reconciled> {
        let view = f.wait_terminal(original.run).await?;
        assert_eq!(view.terminal, Some(Terminal::Completed));
        assert!(
            view.blockers.is_empty(),
            "known-but-unreceived child evidence is not unknown provider effects"
        );
        assert_eq!(
            f.state.runs(original.session.clone(), None, 8).await?,
            vec![original.run]
        );
        values(f, &original.session).await?;
        let facts = history(&f.state, original.run).await?;
        assert_eq!(&facts[..original.facts.len()], original.facts.as_slice());
        for blob in &original.blobs {
            assert_eq!(
                f.state
                    .content(original.run, blob.reference.clone())
                    .await?,
                blob.bytes
            );
        }

        assert!(matches!(
            maka_code_runtime::observe_binding(&original.vm).await,
            maka_code_runtime::RuntimeVmObservation::Gone(_)
        ));
        assert_eq!(
            original_intent(&f.root, &original.reply.reference).await?,
            original.intent
        );
        assert_eq!(
            f.root
                .data_writer()?
                .query(OriginalRecord(original.reply.reference.clone()))
                .await?,
            original.sdk
        );
        assert_eq!(
            serde_json::to_value(returned(&f.root, &original.reply.reference).await?)?,
            serde_json::to_value(&original.reply)?
        );
        let cell = f
            .state
            .cells()
            .read(&original.session, original.running)
            .await?
            .ok_or("interrupted Cell is missing")?;
        let CellStatus::Interrupted { report } = cell.status else {
            return Err("the original running VM did not become Interrupted".into());
        };
        let report_bytes = f
            .state
            .cells()
            .content(&original.session, original.running, report.clone())
            .await?;
        let interrupted: CellInterruption = serde_json::from_slice(&report_bytes)?;
        assert_eq!(interrupted.cell, original.running);
        assert_eq!(interrupted.children.len(), 2);
        assert!(
            interrupted
                .children
                .values()
                .all(|child| child.known() && child.physical_cleanup_confirmed())
        );
        let child = &interrupted.children[&original.child];
        assert!(child.known() && child.physical_cleanup_confirmed());
        assert_eq!(child.reference.as_ref(), Some(&original.reply.reference));
        assert_eq!(
            serde_json::to_value(
                child
                    .reply
                    .as_ref()
                    .ok_or("known child lost original SDK reply")?
            )?,
            serde_json::to_value(&original.reply)?
        );
        assert_eq!(
            facts
                .iter()
                .filter(|record| matches!(&record.fact,
            Fact::Cell { event: CellEvent::ChildAdmitted { cell, operation } }
                if *cell == original.running && *operation == original.child))
                .count(),
            1
        );
        assert_eq!(
            facts
                .iter()
                .filter(|record| matches!(&record.fact,
            Fact::Cell { event: CellEvent::ChildObserved { cell, operation, reply } }
                if *cell == original.running && *operation == original.child
                    && reply.reference == original.reply.reference))
                .count(),
            1
        );
        assert!(!facts.iter().any(|record| matches!(&record.fact,
            Fact::Cell { event: CellEvent::SessionValuePublished { cell, .. } | CellEvent::LoadedToolsPublished { cell, .. } | CellEvent::Completed { cell, .. } }
                if *cell == original.running)), "no abandoned draft or normal completion may publish");
        let notifications: Vec<_> = facts
            .iter()
            .filter_map(|record| match &record.fact {
                Fact::Cell {
                    event:
                        CellEvent::FinalNotificationQueued {
                            cell, notification, ..
                        },
                } if *cell == original.running => Some(*notification),
                _ => None,
            })
            .collect();
        assert_eq!(notifications.len(), 1);
        let notification = notifications[0];
        assert_eq!(
            facts
                .iter()
                .filter(|record| matches!(&record.fact,
            Fact::Cell { event: CellEvent::NotificationConsumed { cell, notification: id, .. } }
                if *cell == original.running && *id == notification))
                .count(),
            1
        );
        let wait_result = facts
            .iter()
            .find_map(|record| match &record.fact {
                Fact::LocalToolReturned { tool, result, .. } if tool.call == WAIT => {
                    Some(result.clone())
                }
                _ => None,
            })
            .ok_or("the model did not execute a real wait for the original Cell")?;
        let waited: ToolReturn<ReturnedToolResult> =
            serde_json::from_slice(&f.state.content(original.run, wait_result).await?)?;
        match waited.body.output {
            ToolOutput::Cell(waited) => {
                assert_eq!(waited.cell, original.running);
                assert_eq!(
                    waited.state,
                    CellReplyState::Interrupted {
                        report: report.clone()
                    }
                );
            }
            _ => return Err("wait lost its persistent Interrupted report".into()),
        }
        assert_eq!(
            facts
                .iter()
                .filter(|record| matches!(
                    &record.fact,
                    Fact::Cell {
                        event: CellEvent::Started { .. }
                    }
                ))
                .count(),
            3,
            "only the accepted Cell, original interrupted Cell, and new verification Cell may exist"
        );
        assert_eq!(
            facts
                .iter()
                .filter(|record| matches!(&record.fact,
            Fact::Cell { event: CellEvent::Interrupted { cell, .. } } if *cell == original.running))
                .count(),
            1
        );
        Ok(Reconciled {
            original,
            facts,
            report,
            report_bytes,
            notification,
        })
    }

    async fn release_counter_after_model_cleanup(
        f: &NativeFixture,
        run: RunId,
        release: oneshot::Sender<()>,
    ) -> Result<()> {
        let mut changes = f.state.subscribe()?;
        changes.borrow_and_update();
        let mut page = f.state.history(run, 0, 256).await?;
        let attempt = page
            .iter()
            .find_map(|record| match &record.fact {
                Fact::Cell {
                    event:
                        CellEvent::Started {
                            owner: CellOwner::Agent { link, call },
                            ..
                        },
                } if link.run == run && call == SECOND => Some(link.attempt),
                _ => None,
            })
            .ok_or("the original second Cell is absent from the canonical fixture prefix")?;
        let mut after = 0;
        loop {
            if page.iter().any(|record| matches!(&record.fact,
                Fact::ModelCleanupObserved { attempt: cleaned, cleanup: OperationCleanup::Confirmed }
                    if *cleaned == attempt)) {
                release.send(()).map_err(|_| "the original counter return gate disappeared")?;
                return Ok(());
            }
            if let Some(last) = page.last() {
                after = last.revision;
            }
            changes.borrow_and_update();
            page = f.state.history(run, after, 256).await?;
            if page.is_empty() {
                changes.changed().await?;
            }
        }
    }

    pub(super) async fn worker(boot: Boot, control: &mut cold_host::Channel) -> Result<()> {
        let (entered, mut references) = mpsc::unbounded_channel();
        let (mut release_counter, counter_release) =
            if matches!(&boot.phase, Phase::CellFirst | Phase::PythonFirst) {
                let (release, waiting) = oneshot::channel();
                (Some(release), Some(waiting))
            } else {
                (None, None)
            };
        let effects = Arc::new(Effects {
            counter: Counter {
                http: boot.http,
                entered,
                expected: child_input(),
            },
            counter_release: Mutex::new(counter_release),
            descriptions: AtomicUsize::new(0),
            draft_descriptions: AtomicUsize::new(0),
        });
        let service = if matches!(&boot.phase, Phase::PackageRecover(_)) {
            FixtureService::from_provider(
                Effects::contract(),
                REPLACEMENT,
                "Tools",
                replacement_registry,
            )
        } else {
            effects.service()
        };
        let fixture =
            NativeFixture::open_with_service(&boot.directory, config(&boot.workspace), service)
                .await?;
        match boot.phase {
            Phase::CellFirst => {
                let (barrier, arrived) = oneshot::channel();
                fixture
                    .root
                    .data_writer()?
                    .write(HoldChildT2(barrier))
                    .await?;
                let model = code_model(&fixture, boot.http).await?;
                let session = fixture
                    .create(
                        "Accepted and live Cell cold recovery",
                        &boot.workspace,
                        Some(BackendPreference::Model {
                            connection_id: model.connection_id,
                            model_id: model.model_id,
                            thinking_level: None,
                        }),
                    )
                    .await?;
                let accepted = fixture
                    .send(
                        &session,
                        "Commit one Cell, then leave another live after one counter mutation.",
                        None,
                    )
                    .await?;
                let run = delivered(&fixture.state, &session, accepted).await?;
                let reference = references
                    .recv()
                    .await
                    .ok_or("nested provider never entered")?;
                release_counter_after_model_cleanup(
                    &fixture,
                    run,
                    release_counter
                        .take()
                        .expect("first Host owns the counter gate"),
                )
                .await?;
                arrived.await?;
                control
                    .send(&capture(&fixture, &effects, session, run, reference).await?)
                    .await?;
                control.receive::<()>().await?;
                return Err("the live-VM Host must be killed at the SQL barrier".into());
            }
            Phase::CellRecover(original) | Phase::PythonRecover(original) => {
                let reconciled = reconcile(&fixture, *original).await?;
                assert_eq!(
                    effects.descriptions.load(Ordering::SeqCst),
                    0,
                    "cold recovery does not rerun the accepted Query"
                );
                assert_eq!(
                    effects.draft_descriptions.load(Ordering::SeqCst),
                    0,
                    "cold recovery does not replay the abandoned VM's Query"
                );
                control.send(&reconciled).await?;
            }
            Phase::CellReopen(reconciled) | Phase::PythonReopen(reconciled) => {
                let original = &reconciled.original;
                let facts = history(&fixture.state, original.run).await?;
                assert_eq!(
                    &facts[..reconciled.facts.len()],
                    reconciled.facts.as_slice()
                );
                // Terminal business output is not proof that all later cleanup
                // metadata has ended. Preserve its cut, but count the original
                // durable notification over the entire newly observed history.
                assert_eq!(
                    facts
                        .iter()
                        .filter(|record| matches!(&record.fact,
                    Fact::Cell { event: CellEvent::FinalNotificationQueued { cell, .. } }
                        if *cell == original.running))
                        .count(),
                    1
                );
                assert_eq!(
                    facts
                        .iter()
                        .filter(|record| matches!(&record.fact,
                    Fact::Cell { event: CellEvent::NotificationConsumed { cell, notification, .. } }
                        if *cell == original.running && *notification == reconciled.notification))
                        .count(),
                    1
                );
                assert_eq!(
                    fixture
                        .root
                        .data_writer()?
                        .query(OriginalRecord(original.reply.reference.clone()))
                        .await?,
                    original.sdk
                );
                values(&fixture, &original.session).await?;
                let cell = fixture
                    .state
                    .cells()
                    .read(&original.session, original.running)
                    .await?
                    .ok_or("original Cell is missing on second reopen")?;
                assert_eq!(
                    cell.status,
                    CellStatus::Interrupted {
                        report: reconciled.report.clone()
                    }
                );
                assert_eq!(
                    fixture
                        .state
                        .cells()
                        .content(
                            &original.session,
                            original.running,
                            reconciled.report.clone()
                        )
                        .await?,
                    reconciled.report_bytes
                );
                assert!(
                    fixture
                        .state
                        .cells()
                        .notifications(original.run, None, 128)
                        .await?
                        .is_empty()
                );
                assert_eq!(effects.descriptions.load(Ordering::SeqCst), 0);
                assert_eq!(effects.draft_descriptions.load(Ordering::SeqCst), 0);
                control.send(&reconciled.notification).await?;
            }
            Phase::PythonFirst => {
                let (barrier, arrived) = oneshot::channel();
                fixture
                    .root
                    .data_writer()?
                    .write(HoldChildT2(barrier))
                    .await?;
                let model = code_model_language(&fixture, boot.http, CodeLanguage::Python).await?;
                let session = fixture
                    .create(
                        "Python owned-worker cold recovery",
                        &boot.workspace,
                        Some(BackendPreference::Model {
                            connection_id: model.connection_id,
                            model_id: model.model_id,
                            thinking_level: None,
                        }),
                    )
                    .await?;
                let accepted = fixture
                    .send(
                        &session,
                        "Commit one Cell, then leave another live after one counter mutation.",
                        None,
                    )
                    .await?;
                let run = delivered(&fixture.state, &session, accepted).await?;
                let reference = references
                    .recv()
                    .await
                    .ok_or("the actual Python VM never invoked counter")?;
                release_counter_after_model_cleanup(
                    &fixture,
                    run,
                    release_counter
                        .take()
                        .expect("first Python Host owns the counter gate"),
                )
                .await?;
                arrived.await?;
                let before = capture_vm(
                    &fixture,
                    &effects,
                    session,
                    run,
                    reference,
                    maka_code_runtime::PYTHON_VM,
                )
                .await?;
                let accepted = fixture
                    .state
                    .cells()
                    .read(&before.session, before.accepted)
                    .await?
                    .ok_or("accepted Python Cell is missing")?;
                let accepted_vm = accepted
                    .vm
                    .ok_or("accepted Python Cell has no actual binding")?;
                assert_eq!(accepted_vm.runtime, maka_code_runtime::PYTHON_VM);
                assert_eq!(accepted_vm.version, maka_code_runtime::VM_BINDING_VERSION);
                let process: maka_process::lifetime::ProcessIdentity =
                    serde_json::from_value(before.vm.descriptor["process"].clone())?;
                assert_ne!(
                    process.pid(),
                    std::process::id(),
                    "Monty is an actual separate worker, not the Host or standalone fixture"
                );
                assert!(
                    !serde_json::from_value::<Uuid>(before.vm.descriptor["job_nonce"].clone())?
                        .is_nil()
                );
                control.send(&before).await?;
                control.receive::<()>().await?;
                return Err(
                    "only the original owned Host/Python tree may be killed at this barrier".into(),
                );
            }
            Phase::CellUnknownFirst => {
                let model = code_model(&fixture, boot.http).await?;
                let session = fixture
                    .create(
                        "Unresolved original counter after physical VM loss",
                        &boot.workspace,
                        Some(BackendPreference::Model {
                            connection_id: model.connection_id,
                            model_id: model.model_id,
                            thinking_level: None,
                        }),
                    )
                    .await?;
                let accepted = fixture
                    .send(
                        &session,
                        "Commit one Cell, then leave another live after one counter mutation.",
                        None,
                    )
                    .await?;
                let run = delivered(&fixture.state, &session, accepted).await?;
                let reference = references
                    .recv()
                    .await
                    .ok_or("original nested provider never entered")?;
                control.send(&reference).await?;
                // Parent releases only this observation, not the business HTTP
                // result: its external count and third Main are already present.
                control.receive::<()>().await?;
                control
                    .send(&capture_unknown(&fixture, &effects, session, run, reference).await?)
                    .await?;
                control.receive::<()>().await?;
                return Err("the original unknown-effect Host must be killed without releasing its provider".into());
            }
            Phase::CellUnknownRecover(original) => {
                let blocked = unresolved(&fixture, *original).await?;
                assert_eq!(effects.descriptions.load(Ordering::SeqCst), 0);
                assert_eq!(effects.draft_descriptions.load(Ordering::SeqCst), 0);
                control.send(&blocked).await?;
                control.receive::<()>().await?;
                return Err(
                    "the unresolved original stays retained; no graceful EOF is inferred".into(),
                );
            }
            Phase::CellUnknownReopen(prior) => {
                let blocked = unresolved(&fixture, prior.original.clone()).await?;
                assert_eq!(blocked.blocker, prior.blocker);
                assert_eq!(&blocked.facts[..prior.facts.len()], prior.facts.as_slice());
                assert_eq!(blocked.report, prior.report);
                assert_eq!(blocked.report_bytes, prior.report_bytes);
                assert_eq!(effects.descriptions.load(Ordering::SeqCst), 0);
                assert_eq!(effects.draft_descriptions.load(Ordering::SeqCst), 0);
                control.send(&blocked.blocker).await?;
                control.receive::<()>().await?;
                return Err(
                    "the second unresolved reopen is killed without claiming cleanup".into(),
                );
            }
            Phase::StopFirst => {
                // No SQL trigger here: Stop must be able to use the real writer.
                let model = code_model(&fixture, boot.http).await?;
                let session = fixture
                    .create(
                        "Cold original Stop with unresolved physical effect",
                        &boot.workspace,
                        Some(BackendPreference::Model {
                            connection_id: model.connection_id,
                            model_id: model.model_id,
                            thinking_level: None,
                        }),
                    )
                    .await?;
                let accepted = fixture
                    .send(
                        &session,
                        "Commit one Cell, then leave another live after one counter mutation.",
                        None,
                    )
                    .await?;
                let run = delivered(&fixture.state, &session, accepted).await?;
                let reference = references
                    .recv()
                    .await
                    .ok_or("the original pre-Stop counter never entered")?;
                control.send(&reference).await?;
                control.receive::<()>().await?;
                let original = capture_unknown(&fixture, &effects, session, run, reference).await?;
                let stop = capture_stop(&fixture, original).await?;
                control.send(&stop).await?;
                control.receive::<()>().await?;
                return Err("the stopped original is killed only after its real Stop receipt and control fact commit".into());
            }
            Phase::StopRecover(original) => {
                let stopped = stopped_original(&fixture, *original).await?;
                assert_eq!(effects.descriptions.load(Ordering::SeqCst), 0);
                assert_eq!(effects.draft_descriptions.load(Ordering::SeqCst), 0);
                control.send(&stopped).await?;
                control.receive::<()>().await?;
                return Err("stopped unknown custody is not a graceful EOF".into());
            }
            Phase::StopReopen(prior) => {
                let stopped = stopped_original(&fixture, prior.original.clone()).await?;
                assert_eq!(stopped.blocker, prior.blocker);
                assert_eq!(&stopped.facts[..prior.facts.len()], prior.facts.as_slice());
                assert_eq!(stopped.report, prior.report);
                assert_eq!(stopped.report_bytes, prior.report_bytes);
                assert_eq!(effects.descriptions.load(Ordering::SeqCst), 0);
                assert_eq!(effects.draft_descriptions.load(Ordering::SeqCst), 0);
                control.send(&stopped.original.stop.id).await?;
                control.receive::<()>().await?;
                return Err(
                    "another cold Root cannot clear the original Stop or invent cleanup".into(),
                );
            }
            Phase::FutureFirst => {
                let model = code_model(&fixture, boot.http).await?;
                let session = fixture
                    .create(
                        "Canonical future RunSpec read boundary",
                        &boot.workspace,
                        Some(BackendPreference::Model {
                            connection_id: model.connection_id,
                            model_id: model.model_id,
                            thinking_level: None,
                        }),
                    )
                    .await?;
                let accepted = fixture
                    .send(
                        &session,
                        "Commit one Cell, then leave another live after one counter mutation.",
                        None,
                    )
                    .await?;
                let run = delivered(&fixture.state, &session, accepted).await?;
                let reference = references
                    .recv()
                    .await
                    .ok_or("future-schema fixture has no real original provider")?;
                control.send(&reference).await?;
                control.receive::<()>().await?;
                let original = capture_unknown(&fixture, &effects, session, run, reference).await?;
                let version = maka_agent_facts::durable::SCHEMA_VERSION + 1;
                let payload = fixture
                    .root
                    .data_writer()?
                    .write(FutureSpec { run, version })
                    .await?;
                let footprint = fixture
                    .root
                    .data_writer()?
                    .query(CanonicalRows(run))
                    .await?;
                control
                    .send(&FutureBoundary {
                        original,
                        version,
                        payload,
                        footprint,
                    })
                    .await?;
                control.receive::<()>().await?;
                return Err("cold-kill after the injected future canonical rows, not before the fault baseline".into());
            }
            Phase::PackageRecover(baseline) => {
                assert_replacement_source(&fixture, &baseline).await?;
                let recovered = unresolved(&fixture, baseline.original.clone()).await?;
                assert_replacement_source(&fixture, &baseline).await?;
                assert_eq!(REPLACEMENT_CALLS.load(Ordering::SeqCst), 0);
                let bound = REPLACEMENT_BOUND.lock().unwrap().clone();
                assert_eq!(
                    bound.len(),
                    1,
                    "App ready must have constructed the actually selected replacement provider"
                );
                control
                    .send(&(recovered, bound, REPLACEMENT_CALLS.load(Ordering::SeqCst)))
                    .await?;
                control.receive::<()>().await?;
                return Err("parent must cold-kill the package recovery observer before settling original Unknown work".into());
            }
            _ => return Err("invalid Cell worker phase".into()),
        }
        control.receive::<()>().await?;
        fixture.shutdown().await?;
        Ok(())
    }

    #[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
    struct PendingSdkRecord {
        request: Vec<u8>,
        outcome: Vec<u8>,
        result: Option<Vec<u8>>,
        cleanup: Vec<u8>,
    }
    struct PendingOriginal(RecoveryRef);
    impl Query for PendingOriginal {
        type Output = PendingSdkRecord;
        fn execute(
            self,
            connection: &rusqlite::Connection,
        ) -> std::result::Result<Self::Output, StoreError> {
            Ok(connection.query_row(
                "SELECT CAST(o.request_json AS BLOB),CAST(o.outcome_json AS BLOB),
                        c.payload,CAST(o.cleanup_json AS BLOB)
                 FROM application_operations o LEFT JOIN contents c ON c.id=o.outcome_content_id
                 WHERE o.deployment=?1 AND o.namespace=?2 AND o.operation=?3",
                rusqlite::params![
                    self.0.source.deployment.to_string(),
                    serde_json::to_string(&self.0.namespace)?,
                    self.0.operation.to_string()
                ],
                |row| {
                    Ok(PendingSdkRecord {
                        request: row.get(0)?,
                        outcome: row.get(1)?,
                        result: row.get(2)?,
                        cleanup: row.get(3)?,
                    })
                },
            )?)
        }
    }
    #[derive(Clone, Debug, Serialize, Deserialize)]
    pub(super) struct UnknownBoundary {
        session: String,
        run: RunId,
        accepted: CellId,
        running: CellId,
        owner: CellOwner,
        source: ContentRef,
        child: Uuid,
        child_input: ContentRef,
        held_attempt: ModelAttemptId,
        held_request: RequestSpec,
        vm: maka_code_runtime::VmBinding,
        facts: Vec<RecordedFact>,
        blobs: Vec<FrozenBytes>,
        reply: OperationReply,
        intent: CallerIntent,
        sdk: PendingSdkRecord,
    }
    #[derive(Clone, Debug, Serialize, Deserialize)]
    pub(super) struct Unresolved {
        original: UnknownBoundary,
        blocker: BlockerId,
        facts: Vec<RecordedFact>,
        report: ContentRef,
        report_bytes: Vec<u8>,
    }
    fn pending_reply(reply: &OperationReply) {
        // Dispatch T0 records this real preview. It says neither NotExecuted nor
        // Returned, and loss of the process does not upgrade SDK cleanup.
        assert!(matches!(
            &reply.receipt,
            Receipt::Recorded {
                outcome: OperationOutcome::Unresolved,
                cleanup: OperationCleanup::Unconfirmed,
            }
        ));
    }
    async fn read_pending(f: &NativeFixture, reference: &RecoveryRef) -> Result<OperationReply> {
        let observation = f
            .root
            .operation(reference)?
            .operation_observation()
            .await?
            .ok_or("the real admitted original SDK operation disappeared")?;
        let reply = OperationReply {
            reference: observation.reference,
            receipt: Receipt::Recorded {
                outcome: observation.outcome,
                cleanup: observation.cleanup,
            },
        };
        pending_reply(&reply);
        Ok(reply)
    }
    async fn capture_unknown(
        f: &NativeFixture,
        effects: &Effects,
        session: String,
        run: RunId,
        reference: RecoveryRef,
    ) -> Result<UnknownBoundary> {
        let reply = read_pending(f, &reference).await?;
        let sdk = f
            .root
            .data_writer()?
            .query(PendingOriginal(reference.clone()))
            .await?;
        assert_eq!(sdk.result, None);
        assert_eq!(
            serde_json::from_slice::<OperationOutcome>(&sdk.outcome)?,
            OperationOutcome::Unresolved
        );
        assert_eq!(
            serde_json::from_slice::<OperationCleanup>(&sdk.cleanup)?,
            OperationCleanup::Unconfirmed
        );
        assert_eq!(
            serde_json::from_slice::<Value>(&sdk.request)?["input"],
            child_input()
        );
        let intent = original_intent(&f.root, &reference).await?;
        let facts = history(&f.state, run).await?;
        let cell = |call: &str| {
            facts.iter().find_map(|record| match &record.fact {
                Fact::Cell {
                    event:
                        CellEvent::Started {
                            cell,
                            owner: CellOwner::Agent { link, call: name },
                            ..
                        },
                } if link.run == run && name == call => Some(*cell),
                _ => None,
            })
        };
        let accepted = cell(FIRST).ok_or("the accepted original Cell is missing")?;
        let running = cell(SECOND).ok_or("the pending original Cell is missing")?;
        let first = f
            .state
            .cells()
            .read(&session, accepted)
            .await?
            .ok_or("accepted Cell projection is missing")?;
        assert!(matches!(
            first.status,
            CellStatus::Completed { accepted: true, .. }
        ));
        let view = f
            .state
            .cells()
            .read(&session, running)
            .await?
            .ok_or("running Cell projection is missing")?;
        assert!(matches!(view.status, CellStatus::Running));
        assert!(view.vm_uncertainty.is_none());
        assert_eq!(view.children.len(), 2);
        let (&child, pending) = view
            .children
            .iter()
            .find(|(_, child)| child.name == "counter")
            .ok_or("the real nested counter admission is missing")?;
        assert!(pending.admitted && pending.reference.is_none() && pending.reply.is_none());
        assert!(pending.provider_result.is_none() && pending.local_result.is_none());
        assert!(!pending.known() && !pending.physical_cleanup_confirmed());
        assert_eq!(
            f.state
                .cells()
                .content(&session, running, pending.input.clone())
                .await?,
            serde_json::to_vec(&child_input())?
        );
        assert!(
            view.children
                .iter()
                .filter(|(id, _)| **id != child)
                .all(|(_, child)| child.name == "draft_describe"
                    && child.known()
                    && child.physical_cleanup_confirmed())
        );
        let parent = facts
            .iter()
            .find_map(|record| match &record.fact {
                Fact::ToolResultAccepted { tool, .. } if tool.call == SECOND => Some(tool.clone()),
                _ => None,
            })
            .ok_or("the original exec Running parent T2 did not commit")?;
        let result = facts
            .iter()
            .find_map(|record| match &record.fact {
                Fact::LocalToolReturned {
                    tool,
                    result,
                    is_error: false,
                    ..
                } if tool == &parent => Some(result.clone()),
                _ => None,
            })
            .ok_or("the actual Running result is missing")?;
        let returned: ToolReturn<ReturnedToolResult> =
            serde_json::from_slice(&f.state.content(run, result).await?)?;
        match returned.body.output {
            ToolOutput::Cell(reply) => {
                assert_eq!(reply.cell, running);
                assert_eq!(reply.state, CellReplyState::Running);
            }
            _ => return Err("the original exec was not a live Running Cell".into()),
        }
        let (held_attempt, held_step) = facts
            .iter()
            .filter_map(|record| match &record.fact {
                Fact::ModelAttemptPrepared { attempt, step } => Some((*attempt, *step)),
                _ => None,
            })
            .last()
            .ok_or("the original held Main has no frozen attempt")?;
        assert_eq!(
            facts
                .iter()
                .filter(|record| matches!(record.fact, Fact::ModelAttemptAdmitted { .. }))
                .count(),
            3
        );
        assert!(!facts.iter().any(|record| matches!(&record.fact,
            Fact::ModelObserved { attempt, .. } | Fact::ModelClosed { attempt, .. } if *attempt == held_attempt)));
        assert!(!facts.iter().any(|record| matches!(&record.fact,
            Fact::Cell { event: CellEvent::ChildObserved { cell, operation, .. } | CellEvent::ChildResultRecorded { cell, operation, .. } }
                if *cell == running && *operation == child)));
        let held_request = f.state.request(run, held_step).await?;
        let contract: Value = serde_json::from_slice(
            &f.state
                .content(run, held_request.recovery_contract.clone())
                .await?,
        )?;
        assert_eq!(
            contract["contract"],
            json!({"protocol":"maka.adapter.chat-completions.local-functions","version":1})
        );
        let binding = view
            .vm
            .as_ref()
            .ok_or("the live original VM has no recorded binding")?;
        let vm = maka_code_runtime::VmBinding {
            runtime: binding.runtime.clone(),
            version: binding.version,
            descriptor: serde_json::from_slice(
                &f.state
                    .cells()
                    .content(&session, running, binding.descriptor.clone())
                    .await?,
            )?,
        };
        assert_eq!(vm.runtime, maka_code_runtime::JAVASCRIPT_VM);
        assert!(matches!(
            maka_code_runtime::observe_binding(&vm).await,
            maka_code_runtime::RuntimeVmObservation::Alive
        ));
        values(f, &session).await?;
        assert_eq!(effects.descriptions.load(Ordering::SeqCst), 1);
        assert_eq!(effects.draft_descriptions.load(Ordering::SeqCst), 1);
        let frontier = f.state.frontier(run).await?;
        assert!(frontier.terminal.is_none() && frontier.blockers.is_empty());
        let mut refs: Vec<_> = frontier.spec.content_refs().into_iter().cloned().collect();
        for record in &facts {
            refs.extend(record.fact.content_refs().into_iter().cloned());
            if let Fact::StepPrepared { step, .. } = &record.fact {
                refs.extend(
                    f.state
                        .request(run, *step)
                        .await?
                        .content_refs()
                        .into_iter()
                        .cloned(),
                );
            }
        }
        let mut blobs: Vec<FrozenBytes> = Vec::new();
        for reference in refs {
            if !blobs.iter().any(|blob| blob.reference == reference) {
                blobs.push(FrozenBytes {
                    bytes: f.state.content(run, reference.clone()).await?,
                    reference,
                });
            }
        }
        Ok(UnknownBoundary {
            session,
            run,
            accepted,
            running,
            owner: view.owner,
            source: view.source,
            child,
            child_input: pending.input.clone(),
            held_attempt,
            held_request,
            vm,
            facts,
            blobs,
            reply,
            intent,
            sdk,
        })
    }
    async fn unresolved(f: &NativeFixture, original: UnknownBoundary) -> Result<Unresolved> {
        let reason = BlockerKind::CodeCellRecoveryUnavailable {
            cell: original.running.to_string(),
        };
        let mut changes = f.state.subscribe()?;
        let blocker = loop {
            changes.borrow_and_update();
            let view = f.state.frontier(original.run).await?;
            assert!(
                view.terminal.is_none(),
                "original unresolved effects must not be completed or cancelled implicitly"
            );
            let active: Vec<_> = view
                .blockers
                .iter()
                .filter(|(_, blocker)| blocker.decision.is_none() && blocker.resolved_by.is_none())
                .collect();
            for (_, blocker) in &active {
                assert_eq!(
                    blocker.reason, reason,
                    "an unrelated or Unsupported blocker is not unknown-effect recovery"
                );
            }
            if let Some((id, _)) = active.first() {
                break **id;
            }
            changes.changed().await?;
        };
        let facts = history(&f.state, original.run).await?;
        assert_eq!(&facts[..original.facts.len()], original.facts.as_slice());
        assert_eq!(
            f.state.runs(original.session.clone(), None, 8).await?,
            vec![original.run]
        );
        assert_eq!(
            f.state
                .request(original.run, original.held_request.step)
                .await?,
            original.held_request
        );
        for blob in &original.blobs {
            assert_eq!(
                f.state
                    .content(original.run, blob.reference.clone())
                    .await?,
                blob.bytes
            );
        }
        assert_eq!(
            original_intent(&f.root, &original.reply.reference).await?,
            original.intent
        );
        assert_eq!(
            serde_json::to_value(read_pending(f, &original.reply.reference).await?)?,
            serde_json::to_value(&original.reply)?
        );
        assert_eq!(
            f.root
                .data_writer()?
                .query(PendingOriginal(original.reply.reference.clone()))
                .await?,
            original.sdk
        );
        values(f, &original.session).await?;
        let first = f
            .state
            .cells()
            .read(&original.session, original.accepted)
            .await?
            .ok_or("the accepted Cell disappeared")?;
        assert!(matches!(
            first.status,
            CellStatus::Completed { accepted: true, .. }
        ));
        let cell = f
            .state
            .cells()
            .read(&original.session, original.running)
            .await?
            .ok_or("the original Cell disappeared")?;
        assert_eq!(cell.owner, original.owner);
        assert_eq!(cell.source, original.source);
        assert!(matches!(
            maka_code_runtime::observe_binding(&original.vm).await,
            maka_code_runtime::RuntimeVmObservation::Gone(_)
        ));
        let CellStatus::Interrupted { report } = &cell.status else {
            return Err(
                "the exact blocker must follow actual VM closure and original-child observation"
                    .into(),
            );
        };
        assert!(cell.vm_uncertainty.is_none());
        assert!(
            cell.pending() && cell.blocks_effect_admission() && !cell.physical_cleanup_confirmed()
        );
        assert!(cell.final_notification.is_none() && cell.notifications.is_empty());
        assert_eq!(cell.children.len(), 2);
        let child = &cell.children[&original.child];
        assert_eq!(child.name, "counter");
        assert_eq!(child.input, original.child_input);
        assert_eq!(child.reference.as_ref(), Some(&original.reply.reference));
        assert!(!child.known() && !child.physical_cleanup_confirmed());
        assert!(child.admitted && child.provider_result.is_none() && child.local_result.is_none());
        let reply = child
            .reply
            .as_ref()
            .ok_or("the original SDK Unresolved observation was not recorded")?;
        pending_reply(reply);
        assert_eq!(
            serde_json::to_value(reply)?,
            serde_json::to_value(&original.reply)?
        );
        let report_bytes = f
            .state
            .cells()
            .content(&original.session, original.running, report.clone())
            .await?;
        let interrupted: CellInterruption = serde_json::from_slice(&report_bytes)?;
        assert_eq!(interrupted.cell, original.running);
        assert_eq!(interrupted.children, cell.children);
        assert_eq!(
            facts
                .iter()
                .filter(|record| matches!(&record.fact,
            Fact::Blocked { blocker: id, reason: why } if *id == blocker && why == &reason))
                .count(),
            1
        );
        assert_eq!(
            facts
                .iter()
                .filter(|record| matches!(&record.fact,
            Fact::Cell { event: CellEvent::ChildAdmitted { cell, operation } }
                if *cell == original.running && *operation == original.child))
                .count(),
            1
        );
        assert_eq!(
            facts
                .iter()
                .filter(|record| matches!(&record.fact,
            Fact::Cell { event: CellEvent::ChildObserved { cell, operation, .. } }
                if *cell == original.running && *operation == original.child))
                .count(),
            1
        );
        assert!(
            !facts[original.facts.len()..].iter().any(|record| matches!(
                &record.fact,
                Fact::StepPrepared { .. }
                    | Fact::ModelAttemptPrepared { .. }
                    | Fact::ModelAttemptAdmitted { .. }
                    | Fact::ToolAdmitted { .. }
                    | Fact::RiskAdjudicated { .. }
                    | Fact::RunTerminated { .. }
            )),
            "a retained unknown-effect obligation blocks new generation, dispatch and automatic risk escape"
        );
        assert!(!facts.iter().any(|record| matches!(&record.fact,
            Fact::Cell { event: CellEvent::Completed { cell, .. } | CellEvent::ResultAccepted { cell }
                | CellEvent::SessionValuePublished { cell, .. } | CellEvent::LoadedToolsPublished { cell, .. }
                | CellEvent::FinalNotificationQueued { cell, .. } } if *cell == original.running)));
        assert!(!facts.iter().any(|record| matches!(&record.fact,
            Fact::Cell { event: CellEvent::ChildResultRecorded { cell, operation, .. } }
                if *cell == original.running && *operation == original.child)));
        assert_eq!(
            facts
                .iter()
                .filter(|record| matches!(
                    &record.fact,
                    Fact::Cell {
                        event: CellEvent::Started { .. }
                    }
                ))
                .count(),
            2
        );
        assert_eq!(
            facts
                .iter()
                .filter(|record| matches!(&record.fact, Fact::ModelAttemptAdmitted { .. }))
                .count(),
            3
        );
        let report = report.clone();
        Ok(Unresolved {
            original,
            blocker,
            facts,
            report,
            report_bytes,
        })
    }

    #[derive(Default)]
    struct Seen {
        effects: Vec<Value>,
        models: Vec<Value>,
        running: Option<CellId>,
    }
    struct Server {
        seen: Mutex<Seen>,
    }
    async fn counter(State(server): State<Arc<Server>>, body: Bytes) -> axum::response::Response {
        let input: Value = serde_json::from_slice(&body).unwrap();
        let count = {
            let mut seen = server.seen.lock().unwrap();
            seen.effects.push(input.clone());
            seen.effects.len()
        };
        (
            [(header::CONTENT_TYPE, "application/json")],
            serde_json::to_vec(&json!({
                "receipt":format!("external-counter:{count}"),"input":input["input"]
            }))
            .unwrap(),
        )
            .into_response()
    }
    fn sse(call: Option<(&str, &str, Value)>) -> axum::response::Response {
        let tool = call.is_some();
        let delta = match call {
            Some((id, name, input)) => {
                json!({"tool_calls":[{"index":0,"id":id,"type":"function","function":{"name":name,"arguments":input.to_string()}}]})
            }
            None => json!({"content":FINAL}),
        };
        let event = json!({"id":"cell-reply","object":"chat.completion.chunk","created":1,"model":"gpt-4.1",
            "choices":[{"index":0,"delta":delta,"finish_reason":null}]});
        let end = json!({"id":"cell-reply","object":"chat.completion.chunk","created":1,"model":"gpt-4.1",
            "choices":[{"index":0,"delta":{},"finish_reason":if tool {"tool_calls"} else {"stop"}}],
            "usage":{"prompt_tokens":4,"completion_tokens":3,"total_tokens":7}});
        (
            [(header::CONTENT_TYPE, "text/event-stream")],
            format!("data: {event}\n\ndata: {end}\n\ndata: [DONE]\n\n"),
        )
            .into_response()
    }
    async fn model(State(server): State<Arc<Server>>, body: Bytes) -> axum::response::Response {
        let input: Value = serde_json::from_slice(&body).unwrap();
        let (index, running) = {
            let mut seen = server.seen.lock().unwrap();
            seen.models.push(input);
            (seen.models.len(), seen.running)
        };
        match index {
            1 => sse(Some((
                FIRST,
                "exec",
                json!({"code":format!("{SETUP} text({{cellFixtureVmObservation:{{catalog:ALL_TOOLS.filter(t => t.name === 'describe' || t.name === 'draft_describe').map(t => ({{name:t.name,description:t.description}}))}}}});")}),
            ))),
            2 => sse(Some((
                SECOND,
                "exec",
                json!({"code":DRAFT,"yield_time_ms":30000}),
            ))),
            3 => sse(Some((
                WAIT,
                "wait",
                json!({"cell_id":running.expect("parent bound the original running Cell before restarting"),"yield_time_ms":0}),
            ))),
            4 => sse(Some((VERIFY, "exec", json!({"code":CHECK})))),
            _ => sse(None),
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn accepted_state_survives_live_vm_loss_and_known_nested_effect_is_not_repeated()
    -> Result<()> {
        let directory = tempfile::tempdir()?;
        let workspace = directory.path().join("workspace");
        tokio::fs::create_dir(&workspace).await?;
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let http = listener.local_addr()?;
        let server = Arc::new(Server {
            seen: Mutex::new(Seen::default()),
        });
        let router = Router::new()
            .route("/effect", post(counter))
            .route("/v1/chat/completions", post(model))
            .with_state(server.clone());
        let (stop, stopped) = oneshot::channel();
        let http_task = tokio::spawn(async move {
            axum::serve(listener, router)
                .with_graceful_shutdown(async {
                    let _ = stopped.await;
                })
                .await
        });
        let mut hosts: [Option<ColdHost>; 3] = [None, None, None];
        let outcome =
            std::panic::AssertUnwindSafe(tokio::time::timeout(Duration::from_secs(90), async {
                hosts[0] = Some(
                    ColdHost::spawn(&Boot {
                        directory: directory.path().into(),
                        workspace: workspace.clone(),
                        http,
                        phase: Phase::CellFirst,
                    })
                    .await?,
                );
                let before: Boundary = hosts[0].as_mut().unwrap().receive().await?;
                {
                    let mut seen = server.seen.lock().unwrap();
                    assert_eq!(seen.models.len(), 2);
                    assert_eq!(before.describe_calls, 1);
                    assert_eq!(before.draft_describe_calls, 1);
                    assert_eq!(
                        seen.effects,
                        vec![json!({"reference":before.reply.reference,"input":child_input()})]
                    );
                    seen.running = Some(before.running);
                }
                hosts[0].as_mut().unwrap().kill().await?;
                hosts[1] = Some(
                    ColdHost::spawn(&Boot {
                        directory: directory.path().into(),
                        workspace: workspace.clone(),
                        http,
                        phase: Phase::CellRecover(Box::new(before.clone())),
                    })
                    .await?,
                );
                let recovered: Reconciled = hosts[1].as_mut().unwrap().receive().await?;
                hosts[1].as_mut().unwrap().finish().await?;
                hosts[2] = Some(
                    ColdHost::spawn(&Boot {
                        directory: directory.path().into(),
                        workspace,
                        http,
                        phase: Phase::CellReopen(Box::new(recovered.clone())),
                    })
                    .await?,
                );
                let notification: FactId = hosts[2].as_mut().unwrap().receive().await?;
                assert_eq!(notification, recovered.notification);
                hosts[2].as_mut().unwrap().finish().await?;
                {
                    let seen = server.seen.lock().unwrap();
                    assert_eq!(
                        seen.effects,
                        vec![json!({"reference":before.reply.reference,"input":child_input()})]
                    );
                    assert_eq!(seen.models.len(), 5);
                    let last_tool = |request: &Value| {
                        request["messages"]
                            .as_array()
                            .unwrap()
                            .iter()
                            .rev()
                            .find(|message| message["role"] == "tool")
                            .unwrap()["content"]
                            .as_str()
                            .unwrap()
                            .to_owned()
                    };
                    let waited = last_tool(&seen.models[3]);
                    assert_eq!(
                        serde_json::from_str::<Value>(waited.lines().next().unwrap())?["state"],
                        "interrupted"
                    );
                    let vm_observation = |text: &str| {
                        let parts: Vec<maka_model::prompt::ContentPart> =
                            serde_json::from_str(text).expect("the tool projects a ContentPart array");
                        let mut records = parts.iter().filter_map(|part| match part {
                            maka_model::prompt::ContentPart::Text { text, .. }
                                if text.starts_with("{\"cellFixtureVmObservation\":") => Some(text),
                            _ => None,
                        });
                        let record = records.next().expect("the VM emitted its observation record");
                        assert!(records.next().is_none(), "the VM observation record must be unique");
                        serde_json::from_str::<Value>(record).unwrap()["cellFixtureVmObservation"].clone()
                    };
                    let first = vm_observation(&last_tool(&seen.models[1]));
                    let catalog = first["catalog"].as_array().expect("the first VM emitted its catalog");
                    assert_eq!(
                        catalog.iter().map(|tool| tool["name"].as_str().unwrap()).collect::<Vec<_>>(),
                        vec!["describe", "draft_describe"]
                    );
                    assert!(catalog.iter().all(|tool|
                        !tool["description"].as_str().unwrap().is_empty()));
                    assert_eq!(
                        vm_observation(&last_tool(&seen.models[4])),
                        json!({"a":1,"bMissing":true,"oldHeapMissing":true,"catalog":catalog}),
                        "the fresh VM restores values and the same catalog metadata, not the old heap"
                    );
                }
                Ok::<(), Box<dyn std::error::Error + Send + Sync>>(())
            }))
            .catch_unwind()
            .await;
        let mut cleanup = None;
        for host in hosts.iter_mut().flatten() {
            if let Err(error) = host.terminate().await {
                cleanup.get_or_insert(error);
            }
        }
        let stop_result = stop.send(());
        let server_result = http_task.await;
        match outcome {
            Err(panic) => {
                if let Some(error) = cleanup {
                    eprintln!("cold Cell worker cleanup also failed: {error}");
                }
                std::panic::resume_unwind(panic)
            }
            Ok(result) => {
                if let Some(error) = cleanup {
                    return Err(error);
                }
                stop_result.map_err(|_| "cold Cell HTTP server ended before shutdown")?;
                server_result??;
                result.map_err(|_| "cold running Cell recovery deadline expired; workers were killed and joined")?
            }
        }
    }

    #[derive(Clone, Debug, Serialize, Deserialize)]
    pub(super) struct StopBoundary {
        original: UnknownBoundary,
        stop: RecordedFact,
        snapshot: maka_agent_state::fold::RunView,
        facts: Vec<RecordedFact>,
        reply: OperationReply,
        sdk: SdkRecord,
        intent: CallerIntent,
    }
    #[derive(Clone, Debug, Serialize, Deserialize)]
    pub(super) struct StoppedEvidence {
        original: StopBoundary,
        blocker: BlockerId,
        facts: Vec<RecordedFact>,
        report: ContentRef,
        report_bytes: Vec<u8>,
    }
    async fn capture_stop(f: &NativeFixture, original: UnknownBoundary) -> Result<StopBoundary> {
        let receipt = f
            .mutation(
                "stop",
                json!({"sessionId":original.session,"runId":original.run}),
                Uuid::new_v4(),
            )
            .await?;
        let reply = returned(&f.root, &receipt.reference).await?;
        assert_eq!(success(&reply), &json!({"requested":true}));
        let sdk = f
            .root
            .data_writer()?
            .query(OriginalRecord(reply.reference.clone()))
            .await?;
        let intent = original_intent(&f.root, &reply.reference).await?;
        let snapshot = f.state.frontier(original.run).await?;
        assert!(snapshot.stopped && snapshot.terminal.is_none());
        assert!(
            snapshot.tokens > 0,
            "the two real model uses must not become a zero-cost cold fixture"
        );
        let facts = history(&f.state, original.run).await?;
        assert_eq!(&facts[..original.facts.len()], original.facts.as_slice());
        let stops: Vec<_> = facts
            .iter()
            .filter(|record| matches!(&record.fact, Fact::StopRequested { .. }))
            .cloned()
            .collect();
        assert_eq!(stops.len(), 1);
        let stop = stops[0].clone();
        assert_eq!(snapshot.stop_request, Some(stop.id));
        assert!(
            matches!(&stop.fact, Fact::StopRequested { diagnostic } if diagnostic == "user_requested_stop")
        );
        // Stop's own RPC cleanup is independent of the original counter's
        // effect/cleanup. Its handler still awaits the actual parent's HTTP.
        assert_eq!(
            serde_json::to_value(read_pending(f, &original.reply.reference).await?)?,
            serde_json::to_value(&original.reply)?
        );
        assert_eq!(
            f.root
                .data_writer()?
                .query(PendingOriginal(original.reply.reference.clone()))
                .await?,
            original.sdk
        );
        values(f, &original.session).await?;
        Ok(StopBoundary {
            original,
            stop,
            snapshot,
            facts,
            reply,
            sdk,
            intent,
        })
    }
    async fn stopped_original(f: &NativeFixture, stopped: StopBoundary) -> Result<StoppedEvidence> {
        let original = &stopped.original;
        let reason = BlockerKind::CodeCellRecoveryUnavailable {
            cell: original.running.to_string(),
        };
        let mut changes = f.state.subscribe()?;
        let (view, blocker) = loop {
            changes.borrow_and_update();
            let view = f.state.frontier(original.run).await?;
            assert!(
                view.stopped && view.terminal.is_none(),
                "Stop cannot erase the original unresolved effect or claim terminal cleanup: revision={} stopped={} terminal={:?} control_version={} stop_request={:?} stop_assessed={:?}",
                view.revision,
                view.stopped,
                view.terminal,
                view.control_version,
                view.stop_request,
                view.stop_assessed
            );
            assert_eq!(view.stop_request, Some(stopped.stop.id));
            let blocker = view
                .blockers
                .iter()
                .find(|(_, blocker)| {
                    blocker.reason == reason
                        && blocker.decision.is_none()
                        && blocker.resolved_by.is_none()
                })
                .map(|(id, _)| *id);
            if let Some(blocker) = blocker {
                if view.stop_assessed == Some(stopped.stop.id) {
                    break (view, blocker);
                }
            }
            changes.changed().await?;
        };
        assert_eq!(view.control_version, stopped.snapshot.control_version);
        assert_eq!(view.spec, stopped.snapshot.spec);
        assert!(!view.cancelled_by_risk);
        assert!(view.tokens >= stopped.snapshot.tokens && view.retries >= stopped.snapshot.retries);
        for (id, prior) in &stopped.snapshot.attempts {
            let current = &view.attempts[id];
            assert!(current.observed >= prior.observed);
            if let Some(partial) = &prior.private_partial {
                assert_eq!(current.private_partial.as_ref(), Some(partial));
            }
            if let Some(retry) = &prior.retry {
                assert_eq!(current.retry.as_ref(), Some(retry));
            }
        }
        let held = &view.attempts[&original.held_attempt];
        assert!(
            held.interrupted.is_some() || held.closed.is_some(),
            "durable Stop must fence the originally submitted no-prefix Main"
        );
        let facts = history(&f.state, original.run).await?;
        assert_eq!(&facts[..stopped.facts.len()], stopped.facts.as_slice());
        assert_eq!(
            facts
                .iter()
                .filter(|record| matches!(&record.fact, Fact::StopRequested { .. }))
                .collect::<Vec<_>>(),
            vec![&stopped.stop],
            "the same original Stop ID/time/cut persists; no synthetic replacement control"
        );
        assert!(facts.iter().any(|record| matches!(&record.fact, Fact::StopAssessed { request } if *request == stopped.stop.id)));
        let charged: u64 = facts
            .iter()
            .filter_map(|record| match &record.fact {
                Fact::BudgetCharged { tokens } => Some(*tokens),
                _ => None,
            })
            .sum();
        assert_eq!(view.tokens, charged);
        assert_eq!(
            u64::from(view.retries),
            facts
                .iter()
                .filter(|record| matches!(&record.fact, Fact::RetryCharged { .. }))
                .count() as u64
        );
        assert_eq!(
            f.state.runs(original.session.clone(), None, 8).await?,
            vec![original.run]
        );
        assert_eq!(
            f.state
                .request(original.run, original.held_request.step)
                .await?,
            original.held_request
        );
        for blob in &original.blobs {
            assert_eq!(
                f.state
                    .content(original.run, blob.reference.clone())
                    .await?,
                blob.bytes
            );
        }
        assert_eq!(
            original_intent(&f.root, &stopped.reply.reference).await?,
            stopped.intent
        );
        assert_eq!(
            f.root
                .data_writer()?
                .query(OriginalRecord(stopped.reply.reference.clone()))
                .await?,
            stopped.sdk
        );
        assert_eq!(
            serde_json::to_value(returned(&f.root, &stopped.reply.reference).await?)?,
            serde_json::to_value(&stopped.reply)?
        );
        assert_eq!(
            original_intent(&f.root, &original.reply.reference).await?,
            original.intent
        );
        assert_eq!(
            f.root
                .data_writer()?
                .query(PendingOriginal(original.reply.reference.clone()))
                .await?,
            original.sdk
        );
        assert_eq!(
            serde_json::to_value(read_pending(f, &original.reply.reference).await?)?,
            serde_json::to_value(&original.reply)?
        );
        values(f, &original.session).await?;
        let cell = f
            .state
            .cells()
            .read(&original.session, original.running)
            .await?
            .ok_or("the stopped original Cell is missing")?;
        assert_eq!(cell.owner, original.owner);
        assert_eq!(cell.source, original.source);
        let CellStatus::Interrupted { report } = &cell.status else {
            let status = match &cell.status {
                CellStatus::Running => "running",
                CellStatus::Completed { .. } => "completed",
                CellStatus::Interrupted { .. } => unreachable!(),
            };
            return Err(format!(
                "cold Stop retains the exact interrupted Cell obligation: status={status} vm_uncertainty={:?} revision={} blockers={:?}",
                cell.vm_uncertainty,
                view.revision,
                view.blockers
                    .values()
                    .map(|blocker| format!("{:?}", blocker.reason))
                    .collect::<Vec<_>>(),
            ).into());
        };
        assert!(matches!(
            maka_code_runtime::observe_binding(&original.vm).await,
            maka_code_runtime::RuntimeVmObservation::Gone(_)
        ));
        assert!(
            cell.pending() && cell.blocks_effect_admission() && !cell.physical_cleanup_confirmed()
        );
        assert!(cell.final_notification.is_none());
        let child = &cell.children[&original.child];
        assert_eq!(child.input, original.child_input);
        assert!(child.admitted && !child.known() && !child.physical_cleanup_confirmed());
        assert!(child.provider_result.is_none() && child.local_result.is_none());
        match (&child.reference, &child.reply) {
            (Some(reference), Some(reply)) => {
                assert_eq!(reference, &original.reply.reference);
                pending_reply(reply);
                assert_eq!(
                    serde_json::to_value(reply)?,
                    serde_json::to_value(&original.reply)?
                );
            }
            (None, None) => {
                // A real Stop can close the source VM before crash. The frozen
                // interruption may predate receipt lookup; don't manufacture a
                // ChildObserved or pretend a serialized ref grants new custody.
                let prior_report = stopped
                    .facts
                    .iter()
                    .find_map(|record| match &record.fact {
                        Fact::Cell {
                            event: CellEvent::Interrupted { cell, report },
                        } if *cell == original.running => Some(report.clone()),
                        _ => None,
                    })
                    .ok_or(
                        "an unbound stopped child requires the actual pre-crash Interrupted fact",
                    )?;
                assert_eq!(
                    cell.status,
                    CellStatus::Interrupted {
                        report: prior_report
                    }
                );
            }
            _ => {
                return Err("the original stopped child has inconsistent receipt knowledge".into());
            }
        }
        let report_bytes = f
            .state
            .cells()
            .content(&original.session, original.running, report.clone())
            .await?;
        let interrupted: CellInterruption = serde_json::from_slice(&report_bytes)?;
        assert_eq!(interrupted.cell, original.running);
        assert!(!interrupted.children[&original.child].known());
        assert!(
            !facts[original.facts.len()..].iter().any(|record| matches!(
                &record.fact,
                Fact::StepPrepared { .. }
                    | Fact::ModelAttemptPrepared { .. }
                    | Fact::ModelAttemptAdmitted { .. }
                    | Fact::ToolAdmitted { .. }
                    | Fact::RiskAdjudicated { .. }
                    | Fact::RunTerminated { .. }
            )),
            "a persisted Stop wins without replay, new generation, risk escape or fake terminal cleanup"
        );
        assert_eq!(
            facts
                .iter()
                .filter(|record| matches!(
                    &record.fact,
                    Fact::Cell {
                        event: CellEvent::Started { .. }
                    }
                ))
                .count(),
            2
        );
        assert_eq!(facts.iter().filter(|record| matches!(&record.fact, Fact::Cell { event: CellEvent::ChildAdmitted { cell, operation } }
            if *cell == original.running && *operation == original.child)).count(), 1);
        assert!(!facts.iter().any(|record| matches!(&record.fact, Fact::Cell {
            event: CellEvent::Completed { cell, .. } | CellEvent::ResultAccepted { cell }
                | CellEvent::SessionValuePublished { cell, .. } | CellEvent::LoadedToolsPublished { cell, .. }
                | CellEvent::FinalNotificationQueued { cell, .. } } if *cell == original.running)));
        let report = report.clone();
        Ok(StoppedEvidence {
            original: stopped,
            blocker,
            facts,
            report,
            report_bytes,
        })
    }

    #[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
    struct CanonicalFootprint {
        spec: (u32, String, String, i64),
        facts: Vec<(i64, String, String, i64, u32, i64, i64)>,
        requests: Vec<(String, String, i64)>,
        attempts: Vec<(String, String, String)>,
        contents: Vec<(i64, String, Vec<u8>)>,
    }
    struct CanonicalRows(RunId);
    impl Query for CanonicalRows {
        type Output = CanonicalFootprint;
        fn execute(
            self,
            c: &rusqlite::Connection,
        ) -> std::result::Result<Self::Output, StoreError> {
            let run = self.0.to_string();
            Ok(CanonicalFootprint {
                spec: c.query_row("SELECT schema_version,owner,session,spec_content_id FROM agent_run_specs WHERE run=?", [&run],
                    |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?)))?,
                facts: c.prepare_cached("SELECT sequence,id,run,revision,schema_version,at,body_content_id FROM agent_facts WHERE run=? ORDER BY revision")?
                    .query_map([&run], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?,r.get(6)?)))?
                    .collect::<std::result::Result<Vec<_>,_>>()?,
                requests: c.prepare_cached("SELECT step,run,content_id FROM agent_request_specs WHERE run=? ORDER BY step")?
                    .query_map([&run], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?)))?.collect::<std::result::Result<Vec<_>,_>>()?,
                attempts: c.prepare_cached("SELECT attempt,run,step FROM agent_attempt_ids WHERE run=? ORDER BY attempt")?
                    .query_map([&run], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?)))?.collect::<std::result::Result<Vec<_>,_>>()?,
                contents: c.prepare_cached("SELECT id,content_sha256,payload FROM contents ORDER BY id")?
                    .query_map([], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?)))?.collect::<std::result::Result<Vec<_>,_>>()?,
            })
        }
    }
    struct FutureSpec {
        run: RunId,
        version: u32,
    }
    impl Statement for FutureSpec {
        type Value = FrozenBytes;
        type Output = FrozenBytes;
        fn execute(
            self,
            c: &rusqlite::Connection,
        ) -> std::result::Result<Prepared<Self::Value>, StoreError> {
            let bytes: Vec<u8> = c.query_row("SELECT b.payload FROM agent_run_specs s JOIN contents b ON b.id=s.spec_content_id WHERE s.run=?",
                [self.run.to_string()], |r| r.get(0))?;
            let mut value: Value = serde_json::from_slice(&bytes)?;
            value["schemaVersion"] = json!(self.version);
            value["futureSemantics"] =
                json!({"opaque":"unrecognized π\u{0}😀","instruction":{"mustNotInterpret":true}});
            let bytes = serde_json::to_vec(&value)?;
            let reference = ContentRef {
                digest: maka_agent_facts::artifact::content_digest(&bytes),
                bytes: bytes.len() as u64,
            };
            let id = maka_event_log::content::put(c, &reference.digest, &bytes)?;
            assert_eq!(
                c.execute(
                    "UPDATE agent_run_specs SET schema_version=?,spec_content_id=? WHERE run=?",
                    rusqlite::params![self.version, id, self.run.to_string()]
                )?,
                1
            );
            Ok(Prepared {
                value: FrozenBytes { reference, bytes },
                changed: true,
                notification: Notification::METADATA,
            })
        }
        fn committed(value: Self::Value) -> Self::Output {
            value
        }
        fn isolated_rejection(_: &StoreError) -> bool {
            false
        }
    }
    #[derive(Clone, Debug, Serialize, Deserialize)]
    pub(super) struct FutureBoundary {
        original: UnknownBoundary,
        version: u32,
        payload: FrozenBytes,
        footprint: CanonicalFootprint,
    }
    pub(super) async fn future_read(boot: Boot, control: &mut cold_host::Channel) -> Result<()> {
        let Phase::FutureRead(baseline) = boot.phase else {
            return Err("wrong future-schema reader phase".into());
        };
        // Actual Store read boundary is sufficient here. Do not synthesize an
        // App.ready error, admission, alternate SQLite connection or Root grant.
        let namespaces = maka_event_log::root::RootNamespaces {
            ownership: boot.directory.join("owners"),
            control: boot.directory.join("control"),
        };
        let owner = Arc::new(maka_event_log::root::RootOwner::open_existing(
            &boot.directory.join("root"),
            &namespaces,
        )?);
        let migrations = [
            maka_event_log::ROOT_MIGRATIONS,
            maka_agent_state::MIGRATIONS,
        ]
        .concat();
        let root = RootStore::open(owner, &migrations).await?;
        let data = root.data_writer()?;
        let state = Store::new(
            data.clone(),
            maka_agent_state::DriverDomain::new(data.clone())?,
        )?;
        let error = state
            .frontier(baseline.original.run)
            .await
            .err()
            .ok_or("future canonical Run schema was silently accepted")?;
        let expected = format!("unsupported Agent schema version: {}", baseline.version);
        assert!(
            matches!(&error, StoreError::InvalidTransition(reason) if reason == &expected),
            "wrong read-boundary error: {error}"
        );
        let after = data.query(CanonicalRows(baseline.original.run)).await?;
        assert_eq!(after.spec, baseline.footprint.spec);
        assert_eq!(after.facts, baseline.footprint.facts);
        assert_eq!(after.requests, baseline.footprint.requests);
        assert_eq!(after.attempts, baseline.footprint.attempts);
        let retained: BTreeMap<_, _> = after
            .contents
            .iter()
            .map(|(id, digest, bytes)| (*id, (digest, bytes)))
            .collect();
        for (id, digest, bytes) in &baseline.footprint.contents {
            assert_eq!(
                retained.get(id),
                Some(&(digest, bytes)),
                "canonical pre-read content changed or disappeared"
            );
        }
        assert_eq!(baseline.footprint.spec.0, baseline.version);
        let future: Value = serde_json::from_slice(&baseline.payload.bytes)?;
        assert_eq!(future["schemaVersion"], baseline.version);
        assert_eq!(
            future["futureSemantics"]["instruction"]["mustNotInterpret"],
            true
        );
        assert!(
            after
                .contents
                .iter()
                .any(|(id, digest, bytes)| *id == after.spec.3
                    && digest == &baseline.payload.reference.digest
                    && bytes == &baseline.payload.bytes)
        );
        assert_eq!(
            data.query(PendingOriginal(baseline.original.reply.reference.clone()))
                .await?,
            baseline.original.sdk
        );
        assert_eq!(
            original_intent(&root, &baseline.original.reply.reference).await?,
            baseline.original.intent
        );
        control.send(&expected).await?;
        control.receive::<()>().await?;
        drop(state);
        drop(data);
        root.shutdown().await?;
        Ok(())
    }

    const REPLACEMENT: &str = "fixture.cold-cell-counter.replacement-v2";
    // Each exact cold worker is a separate OS process. These are observations
    // of actual provider construction/callbacks, never SDK outcome producers.
    static REPLACEMENT_BOUND: Mutex<Vec<Value>> = Mutex::new(Vec::new());
    static REPLACEMENT_CALLS: AtomicUsize = AtomicUsize::new(0);
    struct Replacement {
        effects: Effects,
        _references: Mutex<mpsc::UnboundedReceiver<RecoveryRef>>,
    }
    impl Handler for Replacement {
        fn call(
            &self,
            method: String,
            input: Value,
            context: Context,
        ) -> BoxFuture<'static, HandlerResult> {
            REPLACEMENT_CALLS.fetch_add(1, Ordering::SeqCst);
            self.effects.call(method, input, context)
        }
    }
    fn replacement_registry(
        registry: &mut maka_host_runtime::application::NativeRegistry,
    ) -> std::result::Result<(), String> {
        registry.insert(REPLACEMENT.into(), Arc::new(|context, configuration| Box::pin(async move {
            let observed = json!({
                "package":context.package(),
                "source":context.persistence().expect("replacement requires the actual owned Root").source(),
                "instance":context.activation().instance(),
                "epoch":context.activation().epoch()
            });
            REPLACEMENT_BOUND.lock().unwrap().push(observed);
            let http: SocketAddr = configuration["http"].as_str().expect("validated replacement endpoint").parse().expect("actual fixture endpoint");
            let (entered, references) = mpsc::unbounded_channel();
            let handler: Arc<dyn Handler> = Arc::new(Replacement {
                effects: Effects { counter: Counter { http, entered, expected: child_input() },
                    counter_release: Mutex::new(None),
                    descriptions: AtomicUsize::new(0), draft_descriptions: AtomicUsize::new(0) },
                _references: Mutex::new(references),
            });
            maka_host_runtime::application::NativeActivation {
                exports: Ok(BTreeMap::from([("Tools".into(), maka_plugin_core::runtime::Published {
                    contract: Effects::contract(), value: handler,
                })])),
                owner: Arc::new(()),
            }
        })))
    }
    #[derive(Clone, Debug, Serialize, Deserialize)]
    pub(super) struct PackageBoundary {
        original: UnknownBoundary,
        before: maka_plugin_core::deployment::DeploymentRef,
        after: maka_plugin_core::deployment::DeploymentRef,
        tools: maka_plugin_core::composition::InstanceId,
        old_package: maka_plugin_core::package::PackageRef,
        new_package: maka_plugin_core::package::PackageRef,
        old_files: BTreeMap<String, Vec<u8>>,
        new_files: BTreeMap<String, Vec<u8>>,
        canonical: CanonicalFootprint,
    }
    pub(super) async fn install_package(
        boot: Boot,
        control: &mut cold_host::Channel,
    ) -> Result<()> {
        let Phase::PackageInstall(original) = boot.phase else {
            return Err("wrong package installer phase".into());
        };
        let namespaces = maka_event_log::root::RootNamespaces {
            ownership: boot.directory.join("owners"),
            control: boot.directory.join("control"),
        };
        let owner = Arc::new(maka_event_log::root::RootOwner::open_existing(
            &boot.directory.join("root"),
            &namespaces,
        )?);
        let migrations = [
            maka_event_log::ROOT_MIGRATIONS,
            maka_agent_state::MIGRATIONS,
        ]
        .concat();
        let root = RootStore::open(owner, &migrations).await?;
        let data = root.data_writer()?;
        let canonical = data.query(CanonicalRows(original.run)).await?;
        let launch = root
            .application_launch()
            .await?
            .ok_or("missing actual original launch")?;
        assert!(launch.pending.is_none());
        let loaded = root
            .load_application(launch.deployment)
            .await?
            .ok_or("missing original deployment")?;
        let before = loaded.source().reference.clone();
        let old = loaded
            .packages()
            .iter()
            .find(|package| package.application_ref().id == "fixture-tools")
            .ok_or("original tools immutable package is missing")?;
        let old_files = old.files().clone();
        let old_package = old.application_ref();
        let mut new_files = old_files.clone();
        let manifest = new_files
            .get_mut(maka_packages::MANIFEST_FILE)
            .ok_or("original manifest is missing")?;
        let mut value: Value = serde_json::from_slice(manifest)?;
        assert_eq!(
            value["application"]["host"]["implementation"]["implementation"],
            "fixture.tools"
        );
        value["application"]["host"]["implementation"]["implementation"] = json!(REPLACEMENT);
        value["application"]["host"]["configuration"] = json!({"type":"object","required":["http"],
            "properties":{"http":{"type":"string"}},"additionalProperties":false});
        *manifest = serde_json::to_vec(&value)?;
        let replacement = maka_packages::Package::new(new_files.clone())?;
        let new_package = replacement.application_ref();
        assert_eq!(old_package.id, new_package.id);
        assert_ne!(old_package.revision, new_package.revision);
        assert_ne!(old_files, new_files);
        let mut input = loaded.source().input.clone();
        let node = input
            .instances
            .get_mut("tools")
            .ok_or("original tools node is missing")?;
        let tools = maka_plugin_core::composition::InstanceId(vec![node.key]);
        assert_eq!(
            node.package,
            maka_plugin_core::package::PackageSelection::from(old_package.clone())
        );
        node.package = new_package.clone().into();
        node.configuration
            .values
            .insert("http".into(), json!(boot.http.to_string()));
        for (name, original_node) in &loaded.source().input.instances {
            let updated = &input.instances[name];
            assert_eq!(updated.key, original_node.key);
            assert_eq!(updated.bindings, original_node.bindings);
            if name != "tools" {
                assert_eq!(updated, original_node);
            }
        }
        let after = root
            .commit_application(
                launch.deployment,
                before.revision,
                input.clone(),
                loaded.source().remote_exports.clone(),
                vec![replacement],
            )
            .await?;
        assert_eq!(after.deployment, before.deployment);
        assert!(after.revision > before.revision);
        root.select_committed_application_launch(after.clone(), launch.configuration)
            .await?;
        assert_eq!(
            root.load_application_at(&after)
                .await?
                .ok_or("new committed source missing")?
                .source()
                .input,
            input
        );
        let previous = root
            .load_application_at(&before)
            .await?
            .ok_or("old committed source was lost")?;
        assert_eq!(previous.source().input, loaded.source().input);
        assert_eq!(
            root.load_application_package_at(&before, &old_package)
                .await?
                .ok_or("old package bytes were lost")?
                .files(),
            &old_files
        );
        let now = data.query(CanonicalRows(original.run)).await?;
        assert_eq!(now.spec, canonical.spec);
        assert_eq!(now.facts, canonical.facts);
        assert_eq!(now.requests, canonical.requests);
        assert_eq!(now.attempts, canonical.attempts);
        assert_eq!(
            data.query(PendingOriginal(original.reply.reference.clone()))
                .await?,
            original.sdk
        );
        assert_eq!(
            original_intent(&root, &original.reply.reference).await?,
            original.intent
        );
        control
            .send(&PackageBoundary {
                original: *original,
                before,
                after,
                tools,
                old_package,
                new_package,
                old_files,
                new_files,
                canonical,
            })
            .await?;
        control.receive::<()>().await?;
        drop(data);
        root.shutdown().await?;
        Ok(())
    }
    async fn assert_replacement_source(
        fixture: &NativeFixture,
        baseline: &PackageBoundary,
    ) -> Result<()> {
        let launch = fixture
            .root
            .application_launch()
            .await?
            .ok_or("replacement launch disappeared")?;
        let loaded = fixture
            .root
            .load_application(launch.deployment)
            .await?
            .ok_or("replacement source disappeared")?;
        assert_eq!(loaded.source().reference, baseline.after);
        assert_eq!(
            loaded.source().input.instances["tools"].package,
            maka_plugin_core::package::PackageSelection::from(baseline.new_package.clone())
        );
        assert_eq!(
            fixture
                .root
                .load_application_package_at(&baseline.after, &baseline.new_package)
                .await?
                .ok_or("current replacement package disappeared")?
                .files(),
            &baseline.new_files
        );
        assert_eq!(
            fixture
                .root
                .load_application_package_at(&baseline.before, &baseline.old_package)
                .await?
                .ok_or("original immutable package disappeared")?
                .files(),
            &baseline.old_files
        );
        assert!(
            fixture
                .root
                .load_application_at(&baseline.before)
                .await?
                .is_some()
        );
        let activation = fixture.app.client().activation(&baseline.tools)?;
        let bound = REPLACEMENT_BOUND.lock().unwrap();
        assert_eq!(
            bound.len(),
            1,
            "a registry entry without actual provider construction proves nothing"
        );
        assert_eq!(
            bound[0]["package"],
            serde_json::to_value(&baseline.new_package)?
        );
        assert_eq!(bound[0]["source"], serde_json::to_value(&baseline.after)?);
        assert_eq!(bound[0]["instance"], serde_json::to_value(&baseline.tools)?);
        assert_eq!(bound[0]["epoch"], json!(activation.epoch()));
        drop(bound);
        assert_eq!(REPLACEMENT_CALLS.load(Ordering::SeqCst), 0);
        let current = fixture
            .root
            .data_writer()?
            .query(CanonicalRows(baseline.original.run))
            .await?;
        assert_eq!(current.spec, baseline.canonical.spec);
        assert_eq!(current.requests, baseline.canonical.requests);
        assert_eq!(current.attempts, baseline.canonical.attempts);
        assert_eq!(
            &current.facts[..baseline.canonical.facts.len()],
            baseline.canonical.facts.as_slice()
        );
        let retained: BTreeMap<_, _> = current
            .contents
            .iter()
            .map(|(id, digest, bytes)| (*id, (digest, bytes)))
            .collect();
        for (id, digest, bytes) in &baseline.canonical.contents {
            assert_eq!(retained.get(id), Some(&(digest, bytes)));
        }
        Ok(())
    }

    struct UnreturnedServer {
        seen: Mutex<Seen>,
        changed: watch::Sender<()>,
        end_sources: watch::Sender<bool>,
    }
    async fn unreturned_counter(
        State(server): State<Arc<UnreturnedServer>>,
        body: Bytes,
    ) -> axum::response::Response {
        let input: Value = serde_json::from_slice(&body).unwrap();
        {
            let mut seen = server.seen.lock().unwrap();
            // This is the externally owned business effect, not an Agent fact
            // or a synthesized SDK outcome. The original result is never sent.
            seen.effects.push(input);
        }
        server.changed.send_replace(());
        let mut end = server.end_sources.subscribe();
        loop {
            let closed = *end.borrow_and_update();
            if closed {
                break;
            }
            end.changed()
                .await
                .expect("the parent owns the original counter response");
        }
        // Parent sets end only after OS kill+join (or failure cleanup). In
        // particular, this is not a successful original counter response.
        (
            axum::http::StatusCode::SERVICE_UNAVAILABLE,
            "original Host is already gone",
        )
            .into_response()
    }
    async fn unreturned_model(
        State(server): State<Arc<UnreturnedServer>>,
        body: Bytes,
    ) -> axum::response::Response {
        let input: Value = serde_json::from_slice(&body).unwrap();
        let index = {
            let mut seen = server.seen.lock().unwrap();
            seen.models.push(input);
            seen.models.len()
        };
        server.changed.send_replace(());
        match index {
            1 => sse(Some((FIRST, "exec", json!({"code":SETUP})))),
            2 => sse(Some((
                SECOND,
                "exec",
                json!({"code":DRAFT,"yield_time_ms":0}),
            ))),
            3 => {
                let mut end = server.end_sources.subscribe();
                let held = futures_util::stream::once(async move {
                    loop {
                        let closed = *end.borrow_and_update();
                        if closed {
                            break;
                        }
                        end.changed()
                            .await
                            .expect("the parent owns the old no-prefix Main response");
                    }
                    Ok::<Bytes, std::convert::Infallible>(Bytes::new())
                });
                axum::response::Response::builder()
                    .header(header::CONTENT_TYPE, "text/event-stream")
                    .body(axum::body::Body::from_stream(held))
                    .unwrap()
            }
            _ => (
                axum::http::StatusCode::INTERNAL_SERVER_ERROR,
                "new model generation is forbidden while the original nested effect is unresolved",
            )
                .into_response(),
        }
    }
    fn unreturned_counts(server: &UnreturnedServer, reference: &RecoveryRef) {
        let seen = server.seen.lock().unwrap();
        assert_eq!(
            seen.models.len(),
            3,
            "the cell effect blocker must prevent even retrying the held Main"
        );
        assert_eq!(
            seen.effects,
            vec![json!({"reference":reference,"input":child_input()})],
            "one original external mutation, no replay or new dispatch"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn externally_applied_but_unreturned_child_stays_unresolved_across_cold_roots_without_replay()
    -> Result<()> {
        let directory = tempfile::tempdir()?;
        let workspace = directory.path().join("workspace");
        tokio::fs::create_dir(&workspace).await?;
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let http = listener.local_addr()?;
        let (changed, _) = watch::channel(());
        let (end_sources, _) = watch::channel(false);
        let server = Arc::new(UnreturnedServer {
            seen: Mutex::new(Seen::default()),
            changed,
            end_sources,
        });
        let router = Router::new()
            .route("/effect", post(unreturned_counter))
            .route("/v1/chat/completions", post(unreturned_model))
            .with_state(server.clone());
        let (stop, stopped) = oneshot::channel();
        let http_task = tokio::spawn(async move {
            axum::serve(listener, router)
                .with_graceful_shutdown(async {
                    let _ = stopped.await;
                })
                .await
        });
        let mut hosts: [Option<ColdHost>; 3] = [None, None, None];
        let outcome =
            std::panic::AssertUnwindSafe(tokio::time::timeout(Duration::from_secs(90), async {
                hosts[0] = Some(
                    ColdHost::spawn(&Boot {
                        directory: directory.path().into(),
                        workspace: workspace.clone(),
                        http,
                        phase: Phase::CellUnknownFirst,
                    })
                    .await?,
                );
                let reference: RecoveryRef = hosts[0].as_mut().unwrap().receive().await?;
                let mut changed = server.changed.subscribe();
                loop {
                    changed.borrow_and_update();
                    let applied_and_running = {
                        let seen = server.seen.lock().unwrap();
                        assert!(seen.effects.len() <= 1 && seen.models.len() <= 3);
                        seen.effects.len() == 1 && seen.models.len() == 3
                    };
                    if applied_and_running {
                        break;
                    }
                    changed.changed().await?;
                }
                unreturned_counts(&server, &reference);
                hosts[0].as_mut().unwrap().send(&()).await?;
                let original: UnknownBoundary = hosts[0].as_mut().unwrap().receive().await?;
                assert_eq!(original.reply.reference, reference);
                unreturned_counts(&server, &reference);
                hosts[0].as_mut().unwrap().kill().await?;
                server.end_sources.send_replace(true);

                hosts[1] = Some(
                    ColdHost::spawn(&Boot {
                        directory: directory.path().into(),
                        workspace: workspace.clone(),
                        http,
                        phase: Phase::CellUnknownRecover(Box::new(original)),
                    })
                    .await?,
                );
                let blocked: Unresolved = hosts[1].as_mut().unwrap().receive().await?;
                unreturned_counts(&server, &reference);
                // Unknown original custody is not a graceful-shutdown success.
                // Kill the observing Host too, then prove the same obligation on
                // another real Root open, without a new send or risk decision.
                hosts[1].as_mut().unwrap().kill().await?;
                hosts[2] = Some(
                    ColdHost::spawn(&Boot {
                        directory: directory.path().into(),
                        workspace,
                        http,
                        phase: Phase::CellUnknownReopen(Box::new(blocked.clone())),
                    })
                    .await?,
                );
                let blocker: BlockerId = hosts[2].as_mut().unwrap().receive().await?;
                assert_eq!(blocker, blocked.blocker);
                hosts[2].as_mut().unwrap().kill().await?;
                unreturned_counts(&server, &reference);
                Ok::<(), Box<dyn std::error::Error + Send + Sync>>(())
            }))
            .catch_unwind()
            .await;
        let mut cleanup = None;
        for host in hosts.iter_mut().flatten() {
            if let Err(error) = host.terminate().await {
                cleanup.get_or_insert(error);
            }
        }
        server.end_sources.send_replace(true);
        let stop_result = stop.send(());
        let server_result = http_task.await;
        match outcome {
            Err(panic) => {
                if let Some(error) = cleanup {
                    eprintln!("unknown-effect cold worker cleanup also failed: {error}");
                }
                std::panic::resume_unwind(panic)
            }
            Ok(result) => {
                if let Some(error) = cleanup {
                    return Err(error);
                }
                stop_result.map_err(|_| "unknown-effect HTTP server ended before shutdown")?;
                server_result??;
                result.map_err(
                    |_| "unknown-effect recovery deadline expired; workers were killed and joined",
                )?
            }
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn public_stop_survives_cold_roots_without_clearing_the_original_unknown_effect()
    -> Result<()> {
        let directory = tempfile::tempdir()?;
        let workspace = directory.path().join("workspace");
        tokio::fs::create_dir(&workspace).await?;
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let http = listener.local_addr()?;
        let (changed, _) = watch::channel(());
        let (end_sources, _) = watch::channel(false);
        let server = Arc::new(UnreturnedServer {
            seen: Mutex::new(Seen::default()),
            changed,
            end_sources,
        });
        let router = Router::new()
            .route("/effect", post(unreturned_counter))
            .route("/v1/chat/completions", post(unreturned_model))
            .with_state(server.clone());
        let (stop, stopped) = oneshot::channel();
        let http_task = tokio::spawn(async move {
            axum::serve(listener, router)
                .with_graceful_shutdown(async {
                    let _ = stopped.await;
                })
                .await
        });
        let mut hosts: [Option<ColdHost>; 3] = [None, None, None];
        let outcome =
            std::panic::AssertUnwindSafe(tokio::time::timeout(Duration::from_secs(90), async {
                hosts[0] = Some(
                    ColdHost::spawn(&Boot {
                        directory: directory.path().into(),
                        workspace: workspace.clone(),
                        http,
                        phase: Phase::StopFirst,
                    })
                    .await?,
                );
                let reference: RecoveryRef = hosts[0].as_mut().unwrap().receive().await?;
                let mut changed = server.changed.subscribe();
                loop {
                    changed.borrow_and_update();
                    let ready = {
                        let seen = server.seen.lock().unwrap();
                        assert!(seen.effects.len() <= 1 && seen.models.len() <= 3);
                        seen.effects.len() == 1 && seen.models.len() == 3
                    };
                    if ready {
                        break;
                    }
                    changed.changed().await?;
                }
                unreturned_counts(&server, &reference);
                // The original producer remains unresolved throughout the real SDK
                // Stop. Do not release its response or hold the SQL writer.
                hosts[0].as_mut().unwrap().send(&()).await?;
                let original: StopBoundary = hosts[0].as_mut().unwrap().receive().await?;
                assert_eq!(original.original.reply.reference, reference);
                assert_eq!(success(&original.reply), &json!({"requested":true}));
                let stop_fact = original.stop.clone();
                let control_cut = original.snapshot.control_version;
                unreturned_counts(&server, &reference);
                hosts[0].as_mut().unwrap().kill().await?;
                server.end_sources.send_replace(true);

                hosts[1] = Some(
                    ColdHost::spawn(&Boot {
                        directory: directory.path().into(),
                        workspace: workspace.clone(),
                        http,
                        phase: Phase::StopRecover(Box::new(original)),
                    })
                    .await?,
                );
                let first: StoppedEvidence = hosts[1].as_mut().unwrap().receive().await?;
                assert_eq!(first.original.stop, stop_fact);
                assert_eq!(first.original.snapshot.control_version, control_cut);
                unreturned_counts(&server, &reference);
                hosts[1].as_mut().unwrap().kill().await?;
                hosts[2] = Some(
                    ColdHost::spawn(&Boot {
                        directory: directory.path().into(),
                        workspace,
                        http,
                        phase: Phase::StopReopen(Box::new(first)),
                    })
                    .await?,
                );
                let same_stop: FactId = hosts[2].as_mut().unwrap().receive().await?;
                assert_eq!(same_stop, stop_fact.id);
                hosts[2].as_mut().unwrap().kill().await?;
                unreturned_counts(&server, &reference);
                Ok::<(), Box<dyn std::error::Error + Send + Sync>>(())
            }))
            .catch_unwind()
            .await;
        let mut cleanup = None;
        for host in hosts.iter_mut().flatten() {
            if let Err(error) = host.terminate().await {
                cleanup.get_or_insert(error);
            }
        }
        server.end_sources.send_replace(true);
        let stop_result = stop.send(());
        let server_result = http_task.await;
        match outcome {
            Err(panic) => {
                if let Some(error) = cleanup {
                    eprintln!("cold Stop worker cleanup also failed: {error}");
                }
                std::panic::resume_unwind(panic)
            }
            Ok(result) => {
                if let Some(error) = cleanup {
                    return Err(error);
                }
                stop_result.map_err(|_| "cold Stop HTTP server ended before shutdown")?;
                server_result??;
                result.map_err(
                    |_| "cold Stop recovery deadline expired; workers were killed and joined",
                )?
            }
        }
    }

    fn normalized_stop(evidence: &StoppedEvidence) -> Result<Value> {
        let original = &evidence.original.original;
        let reason = evidence
            .facts
            .iter()
            .find_map(|record| match &record.fact {
                Fact::Blocked { blocker, reason } if *blocker == evidence.blocker => Some(reason),
                _ => None,
            })
            .ok_or("the original Cell recovery decision has no canonical blocker reason")?;
        let report: CellInterruption = serde_json::from_slice(&evidence.report_bytes)?;
        let charged: u64 = evidence
            .facts
            .iter()
            .filter_map(|record| match &record.fact {
                Fact::BudgetCharged { tokens } => Some(*tokens),
                _ => None,
            })
            .sum();
        Ok(json!({
            "run":original.run,"step":original.held_request.step,"attempt":original.held_attempt,
            "cell":original.running,"child":original.child,"counter":original.reply,
            "stop":evidence.original.stop,"controlVersion":evidence.original.snapshot.control_version,
            "reason":reason,"reportCell":report.cell,"children":report.children,"priorOutput":report.prior_output,
            "tokens":charged,"retries":evidence.facts.iter().filter(|record| matches!(&record.fact,Fact::RetryCharged {..})).count()
        }))
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn one_frozen_stop_control_cut_converges_after_three_closed_database_restores()
    -> Result<()> {
        let directory = tempfile::tempdir()?;
        let workspace = directory.path().join("workspace");
        tokio::fs::create_dir(&workspace).await?;
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let http = listener.local_addr()?;
        let (changed, _) = watch::channel(());
        let (end_sources, _) = watch::channel(false);
        let server = Arc::new(UnreturnedServer {
            seen: Mutex::new(Seen::default()),
            changed,
            end_sources,
        });
        let router = Router::new()
            .route("/effect", post(unreturned_counter))
            .route("/v1/chat/completions", post(unreturned_model))
            .with_state(server.clone());
        let (stop, stopped) = oneshot::channel();
        let http_task = tokio::spawn(async move {
            axum::serve(listener, router)
                .with_graceful_shutdown(async {
                    let _ = stopped.await;
                })
                .await
        });
        let mut hosts: [Option<ColdHost>; 4] = [None, None, None, None];
        let outcome =
            std::panic::AssertUnwindSafe(tokio::time::timeout(Duration::from_secs(90), async {
                hosts[0] = Some(
                    ColdHost::spawn(&Boot {
                        directory: directory.path().into(),
                        workspace: workspace.clone(),
                        http,
                        phase: Phase::StopFirst,
                    })
                    .await?,
                );
                let reference: RecoveryRef = hosts[0].as_mut().unwrap().receive().await?;
                let mut changed = server.changed.subscribe();
                loop {
                    changed.borrow_and_update();
                    let ready = {
                        let seen = server.seen.lock().unwrap();
                        assert!(seen.effects.len() <= 1 && seen.models.len() <= 3);
                        seen.effects.len() == 1 && seen.models.len() == 3
                    };
                    if ready {
                        break;
                    }
                    changed.changed().await?;
                }
                hosts[0].as_mut().unwrap().send(&()).await?;
                let frozen: StopBoundary = hosts[0].as_mut().unwrap().receive().await?;
                assert_eq!(frozen.original.reply.reference, reference);
                assert!(frozen.snapshot.spec.budget.deadline.is_none());
                assert!(
                    frozen.snapshot.retry_due_at.is_none()
                        && frozen.snapshot.retry_pending.is_none()
                );
                assert!(
                    frozen
                        .snapshot
                        .attempts
                        .values()
                        .all(|attempt| attempt.retry.is_none())
                );
                hosts[0].as_mut().unwrap().kill().await?;
                server.end_sources.send_replace(true);
                // No Root or SQLite actor is alive. Keep the original inode-bound
                // directory/markers/leases and freeze only this closed DB family.
                let database = cold_host::FrozenDatabase::capture(directory.path()).await?;
                let mut expected = None;
                for branch in 0..3 {
                    // The preceding branch was killed and joined before restoring
                    // in place. Its new claims/knowledge never enter the next cut.
                    database.restore().await?;
                    hosts[branch + 1] = Some(
                        ColdHost::spawn(&Boot {
                            directory: directory.path().into(),
                            workspace: workspace.clone(),
                            http,
                            phase: Phase::StopRecover(Box::new(frozen.clone())),
                        })
                        .await?,
                    );
                    let recovered: StoppedEvidence =
                        hosts[branch + 1].as_mut().unwrap().receive().await?;
                    let semantic = normalized_stop(&recovered)?;
                    match &expected {
                        Some(expected) => assert_eq!(&semantic, expected),
                        None => expected = Some(semantic),
                    }
                    unreturned_counts(&server, &reference);
                    hosts[branch + 1].as_mut().unwrap().kill().await?;
                }
                unreturned_counts(&server, &reference);
                Ok::<(), Box<dyn std::error::Error + Send + Sync>>(())
            }))
            .catch_unwind()
            .await;
        let mut cleanup = None;
        for host in hosts.iter_mut().flatten() {
            if let Err(error) = host.terminate().await {
                cleanup.get_or_insert(error);
            }
        }
        server.end_sources.send_replace(true);
        let stop_result = stop.send(());
        let server_result = http_task.await;
        match outcome {
            Err(panic) => {
                if let Some(error) = cleanup {
                    eprintln!("frozen-cut worker cleanup also failed: {error}");
                }
                std::panic::resume_unwind(panic)
            }
            Ok(result) => {
                if let Some(error) = cleanup {
                    return Err(error);
                }
                stop_result.map_err(|_| "frozen-cut HTTP server ended before shutdown")?;
                server_result??;
                result.map_err(
                    |_| "frozen-cut recovery deadline expired; workers were killed and joined",
                )?
            }
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn future_canonical_run_schema_is_explicitly_refused_without_rewriting_original_bytes()
    -> Result<()> {
        let directory = tempfile::tempdir()?;
        let workspace = directory.path().join("workspace");
        tokio::fs::create_dir(&workspace).await?;
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let http = listener.local_addr()?;
        let (changed, _) = watch::channel(());
        let (end_sources, _) = watch::channel(false);
        let server = Arc::new(UnreturnedServer {
            seen: Mutex::new(Seen::default()),
            changed,
            end_sources,
        });
        let router = Router::new()
            .route("/effect", post(unreturned_counter))
            .route("/v1/chat/completions", post(unreturned_model))
            .with_state(server.clone());
        let (stop, stopped) = oneshot::channel();
        let http_task = tokio::spawn(async move {
            axum::serve(listener, router)
                .with_graceful_shutdown(async {
                    let _ = stopped.await;
                })
                .await
        });
        let mut hosts: [Option<ColdHost>; 2] = [None, None];
        let outcome =
            std::panic::AssertUnwindSafe(tokio::time::timeout(Duration::from_secs(90), async {
                hosts[0] = Some(
                    ColdHost::spawn(&Boot {
                        directory: directory.path().into(),
                        workspace: workspace.clone(),
                        http,
                        phase: Phase::FutureFirst,
                    })
                    .await?,
                );
                let reference: RecoveryRef = hosts[0].as_mut().unwrap().receive().await?;
                let mut changed = server.changed.subscribe();
                loop {
                    changed.borrow_and_update();
                    let ready = {
                        let seen = server.seen.lock().unwrap();
                        assert!(seen.effects.len() <= 1 && seen.models.len() <= 3);
                        seen.effects.len() == 1 && seen.models.len() == 3
                    };
                    if ready {
                        break;
                    }
                    changed.changed().await?;
                }
                hosts[0].as_mut().unwrap().send(&()).await?;
                let baseline: FutureBoundary = hosts[0].as_mut().unwrap().receive().await?;
                assert_eq!(baseline.original.reply.reference, reference);
                assert_eq!(baseline.footprint.spec.0, baseline.version);
                assert_eq!(
                    baseline.version,
                    maka_agent_facts::durable::SCHEMA_VERSION + 1
                );
                unreturned_counts(&server, &reference);
                hosts[0].as_mut().unwrap().kill().await?;
                server.end_sources.send_replace(true);
                hosts[1] = Some(
                    ColdHost::spawn(&Boot {
                        directory: directory.path().into(),
                        workspace,
                        http,
                        phase: Phase::FutureRead(Box::new(baseline.clone())),
                    })
                    .await?,
                );
                let refusal: String = hosts[1].as_mut().unwrap().receive().await?;
                assert_eq!(
                    refusal,
                    format!("unsupported Agent schema version: {}", baseline.version)
                );
                unreturned_counts(&server, &reference);
                hosts[1].as_mut().unwrap().finish().await?;
                unreturned_counts(&server, &reference);
                Ok::<(), Box<dyn std::error::Error + Send + Sync>>(())
            }))
            .catch_unwind()
            .await;
        let mut cleanup = None;
        for host in hosts.iter_mut().flatten() {
            if let Err(error) = host.terminate().await {
                cleanup.get_or_insert(error);
            }
        }
        server.end_sources.send_replace(true);
        let stop_result = stop.send(());
        let server_result = http_task.await;
        match outcome {
            Err(panic) => {
                if let Some(error) = cleanup {
                    eprintln!("future-schema worker cleanup also failed: {error}");
                }
                std::panic::resume_unwind(panic)
            }
            Ok(result) => {
                if let Some(error) = cleanup {
                    return Err(error);
                }
                stop_result.map_err(|_| "future-schema HTTP server ended before shutdown")?;
                server_result??;
                result.map_err(
                    |_| "future-schema read deadline expired; workers were killed and joined",
                )?
            }
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn actual_package_and_implementation_change_does_not_delegate_original_unknown_work_to_the_new_handler()
    -> Result<()> {
        let directory = tempfile::tempdir()?;
        let workspace = directory.path().join("workspace");
        tokio::fs::create_dir(&workspace).await?;
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let http = listener.local_addr()?;
        let (changed, _) = watch::channel(());
        let (end_sources, _) = watch::channel(false);
        let server = Arc::new(UnreturnedServer {
            seen: Mutex::new(Seen::default()),
            changed,
            end_sources,
        });
        let router = Router::new()
            .route("/effect", post(unreturned_counter))
            .route("/v1/chat/completions", post(unreturned_model))
            .with_state(server.clone());
        let (stop, stopped) = oneshot::channel();
        let http_task = tokio::spawn(async move {
            axum::serve(listener, router)
                .with_graceful_shutdown(async {
                    let _ = stopped.await;
                })
                .await
        });
        let mut hosts: [Option<ColdHost>; 3] = [None, None, None];
        let outcome =
            std::panic::AssertUnwindSafe(tokio::time::timeout(Duration::from_secs(90), async {
                hosts[0] = Some(
                    ColdHost::spawn(&Boot {
                        directory: directory.path().into(),
                        workspace: workspace.clone(),
                        http,
                        phase: Phase::CellUnknownFirst,
                    })
                    .await?,
                );
                let reference: RecoveryRef = hosts[0].as_mut().unwrap().receive().await?;
                let mut changed = server.changed.subscribe();
                loop {
                    changed.borrow_and_update();
                    let ready = {
                        let seen = server.seen.lock().unwrap();
                        assert!(seen.effects.len() <= 1 && seen.models.len() <= 3);
                        seen.effects.len() == 1 && seen.models.len() == 3
                    };
                    if ready {
                        break;
                    }
                    changed.changed().await?;
                }
                hosts[0].as_mut().unwrap().send(&()).await?;
                let original: UnknownBoundary = hosts[0].as_mut().unwrap().receive().await?;
                assert_eq!(original.reply.reference, reference);
                unreturned_counts(&server, &reference);
                hosts[0].as_mut().unwrap().kill().await?;
                server.end_sources.send_replace(true);
                // The installer owns the same Root exclusively but never starts an
                // Agent. Commit real package bytes/source selection before App boot.
                hosts[1] = Some(
                    ColdHost::spawn(&Boot {
                        directory: directory.path().into(),
                        workspace: workspace.clone(),
                        http,
                        phase: Phase::PackageInstall(Box::new(original.clone())),
                    })
                    .await?,
                );
                let baseline: PackageBoundary = hosts[1].as_mut().unwrap().receive().await?;
                assert_eq!(baseline.original.sdk, original.sdk);
                assert_eq!(baseline.original.intent, original.intent);
                assert_eq!(baseline.original.reply.reference, reference);
                assert_ne!(baseline.old_package.revision, baseline.new_package.revision);
                assert_ne!(baseline.old_files, baseline.new_files);
                assert_eq!(baseline.before.deployment, baseline.after.deployment);
                hosts[1].as_mut().unwrap().finish().await?;
                unreturned_counts(&server, &reference);
                hosts[2] = Some(
                    ColdHost::spawn(&Boot {
                        directory: directory.path().into(),
                        workspace,
                        http,
                        phase: Phase::PackageRecover(Box::new(baseline.clone())),
                    })
                    .await?,
                );
                let (recovered, constructed, calls): (Unresolved, Vec<Value>, usize) =
                    hosts[2].as_mut().unwrap().receive().await?;
                assert_eq!(calls, 0);
                assert_eq!(recovered.original.reply.reference, reference);
                assert_eq!(constructed.len(), 1);
                assert_eq!(
                    constructed[0]["package"],
                    serde_json::to_value(&baseline.new_package)?
                );
                assert_eq!(
                    constructed[0]["source"],
                    serde_json::to_value(&baseline.after)?
                );
                assert_eq!(
                    constructed[0]["instance"],
                    serde_json::to_value(&baseline.tools)?
                );
                assert!(
                    !constructed[0]["epoch"]
                        .as_str()
                        .ok_or("missing actual activation epoch")?
                        .is_empty()
                );
                unreturned_counts(&server, &reference);
                // Unknown original cleanup is not settled by terminating this
                // observer. Do not make App.close stand in for the old producer ACK.
                hosts[2].as_mut().unwrap().kill().await?;
                unreturned_counts(&server, &reference);
                Ok::<(), Box<dyn std::error::Error + Send + Sync>>(())
            }))
            .catch_unwind()
            .await;
        let mut cleanup = None;
        for host in hosts.iter_mut().flatten() {
            if let Err(error) = host.terminate().await {
                cleanup.get_or_insert(error);
            }
        }
        server.end_sources.send_replace(true);
        let stop_result = stop.send(());
        let server_result = http_task.await;
        match outcome {
            Err(panic) => {
                if let Some(error) = cleanup {
                    eprintln!("package-change worker cleanup also failed: {error}");
                }
                std::panic::resume_unwind(panic)
            }
            Ok(result) => {
                if let Some(error) = cleanup {
                    return Err(error);
                }
                stop_result.map_err(|_| "package-change HTTP server ended before shutdown")?;
                server_result??;
                result.map_err(
                    |_| "package-change recovery deadline expired; workers were killed and joined",
                )?
            }
        }
    }

    async fn python_model(
        State(server): State<Arc<Server>>,
        body: Bytes,
    ) -> axum::response::Response {
        let input: Value = serde_json::from_slice(&body).unwrap();
        let (index, running) = {
            let mut seen = server.seen.lock().unwrap();
            seen.models.push(input);
            (seen.models.len(), seen.running)
        };
        match index {
            1 => sse(Some((
                FIRST,
                "exec",
                json!({"code":PY_SETUP,"yield_time_ms":30000}),
            ))),
            2 => sse(Some((
                SECOND,
                "exec",
                json!({"code":PY_DRAFT,"yield_time_ms":30000}),
            ))),
            3 => sse(Some((
                WAIT,
                "wait",
                json!({"cell_id":running.expect("the parent captured the real Python Cell"),"yield_time_ms":0}),
            ))),
            4 => sse(Some((
                VERIFY,
                "exec",
                json!({"code":PY_CHECK,"yield_time_ms":30000}),
            ))),
            _ => sse(None),
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn actual_python_worker_owned_tree_loss_recovers_original_cell_without_repeating_effects()
    -> Result<()> {
        let directory = tempfile::tempdir()?;
        let workspace = directory.path().join("workspace");
        tokio::fs::create_dir(&workspace).await?;
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let http = listener.local_addr()?;
        let server = Arc::new(Server {
            seen: Mutex::new(Seen::default()),
        });
        let router = Router::new()
            .route("/effect", post(counter))
            .route("/v1/chat/completions", post(python_model))
            .with_state(server.clone());
        let (stop, stopped) = oneshot::channel();
        let http_task = tokio::spawn(async move {
            axum::serve(listener, router)
                .with_graceful_shutdown(async {
                    let _ = stopped.await;
                })
                .await
        });
        let mut hosts: [Option<ColdHost>; 3] = [None, None, None];
        let outcome = std::panic::AssertUnwindSafe(tokio::time::timeout(Duration::from_secs(90), async {
            hosts[0] = Some(ColdHost::spawn_owned(&Boot { directory: directory.path().into(),
                workspace: workspace.clone(), http, phase: Phase::PythonFirst }, &workspace).await?);
            let host_pid = hosts[0].as_ref().unwrap().id().ok_or("the original Host has no owned process")?;
            let before: Boundary = hosts[0].as_mut().unwrap().receive().await?;
            assert_eq!(before.vm.runtime, maka_code_runtime::PYTHON_VM);
            assert_eq!(before.vm.version, maka_code_runtime::VM_BINDING_VERSION);
            let process: maka_process::lifetime::ProcessIdentity = serde_json::from_value(before.vm.descriptor["process"].clone())?;
            assert_ne!(process.pid(), host_pid);
            assert_ne!(process.pid(), std::process::id());
            assert!(!serde_json::from_value::<Uuid>(before.vm.descriptor["job_nonce"].clone())?.is_nil());
            assert!(matches!(maka_code_runtime::observe_binding(&before.vm).await, maka_code_runtime::RuntimeVmObservation::Alive));
            {
                let mut seen = server.seen.lock().unwrap();
                assert_eq!(seen.models.len(), 2);
                assert_eq!(seen.effects, vec![json!({"reference":before.reply.reference,"input":child_input()})]);
                assert_eq!(before.describe_calls, 1);
                assert_eq!(before.draft_describe_calls, 1);
                seen.running = Some(before.running);
            }

            // Deliberately kill the original native owned tree, not just Host.
            // Neither a serialized PID nor Host exit proves the Monty worker
            // gone. Native tree wait and a separate fresh OS proof are required.
            hosts[0].as_mut().unwrap().kill().await?;
            let gone = match maka_code_runtime::observe_binding(&before.vm).await {
                maka_code_runtime::RuntimeVmObservation::Gone(proof) => proof,
                maka_code_runtime::RuntimeVmObservation::Alive => return Err("the owned Python worker is still physically alive; do not recover or replay it".into()),
                maka_code_runtime::RuntimeVmObservation::Unobservable { diagnostic } => return Err(format!("the original Python lifetime is unobservable: {diagnostic}").into()),
            };
            assert_eq!(gone.binding(), &before.vm);
            assert_eq!(gone.process().ok_or("Python requires the actual process lifetime proof")?.identity(), &process);

            hosts[1] = Some(ColdHost::spawn_owned(&Boot { directory: directory.path().into(),
                workspace: workspace.clone(), http, phase: Phase::PythonRecover(Box::new(before.clone())) }, &workspace).await?);
            let recovered: Reconciled = hosts[1].as_mut().unwrap().receive().await?;
            assert_eq!(recovered.original.vm, before.vm);
            let interrupted: CellInterruption = serde_json::from_slice(&recovered.report_bytes)?;
            assert!(interrupted.diagnostic.contains(maka_code_runtime::PYTHON_VM));
            hosts[1].as_mut().unwrap().finish().await?;
            hosts[2] = Some(ColdHost::spawn_owned(&Boot { directory: directory.path().into(),
                workspace: workspace.clone(), http, phase: Phase::PythonReopen(Box::new(recovered.clone())) }, &workspace).await?);
            let notification: FactId = hosts[2].as_mut().unwrap().receive().await?;
            assert_eq!(notification, recovered.notification);
            hosts[2].as_mut().unwrap().finish().await?;
            {
                let seen = server.seen.lock().unwrap();
                assert_eq!(seen.effects, vec![json!({"reference":before.reply.reference,"input":child_input()})]);
                assert_eq!(seen.models.len(), 5);
                let tool_text = |request: &Value| request["messages"].as_array().unwrap().iter().rev()
                    .find(|message| message["role"] == "tool").unwrap()["content"].as_str().unwrap().to_owned();
                let waited = tool_text(&seen.models[3]);
                assert_eq!(serde_json::from_str::<Value>(waited.lines().next().unwrap())?["state"], "interrupted");
                let vm_observation = |text: &str| {
                    let parts: Vec<maka_model::prompt::ContentPart> =
                        serde_json::from_str(text).expect("the Python tool projects a ContentPart array");
                    let mut records = parts.iter().filter_map(|part| match part {
                        maka_model::prompt::ContentPart::Text { text, .. }
                            if text.starts_with("{\"cellFixtureVmObservation\":") => Some(text),
                        _ => None,
                    });
                    let record = records.next().expect("the Python VM emitted its observation record");
                    assert!(records.next().is_none(), "the Python VM observation record must be unique");
                    serde_json::from_str::<Value>(record).unwrap()["cellFixtureVmObservation"].clone()
                };
                let first = vm_observation(&tool_text(&seen.models[1]));
                let catalog = first["catalog"].as_array().expect("the first Python VM emitted its catalog");
                assert_eq!(
                    catalog.iter().map(|tool| tool["name"].as_str().unwrap()).collect::<Vec<_>>(),
                    vec!["describe", "draft_describe"]
                );
                assert!(catalog.iter().all(|tool|
                    !tool["description"].as_str().unwrap().is_empty()));
                assert_eq!(vm_observation(&tool_text(&seen.models[4])),
                    json!({"a":1,"bMissing":true,"oldHeapMissing":true,"catalog":catalog}));
            }
            Ok::<(), Box<dyn std::error::Error + Send + Sync>>(())
        })).catch_unwind().await;
        let mut cleanup = None;
        for host in hosts.iter_mut().flatten() {
            if let Err(error) = host.terminate().await {
                cleanup.get_or_insert(error);
            }
        }
        let stop_result = stop.send(());
        let server_result = http_task.await;
        match outcome {
            Err(panic) => {
                if let Some(error) = cleanup {
                    eprintln!("owned Python tree cleanup also failed: {error}");
                }
                std::panic::resume_unwind(panic)
            }
            Ok(result) => {
                if let Some(error) = cleanup {
                    return Err(error);
                }
                stop_result.map_err(|_| "Python cold HTTP server ended before shutdown")?;
                server_result??;
                result.map_err(|_| "owned Python tree recovery deadline expired; native trees were terminated and joined")?
            }
        }
    }
}
