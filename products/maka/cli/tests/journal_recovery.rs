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

#![cfg(unix)]

// Lost delivery after a known commit, not an injected transaction gap or an
// assertion that an unobserved provider receipt must have been Unknown.
#[path = "support/host.rs"]
mod host;

use futures_util::FutureExt;
use host::{Host, Result, Sandbox};
use maka_app_client::{Client, Journal};
use maka_capabilities::call::Attachments;
use maka_host_runtime::{
    application::{host::Client as HostClient, transport::Reply},
    ipc::LocalListener,
};
use maka_plugin_core::operation::{
    OperationOutcome, OperationReply, OperationResult, Receipt, RecoveryRef,
};
use serde_json::{Value, json};
use std::{
    future::Future,
    panic::AssertUnwindSafe,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt},
    net::UnixStream,
    sync::{mpsc, oneshot},
    task::{JoinHandle, JoinSet},
};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

async fn phase<T>(name: &str, future: impl Future<Output = Result<T>>) -> Result<T> {
    tokio::time::timeout(Duration::from_secs(30), future)
        .await
        .map_err(|_| format!("deadline waiting for {name}"))?
        .map_err(|error| format!("{name}: {error}"))
}

struct Frame {
    prefix: [u8; 4],
    body: Vec<u8>,
    value: Value,
}
impl Frame {
    async fn read(input: &mut (impl AsyncRead + Unpin)) -> Result<Option<Self>> {
        let mut prefix = [0; 4];
        if input
            .read(&mut prefix[..1])
            .await
            .map_err(|error| error.to_string())?
            == 0
        {
            return Ok(None);
        }
        input
            .read_exact(&mut prefix[1..])
            .await
            .map_err(|error| format!("partial frame prefix: {error}"))?;
        let length = u32::from_be_bytes(prefix) as usize;
        if !(1..=32 * 1024 * 1024).contains(&length) {
            return Err(format!("unexpected application frame length {length}"));
        }
        let mut body = vec![0; length];
        input
            .read_exact(&mut body)
            .await
            .map_err(|error| format!("partial frame body: {error}"))?;
        let value =
            serde_json::from_slice(&body).map_err(|error| format!("frame JSON: {error}"))?;
        Ok(Some(Self {
            prefix,
            body,
            value,
        }))
    }
    async fn forward(&self, output: &mut (impl AsyncWrite + Unpin)) -> Result<()> {
        output
            .write_all(&self.prefix)
            .await
            .map_err(|error| error.to_string())?;
        output
            .write_all(&self.body)
            .await
            .map_err(|error| error.to_string())?;
        output.flush().await.map_err(|error| error.to_string())
    }
}

#[derive(Clone, Debug)]
struct Request {
    endpoint: String,
    method: String,
    input: Value,
}
enum Route {
    Metadata(Value),
    Recovery(RecoveryRef),
}
#[derive(Default)]
struct Audit {
    requests: Vec<Request>,
    confirmations: usize,
}
enum Ingress {
    Opening,
    Anchor,
    Open,
    Descriptors,
    Control,
}
struct Probe {
    address: PathBuf,
    reference: Arc<Mutex<Option<RecoveryRef>>>,
    audit: Arc<Mutex<Audit>>,
    held: oneshot::Receiver<OperationReply>,
    failures: mpsc::UnboundedReceiver<String>,
    stop: CancellationToken,
    task: Option<JoinHandle<()>>,
}
impl Probe {
    fn spawn(address: PathBuf, upstream: PathBuf, route: Route) -> Result<Self> {
        // This is only the Application JSON transport with no request resources,
        // not a generic Unix/SCM_RIGHTS relay.
        let mut listener = LocalListener::bind(&address).map_err(|error| error.to_string())?;
        let reference = Arc::new(Mutex::new(None));
        let audit = Arc::new(Mutex::new(Audit::default()));
        let (sent, held) = oneshot::channel();
        let sent = Arc::new(Mutex::new(Some(sent)));
        let (failures_tx, failures) = mpsc::unbounded_channel();
        let stop = CancellationToken::new();
        let (expected, log, end) = (reference.clone(), audit.clone(), stop.clone());
        let route = Arc::new(route);
        let task = tokio::spawn(async move {
            let mut calls = JoinSet::new();
            loop {
                tokio::select! {
                    _ = end.cancelled() => break,
                    joined = calls.join_next(), if !calls.is_empty() => {
                        if let Err(error) = joined.expect("nonempty calls") {
                            let _ = failures_tx.send(format!("proxy task panicked: {error}"));
                        }
                    }
                    accepted = listener.accept() => {
                        let socket = match accepted {
                            Ok(socket) => socket,
                            Err(error) => { let _ = failures_tx.send(format!("proxy accept: {error}")); break; }
                        };
                        let (upstream, route, expected, log, sent, end, failed) =
                            (upstream.clone(), route.clone(), expected.clone(), log.clone(), sent.clone(), end.clone(), failures_tx.clone());
                        calls.spawn(async move {
                            if let Err(error) = relay(socket, upstream, route, expected, log, sent, end).await {
                                let _ = failed.send(error);
                            }
                        });
                    }
                }
            }
            while let Some(joined) = calls.join_next().await {
                if let Err(error) = joined {
                    let _ = failures_tx.send(format!("proxy settlement panicked: {error}"));
                }
            }
        });
        Ok(Self {
            address,
            reference,
            audit,
            held,
            failures,
            stop,
            task: Some(task),
        })
    }

    async fn finish(&mut self) -> Result<()> {
        self.stop.cancel();
        if let Some(task) = &mut self.task {
            let joined = task.await;
            self.task = None;
            joined.map_err(|error| format!("join proxy: {error}"))?;
        }
        let mut failures = Vec::new();
        while let Ok(error) = self.failures.try_recv() {
            failures.push(error);
        }
        if !failures.is_empty() {
            return Err(failures.join("; "));
        }
        Ok(())
    }
}

async fn relay(
    downstream: UnixStream,
    address: PathBuf,
    route: Arc<Route>,
    reference: Arc<Mutex<Option<RecoveryRef>>>,
    audit: Arc<Mutex<Audit>>,
    held: Arc<Mutex<Option<oneshot::Sender<OperationReply>>>>,
    stop: CancellationToken,
) -> Result<()> {
    let upstream = maka_host_runtime::ipc::connect(&address)
        .await
        .map_err(|error| error.to_string())?;
    let (mut client_input, mut client_output) = downstream.into_split();
    let (mut host_input, mut host_output) = upstream.into_split();
    let upload = async {
        let mut ingress = Ingress::Opening;
        while let Some(frame) = Frame::read(&mut client_input).await? {
            ingress = match ingress {
                Ingress::Opening => {
                    if frame.value["version"] != 1 || !frame.value["epoch"].is_string() {
                        return Err("probe only accepts epoch-pinned Application protocol v1, not ancillary transports".into());
                    }
                    match frame.value["request"]["kind"].as_str() {
                        Some("connect") => Ingress::Anchor,
                        Some("call") => Ingress::Open,
                        other => return Err(format!("unsupported proxy opening: {other:?}")),
                    }
                }
                Ingress::Open => {
                    let request = Request {
                        endpoint: frame.value["endpoint"]
                            .as_str()
                            .ok_or("missing Open.endpoint")?
                            .into(),
                        method: frame.value["method"]
                            .as_str()
                            .ok_or("missing Open.method")?
                            .into(),
                        input: frame
                            .value
                            .get("input")
                            .ok_or("missing Open.input")?
                            .clone(),
                    };
                    match route.as_ref() {
                        Route::Metadata(input) => {
                            if request.endpoint != "agent"
                                || request.method != "metadata"
                                || &request.input != input
                            {
                                return Err(format!(
                                    "unexpected original business request: {request:?}"
                                ));
                            }
                        }
                        Route::Recovery(original) => {
                            let observed: RecoveryRef =
                                serde_json::from_value(request.input.clone())
                                    .map_err(|error| error.to_string())?;
                            if request.endpoint != "receipts"
                                || request.method != "read"
                                || &observed != original
                            {
                                return Err(format!(
                                    "recovery attempted something other than the exact original receipt: {request:?}"
                                ));
                            }
                        }
                    }
                    audit.lock().unwrap().requests.push(request);
                    Ingress::Descriptors
                }
                Ingress::Descriptors => {
                    let descriptors = frame
                        .value
                        .as_object()
                        .ok_or("request descriptors must be an object")?;
                    if !descriptors.is_empty() {
                        return Err(
                            "this probe refuses request resources and FD-bearing transports".into(),
                        );
                    }
                    Ingress::Control
                }
                Ingress::Control => {
                    match frame.value["kind"].as_str() {
                        Some("confirm") => {
                            audit.lock().unwrap().confirmations += 1;
                        }
                        Some("cancel" | "pull") => {}
                        other => return Err(format!("unsupported call control: {other:?}")),
                    }
                    Ingress::Control
                }
                Ingress::Anchor => {
                    if !matches!(
                        frame.value["kind"].as_str(),
                        Some("close" | "capture" | "epochs" | "refresh")
                    ) {
                        return Err(format!("unsupported anchor control: {}", frame.value));
                    }
                    Ingress::Anchor
                }
            };
            frame.forward(&mut host_output).await?;
        }
        Ok(())
    };
    let download = async {
        while let Some(frame) = Frame::read(&mut host_input).await? {
            if frame.value["kind"] == "mutation" {
                let Reply::Mutation { reply, .. } =
                    serde_json::from_slice(&frame.body).map_err(|error| error.to_string())?
                else {
                    return Err("mutation frame had a different typed Reply".into());
                };
                let original = reference
                    .lock()
                    .unwrap()
                    .clone()
                    .ok_or("unarmed mutation terminal")?;
                if reply.reference != original {
                    return Err("terminal differs from the entire original RecoveryRef".into());
                }
                let sender = held
                    .lock()
                    .unwrap()
                    .take()
                    .ok_or("duplicate terminal mutation")?;
                sender
                    .send(*reply)
                    .map_err(|_| "terminal observer disappeared")?;
                // Do not send even its length prefix. Keep the original observer
                // pending until the exact Host has been killed and reaped.
                stop.cancelled().await;
                return Ok(());
            }
            frame.forward(&mut client_output).await?;
        }
        Ok(())
    };
    tokio::select! {
        _ = stop.cancelled() => Ok(()),
        result = upload => result,
        result = download => result,
    }
}

fn returned(reply: &OperationReply) -> Result<Value> {
    match &reply.receipt {
        Receipt::Recorded {
            outcome:
                OperationOutcome::Returned {
                    result: OperationResult::Success { value },
                },
            ..
        } => Ok(value.clone()),
        other => Err(format!(
            "expected actual recorded Returned success, got {other:?}"
        )),
    }
}

async fn session(client: &Client, prefix: &str, id: &str) -> Result<Value> {
    let page = client
        .query(
            "agent",
            "list",
            json!({
                "filter":"all", "position":{"kind":"start"}, "titleQuery":prefix,
            }),
        )
        .await?;
    let sessions = page["sessions"].as_array().ok_or("list omitted sessions")?;
    if sessions.len() != 1 || sessions[0]["id"] != id {
        return Err(format!("expected the one original Session, got {page}"));
    }
    Ok(sessions[0].clone())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn withheld_metadata_reply_survives_sigkill_and_recovers_the_original_journal_attempt() {
    let sandbox = Sandbox::new()
        .await
        .expect("owned empty Unix HOME/Root/workspace");
    let mut hosts = Vec::new();
    let mut probes = Vec::new();
    let mut confirming: Option<JoinHandle<Result<OperationReply>>> = None;
    let outcome = AssertUnwindSafe(async {
        tokio::time::timeout(Duration::from_secs(180), async {
            hosts.push(Host::spawn(&sandbox)?);
            let (first, address) = phase("first Host ready/real registrations", hosts[0].ready()).await?;
            let epoch = first.epoch();
            let source = first.source().clone();
            let journal = phase("open original client Journal", Journal::open(&sandbox.journal)).await?;
            let observer = Client::new(
                phase("independent first Host client", HostClient::connect(&address, Some(epoch))).await?,
                journal.clone(), "receipts".into(),
            )?;
            let prefix = format!("journal-{}", Uuid::new_v4().simple());
            let before_title = format!("{prefix}-before");
            let after_title = format!("{prefix}-after");
            let seed = phase("open real model-free Session creation", observer.mutation(
                Uuid::new_v4(), "agent", "create",
                json!({"title":before_title, "automaticTitle":false, "labels":[], "backend":null,
                    "tools":[], "workspace":{"kind":"directory","path":sandbox.workspace}}),
                Attachments::new(), None, json!({"kind":"journal-recovery-seed"}),
            )).await?;
            phase("prepare real Session creation", seed.prepare()).await?;
            let created = returned(&phase("confirm real Session creation", seed.confirm()).await?)?;
            if created["kind"] != "created" { return Err(format!("Session creation rejected: {created}")); }
            let id = created["session"]["id"].as_str().ok_or("creation omitted Session id")?.to_owned();
            let before = phase("independent initial Session query", session(&observer, &prefix, &id)).await?;
            let revision = before["revision"].as_u64().ok_or("Session revision missing")?;
            let expected_revision = revision.checked_add(1).ok_or("Session revision overflow")?;
            let input = json!({"sessionId":id,"expectedRevision":revision,"title":after_title,"labels":[]});
            probes.push(Probe::spawn(sandbox.directory.path().join("lost-reply.sock"), address, Route::Metadata(input.clone()))?);
            let original = Client::new(
                phase("original SDK through byte proxy", HostClient::connect(&probes[0].address, Some(epoch))).await?,
                journal, "receipts".into(),
            )?;
            let client_id = Uuid::new_v4();
            let mutation = phase("open original metadata once", original.mutation(
                client_id, "agent", "metadata", input, Attachments::new(), Some(id.clone()),
                json!({"kind":"journal-recovery-metadata"}),
            )).await?;
            let prepared = phase("durably prepare opaque original RecoveryRef", mutation.prepare()).await?;
            let reference = prepared.reference.ok_or("SDK prepare omitted original RecoveryRef")?;
            assert_eq!(prepared.id, client_id);
            assert!(!prepared.abandoned && prepared.receipt.is_none());
            reference.validate().map_err(|error| error.to_string())?;
            assert_eq!(phase("read durable client preparation", original.operation(client_id)).await?.reference.as_ref(), Some(&reference));
            *probes[0].reference.lock().unwrap() = Some(reference.clone());
            confirming = Some(tokio::spawn(async move { mutation.confirm().await }));
            let held = phase("complete terminal frame withheld before its prefix", async {
                let probe = &mut probes[0];
                tokio::select! {
                    reply = &mut probe.held => reply.map_err(|error| error.to_string()),
                    failure = probe.failures.recv() => Err(format!("proxy failed: {failure:?}")),
                    reply = confirming.as_mut().expect("original confirm task") => {
                        confirming = None;
                        Err(format!("original SDK received a result before held terminal: {reply:?}"))
                    },
                }
            }).await?;
            assert_eq!(held.reference, reference);
            let committed = returned(&held)?;
            assert_eq!(committed["kind"], "committed");
            let after = phase("independent query proves domain commit before crash", session(&observer, &prefix, &id)).await?;
            assert_eq!(after["revision"], expected_revision);
            assert_eq!(after["title"], after_title);
            assert_eq!(committed["session"]["id"], id);
            assert_eq!(committed["session"]["revision"], expected_revision);
            assert_eq!(committed["session"]["title"], after_title);
            assert!(phase("original client still has no terminal receipt", original.operation(client_id)).await?.receipt.is_none());
            assert!(!confirming.as_ref().unwrap().is_finished());
            phase("SIGKILL and wait exact original Host", hosts[0].sigkill()).await?;
            phase("settle first proxy after original Host death", probes[0].finish()).await?;
            let delivered = phase("settle original unacknowledged confirm", async {
                Ok(confirming.as_mut().unwrap().await)
            }).await?;
            confirming = None;
            let delivered = delivered.map_err(|error| error.to_string())?;
            assert!(delivered.is_err(), "suppressed terminal must never reach the original SDK: {delivered:?}");
            assert!(phase("receipt remains absent after transport loss", original.operation(client_id)).await?.receipt.is_none());
            {
                let audit = probes[0].audit.lock().unwrap();
                assert_eq!(audit.requests.len(), 1, "{:?}", audit.requests);
                assert_eq!(audit.confirmations, 1);
            }

            hosts.push(Host::spawn(&sandbox)?);
            let (mut reopened, address) = phase("new Host on same owned Root", hosts[1].ready()).await?;
            assert_ne!(reopened.epoch(), epoch);
            assert_eq!(reopened.source(), &source);
            let fresh_journal = phase("reopen original Journal from disk", Journal::open(&sandbox.journal)).await?;
            probes.push(Probe::spawn(sandbox.directory.path().join("recovery.sock"), address.clone(), Route::Recovery(reference.clone()))?);
            let recovery = Client::new(
                phase("new SDK and epoch for receipt queries", HostClient::connect(&probes[1].address, Some(reopened.epoch()))).await?,
                fresh_journal.clone(), "receipts".into(),
            )?;
            let new_observer = Client::new(
                phase("independent reopened domain client", HostClient::connect(&address, Some(reopened.epoch()))).await?,
                fresh_journal, "receipts".into(),
            )?;
            let saved = phase("load original client UUID, not reinvoke", recovery.operation(client_id)).await?;
            assert_eq!(saved.id, client_id);
            assert_eq!(saved.reference.as_ref(), Some(&reference));
            assert!(saved.receipt.is_none() && !saved.abandoned);
            let persisted = phase("query domain before any receipt recovery", session(&new_observer, &prefix, &id)).await?;
            assert_eq!(persisted["revision"], expected_revision);
            assert_eq!(persisted["title"], after_title);
            for _ in 0..2 {
                let receipt = phase("read only original complete receipt reference", recovery.recover(client_id)).await?;
                assert_eq!(receipt.reference, reference);
                assert_eq!(returned(&receipt)?, committed);
            }
            let final_session = phase("recovery did not duplicate metadata or creation", session(&new_observer, &prefix, &id)).await?;
            assert_eq!(final_session["revision"], expected_revision);
            assert_eq!(final_session["title"], after_title);
            assert!(phase("recovery durably observes receipt locally", recovery.operation(client_id)).await?.receipt.is_some());
            {
                let audit = probes[1].audit.lock().unwrap();
                assert_eq!(audit.requests.len(), 2, "{:?}", audit.requests);
                assert_eq!(audit.confirmations, 0, "recovery must not confirm a business mutation");
            }
            phase("close reopened SDK receipt observer", recovery.close()).await?;
            phase("close reopened domain observer", new_observer.close()).await?;
            phase("settle second proxy", probes[1].finish()).await?;
            phase("new Host quit acknowledgement, EOF and wait", hosts[1].quit(&mut reopened)).await?;
            Ok::<_, String>(())
        }).await.map_err(|_| "overall journal recovery deadline".to_owned())?
    }).catch_unwind().await;

    // Slots and the owned directory outlive cancellation/panic of every startup
    // and body future. Reap first; proxy shutdown must not masquerade as a Root ACK.
    let mut cleanup = Vec::new();
    for process in &mut hosts {
        if let Err(error) =
            phase("failure cleanup exact Host SIGKILL/wait", process.cleanup()).await
        {
            cleanup.push(error);
        }
    }
    for probe in &mut probes {
        if let Err(error) = phase("settle owned byte proxy", probe.finish()).await {
            cleanup.push(error);
        }
    }
    if let Some(task) = &mut confirming {
        if let Err(error) = phase("settle owned original confirmation observer", async {
            task.await.map(|_| ()).map_err(|error| error.to_string())
        })
        .await
        {
            cleanup.push(error);
        }
    }
    if !cleanup.is_empty() {
        eprintln!("journal recovery cleanup failures: {}", cleanup.join("; "));
    }
    match outcome {
        Err(panic) => std::panic::resume_unwind(panic),
        Ok(Err(error)) => panic!("{error}; cleanup={cleanup:?}"),
        Ok(Ok(())) => assert!(cleanup.is_empty(), "{cleanup:?}"),
    }
}
