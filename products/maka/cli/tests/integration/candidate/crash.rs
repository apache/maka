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
use crate::terminal::support::{ModelRequest, configure, mutate};
use maka_agent_api::contract::{ExecutionResult, ExecutionState};
use maka_agent_facts::{
    artifact::ToolReturn,
    cells::{CellEvent, CellId, CellOwner, CellReturnedResult, CellStatus, CellView},
    durable::{AttemptRecovery, Fact, ModelAttemptId, RecordedFact, RequestSpec, RunId},
    tool_output::ToolOutput,
};
use maka_app_client::{Client as AppClient, Journal};
use maka_capabilities::call::Attachments;
use maka_host_runtime::application::host::startup;
use maka_plugin_core::operation::{
    OperationCleanup, OperationOutcome, OperationReply, OperationResult, Receipt,
};
use rusqlite::{Connection, OpenFlags};
use serde_json::json;
use std::{
    collections::BTreeSet,
    os::unix::process::ExitStatusExt,
    process::Stdio,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
};
use tokio::{
    io::{AsyncBufReadExt, BufReader},
    net::TcpListener,
    sync::mpsc,
};

async fn activity(client: &AppClient, session: &str) -> Value {
    client
        .query("agent", "observe", json!({"sessionId":session}))
        .await
        .unwrap()["session"]["activity"]
        .clone()
}

// Data-only inspection of the original database, never a Store/DriverDomain or live grant.
struct ColdEvidence {
    spec: Vec<u8>,
    facts: Vec<RecordedFact>,
    cells: Vec<CellView>,
    write_return: Vec<u8>,
    value: Value,
    loaded: BTreeSet<String>,
    request: RequestSpec,
    recovery: Value,
    latest: RunId,
    runs: usize,
    unfinished: usize,
}
async fn cold_evidence(root: &Path, session: &str, run: RunId) -> ColdEvidence {
    let path = root.join(maka_event_log::root::ROOT_DATABASE);
    let session = session.to_owned();
    tokio::task::spawn_blocking(move || {
        let mut connection = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        let tx = connection.transaction().unwrap();
        let spec = tx.query_row(
            "SELECT c.payload FROM agent_run_specs r JOIN contents c ON c.id=r.spec_content_id WHERE r.run=?",
            [run.to_string()], |r| r.get::<_, Vec<u8>>(0),
        ).unwrap();
        let facts = tx.prepare(
            "SELECT c.payload FROM agent_facts f JOIN contents c ON c.id=f.body_content_id WHERE f.run=? ORDER BY f.revision",
        ).unwrap().query_map([run.to_string()], |r| r.get::<_, Vec<u8>>(0)).unwrap()
            .map(|r| serde_json::from_slice::<RecordedFact>(&r.unwrap()).unwrap()).collect();
        let cells: Vec<CellView> = tx.prepare("SELECT body FROM agent_cells WHERE run=? ORDER BY cell").unwrap()
            .query_map([run.to_string()], |r| r.get::<_, String>(0)).unwrap()
            .map(|r| serde_json::from_str::<CellView>(&r.unwrap()).unwrap()).collect();
        let write = cells.iter().flat_map(|cell| cell.children.values()).find(|child| child.name=="todo_write").unwrap();
        let write_ref = &write.local_result.as_ref().unwrap().result;
        let write_return = maka_event_log::content::read(&tx, &write_ref.digest).unwrap().unwrap();
        assert_eq!(u64::try_from(write_return.len()).unwrap(), write_ref.bytes);
        assert_eq!(maka_agent_facts::artifact::content_digest(&write_return), write_ref.digest);
        let value = tx.query_row(
            "SELECT c.payload FROM agent_session_values v JOIN contents c ON c.id=v.value_content_id WHERE v.session=? AND v.key='cold-checkpoint'",
            [&session], |r| r.get::<_, Vec<u8>>(0),
        ).unwrap();
        let loaded = tx.query_row("SELECT body FROM agent_session_loaded_tools WHERE session=?", [&session], |r| r.get::<_, String>(0)).unwrap();
        let request = tx.query_row(
            "SELECT c.payload FROM agent_runs r JOIN agent_request_specs s ON s.step=r.current_step JOIN contents c ON c.id=s.content_id WHERE r.run=?",
            [run.to_string()], |r| r.get::<_, Vec<u8>>(0),
        ).unwrap();
        let request: RequestSpec = serde_json::from_slice(&request).unwrap();
        let recovery = maka_event_log::content::read(&tx, &request.recovery_contract.digest).unwrap().unwrap();
        let latest: String = tx.query_row("SELECT run FROM agent_runs WHERE session=? ORDER BY admission_sequence DESC LIMIT 1", [&session], |r| r.get(0)).unwrap();
        let runs: i64 = tx.query_row("SELECT count(*) FROM agent_runs WHERE session=?", [&session], |r| r.get(0)).unwrap();
        let unfinished: i64 = tx.query_row("SELECT count(*) FROM agent_runs WHERE session=? AND terminal IS NULL", [&session], |r| r.get(0)).unwrap();
        ColdEvidence {
            spec, facts, cells, write_return, value:serde_json::from_slice(&value).unwrap(),
            loaded:serde_json::from_str(&loaded).unwrap(), request,
            recovery:serde_json::from_slice(&recovery).unwrap(),
            latest:serde_json::from_value(json!(latest)).unwrap(), runs: usize::try_from(runs).unwrap(), unfinished: usize::try_from(unfinished).unwrap(),
        }
    }).await.unwrap()
}

async fn completed(client: &AppClient, session: &str, run: RunId) {
    let catalog = client
        .subscribe(
            "agent",
            "catalog",
            json!({"filter":"all","position":{"kind":"start"}}),
        )
        .await
        .unwrap();
    loop {
        let observed = client
            .query(
                "agent",
                "execution",
                json!({"sessionId":session,"runId":run}),
            )
            .await
            .unwrap();
        let ExecutionResult::Found { execution } = serde_json::from_value(observed).unwrap() else {
            panic!("the original admitted Run must remain addressable")
        };
        assert_eq!(execution.run_id, run);
        match execution.state {
            ExecutionState::Completed => break,
            ExecutionState::Blocked { blockers } => panic!(
                "the captured local-functions recovery contract must resume, not block: {}",
                serde_json::to_string(&blockers).unwrap()
            ),
            ExecutionState::Failed | ExecutionState::Cancelled => {
                panic!("SIGKILL is neither a Stop nor an automatic failed turn")
            }
            _ => {
                catalog
                    .next()
                    .await
                    .unwrap()
                    .expect("the actual Native catalog must remain observable");
            }
        }
    }
    catalog.close().await.unwrap();
}

fn same_business_receipt(original: &OperationReply, observed: &OperationReply) {
    assert_eq!(observed.reference, original.reference);
    let (
        Receipt::Recorded {
            outcome: original_outcome,
            cleanup: original_cleanup,
        },
        Receipt::Recorded { outcome, cleanup },
    ) = (&original.receipt, &observed.receipt)
    else {
        panic!("the exact original send receipt must remain recorded")
    };
    assert_eq!(outcome, original_outcome);
    if *original_cleanup == OperationCleanup::Confirmed {
        assert_eq!(*cleanup, OperationCleanup::Confirmed);
    }
}

async fn after_cell(requests: &mut mpsc::Receiver<ModelRequest>) -> (ModelRequest, usize) {
    let mut waits = 0;
    loop {
        let held = requests.recv().await.unwrap();
        let output = held.body["messages"]
            .as_array()
            .unwrap()
            .iter()
            .rev()
            .find(|message| message["role"] == "tool")
            .unwrap()["content"]
            .as_str()
            .unwrap();
        let result: Value = serde_json::from_str(output.lines().next().unwrap()).unwrap();
        match result["state"].as_str().unwrap() {
            "completed" => return (held, waits),
            "running" => {
                held.tool_call(
                    "wait",
                    json!({"cell_id":result["cell_id"],"yield_time_ms":1000}),
                )
                .await
            }
            other => panic!("the original Cell failed: {other}"),
        }
        waits += 1;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn killed_host_leaves_an_ended_turn_and_a_session_that_takes_messages() {
    let mut fixture = RootStartupFixture::new();
    let root = fixture.root.clone();
    let executable = crate::maka_executable();
    let journal = fixture.directory().join("client.db");
    let namespaces = RootNamespaces::for_current_account().unwrap();
    let owner = Arc::new(RootOwner::create(&root, &namespaces).unwrap());
    let original_root = owner.root_id().to_owned();
    fixture.adopt();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let selection = configure(
        owner.clone(),
        &format!("http://{}/v1", listener.local_addr().unwrap()),
        false,
        true,
    )
    .await;
    drop(owner);
    let count = Arc::new(AtomicUsize::new(0));
    let served = count.clone();
    let (send, mut requests) = mpsc::channel(8);
    let provider = tokio::spawn(async move {
        let mut connections = tokio::task::JoinSet::new();
        loop {
            tokio::select! {
                accepted = listener.accept() => {
                    let (socket, _) = accepted.unwrap();
                    connections.spawn(ModelRequest::serve(socket, send.clone(), served.clone()));
                }
                ended = connections.join_next(), if !connections.is_empty() => { ended.unwrap().unwrap(); }
            }
        }
    });
    tokio::time::timeout(Duration::from_secs(90), async {
        let mut first_host = tokio::process::Command::new(&executable)
            .args(["host", "serve", "--root"]).arg(&root)
            .stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::inherit())
            .kill_on_drop(true).spawn().unwrap();
        let mut ready = String::new();
        BufReader::new(first_host.stdout.take().unwrap()).read_line(&mut ready).await.unwrap();
        let ready: Value = serde_json::from_str(&ready).unwrap();
        let first_epoch = uuid::Uuid::parse_str(ready["hostEpoch"].as_str().unwrap()).unwrap();
        let host = Client::connect(Path::new(ready["socketPath"].as_str().unwrap()), Some(first_epoch)).await.unwrap();
        let client = AppClient::new(host, Journal::open(&journal).await.unwrap(), "receipts".into()).unwrap();
        match RootOwner::open_existing(&root, &namespaces) {
            Ok(_) => panic!("a running Host must exclusively own its Root"),
            Err(error) => assert_eq!(error.kind(), std::io::ErrorKind::WouldBlock),
        }
        let roots = client.query("agent", "directories", json!({"kind":"roots"})).await.unwrap();
        let created = mutate(&client, "create", json!({"title":"Crash","labels":[],"workspace":{"kind":"directory","path":roots["roots"][0]["path"]}})).await;
        let session = created["session"]["id"].as_str().unwrap().to_owned();
        let intent = json!({"sessionId":session,"message":"BEFORE_THE_CRASH","backend":{"kind":"model","connectionId":selection["connectionId"],"modelId":selection["modelId"]}});
        let operation = uuid::Uuid::new_v4();
        let mutation = client.mutation(operation, "agent", "send", intent.clone(), Attachments::new(), Some(session.clone()), Value::Null).await.unwrap();
        let prepared = mutation.prepare().await.unwrap();
        let receipt = mutation.confirm().await.unwrap();
        assert_eq!(prepared.reference.as_ref(), Some(&receipt.reference));
        let Receipt::Recorded {outcome:OperationOutcome::Returned {result:OperationResult::Success {value}},..} = &receipt.receipt else { panic!("send must record its original admission receipt") };
        assert_eq!(value["kind"], "queued");
        let message = value["messageId"].as_str().unwrap().to_owned();
        drop(mutation);
        let first = requests.recv().await.unwrap();
        let work = client.query("agent", "work", json!({"sessionId":session,"target":{"kind":"message","messageId":message},"cursor":null})).await.unwrap();
        assert_eq!(work["kind"], "delivered");
        let run: RunId = serde_json::from_value(work["execution"]["runId"].clone()).unwrap();
        assert!(first.body["messages"].to_string().contains("BEFORE_THE_CRASH"));
        first.tool_call("exec", json!({"code":"globalThis.onlyInOldVm = 99; await tools.todo_write({todos:[{content:'ONE_DURABLE_EFFECT',status:'in_progress'}]}); const doc = await tools.todo_read({}); store('cold-checkpoint',{n:42,origin:'BEFORE_THE_CRASH'}); text(doc.items);"})).await;
        let (held, _) = after_cell(&mut requests).await;
        let calls_before_crash = count.load(Ordering::SeqCst);
        let frozen_request = held.body.clone();
        assert!(frozen_request["messages"].to_string().contains("ONE_DURABLE_EFFECT"));
        assert_ne!(activity(&client, &session).await, "idle");
        let checklist = client.query("agent", "checklist", json!({"sessionId":session})).await.unwrap();
        assert_eq!(checklist["revision"], 1);
        assert_eq!(checklist["total"], 1);
        let before = cold_evidence(&root, &session, run).await;
        assert_eq!(before.runs, 1);
        assert_eq!(before.unfinished, 1);
        assert_eq!(before.cells.len(), 1);
        let original_cell = &before.cells[0];
        let CellOwner::Agent {link, call} = &original_cell.owner else { panic!("the Cell must have its real Agent parent") };
        assert_eq!(link.run, run);
        assert_eq!(original_cell.id, CellId::for_agent(*link, call));
        assert!(matches!(&original_cell.status, CellStatus::Completed {accepted:true,..}));
        assert!(original_cell.physical_cleanup_confirmed());
        assert_eq!(before.value, json!({"n":42,"origin":"BEFORE_THE_CRASH"}));
        assert!(before.loaded.contains("todo_write") && before.loaded.contains("todo_read"));
        let written: ToolReturn<CellReturnedResult> = serde_json::from_slice(&before.write_return).unwrap();
        written.validate().unwrap();
        assert!(!written.body.is_error);
        let ToolOutput::Json(written) = &written.body.output else { panic!("Todo must retain its actual JSON business result, not a fabricated Host operation receipt") };
        assert_eq!(written["items"], json!([{"content":"ONE_DURABLE_EFFECT","status":"in_progress"}]));
        assert_eq!(before.recovery["contract"], json!({"protocol":"maka.adapter.chat-completions.local-functions","version":1}));
        let attempts: Vec<ModelAttemptId> = before.facts.iter().filter_map(|record| match &record.fact {
            Fact::ModelAttemptAdmitted {attempt,..} => Some(*attempt), _ => None,
        }).collect();
        assert_eq!(attempts.len(), calls_before_crash);
        let interrupted_attempt = *attempts.last().unwrap();
        assert_eq!(before.facts.iter().filter(|record| matches!(&record.fact, Fact::ModelObserved {attempt,..} if *attempt==interrupted_attempt)).count(), 0);
        // The admitted request was sent. Its explicit adapter contract, not absence
        // of frames or the Host's death, is the proof permitting a frozen retry.
        assert_eq!(discovery::read(&root).unwrap().pid.get(), first_host.id().unwrap());
        first_host.start_kill().unwrap();
        assert_eq!(first_host.wait().await.unwrap().signal(), Some(libc::SIGKILL));
        drop(held);
        drop(client);
        let reopened_owner = RootOwner::open_existing(&root, &namespaces).unwrap();
        assert_eq!(reopened_owner.root_id(), original_root);
        drop(reopened_owner);
        fixture.begin_admission();
        let host = startup::connect_root(&executable, &root).await.unwrap();
        fixture.adopt();
        assert_ne!(host.epoch(), first_epoch);
        let client = AppClient::new(host, Journal::open(&journal).await.unwrap(), "receipts".into()).unwrap();
        let recovered_receipt = client.recover(operation).await.unwrap();
        same_business_receipt(&receipt, &recovered_receipt);
        let resumed = requests.recv().await.unwrap();
        assert_eq!(resumed.body, frozen_request, "cold recovery must retain the exact original logical request");
        let recovered = cold_evidence(&root, &session, run).await;
        assert_eq!(recovered.spec, before.spec);
        assert_eq!(&recovered.facts[..before.facts.len()], before.facts.as_slice());
        assert_eq!(recovered.latest, run);
        assert_eq!(recovered.runs, 1, "no fresh send/continuation may substitute for the original Run");
        assert_eq!(recovered.unfinished, 1);
        assert_eq!(recovered.request.request, before.request.request);
        assert!(!recovered.facts[before.facts.len()..].iter().any(|record| matches!(&record.fact, Fact::StepPrepared {..})), "frozen retry must not prepare a replacement logical Step");
        assert_eq!(recovered.facts[before.facts.len()..].iter().filter(|record| matches!(&record.fact, Fact::ModelAttemptPrepared {..})).count(), 1, "one new physical Attempt retries the original Step in the same Run");
        assert_eq!(recovered.cells, before.cells, "the accepted Cell must not acquire a new VM binding");
        assert_eq!(recovered.write_return, before.write_return);
        assert_eq!(recovered.value, before.value);
        assert_eq!(recovered.loaded, before.loaded);
        assert_eq!(recovered.facts.iter().filter(|record| matches!(&record.fact,
            Fact::AttemptRecoveryRecorded {attempt,recovery:AttemptRecovery::FrozenRetrySafe {not_before:None}} if *attempt==interrupted_attempt)).count(), 1);
        assert_eq!(recovered.facts.iter().filter(|record| matches!(&record.fact,
            Fact::ModelInterrupted {attempt,..} if *attempt==interrupted_attempt)).count(), 1);
        assert!(!recovered.facts.iter().any(|record| matches!(&record.fact, Fact::StopRequested {..} | Fact::Blocked {..})));
        assert!(matches!(requests.try_recv(), Err(mpsc::error::TryRecvError::Empty)));
        resumed.tool_call("exec", json!({"code":"if (typeof globalThis.onlyInOldVm !== 'undefined') throw Error('old VM heap escaped'); const saved = load('cold-checkpoint'); if (saved.n !== 42 || saved.origin !== 'BEFORE_THE_CRASH') throw Error('canonical KV missing'); const doc = await tools.todo_read({}); text({saved,items:doc.items});"})).await;
        let (mut answer, read_waits) = after_cell(&mut requests).await;
        let output = answer.body["messages"].as_array().unwrap().iter().rev()
            .find(|message| message["role"]=="tool").unwrap()["content"].as_str().unwrap();
        let restored: Value = serde_json::from_str(output.lines().nth(1).unwrap()).unwrap();
        assert_eq!(restored, json!({"saved":{"n":42,"origin":"BEFORE_THE_CRASH"},"items":[{"content":"ONE_DURABLE_EFFECT","status":"in_progress"}]}));
        answer.delta("RECOVERED_ANSWER").await;
        answer.finish().await;
        completed(&client, &session, run).await;
        let after = cold_evidence(&root, &session, run).await;
        assert_eq!(after.runs, 1);
        assert_eq!(after.unfinished, 0);
        assert_eq!(&after.facts[..before.facts.len()], before.facts.as_slice());
        assert_eq!(after.cells.iter().find(|cell| cell.id==original_cell.id), Some(original_cell));
        assert_eq!(after.cells.len(), 2, "only the explicitly requested second Cell may start");
        assert_eq!(after.value, before.value);
        assert_eq!(after.loaded, before.loaded);
        assert_eq!(after.write_return, before.write_return);
        let writes: Vec<_> = after.facts.iter().filter_map(|record| match &record.fact {
            Fact::Cell {event:CellEvent::ChildPrepared {cell,operation,name,..}} if name=="todo_write" => Some((*cell,*operation)), _ => None,
        }).collect();
        assert_eq!(writes.len(), 1);
        let (write_cell, write_operation) = writes[0];
        assert_eq!(write_cell, original_cell.id);
        assert_eq!(after.facts.iter().filter(|record| matches!(&record.fact,
            Fact::Cell {event:CellEvent::ChildAdmitted {cell,operation}} if *cell==write_cell && *operation==write_operation)).count(), 1);
        assert_eq!(after.facts.iter().filter(|record| matches!(&record.fact,
            Fact::Cell {event:CellEvent::LocalChildReturned {cell,operation,is_error:false,..}} if *cell==write_cell && *operation==write_operation)).count(), 1);
        assert_eq!(client.query("agent", "checklist", json!({"sessionId":session})).await.unwrap(), checklist);
        same_business_receipt(&receipt, &client.recover(operation).await.unwrap());
        assert!(!after.facts.iter().any(|record| matches!(&record.fact, Fact::StopRequested {..} | Fact::Blocked {..})));

        // A fresh message is tested only after the original Run has actually completed.
        mutate(&client, "send", json!({"sessionId":session,"message":"AFTER_THE_CRASH","backend":{"kind":"model","connectionId":selection["connectionId"],"modelId":selection["modelId"]}})).await;
        let mut fresh = requests.recv().await.unwrap();
        assert!(fresh.body["messages"].to_string().contains("AFTER_THE_CRASH"));
        let fresh_run = cold_evidence(&root, &session, run).await.latest;
        assert_ne!(fresh_run, run);
        fresh.delta("ANSWER").await;
        fresh.finish().await;
        completed(&client, &session, fresh_run).await;
        let history = client.query("agent", "history", json!({"sessionId":session,"position":{"kind":"start"}})).await.unwrap();
        let chunks = history["chunks"].as_array().unwrap();
        assert!(chunks.iter().any(|chunk| chunk.to_string().contains("BEFORE_THE_CRASH")));
        assert!(chunks.iter().any(|chunk| chunk.to_string().contains("RECOVERED_ANSWER")));
        assert!(chunks.iter().any(|chunk| chunk.to_string().contains("ANSWER")));
        assert_eq!(count.load(Ordering::SeqCst), calls_before_crash + read_waits + 3, "no concurrent frontier or replayed Cell may dispatch additional model work");
        assert!(matches!(requests.try_recv(), Err(mpsc::error::TryRecvError::Empty)));
        client.close().await.unwrap();
    }).await.expect("same-Run cold recovery after a killed Host timed out");
    provider.abort();
    assert!(provider.await.unwrap_err().is_cancelled());
}
