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

#[path = "support/acp_release.rs"]
mod acp_release;
#[path = "support/host.rs"]
mod host;

use futures_util::FutureExt;
use host::{Host, Result, Sandbox};
use maka_agent_facts::durable::{
    AuthorityStage, BlockerId, BlockerKind, Fact, FactId, RunId, Trigger, UnixMillis,
};
use maka_agent_state::{
    Change, DriverDomain, Store,
    queue::{QueueCommand, QueueEdit, SteeringTarget},
};
use maka_app_client::{Client, Journal};
use maka_capabilities::call::Attachments;
use maka_event_log::root::{RootNamespaces, RootOwner};
use maka_host_runtime::application::host::Client as HostClient;
use maka_plugin_core::composition::ConfigurationField;
use maka_plugin_core::deployment::DeploymentRef;
use maka_plugin_core::operation::{
    OperationCleanup, OperationOutcome, OperationReply, OperationResult, Receipt, RecoveryRef,
};
use maka_process::isolated::{self, Descriptor, EvidenceInterest, EvidenceWatch};
use serde_json::{Value, json};
use std::{
    future::Future,
    io::Read,
    panic::AssertUnwindSafe,
    path::{Path, PathBuf},
    process::Stdio,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    net::{TcpListener, TcpStream},
    process::{Child, Command},
    sync::{mpsc, watch},
    task::{JoinHandle, JoinSet},
};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

async fn phase<T>(name: &str, work: impl Future<Output = Result<T>>) -> Result<T> {
    tokio::time::timeout(Duration::from_secs(45), work)
        .await
        .map_err(|_| format!("deadline: {name}"))?
        .map_err(|error| format!("{name}: {error}"))
}

struct Peer {
    pid: Option<u64>,
    send: mpsc::UnboundedSender<Value>,
}
struct ControlState {
    peers: Vec<Peer>,
    events: Vec<Value>,
}
struct Controller {
    address: String,
    namespace: PathBuf,
    state: Arc<Mutex<ControlState>>,
    changed: watch::Sender<u64>,
    stop: CancellationToken,
    task: Option<JoinHandle<Result<()>>>,
}
impl Controller {
    async fn open() -> Result<Self> {
        let namespace = tokio::task::spawn_blocking(maka_sandbox::native_task_namespace)
            .await
            .map_err(|e| e.to_string())?
            .map_err(|e| e.to_string())?;
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .map_err(|e| e.to_string())?;
        let address = format!(
            "tcp://{}",
            listener.local_addr().map_err(|e| e.to_string())?
        );
        let state = Arc::new(Mutex::new(ControlState {
            peers: vec![],
            events: vec![],
        }));
        let (changed, _) = watch::channel(0);
        let stop = CancellationToken::new();
        let (shared, wake, stopped) = (state.clone(), changed.clone(), stop.clone());
        let task = tokio::spawn(async move {
            let mut connections = JoinSet::new();
            loop {
                tokio::select! {
                    biased;
                    () = stopped.cancelled() => break,
                    joined = connections.join_next(), if !connections.is_empty() => {
                        joined.ok_or("missing control connection")?.map_err(|e| e.to_string())??;
                    }
                    incoming = listener.accept() => {
                        let (stream, _) = incoming.map_err(|e| e.to_string())?;
                        let (send, receive) = mpsc::unbounded_channel();
                        let index = {
                            let mut state = shared.lock().unwrap();
                            let index = state.peers.len();
                            state.peers.push(Peer { pid: None, send });
                            index
                        };
                        connections.spawn(control_connection(stream, receive, index, shared.clone(), wake.clone(), stopped.clone()));
                    }
                }
            }
            while let Some(joined) = connections.join_next().await {
                joined.map_err(|e| e.to_string())??;
            }
            Ok(())
        });
        Ok(Self {
            address,
            namespace,
            state,
            changed,
            stop,
            task: Some(task),
        })
    }
    fn events(&self) -> Vec<Value> {
        self.state.lock().unwrap().events.clone()
    }
    async fn event(&self, label: &str, kind: &str) -> Result<Value> {
        let mut changed = self.changed.subscribe();
        loop {
            let events = self.events();
            if let Some(failure) = events.iter().find(|e| e["kind"] == "failure") {
                return Err(format!("provider: {}", failure["message"]));
            }
            if let Some(event) = events
                .iter()
                .find(|e| e["job"] == label && e["kind"] == kind)
            {
                return Ok(event.clone());
            }
            changed.changed().await.map_err(|e| e.to_string())?;
        }
    }
    fn send(&self, pid: u64, value: Value) -> Result<()> {
        self.state
            .lock()
            .unwrap()
            .peers
            .iter()
            .find(|p| p.pid == Some(pid))
            .ok_or("original provider connection missing")?
            .send
            .send(value)
            .map_err(|e| e.to_string())
    }
    fn exit_all(&self) {
        for peer in &self.state.lock().unwrap().peers {
            let _closed = peer.send.send(json!({"action":"exit"}));
        }
    }
    fn resource(&self, pid: u64) -> Result<Descriptor> {
        let hello = self
            .events()
            .into_iter()
            .find(|e| e["kind"] == "hello" && e["pid"] == pid)
            .ok_or("original provider hello missing")?;
        let tmp = PathBuf::from(hello["tmp"].as_str().ok_or("task tmp missing")?);
        let resource = tmp.parent().ok_or("task resource missing")?.to_path_buf();
        if resource.parent() != Some(self.namespace.as_path()) {
            return Err("provider did not enter the actual private namespace".into());
        }
        Ok(Descriptor {
            resource_ref: resource,
        })
    }
    fn assert_submissions(&self, jobs: usize, resumes: usize) {
        let events = self.events();
        assert!(!events.iter().any(|e| e["kind"] == "failure"), "{events:?}");
        assert_eq!(
            events.iter().filter(|e| e["kind"] == "hello").count(),
            jobs,
            "no replacement process: {events:?}"
        );
        for (method, count) in [
            ("thread/start", jobs - resumes),
            ("thread/resume", resumes),
            ("turn/start", jobs),
        ] {
            assert_eq!(
                events
                    .iter()
                    .filter(|e| e["kind"] == "method" && e["method"] == method)
                    .count(),
                count,
                "{events:?}"
            );
        }
        assert!(
            !events
                .iter()
                .any(|e| e["kind"] == "method" && e["method"] == "turn/steer")
        );
        assert_eq!(
            events.iter().filter(|e| e["kind"] == "host_call").count(),
            1,
            "{events:?}"
        );
        assert_eq!(
            events.iter().filter(|e| e["kind"] == "effect").count(),
            1,
            "{events:?}"
        );
    }
}
async fn control_connection(
    stream: TcpStream,
    mut commands: mpsc::UnboundedReceiver<Value>,
    index: usize,
    state: Arc<Mutex<ControlState>>,
    changed: watch::Sender<u64>,
    stop: CancellationToken,
) -> Result<()> {
    let (input, mut output) = stream.into_split();
    let mut lines = BufReader::new(input).lines();
    loop {
        tokio::select! {
            () = stop.cancelled() => return Ok(()),
            command = commands.recv() => {
                let Some(command) = command else { return Ok(()); };
                output.write_all(format!("{}\n", command).as_bytes()).await.map_err(|e| e.to_string())?;
            }
            read = lines.next_line() => {
                let line = match read {
                    Ok(Some(line)) => line,
                    Ok(None) => return Ok(()),
                    Err(error) if error.kind() == std::io::ErrorKind::ConnectionReset => return Ok(()),
                    Err(error) => return Err(error.to_string()),
                };
                if line.len() > 65536 { return Err("oversized controller frame".into()); }
                let event: Value = serde_json::from_str(&line).map_err(|e| e.to_string())?;
                let mut state = state.lock().unwrap();
                let pid = event["pid"].as_u64().ok_or("provider PID missing")?;
                if let Some(original) = state.peers[index].pid {
                    if original != pid { return Err("control connection changed its original PID".into()); }
                } else {
                    if event["kind"] != "hello" { return Err("first provider frame is not hello".into()); }
                    state.peers[index].pid = Some(pid);
                }
                state.events.push(event);
                changed.send_modify(|revision| *revision += 1);
            }
        }
    }
}

struct Transcript {
    input: Vec<Value>,
    output: Vec<Value>,
}
impl Transcript {
    fn task_prompt(&self) -> &Value {
        let mut prompts = self
            .input
            .iter()
            .filter(|row| row["method"] == "session/prompt");
        let task = prompts.next().expect("original task prompt");
        assert!(prompts.next().is_none(), "expected a single ACP prompt");
        task
    }
}
async fn sealed(descriptor: Descriptor) -> Result<Transcript> {
    let mut watch = EvidenceWatch::open(&descriptor, EvidenceInterest::Cleanup)
        .await
        .map_err(|e| e.to_string())?;
    let waited = watch.wait().await.map_err(|e| e.to_string());
    let closed = watch.close().await.map_err(|e| e.to_string());
    waited?;
    closed?;
    let evidence = isolated::closed_evidence(&descriptor)
        .await
        .map_err(|e| e.to_string())?
        .ok_or("original Domain closure absent after notification")?;
    tokio::task::spawn_blocking(move || {
        fn frames(mut file: std::fs::File) -> Result<Vec<Value>> {
            if file.metadata().map_err(|e| e.to_string())?.len() > 2 * 1024 * 1024 {
                return Err("unexpected protocol size".into());
            }
            let mut bytes = String::new();
            file.read_to_string(&mut bytes).map_err(|e| e.to_string())?;
            bytes
                .lines()
                .map(|line| serde_json::from_str(line).map_err(|e| e.to_string()))
                .collect()
        }
        assert!(
            evidence.snapshot.is_none(),
            "built-in CLI must not stage a workspace snapshot"
        );
        assert!(matches!(
            evidence.receipt,
            isolated::TaskReceipt::Task {
                terminal_size: None,
                ..
            }
        ));
        Ok(Transcript {
            input: frames(evidence.stdin)?,
            output: frames(evidence.stdout)?,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}
fn check_transcript(transcript: &Transcript, ready: &Value, terminal: Option<&str>) {
    for method in ["initialize", "thread/start", "turn/start"] {
        let sent: Vec<_> = transcript
            .input
            .iter()
            .filter(|v| v["method"] == method)
            .collect();
        assert_eq!(sent.len(), 1, "original {method} only");
        let response = transcript
            .output
            .iter()
            .find(|v| v["id"] == sent[0]["id"] && v.get("method").is_none())
            .expect("original response");
        assert!(response.get("error").is_none());
        if method == "thread/start" {
            assert_eq!(response["result"]["thread"]["id"], ready["thread"]);
        }
        if method == "turn/start" {
            assert_eq!(response["result"]["turn"]["id"], ready["turn"]);
        }
    }
    assert!(
        !transcript
            .input
            .iter()
            .any(|v| matches!(v["method"].as_str(), Some("thread/resume" | "turn/steer")))
    );
    let completed: Vec<_> = transcript
        .output
        .iter()
        .filter(|v| v["method"] == "turn/completed")
        .collect();
    if let Some(status) = terminal {
        assert_eq!(completed.len(), 1);
        assert_eq!(completed[0]["params"]["threadId"], ready["thread"]);
        assert_eq!(completed[0]["params"]["turn"]["id"], ready["turn"]);
        assert_eq!(completed[0]["params"]["turn"]["status"], status);
    } else {
        assert!(completed.is_empty(), "never fabricate a native terminal");
    }
}

async fn node_executable() -> Result<PathBuf> {
    let output = Command::new("node")
        .args(["-e", "if (+process.versions.node.split('.')[0] < 24) process.exit(1); process.stdout.write(process.execPath)"])
        .stdin(Stdio::null())
        .kill_on_drop(true)
        .output().await.map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err(format!(
            "Node 24+ is required: {}",
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    Ok(PathBuf::from(
        String::from_utf8(output.stdout).map_err(|e| e.to_string())?,
    ))
}

struct Rig {
    sandbox: Sandbox,
    endpoint: Option<PathBuf>,
    root_pid: Option<u32>,
    hosts: Vec<Host>,
    commands: Vec<Child>,
    clients: Vec<Client>,
    evidence: Vec<JoinHandle<Result<Transcript>>>,
    controller: Controller,
}
impl Rig {
    async fn new() -> Result<Self> {
        Ok(Self {
            sandbox: Sandbox::new().await?,
            endpoint: None,
            root_pid: None,
            hosts: vec![],
            commands: vec![],
            clients: vec![],
            evidence: vec![],
            controller: Controller::open().await?,
        })
    }
    async fn start(&mut self) -> Result<(HostClient, Client)> {
        self.hosts.push(Host::spawn(&self.sandbox)?);
        let (anchor, address) = self.hosts.last_mut().unwrap().ready().await?;
        self.endpoint = Some(address.clone());
        let journal = Journal::open(&self.sandbox.journal).await?;
        let sdk = Client::new(
            HostClient::connect(&address, Some(anchor.epoch())).await?,
            journal,
            "receipts".into(),
        )?;
        self.clients.push(sdk.clone());
        Ok((anchor, sdk))
    }
    async fn configure(
        &mut self,
        anchor: &mut HostClient,
        sdk: &Client,
        runtime: &str,
    ) -> Result<DeploymentRef> {
        let node = node_executable().await?;
        let path = self.sandbox.workspace.join("external-codex-cli.mjs");
        tokio::fs::write(&path, include_bytes!("support/external_codex_cli.mjs"))
            .await
            .map_err(|error| error.to_string())?;
        let external = query(sdk, "agent", "externalAgents", json!({"inspect":true})).await?;
        assert_eq!(external["configured"], false);
        let source = query(sdk, "management", "read", json!({})).await?;
        let target = &external["target"];
        let original_epoch = anchor.catalogue().describe("agent")?.registration_epoch;
        let status = HostClient::status(
            self.endpoint
                .as_deref()
                .ok_or("held ready endpoint missing")?,
            Some(anchor.epoch()),
        )
        .await?;
        self.root_pid = Some(status.pid.get());
        let mut deployment: maka_plugin_core::deployment::management::ManagedDeployment =
            serde_json::from_value(source).map_err(|error| error.to_string())?;
        let external_path: Vec<String> =
            serde_json::from_value(target["path"].clone()).map_err(|error| error.to_string())?;
        let runtime_config = json!({
            "runtimes": {runtime: true},
            "commands": {runtime: {"executable": node, "args":[path], "env":{
                "FAKE_CONTROL": self.controller.address, "FAKE_ROOT_PID": status.pid.get().to_string()
            }}}
        });
        deployment
            .source
            .input
            .configure(
                &["agent".into()],
                vec![
                    ConfigurationField {
                        path: external_path,
                        value: Some(runtime_config),
                    },
                    ConfigurationField {
                        path: vec!["assistant".into(), "home".into()],
                        value: Some(json!(self.sandbox.home)),
                    },
                ],
            )
            .map_err(|error| error.to_string())?;
        let configured = mutate(
            sdk,
            "management",
            "replaceSource",
            json!({
                "expectedRevision": deployment.source.reference.revision,
                "document": {"input":deployment.source.input, "packages":deployment.packages,
                    "remoteExports":deployment.source.remote_exports}
            }),
        )
        .await?;
        assert_eq!(configured["status"], "committed", "{configured}");
        let committed: DeploymentRef = serde_json::from_value(configured["value"].clone())
            .map_err(|error| error.to_string())?;
        loop {
            anchor.refresh().await?;
            let current = anchor.catalogue().describe("agent")?.registration_epoch;
            if current.is_some() && current != original_epoch {
                break;
            }
            tokio::task::yield_now().await;
        }
        Ok(committed)
    }
    async fn resource(&self, pid: u64) -> Result<Descriptor> {
        let events = self.controller.events();
        if !events
            .iter()
            .any(|e| e["kind"] == "hello" && e["pid"] == pid && e["acp"] == true)
        {
            return self.controller.resource(pid);
        }
        let ready = events
            .iter()
            .find(|e| e["kind"] == "ready" && e["pid"] == pid)
            .ok_or("missing ACP worker ready")?;
        let label = format!("\"label\":\"{}\"", ready["job"].as_str().unwrap());
        let thread = ready["thread"].as_str().unwrap();
        let path = self.sandbox.root.join("runtime-rust.sqlite");
        // The provider can report ready before the Host commits the recovery binding.
        phase("record original ACP recovery binding", async {
            let mut tick = tokio::time::interval(Duration::from_millis(20));
            loop {
                tick.tick().await;
                let path = path.clone();
                let thread = thread.to_owned();
                let label = label.clone();
                let resource = tokio::task::spawn_blocking(move || {
                    use rusqlite::OptionalExtension;
                    let db = rusqlite::Connection::open_with_flags(
                        path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
                    )?;
                    db.query_row(
                        "SELECT json_extract(CAST(c.payload AS TEXT), '$.payload.privateResource.resourceRef')
                           FROM agent_runs r JOIN contents c
                             ON c.content_sha256 = json_extract(r.external, '$.binding.digest')
                          WHERE json_extract(CAST(c.payload AS TEXT), '$.payload.recovery.binding.task.session') = ?1
                            AND instr(json_extract(CAST(c.payload AS TEXT), '$.payload.request.content.text'), ?2) > 0
                          ORDER BY r.rowid DESC LIMIT 1",
                        rusqlite::params![thread, label],
                        |row| row.get::<_, String>(0),
                    ).optional()
                }).await.map_err(|error| error.to_string())?
                  .map_err(|error| error.to_string())?;
                if let Some(resource) = resource {
                    return Ok(Descriptor { resource_ref: resource.into() });
                }
            }
        }).await
    }
    async fn transcript(&mut self, pid: u64) -> Result<Transcript> {
        let descriptor = self.resource(pid).await?;
        self.evidence.push(tokio::spawn(sealed(descriptor)));
        let result = self.evidence.last_mut().unwrap().await;
        self.evidence.pop();
        result.map_err(|e| e.to_string())?
    }
    async fn inspect(&mut self, session: &str, run: &Value) -> Result<Vec<Value>> {
        let child = host::command(&self.sandbox)?
            .args(["inspect", "--root"])
            .arg(&self.sandbox.root)
            .args(["--session", session])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .map_err(|e| e.to_string())?;
        self.commands.push(child);
        let child = self.commands.last_mut().unwrap();
        let mut stdout = child.stdout.take().ok_or("inspection stdout missing")?;
        let mut bytes = Vec::new();
        let (read, status) = tokio::join!(stdout.read_to_end(&mut bytes), child.wait());
        read.map_err(|e| e.to_string())?;
        if !status.map_err(|e| e.to_string())?.success() {
            return Err("public canonical inspection failed".into());
        }
        let page: Value = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
        assert_eq!(page["truncated"], false);
        Ok(page["facts"]
            .as_array()
            .ok_or("inspection facts missing")?
            .iter()
            .filter(|row| row["item"]["recorded"]["run"] == *run)
            .map(|row| row["item"]["recorded"]["fact"].clone())
            .collect())
    }
    async fn cleanup(&mut self) -> Vec<String> {
        let mut errors = vec![];
        self.controller.exit_all();
        for host in &mut self.hosts {
            if let Err(error) = phase("reap exact Host", host.cleanup()).await {
                errors.push(error);
            }
        }
        for client in self.clients.drain(..) {
            if let Err(error) = phase("close retained SDK request resources", client.close()).await
            {
                errors.push(error);
            }
        }
        for child in &mut self.commands {
            let result = phase("reap exact probe/inspection child", async {
                if child.try_wait().map_err(|e| e.to_string())?.is_none() {
                    child.start_kill().map_err(|e| e.to_string())?;
                    child.wait().await.map_err(|e| e.to_string())?;
                }
                Ok(())
            })
            .await;
            if let Err(error) = result {
                errors.push(error);
            }
        }
        // Only descriptors observed from this fixture's original connected children.
        let pids: Vec<_> = self
            .controller
            .events()
            .iter()
            .filter(|e| e["kind"] == "hello")
            .filter_map(|e| e["pid"].as_u64())
            .collect();
        for pid in pids {
            if let Err(error) = phase(
                "original provider Domain/group/streams closure",
                self.transcript(pid),
            )
            .await
            {
                errors.push(error);
            }
        }
        while let Some(task) = self.evidence.pop() {
            if let Err(error) = phase("join retained original evidence observer", async {
                task.await.map_err(|e| e.to_string())?.map(|_| ())
            })
            .await
            {
                errors.push(error);
            }
        }
        self.controller.stop.cancel();
        if let Some(mut task) = self.controller.task.take()
            && let Err(error) = phase("join owned controller and original connections", async {
                (&mut task).await.map_err(|e| e.to_string())?
            })
            .await
        {
            errors.push(error);
        }
        errors
    }
}

async fn query(client: &Client, endpoint: &str, method: &str, input: Value) -> Result<Value> {
    client.query(endpoint, method, input).await
}
async fn mutate(client: &Client, endpoint: &str, method: &str, input: Value) -> Result<Value> {
    let mutation = client
        .mutation(
            Uuid::new_v4(),
            endpoint,
            method,
            input,
            Attachments::new(),
            None,
            json!({"kind":"external-jobs"}),
        )
        .await?;
    mutation.prepare().await?;
    let reply = mutation.confirm().await?;
    receipt_value(&reply)
}
fn receipt_value(reply: &OperationReply) -> Result<Value> {
    match &reply.receipt {
        Receipt::Recorded {
            outcome:
                OperationOutcome::Returned {
                    result: OperationResult::Success { value },
                },
            cleanup: OperationCleanup::Confirmed,
        } => Ok(value.clone()),
        Receipt::Recorded {
            outcome:
                OperationOutcome::Returned {
                    result: OperationResult::Failure { diagnostic },
                },
            cleanup: OperationCleanup::Confirmed,
        } => Err(diagnostic.clone()),
        _ => Err(
            "actual provider mutation did not return known success with independent cleanup".into(),
        ),
    }
}
async fn launch(
    client: &Client,
    workspace: &Path,
    label: &str,
    title: &str,
    effect: bool,
    runtime: &str,
) -> Result<(String, Value)> {
    let created = mutate(client, "agent", "create", json!({
        "title":format!("External job {label}"),"automaticTitle":false,"labels":[],
        "workspace":{"kind":"directory","path":workspace},
        "backend":{"kind":"executor","selection":{"executor":"external","settings":{"runtime":runtime,"model":if runtime == "codex" { "gpt-fixture" } else { "default" }}}}
    })).await?;
    assert_eq!(created["kind"], "created", "{created}");
    let session = created["session"].clone();
    let id = session["id"]
        .as_str()
        .ok_or("session id missing")?
        .to_owned();
    let access = if effect {
        "danger_full_access"
    } else {
        "read_only"
    };
    let changed = mutate(client,"agent","metadata",json!({
        "sessionId":id,"expectedRevision":session["revision"],"title":session["title"],"labels":[],
        "permissions":{"settings":{"access":access,"requestPermissions":true},"revokeGrants":false}
    })).await?;
    assert_eq!(changed["kind"], "committed", "{changed}");
    assert_eq!(changed["session"]["permissions"]["access"], access);
    let run = send_native(client, &id, label, title, effect).await?;
    Ok((id, run))
}
async fn send_native(
    client: &Client,
    id: &str,
    label: &str,
    title: &str,
    effect: bool,
) -> Result<Value> {
    let message = format!(
        "MAKA_EXTERNAL_CASE {}",
        json!({"label":label,"session":id,"title":title,"effect":effect})
    );
    let sent = mutate(
        client,
        "agent",
        "send",
        json!({"sessionId":id,"message":message,"delivery":"queue"}),
    )
    .await?;
    assert_eq!(sent["kind"], "queued", "{sent}");
    let mut tick = tokio::time::interval(Duration::from_millis(20));
    loop {
        tick.tick().await;
        let work = query(
            client,
            "agent",
            "work",
            json!({"sessionId":id,"target":{"kind":"message","messageId":sent["messageId"]}}),
        )
        .await?;
        match work["kind"].as_str() {
            Some("pending") => {}
            Some("delivered") => return Ok(work["execution"]["runId"].clone()),
            _ => return Err(format!("original admission unavailable: {work}")),
        }
    }
}
async fn checkpoint(client: &Client, session: &str, run: &Value, marker: &Value) -> Result<Value> {
    let mut tick = tokio::time::interval(Duration::from_millis(20));
    loop {
        tick.tick().await;
        let work = query(
            client,
            "agent",
            "work",
            json!({"sessionId":session,"target":{"kind":"run","runId":run}}),
        )
        .await?;
        if work["kind"] != "delivered" {
            return Err(format!("original Run missing: {work}"));
        }
        let history = query(
            client,
            "agent",
            "history",
            json!({"sessionId":session,"position":{"kind":"tail"},"includeThinking":false}),
        )
        .await?;
        if history["kind"] != "ready" {
            return Err(format!("original history unavailable: {history}"));
        }
        if let Some(chunk) = history["chunks"]
            .as_array()
            .ok_or("history chunks missing")?
            .iter()
            .find(|chunk| {
                chunk["role"] == "assistant"
                    && chunk["text"]
                        .as_str()
                        .is_some_and(|text| text == marker.as_str().unwrap())
            })
        {
            return Ok(json!({"execution":work["execution"],"prefix":{
                "text":chunk["text"],"messageId":chunk["messageId"],"position":chunk["position"],"offset":chunk["offset"]
            }}));
        }
        if !matches!(
            work["execution"]["state"]["kind"].as_str(),
            Some("running" | "waiting" | "admitted")
        ) {
            return Err(format!("no committed original output: {work}"));
        }
    }
}
async fn terminal_state(
    client: &Client,
    session: &str,
    run: &Value,
    expected: &str,
) -> Result<Value> {
    let mut tick = tokio::time::interval(Duration::from_millis(20));
    loop {
        tick.tick().await;
        let result = query(
            client,
            "agent",
            "execution",
            json!({"sessionId":session,"runId":run}),
        )
        .await?;
        if result["kind"] != "found" {
            return Err("original execution disappeared".into());
        }
        let state = &result["execution"]["state"];
        if state["kind"] == expected {
            return Ok(result["execution"].clone());
        }
        if !matches!(
            state["kind"].as_str(),
            Some("running" | "waiting" | "admitted")
        ) {
            return Err(format!("unexpected original state: {state}"));
        }
    }
}
async fn readiness(client: &Client, session: &str, run: &Value) -> Result<()> {
    let mut tick = tokio::time::interval(Duration::from_millis(20));
    loop {
        tick.tick().await;
        let result = query(
            client,
            "agent",
            "workReadiness",
            json!({"sessionId":session,"target":{"kind":"run","runId":run}}),
        )
        .await?;
        match result["kind"].as_str() {
            Some("ready") => return Ok(()),
            Some("pending") => {}
            _ => return Err("original physical readiness unavailable".into()),
        }
    }
}
async fn unique_effect(client: &Client, title: &str, id: &Value, parent: &str) -> Result<()> {
    let page = query(
        client,
        "agent",
        "list",
        json!({"filter":"all","position":{"kind":"start"},"titleQuery":title}),
    )
    .await?;
    let sessions = page["sessions"].as_array().ok_or("session list missing")?;
    assert_eq!(sessions.len(), 1, "one actual Host effect only: {page}");
    assert_eq!(sessions[0]["id"], *id);
    assert_eq!(sessions[0]["title"], title);
    assert_eq!(sessions[0]["parentSessionId"], parent);
    Ok(())
}
fn task_facts(facts: &[Value]) -> (&Value, &Value) {
    let prepared: Vec<_> = facts
        .iter()
        .filter(|f| f["kind"] == "external_task_prepared")
        .collect();
    let bound: Vec<_> = facts
        .iter()
        .filter(|f| f["kind"] == "external_task_bound")
        .collect();
    assert_eq!(prepared.len(), 1);
    assert_eq!(bound.len(), 1);
    assert_eq!(prepared[0]["task"], bound[0]["task"]);
    assert!(
        facts
            .iter()
            .any(|f| f["kind"] == "external_task_observed" && f["task"] == bound[0]["task"])
    );
    (prepared[0], bound[0])
}
fn confirmed_task(facts: &[Value], task: &Value) {
    assert!(
        facts
            .iter()
            .any(|f| f["kind"] == "external_task_cleanup_observed"
                && f["task"] == *task
                && f["cleanup"]["kind"] == "confirmed"),
        "independent original Domain ACK: {facts:?}"
    );
}

fn confirmed_effect(facts: &[Value], task: &Value, effect: &Value, title: &str, parent: &str) {
    let child_effects: Vec<_> = facts
        .iter()
        .filter(|fact| fact["kind"] == "cell")
        .map(|fact| &fact["event"])
        .collect();
    let prepared: Vec<_> = child_effects
        .iter()
        .filter(|event| event["kind"] == "child_prepared" && event["name"] == "SessionCreate")
        .collect();
    assert_eq!(prepared.len(), 1, "one original SessionCreate");
    let original = prepared[0];
    assert!(
        child_effects.iter().any(|event| {
            event["kind"] == "started"
                && event["cell"] == original["cell"]
                && event["owner"]["key"]["task"] == *task
        }),
        "SessionCreate ran inside the original external task's code cell"
    );
    let events: Vec<_> = child_effects
        .iter()
        .filter(|event| {
            event["cell"] == original["cell"] && event["operation"] == original["operation"]
        })
        .collect();
    for kind in ["child_admitted", "child_bound", "child_result_recorded"] {
        assert_eq!(
            events.iter().filter(|event| event["kind"] == kind).count(),
            1,
            "{kind}"
        );
    }
    let bound = events
        .iter()
        .find(|event| event["kind"] == "child_bound")
        .unwrap();
    let reference: RecoveryRef = serde_json::from_value(bound["reference"].clone())
        .expect("complete original Host reference");
    reference.validate().expect("valid original Host reference");
    let observations: Vec<_> = events
        .iter()
        .filter(|event| event["kind"] == "child_observed")
        .map(|event| &event["reply"])
        .collect();
    let final_receipt = &observations.last().expect("final Host observation")["receipt"];
    assert!(
        observations
            .iter()
            .all(|observation| observation["reference"] == bound["reference"])
    );
    assert_eq!(final_receipt["kind"], "recorded");
    assert_eq!(final_receipt["cleanup"]["kind"], "confirmed");
    assert_eq!(final_receipt["outcome"]["kind"], "returned");
    let result = &final_receipt["outcome"]["result"];
    assert!(
        result["kind"] == "success"
            || (result["kind"] == "referenced" && result["is_error"] == false)
    );
    assert_eq!(effect["title"], title);
    assert_ne!(effect["session"], parent);
}

async fn connect_sdk(rig: &mut Rig, anchor: &HostClient) -> Result<Client> {
    let client = Client::new(
        HostClient::connect(
            rig.endpoint.as_deref().ok_or("ready endpoint missing")?,
            Some(anchor.epoch()),
        )
        .await?,
        Journal::open(&rig.sandbox.journal).await?,
        "receipts".into(),
    )?;
    rig.clients.push(client.clone());
    Ok(client)
}
async fn run_case(crash: bool) {
    let mut rig = Rig::new()
        .await
        .expect("owned Root/home/workspace/controller");
    let outcome = AssertUnwindSafe(async {
        tokio::time::timeout(Duration::from_secs(180), async {
            let (mut anchor, bootstrap) = phase("default Host and Journal", rig.start()).await?;
            let committed_source = phase("configure actual external runtime", rig.configure(&mut anchor, &bootstrap, "codex")).await?;
            phase("close bootstrap SDK observer", bootstrap.close()).await?;
            rig.clients.pop();
            let sdk = phase("current SDK registration", connect_sdk(&mut rig, &anchor)).await?;
            let metadata = phase("post-config source from public SDK",query(&sdk,"management","read",json!({}))).await?;
            let post_config_source: DeploymentRef = serde_json::from_value(metadata["source"]["reference"].clone())
                .map_err(|error| error.to_string())?;
            assert_eq!(post_config_source,committed_source,"current source must equal the exact configured commit");
            let enabled = query(&sdk,"agent","externalAgents",json!({"inspect":true})).await?;
            assert!(enabled["runtimes"].as_array().unwrap().iter().any(|r| r["id"] == "codex" && r["enabled"] == true));
            let title = format!("external-effect-{}", Uuid::new_v4().simple());
            let label = if crash { "C" } else { "A" };
            let (session, run) = phase("launch exact original external task",
                launch(&sdk, &rig.sandbox.workspace, label, &title, true, "codex")).await?;
            let ready = phase("original provider accepted turn and actual MCP effect", rig.controller.event(label,"ready")).await?;
            let effect = phase("actual MCP creation result", rig.controller.event(label,"effect")).await?;
            let pid = ready["pid"].as_u64().ok_or("original PID missing")?;
            let before = phase("canonical bound-task output prefix", checkpoint(&sdk,&session,&run,&ready["checkpoint"])).await?;
            assert!(before["execution"]["highWater"].as_u64().unwrap() > 1);
            phase("independent unique side-effect readback", unique_effect(&sdk,&title,&effect["session"],&session)).await?;
            let descriptor = rig.controller.resource(pid)?;
            assert!(isolated::closed_evidence(&descriptor).await.map_err(|e| e.to_string())?.is_none(), "original task must still be physically live");
            if crash {
                let epoch = anchor.epoch();
                phase("close completed frontend calls, not the original native job",sdk.close()).await?;
                rig.clients.pop();
                assert!(isolated::closed_evidence(&descriptor).await.map_err(|e| e.to_string())?.is_none());
                phase("SIGKILL/reap exact held original Host", rig.hosts[0].sigkill()).await?;
                rig.controller.send(pid,json!({"action":"root_reaped","pid":rig.root_pid.ok_or("original Root PID missing")?}))?;
                phase("original native process observes its actual Root death", rig.controller.event("C","root_gone")).await?;
                let transcript = phase("original helper immutable group/stream closure", rig.transcript(pid)).await?;
                check_transcript(&transcript,&ready,None);
                assert!(!transcript.input.iter().any(|v| v["method"] == "turn/interrupt"));
                let original = phase("public offline original identities", rig.inspect(&session,&run)).await?;
                let (prepared, bound) = task_facts(&original);
                let prepared = prepared.clone();
                let bound = bound.clone();
                assert!(!original.iter().any(|f| f["kind"] == "external_task_closed"), "crash did not produce a business terminal");
                assert!(!original.iter().any(|f| f["kind"] == "external_task_cleanup_observed" && f["cleanup"]["kind"] == "confirmed"),
                    "dead Root did not ACK the later physical closure");
                let observed: Vec<_> = original.iter().filter(|f| f["kind"] == "external_task_observed").cloned().collect();
                let effects: Vec<_> = original.iter().filter(|f| f["kind"] == "external_effect").cloned().collect();
                confirmed_effect(&original,&bound["task"],&effect,&title,&session);
                // No clean quit, no replacement submission, no manual continuation.
                drop(sdk);
                let (mut reopened, recovery) = phase("same Root new Host epoch", rig.start()).await?;
                assert_ne!(reopened.epoch(),epoch);
                assert_eq!(reopened.source(),&post_config_source);
                phase("end the original run without resubmitting it",
                    terminal_state(&recovery,&session,&run,"cancelled")).await?;
                let after = phase("same canonical output prefix after crash",
                    checkpoint(&recovery,&session,&run,&ready["checkpoint"])).await?;
                assert_eq!(after["execution"]["runId"],run);
                assert_eq!(after["prefix"],before["prefix"]);
                phase("reopen did not duplicate the Host mutation", unique_effect(&recovery,&title,&effect["session"],&session)).await?;
                rig.controller.assert_submissions(1,0);
                let again = phase("same sealed source, never a new generation",rig.transcript(pid)).await?;
                assert_eq!(again.input,transcript.input);
                assert_eq!(again.output,transcript.output);
                phase("close recovery reader",recovery.close()).await?;
                rig.clients.pop();
                phase("new Host actual quit/wait",rig.hosts[1].quit(&mut reopened)).await?;
                let recovered = phase("public offline reconciled task facts",rig.inspect(&session,&run)).await?;
                let (new_prepared,new_bound) = task_facts(&recovered);
                assert_eq!(*new_prepared,prepared);
                assert_eq!(*new_bound,bound);
                assert_eq!(recovered.iter().filter(|f| f["kind"] == "external_task_observed").cloned().collect::<Vec<_>>(),observed);
                assert_eq!(recovered.iter().filter(|f| f["kind"] == "external_effect").cloned().collect::<Vec<_>>(),effects);
                confirmed_task(&recovered,&bound["task"]);
                assert!(recovered.iter().any(|f| f["kind"] == "external_task_closed" && f["outcome"] == "cancelled"));
                assert_eq!(recovered.iter().filter(|f| f["kind"] == "run_admitted").count(),1);
            } else {
                let (session_b,run_b) = phase("parallel original job B",
                    launch(&sdk,&rig.sandbox.workspace,"B",&title,false,"codex")).await?;
                let ready_b = phase("original B connection ready",rig.controller.event("B","ready")).await?;
                let pid_b = ready_b["pid"].as_u64().unwrap();
                assert_ne!(pid,pid_b);
                assert_ne!(ready["thread"],ready_b["thread"]);
                assert_ne!(ready["turn"],ready_b["turn"]);
                phase("B canonical bound output",checkpoint(&sdk,&session_b,&run_b,&ready_b["checkpoint"])).await?;
                let resource_b = rig.controller.resource(pid_b)?;
                assert_ne!(descriptor.resource_ref,resource_b.resource_ref);
                let hellos = rig.controller.events();
                let hello_a = hellos.iter().find(|e| e["kind"] == "hello" && e["pid"] == pid).unwrap();
                let hello_b = hellos.iter().find(|e| e["kind"] == "hello" && e["pid"] == pid_b).unwrap();
                let home = rig.sandbox.home.canonicalize().map_err(|error| error.to_string())?;
                let workspace = rig.sandbox.workspace.canonicalize().map_err(|error| error.to_string())?;
                for hello in [hello_a, hello_b] {
                    assert_eq!(Path::new(hello["home"].as_str().unwrap()).canonicalize().unwrap(), home);
                    assert_eq!(Path::new(hello["cwd"].as_str().unwrap()).canonicalize().unwrap(), workspace);
                }
                let expected = rig.sandbox.workspace.join("direct-write-B");
                assert_eq!(tokio::fs::read_to_string(expected).await.map_err(|error| error.to_string())?, "B");
                for target in [pid,pid_b] {
                    rig.controller.send(target,json!({"action":"challenge","nonce":"before-stop"}))?;
                }
                phase("original A initial challenge",rig.controller.event("A","challenge")).await?;
                phase("original B initial challenge",rig.controller.event("B","challenge")).await?;
                let stopped = phase("Stop exact A Run",mutate(&sdk,"agent","stop",json!({"sessionId":session,"runId":run}))).await?;
                assert_eq!(stopped["requested"],true);
                let interrupt = phase("upstream exact A interrupt",rig.controller.event("A","interrupt")).await?;
                assert_eq!(interrupt["thread"],ready["thread"]); assert_eq!(interrupt["turn"],ready["turn"]);
                phase("A canonical cancelled state",terminal_state(&sdk,&session,&run,"cancelled")).await?;
                let transcript = phase("original A Domain closure",rig.transcript(pid)).await?;
                check_transcript(&transcript,&ready,Some("interrupted"));
                phase("A independent physical readiness",readiness(&sdk,&session,&run)).await?;
                assert!(isolated::closed_evidence(&resource_b).await.map_err(|e| e.to_string())?.is_none(),"B was not cancelled with A");
                let nonce = Uuid::new_v4().to_string();
                rig.controller.send(pid_b,json!({"action":"challenge","nonce":nonce}))?;
                phase("original B answers a fresh challenge after A Stop/cleanup",async {
                    let mut changes = rig.controller.changed.subscribe();
                    loop {
                        if let Some(event) = rig.controller.events().iter().find(|e| e["kind"] == "challenge" && e["nonce"] == nonce) {
                            assert_eq!(event["pid"],pid_b); assert_eq!(event["thread"],ready_b["thread"]); assert_eq!(event["turn"],ready_b["turn"]);
                            return Ok(());
                        }
                        changes.changed().await.map_err(|e| e.to_string())?;
                    }
                }).await?;
                assert!(!rig.controller.events().iter().any(|e| e["job"] == "B" && e["kind"] == "interrupt"));
                rig.controller.send(pid_b,json!({"action":"complete"}))?;
                phase("same original B completes",terminal_state(&sdk,&session_b,&run_b,"completed")).await?;
                let b = phase("original B Domain closure",rig.transcript(pid_b)).await?;
                check_transcript(&b,&ready_b,Some("completed"));
                phase("B independent physical readiness",readiness(&sdk,&session_b,&run_b)).await?;
                phase("actual side effect remains unique",unique_effect(&sdk,&title,&effect["session"],&session)).await?;
                rig.controller.assert_submissions(2,0);
                phase("close original SDK reader",sdk.close()).await?;
                rig.clients.pop();
                phase("Host quit/wait",rig.hosts[0].quit(&mut anchor)).await?;
                let a_facts = phase("public A canonical facts",rig.inspect(&session,&run)).await?;
                let b_facts = phase("public B canonical facts",rig.inspect(&session_b,&run_b)).await?;
                let (_,a_bound) = task_facts(&a_facts);
                let (_,b_bound) = task_facts(&b_facts);
                assert_ne!(a_bound["task"],b_bound["task"]);
                confirmed_task(&a_facts,&a_bound["task"]); confirmed_task(&b_facts,&b_bound["task"]);
                confirmed_effect(&a_facts,&a_bound["task"],&effect,&title,&session);
                assert!(!b_facts.iter().any(|f| f["kind"] == "external_effect"));
                let (mut reopened, continuation) = phase("reopen Host before the next native turn",rig.start()).await?;
                assert_ne!(anchor.epoch(),reopened.epoch());
                let resumed_run = phase("send a new turn on the same Maka session",
                    send_native(&continuation,&session_b,"D",&title,false)).await?;
                let resumed = phase("native provider accepted resumed turn",rig.controller.event("D","ready")).await?;
                assert_eq!(resumed["thread"],ready_b["thread"]);
                assert_ne!(resumed["turn"],ready_b["turn"]);
                let resumed_pid = resumed["pid"].as_u64().unwrap();
                rig.controller.send(resumed_pid,json!({"action":"complete"}))?;
                phase("resumed native turn completes",terminal_state(&continuation,&session_b,&resumed_run,"completed")).await?;
                let resumed_wire = phase("read resumed native wire",rig.transcript(resumed_pid)).await?;
                assert!(b.input.iter().any(|row| row["method"] == "thread/inject_items"
                    && row["params"]["items"][0]["role"] == "user"
                    && row["params"]["items"][0]["content"][0]["text"].as_str().unwrap().contains("<maka_system_instructions>")));
                assert!(resumed_wire.input.iter().any(|row| row["method"] == "thread/resume"
                    && row["params"]["threadId"] == ready_b["thread"]));
                assert!(!resumed_wire.input.iter().any(|row| matches!(row["method"].as_str(), Some("thread/start" | "thread/inject_items"))));
                let input = resumed_wire.input.iter().find(|row| row["method"] == "turn/start").unwrap();
                assert!(input["params"]["input"][0]["text"].as_str().unwrap().starts_with("MAKA_EXTERNAL_CASE "));
                let history = query(&continuation,"agent","history",json!({"sessionId":session_b,"position":{"kind":"start"},"includeThinking":false})).await?;
                let chunks = history["chunks"].as_array().ok_or("resumed history unavailable")?;
                for expected in [10,5] {
                    assert!(chunks.iter().any(|chunk| chunk["timing"]["executorUsage"]["totalTokens"] == expected),
                        "missing per-turn usage {expected}: {history}");
                }
                rig.controller.assert_submissions(3,1);
                phase("close resumed SDK reader",continuation.close()).await?;
                rig.clients.pop();
                phase("reopened Host quit/wait",rig.hosts[1].quit(&mut reopened)).await?;
            }
            Ok::<_,String>(())
        }).await.map_err(|_| "overall external-job case deadline".to_owned())?
    }).catch_unwind().await;
    let cleanup = rig.cleanup().await;
    match outcome {
        Err(panic) => {
            if !cleanup.is_empty() {
                eprintln!("external case cleanup: {cleanup:?}");
            }
            std::panic::resume_unwind(panic)
        }
        Ok(Err(error)) => panic!("{error}; cleanup={cleanup:?}"),
        Ok(Ok(())) => assert!(cleanup.is_empty(), "{cleanup:?}"),
    }
}

#[cfg(windows)]
#[path = "support/windows_sandbox.rs"]
mod windows_sandbox;
#[cfg(windows)]
use windows_sandbox::WindowsSandboxGuard;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn composed_acp_setup_checks_a_provider_without_exposing_state_root()
-> std::result::Result<(), Box<dyn std::error::Error>> {
    async fn run(command: &mut Command) -> Result<()> {
        let result = command
            .kill_on_drop(true)
            .output()
            .await
            .map_err(|e| e.to_string())?;
        if result.status.success() {
            Ok(())
        } else {
            Err(format!(
                "{:?}: {}",
                result.status,
                String::from_utf8_lossy(&result.stderr)
            ))
        }
    }

    let sandbox = Sandbox::new().await?;
    let deployment = Uuid::new_v4().to_string();
    let source = sandbox.directory.path().join("composition");
    let config = sandbox.directory.path().join("installation.json");
    run(host::command(&sandbox)?
        .args(["host", "init", "--root"])
        .arg(&sandbox.root))
    .await?;
    let secret = dunce::canonicalize(&sandbox.root)?.join("private-probe");
    std::fs::write(&secret, "private")?;

    let executable = node_executable().await?;
    let args = [
        "-e",
        r#"
        const fs = require('node:fs');
        const assert = require('node:assert/strict');
        const lines = require('node:readline').createInterface({input:process.stdin});
        const send = msg => console.log(JSON.stringify({jsonrpc:'2.0', ...msg}));
        const update = value => send({method:'session/update', params:{sessionId:'root',update:value}});
        const ask = (id, sessionId) => send({id, method:'session/request_permission',
            params:{sessionId, title:'Child consent', options:[{optionId:'no',name:'Deny',kind:'reject_once'}]}});
        let prompt;
        lines.on('line', line => {
            const {id, method, params, result, error} = JSON.parse(line);
            if (method === 'initialize') {
                assert.throws(() => fs.readFileSync(process.env.ACP_PRIVATE_PROBE),
                    e => ['EPERM','EACCES','ENOENT'].includes(e.code));
                send({id,result:{protocolVersion:2,info:{name:'isolated-probe',version:'1'},
                    capabilities:{session:{}},authMethods:[]}});
            } else if (method === 'session/new') {
                send({id,result:{sessionId:'root'}});
            } else if (method === 'session/prompt') {
                prompt = id;
                update({sessionUpdate:'user_message',messageId:'input',content:params.prompt});
                update({sessionUpdate:'state_update',state:'running'});
                ask('unannounced', 'child');
            } else if (id === 'unannounced') {
                assert.equal(error?.code, -32602);
                update({sessionUpdate:'subagent_update',sessionId:'child'});
                ask('announced', 'child');
            } else if (id === 'announced') {
                assert.deepEqual(result?.outcome, {outcome:'selected',optionId:'no'});
                send({id:prompt,result:{messageId:'input'}});
                update({sessionUpdate:'agent_message',messageId:'result',
                    content:[{type:'text',text:'Child permission denied.'}]});
                update({sessionUpdate:'state_update',state:'idle',stopReason:'end_turn'});
                lines.close();
                process.stdin.destroy();
            }
        });
    "#,
    ];
    let helper = std::env::var_os("CARGO_BIN_EXE_maka").ok_or("missing CLI helper")?;
    let configuration = json!({
        "locale":"en","hostDeployment":deployment,
        "agent":{"workspaceRoots":[{"path":sandbox.workspace,"label":"fixture"}],
                 "permissions":{"access":"read_only","requestPermissions":false},"tools":[]},
        "acpExecutors":[{"name":"probe","configuration":{"agent":{"id":"probe","displayName":"Probe",
            "executable":executable,"args":args,"env":{"ACP_PRIVATE_PROBE":secret}}}}],
        "executorProcesses":{"setupDirectory":sandbox.workspace, "helper":PathBuf::from(helper),
            "filesystem":{"default":"read","rules":[],"denyGlobs":[]},"network":"denied"}
    });
    std::fs::write(&config, serde_json::to_vec(&configuration)?)?;
    run(host::command(&sandbox)?
        .args(["application", "compose", "--configuration"])
        .arg(config)
        .arg("--output")
        .arg(&source))
    .await?;
    let mut commit = host::command(&sandbox)?;
    commit
        .args(["application", "commit", "--root"])
        .arg(&sandbox.root)
        .args([
            "--deployment",
            &deployment,
            "--expected-revision",
            "0",
            "--input",
        ])
        .arg(source.join("host.json"));
    for package in std::fs::read_dir(source.join("packages"))? {
        commit.arg("--package").arg(package?.path());
    }
    run(&mut commit).await?;
    #[cfg(windows)]
    let sandbox_guard = WindowsSandboxGuard::setup(&sandbox.root).await?;
    let mut serve = host::command(&sandbox)?;
    serve
        .args(["application", "serve", "--root"])
        .arg(&sandbox.root)
        .args(["--deployment", &deployment, "--endpoints"])
        .arg(source.join("endpoints.json"))
        .arg("--native")
        .arg(source.join("native-grants.json"));
    let mut host = Host::spawn_service(serve)?;
    let result = phase("composed ACP setup", async {
        let (mut anchor, address) = host.ready().await?;
        let client = Client::new(
            HostClient::connect(&address, Some(anchor.epoch())).await?,
            Journal::open(&sandbox.journal).await?,
            "receipts".into(),
        )?;
        let checked = mutate(
            &client,
            "agent",
            "executorSetup",
            json!({"executor":"probe","action":{"kind":"check"}}),
        )
        .await?;
        let created = mutate(&client, "agent", "create", json!({
            "title":"ACP child permission", "automaticTitle":false, "labels":[],
            "workspace":{"kind":"directory","path":sandbox.workspace},
            "backend":{"kind":"executor","selection":{"executor":"probe","settings":{}}}
        })).await?;
        let session = created["session"]["id"].as_str().ok_or("missing ACP session")?;
        let run = send_native(&client, session, "permission", "Child consent", false).await?;
        let wait_form = async {
            let mut tick = tokio::time::interval(Duration::from_millis(20));
            loop {
                tick.tick().await;
                let pending = query(&client, "agent", "pendingInteractions", json!({"sessionId":session})).await?;
                if let Some(id) = pending["entries"][0]["requestId"].as_str() {
                    break Ok::<_,String>(id.to_owned());
                }
            }
        };
        let request = tokio::select! {
            id = wait_form => id?,
            result = terminal_state(&client, session, &run, "completed") => return Err(format!("ACP ended before child form: {result:?}")),
        };
        let form = query(&client, "agent", "interaction", json!({"sessionId":session,"requestId":request})).await?;
        let message = form["request"]["message"].as_str().ok_or_else(||format!("expected form: {form}"))?;
        assert!(message.contains(r#""sessionId":"child""#), "{message}");
        let answer = mutate(&client, "agent", "respond", json!({"sessionId":session,"requestId":request,
            "answer":{"kind":"form","action":"accept","values":{"permission":"no"}}})).await?;
        assert_eq!(answer["kind"], "recorded", "{answer}");
        terminal_state(&client, session, &run, "completed").await?;
        client.close().await?;
        host.quit(&mut anchor).await?;
        Ok(checked)
    })
    .await;
    host.cleanup().await?;
    #[cfg(windows)]
    sandbox_guard.teardown().await?;
    assert_eq!(
        result?,
        json!({"kind":"checked","info":{"title":null,"name":"isolated-probe","version":"1"},"methods":[]})
    );
    Ok(())
}

fn remove_task_resource(root: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fn make_writable(dir: &Path) -> std::io::Result<()> {
            let mut stack = vec![dir.to_owned()];
            while let Some(path) = stack.pop() {
                let meta = std::fs::symlink_metadata(&path)?;
                if meta.file_type().is_symlink() {
                    continue;
                }
                if meta.is_dir() {
                    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700))?;
                    for entry in std::fs::read_dir(&path)? {
                        stack.push(entry?.path());
                    }
                }
            }
            Ok(())
        }
        make_writable(root)?;
    }
    #[cfg(windows)]
    {
        const ERROR_SHARING_VIOLATION: i32 = 32;
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        loop {
            match std::fs::remove_dir_all(root) {
                Ok(()) => return Ok(()),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
                Err(error)
                    if error.raw_os_error() == Some(ERROR_SHARING_VIOLATION)
                        && std::time::Instant::now() < deadline =>
                {
                    std::thread::sleep(Duration::from_millis(50));
                }
                Err(error) => return Err(error),
            }
        }
    }
    #[cfg(not(windows))]
    std::fs::remove_dir_all(root)
}

fn file_digest(path: &Path) -> std::io::Result<[u8; 32]> {
    let mut hash = sha2::Sha256::default();
    {
        use sha2::Digest;
        let mut input = std::fs::File::open(path)?;
        let mut buffer = [0; 65536];
        loop {
            let count = input.read(&mut buffer)?;
            if count == 0 {
                break;
            }
            hash.update(&buffer[..count]);
        }
    }
    Ok(sha2::Digest::finalize(hash).into())
}

async fn private_release_task(
    source: &Path,
    state: &Path,
) -> std::result::Result<isolated::TaskOwner, Box<dyn std::error::Error>> {
    use maka_sandbox::{
        Destination, Network, Sandbox as ProcessSandbox,
        filesystem::{Access, Policy},
    };
    let helper = std::env::var_os("CARGO_BIN_EXE_maka").ok_or("missing CLI helper")?;
    let policy = ProcessSandbox::Managed {
        filesystem: Policy::uniform(Access::Read),
        network: Network::destination(Destination::new("127.0.0.1", 9)?),
    };
    let runtime = isolated::SandboxRuntime::default();
    #[cfg(target_os = "linux")]
    let runtime = runtime.with_network_helper(PathBuf::from(&helper));
    #[cfg(windows)]
    let runtime = runtime.with_backend(Arc::new(
        maka_host_runtime::sandbox::windows::Backend::new(state, Path::new(&helper)),
    ));
    Ok(isolated::TaskOwner::prepare(
        source,
        state,
        Path::new(&helper),
        &policy,
        &Policy::uniform(Access::Read),
        &runtime,
        CancellationToken::new(),
    )
    .await?)
}

#[tokio::test]
async fn installed_program_runs_with_private_inputs_and_publishes_its_snapshot()
-> std::result::Result<(), Box<dyn std::error::Error>> {
    let temp = tempfile::tempdir()?;
    let source = temp.path().join("source");
    let state = temp.path().join("root");
    std::fs::create_dir(&source)?;
    std::fs::create_dir(&state)?;
    std::fs::write(source.join("document"), b"original")?;
    std::fs::write(state.join("secret"), b"private")?;
    #[cfg(windows)]
    let sandbox_guard = WindowsSandboxGuard::setup(&state).await?;
    let outcome: std::result::Result<(), Box<dyn std::error::Error>> = async {
    let mut owner = private_release_task(&source, &state).await?;
    let descriptor = owner.descriptor();
    owner.seed_home([
        Ok(isolated::HomeEntry {
            relative_path: PathBuf::from(".config/profile"),
            mode: 0o700,
            kind: isolated::HomeEntryKind::Directory,
        }),
        #[cfg(unix)]
        Ok(isolated::HomeEntry {
            relative_path: PathBuf::from(".config/profile-link"),
            mode: 0o777,
            kind: isolated::HomeEntryKind::Symlink {
                target: PathBuf::from("profile"),
            },
        }),
    ])?;
    let home = owner.home_capture().cloned().expect("managed HOME custody");
    let candidate = owner.candidate_capture()?;
    // Use a real native program in both release slots so the kernel must load
    // both delivered files. The originals deliberately live under StateRoot.
    let installation = state.join("plugin-data").join("fixture");
    std::fs::create_dir_all(&installation)?;
    let node = node_executable().await?;
    let digest = file_digest(&node)?;
    let installed_file = |name: &'static str| -> std::io::Result<isolated::ProgramFile> {
        let path = installation.join(name);
        std::fs::copy(&node, &path)?;
        Ok(isolated::ProgramFile {
            name,
            source: std::fs::File::open(path)?,
            sha256: digest,
        })
    };
    let program = isolated::InstalledProgram {
        executable: installed_file(if cfg!(windows) {
            "agy_acp_server.exe"
        } else {
            "agy_acp_server.par"
        })?,
        helper: installed_file(if cfg!(windows) {
            "localharness_external.exe"
        } else {
            "localharness_external"
        })?,
        helper_env: "ANTIGRAVITY_HARNESS_PATH",
    };
    let mut command =
        maka_process::Command::private_task(installation.join(program.executable.name));
    command.args(["-e", r#"
        const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), assert = require('node:assert/strict');
        assert.equal(fs.readFileSync('document', 'utf8'), 'original');
        assert.throws(() => fs.readFileSync(process.argv[1]), e => ['EACCES','EPERM','ENOENT'].includes(e.code));
        const helper = process.env.ANTIGRAVITY_HARNESS_PATH;
        // Use file-backed stdout in TMP rather than libuv's default stdio:'pipe':
        // Windows NPFS ignores TokenDefaultDacl for CreateNamedPipeW(..., NULL), so
        // WRITE_RESTRICTED tokens (Account backend) reject libuv's pipe client open.
        const helperOut = path.join(os.tmpdir(), 'helper.out');
        const fd = fs.openSync(helperOut, 'w');
        const helperRun = require('node:child_process').spawnSync(helper, ['-p', '42'], { stdio: ['ignore', fd, 'inherit'] });
        fs.closeSync(fd);
        assert.equal(helperRun.error, undefined);
        assert.equal(helperRun.status, 0);
        assert.equal(fs.readFileSync(helperOut, 'utf8').trim(), '42');
        assert.throws(() => fs.writeFileSync(path.join(path.dirname(helper), 'extra'), ''), e => ['EACCES','EPERM','EROFS'].includes(e.code));
        assert.ok(process.env.HTTP_PROXY);
        fs.writeFileSync('document', 'candidate');
        fs.writeFileSync(path.join(process.env.HOME, '.config', process.platform === 'win32' ? 'profile' : 'profile-link', 'settings'), 'config');
    "#]).arg(dunce::canonicalize(&state)?.join("secret"));
    owner
        .bind_installed_program(&mut command, Arc::new(program))
        .await?;
    assert!(
        !descriptor.resource_ref.join("inputs/runtime").exists(),
        "bind must defer runtime staging until spawn"
    );
    let mut watch = EvidenceWatch::open(&descriptor, EvidenceInterest::Cleanup).await?;
    let process = owner.spawn_pipe(command).await?;
    let maka_process::pipe::Spawned {
        mut child,
        stdin,
        stdout: _,
        mut stderr,
    } = process;
    drop(stdin);
    let mut diagnostics = String::new();
    let (status, _) = tokio::time::timeout(Duration::from_secs(45), async {
        tokio::try_join!(child.wait(), stderr.read_to_string(&mut diagnostics))
    })
    .await??;
    let observed = tokio::time::timeout(Duration::from_secs(45), watch.wait()).await;
    watch.close().await?;
    observed??;
    assert!(status.success(), "{status}: {diagnostics}");

    assert!(
        !descriptor.resource_ref.join("inputs/runtime").exists(),
        "closed task must reclaim staged inputs/runtime"
    );
    let evidence = isolated::closed_evidence(&descriptor)
        .await?
        .expect("closed managed task evidence");
    assert!(evidence.snapshot.is_some());
    assert_eq!(std::fs::read(source.join("document")).unwrap(), b"original");
    let candidate = candidate.freeze().await?;
    let isolated::BaselineEntry::File { file, mode } =
        candidate.open_entry(Path::new("document"))?
    else {
        panic!("candidate did not contain document");
    };
    use maka_fs_tools::{MutationExecutor, WriteCoordinator, WriteScope, publication::*};
    let writer = MutationExecutor::new(
        &source,
        WriteScope::Restricted {
            roots: vec![source.clone()],
        },
        WriteCoordinator::shared(),
    )?;
    let identity = candidate.snapshot().source_identity();
    let content = |bytes: &[u8]| maka_agent_facts::durable::ContentRef {
        digest: maka_agent_facts::artifact::content_digest(bytes),
        bytes: bytes.len() as u64,
    };
    let source_id = SourceIdentity {
        device: identity.device,
        inode: identity.inode.into(),
    };
    let change = PublicationChange {
        path: "document".into(),
        expected: PublicationEntry::File {
            content: content(b"original"),
            mode,
        },
        candidate: PublicationEntry::File {
            content: content(b"candidate"),
            mode,
        },
    };
    let published = writer
        .publish_change(
            change,
            source_id,
            Some(Box::new(file)),
            CancellationToken::new(),
        )
        .await?;
    assert_eq!(published, PublicationResult::Applied);
    assert_eq!(std::fs::read(source.join("document"))?, b"candidate");
    let home = home.freeze().await?;
    let settings = home
        .entries()?
        .find_map(|entry| match entry {
            Ok(entry) if entry.relative_path == Path::new(".config/profile/settings") => {
                Some(Ok(entry.kind))
            }
            Ok(_) => None,
            Err(error) => Some(Err(error)),
        })
        .transpose()?;
    let Some(isolated::HomeEntryKind::File { mut file }) = settings else {
        panic!("frozen HOME did not contain settings");
    };
    let mut contents = String::new();
    file.read_to_string(&mut contents)?;
    assert_eq!(contents, "config");
    drop((file, home, candidate, evidence, child));
    remove_task_resource(&descriptor.resource_ref)?;
    Ok(())
    }
    .await;
    #[cfg(windows)]
    sandbox_guard.teardown().await?;
    outcome
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn quitting_host_reaps_the_active_original_external_process() {
    let mut rig = Rig::new().await.expect("owned external job fixture");
    let outcome = AssertUnwindSafe(async {
        let (mut anchor, bootstrap) = phase("start original Host", rig.start()).await?;
        phase(
            "configure external runtime",
            rig.configure(&mut anchor, &bootstrap, "codex"),
        )
        .await?;
        phase("close bootstrap session", bootstrap.close()).await?;
        rig.clients.pop();
        let sdk = phase("connect to the active Host", connect_sdk(&mut rig, &anchor)).await?;
        let (session, run) = phase(
            "start an external task that waits for the fixture",
            launch(
                &sdk,
                &rig.sandbox.workspace,
                "A",
                "quit-active-external",
                true,
                "codex",
            ),
        )
        .await?;
        let ready = phase("provider is running", rig.controller.event("A", "ready")).await?;
        phase(
            "provider is bound",
            checkpoint(&sdk, &session, &run, &ready["checkpoint"]),
        )
        .await?;
        let pid = ready["pid"].as_u64().ok_or("original PID missing")?;
        let resource = rig.controller.resource(pid)?;
        assert!(
            isolated::closed_evidence(&resource)
                .await
                .map_err(|error| error.to_string())?
                .is_none()
        );
        phase("close UI session", sdk.close()).await?;
        rig.clients.pop();
        phase(
            "quit original Host without completing the task",
            rig.hosts[0].quit(&mut anchor),
        )
        .await?;
        assert!(
            isolated::closed_evidence(&resource)
                .await
                .map_err(|error| error.to_string())?
                .is_some()
        );
        rig.controller.assert_submissions(1, 0);
        Ok::<_, String>(())
    })
    .catch_unwind()
    .await;
    let cleanup = rig.cleanup().await;
    match outcome {
        Err(panic) => std::panic::resume_unwind(panic),
        Ok(Err(error)) => panic!("{error}; cleanup={cleanup:?}"),
        Ok(Ok(())) => assert!(cleanup.is_empty(), "{cleanup:?}"),
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn exact_stop_isolates_parallel_original_external_jobs() {
    run_case(false).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn antigravity_keeps_the_peer_alive_while_a_worker_fails_to_close() {
    let mut rig = Rig::new().await.expect("isolated ACP Host");
    let outcome = AssertUnwindSafe(async {
        let (mut anchor, bootstrap) = rig.start().await?;
        rig.configure(&mut anchor, &bootstrap, "antigravity")
            .await?;
        bootstrap.close().await?;
        rig.clients.pop();
        let sdk = connect_sdk(&mut rig, &anchor).await?;
        let (a, run_a) = phase(
            "launch A",
            launch(
                &sdk,
                &rig.sandbox.workspace,
                "ACP-stuck-close",
                "A",
                true,
                "antigravity",
            ),
        )
        .await?;
        let (b, run_b) = phase(
            "launch B",
            launch(
                &sdk,
                &rig.sandbox.workspace,
                "ACP-peer",
                "B",
                true,
                "antigravity",
            ),
        )
        .await?;
        let first = phase(
            "A is live",
            rig.controller.event("ACP-stuck-close", "ready"),
        )
        .await?;
        let peer = phase("B is live", rig.controller.event("ACP-peer", "ready")).await?;
        assert_eq!(first["front"], peer["front"]);
        assert_ne!(first["pid"], peer["pid"]);

        let stop = mutate(&sdk, "agent", "stop", json!({"sessionId":a,"runId":run_a}));
        let check = async {
            phase(
                "A's close is outstanding",
                rig.controller.event("ACP-stuck-close", "close_pending"),
            )
            .await?;
            let original = rig.resource(first["pid"].as_u64().unwrap()).await?;
            assert!(
                isolated::cleanup_evidence(&original)
                    .await
                    .map_err(|e| e.to_string())?
                    .is_none()
            );
            rig.controller.send(
                peer["pid"].as_u64().unwrap(),
                json!({"action":"complete","promptId":peer["promptId"]}),
            )?;
            phase("B completes", terminal_state(&sdk, &b, &run_b, "completed")).await?;
            phase("A has original closure evidence", sealed(original)).await?;
            Ok::<_, String>(())
        };
        let (stopped, ()) = tokio::try_join!(stop, check)?;
        assert_eq!(stopped["requested"], true);
        phase(
            "A is cancelled",
            terminal_state(&sdk, &a, &run_a, "cancelled"),
        )
        .await?;
        sdk.close().await?;
        rig.clients.pop();
        rig.hosts[0].quit(&mut anchor).await?;
        Ok::<_, String>(())
    })
    .catch_unwind()
    .await;
    let cleanup = rig.cleanup().await;
    match outcome {
        Err(panic) => std::panic::resume_unwind(panic),
        Ok(Err(error)) => panic!("{error}; cleanup={cleanup:?}"),
        Ok(Ok(())) => assert!(cleanup.is_empty(), "{cleanup:?}"),
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn sigkill_reopens_original_external_transcript_without_resubmission() {
    run_case(true).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn antigravity_can_continue_after_host_restarts_during_a_prompt() {
    let mut rig = Rig::new().await.expect("isolated Host and ACP fixture");
    let outcome =
        AssertUnwindSafe(async {
            let (mut anchor, bootstrap) = phase("start original Host", rig.start()).await?;
            phase(
                "enable Antigravity ACP",
                rig.configure(&mut anchor, &bootstrap, "antigravity"),
            )
            .await?;
            let global_agents = rig.sandbox.home.join(".gemini/config/agents");
            let managed_profile = rig
                .sandbox
                .home
                .join(".maka/external-agents/antigravity/agent/.agents/agents/maka.md");
            assert!(
                !tokio::fs::try_exists(&managed_profile)
                    .await
                    .map_err(|error| error.to_string())?
            );
            bootstrap.close().await?;
            rig.clients.pop();
            let sdk = connect_sdk(&mut rig, &anchor).await?;
            let (session, run) = phase(
                "send first prompt",
                launch(
                    &sdk,
                    &rig.sandbox.workspace,
                    "ACP-original",
                    "Antigravity restart",
                    true,
                    "antigravity",
                ),
            )
            .await?;
            let original = phase(
                "first ACP prompt delivered",
                rig.controller.event("ACP-original", "ready"),
            )
            .await?;
            let before = phase(
                "first ACP output saved",
                checkpoint(&sdk, &session, &run, &original["checkpoint"]),
            )
            .await?;
            let pid = original["pid"].as_u64().unwrap();
            assert!(
                isolated::closed_evidence(&rig.resource(pid).await?)
                    .await
                    .map_err(|e| e.to_string())?
                    .is_none()
            );
            sdk.close().await?;
            rig.clients.pop();
            phase("kill and reap original Host", rig.hosts[0].sigkill()).await?;
            let (mut reopened, recovery) = phase("reopen the same Root", rig.start()).await?;
            assert_ne!(reopened.epoch(), anchor.epoch());
            let transcript = phase(
                "original ACP process exited and all streams drained",
                rig.transcript(pid),
            )
            .await?;
            assert!(
                !transcript
                    .output
                    .iter()
                    .any(|row| row["id"] == transcript.task_prompt()["id"]
                        && row.get("method").is_none())
            );
            phase(
                "interrupted Run",
                terminal_state(&recovery, &session, &run, "cancelled"),
            )
            .await?;
            let after = phase(
                "original partial answer remains",
                checkpoint(&recovery, &session, &run, &original["checkpoint"]),
            )
            .await?;
            assert_eq!(after["prefix"], before["prefix"]);
            tokio::fs::write(
                rig.sandbox.home.join(".maka/AGENTS.md"),
                "ACP resumed instruction revision",
            )
            .await
            .map_err(|e| e.to_string())?;
            let next = phase(
                "send a new message in the original conversation",
                send_native(
                    &recovery,
                    &session,
                    "ACP-followup",
                    "Antigravity restart",
                    false,
                ),
            )
            .await?;
            assert_ne!(next, run);
            let resumed = phase(
                "new prompt reaches Antigravity",
                rig.controller.event("ACP-followup", "ready"),
            )
            .await?;
            assert_eq!(resumed["thread"], original["thread"]);
            phase(
                "follow-up completes",
                terminal_state(&recovery, &session, &next, "completed"),
            )
            .await?;
            let resumed_transcript = phase(
                "seal resumed process",
                rig.transcript(resumed["pid"].as_u64().unwrap()),
            )
            .await?;
            for (wire, method, label, revised) in [
                (&transcript, "session/new", "ACP-original", false),
                (&resumed_transcript, "session/resume", "ACP-followup", true),
            ] {
                let open = wire
                    .input
                    .iter()
                    .find(|row| row["method"] == method)
                    .unwrap();
                let instructions = open
                    .pointer("/params/_meta/antigravity/systemPrompt/append")
                    .and_then(Value::as_str)
                    .unwrap();
                assert!(!instructions.trim().is_empty());
                assert_eq!(
                    instructions.contains("ACP resumed instruction revision"),
                    revised
                );
                let [user] = wire.task_prompt()["params"]["prompt"]
                    .as_array()
                    .unwrap()
                    .as_slice()
                else {
                    panic!(
                        "expected only the user task block when systemPrompt.append is supported"
                    );
                };
                let task = user["text"].as_str().unwrap();
                assert!(task.contains(label));
                assert!(!task.contains("<maka_system_instructions>"));
                if revised {
                    assert!(!task.contains("ACP-original"));
                }
            }
            let events = rig.controller.events();
            assert_eq!(
                events.iter().filter(|e| e["kind"] == "hello").count(),
                2,
                "{events:?}"
            );
            assert!(events.iter().all(|e| e["kind"] != "failure"), "{events:?}");
            phase(
                "resumed Run settles before Host quit",
                readiness(&recovery, &session, &next),
            )
            .await?;
            let observed =
                query(&recovery, "agent", "observe", json!({"sessionId":session})).await?;
            assert_eq!(observed["session"]["hasUnread"], true);
            let history = query(&recovery, "agent", "history", json!({
            "sessionId":session,"position":{"kind":"tail"},"includeThinking":false,"view":"chat"
        })).await?;
            let final_reply = history["chunks"]
                .as_array()
                .unwrap()
                .iter()
                .rev()
                .find(|chunk| {
                    chunk["role"] == "assistant" && chunk["text"] == "ACP follow-up final reply"
                })
                .ok_or("external final reply missing from history")?;
            let message = final_reply["messageId"]
                .as_str()
                .ok_or("final reply identity missing")?;
            assert_eq!(observed["session"]["tailMessageId"], message);
            let read = recovery
                .control(
                    Uuid::new_v4(),
                    "markRead",
                    json!({
                        "sessionId":session,"messageId":message
                    }),
                )
                .await?;
            read.prepare().await?;
            receipt_value(&read.confirm().await?)?;
            let observed =
                query(&recovery, "agent", "observe", json!({"sessionId":session})).await?;
            assert_eq!(observed["session"]["hasUnread"], false);
            let external = query(
                &recovery,
                "agent",
                "externalAgents",
                json!({"inspect":true}),
            )
            .await?;
            let target = &external["target"];
            let source = query(&recovery, "management", "read", json!({})).await?;
            let original_epoch = reopened.catalogue().describe("agent")?.registration_epoch;
            let mut setting = target["path"]
                .as_array()
                .ok_or("external target path missing")?
                .clone();
            setting.extend([json!("runtimes"), json!("antigravity")]);
            let changed = mutate(
                &recovery,
                "management",
                "configureBatch",
                json!({
                    "expectedRevision":source["source"]["reference"]["revision"],
                    "edits":[{"instance":target["source"]["namespace"],"changes":[
                        {"path":setting,"value":{"kind":"boolean","value":false}}
                    ]}]
                }),
            )
            .await?;
            assert_eq!(changed["status"], "committed", "{changed}");
            phase("apply the disabled Antigravity runtime", async {
                loop {
                    reopened.refresh().await?;
                    let epoch = reopened.catalogue().describe("agent")?.registration_epoch;
                    if epoch.is_some() && epoch != original_epoch {
                        break;
                    }
                    tokio::task::yield_now().await;
                }
                Ok(())
            })
            .await?;
            assert!(
                !tokio::fs::try_exists(&global_agents)
                    .await
                    .map_err(|error| error.to_string())?
            );
            recovery.close().await?;
            rig.clients.pop();
            phase("quit reopened Host", rig.hosts[1].quit(&mut reopened)).await?;
            Ok::<_, String>(())
        })
        .catch_unwind()
        .await;
    let cleanup = rig.cleanup().await;
    match outcome {
        Err(panic) => std::panic::resume_unwind(panic),
        Ok(Err(error)) => panic!("{error}; cleanup={cleanup:?}"),
        Ok(Ok(())) => assert!(cleanup.is_empty(), "{cleanup:?}"),
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn antigravity_steers_new_and_queued_messages_before_older_followups() {
    let mut rig = Rig::new().await.expect("isolated Host and ACP fixture");
    let work = async {
        let (mut anchor, bootstrap) = rig.start().await?;
        rig.configure(&mut anchor, &bootstrap, "antigravity")
            .await?;
        bootstrap.close().await?;
        rig.clients.pop();
        let sdk = connect_sdk(&mut rig, &anchor).await?;
        let (session, _) = launch(
            &sdk,
            &rig.sandbox.workspace,
            "ACP-original",
            "Steering",
            true,
            "antigravity",
        )
        .await?;
        let original = rig.controller.event("ACP-original", "ready").await?;
        let message = |label: &str| {
            format!(
                "MAKA_EXTERNAL_CASE {}",
                json!({"label":label, "session":session})
            )
        };
        let backlog = mutate(
            &sdk,
            "agent",
            "send",
            json!({"sessionId":session, "message":message("ACP-wake"), "delivery":"queue"}),
        )
        .await?;
        let queued = mutate(
            &sdk,
            "agent",
            "send",
            json!({"sessionId":session, "message":message("ACP-promoted"), "delivery":"queue"}),
        )
        .await?;
        let promoted = mutate(
            &sdk,
            "agent",
            "editQueue",
            json!({
                "sessionId": session, "expectedRevision":queued["revision"],
                "edit":{"kind":"promote", "messageId":queued["messageId"]}
            }),
        )
        .await?;
        assert_eq!(promoted["kind"], "committed", "{promoted}");
        let first = rig.controller.event("ACP-promoted", "ready").await?;
        assert_eq!(first["thread"], original["thread"]);

        let direct = mutate(
            &sdk,
            "agent",
            "send",
            json!({"sessionId":session, "message":message("ACP-peer")}),
        )
        .await?;
        assert_eq!(direct["kind"], "queued", "{direct}");
        let second = rig.controller.event("ACP-peer", "ready").await?;
        assert_eq!(second["thread"], original["thread"]);
        let pending = query(&sdk, "agent", "queue", json!({"sessionId":session})).await?;
        let entries = pending["entries"]
            .as_array()
            .ok_or("queue entries missing")?;
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0]["messageId"], backlog["messageId"]);
        for id in [&queued["messageId"], &direct["messageId"]] {
            let work = query(
                &sdk,
                "agent",
                "work",
                json!({"sessionId":session,"target":{"kind":"message","messageId":id}}),
            )
            .await?;
            assert_eq!(work["kind"], "delivered", "{work}");
        }
        rig.controller.send(
            second["pid"].as_u64().unwrap(),
            json!({"action":"complete","promptId":second["promptId"]}),
        )?;
        let wake = rig.controller.event("ACP-wake", "ready").await?;
        let delivered = query(
            &sdk,
            "agent",
            "work",
            json!({
                "sessionId":session,"target":{"kind":"message","messageId":backlog["messageId"]}
            }),
        )
        .await?;
        let run = &delivered["execution"]["runId"];
        terminal_state(&sdk, &session, run, "completed").await?;
        rig.transcript(wake["pid"].as_u64().unwrap()).await?;
        let jobs: Vec<_> = rig
            .controller
            .events()
            .into_iter()
            .filter(|event| event["kind"] == "ready")
            .map(|event| event["job"].clone())
            .collect();
        assert_eq!(
            jobs,
            ["ACP-original", "ACP-promoted", "ACP-peer", "ACP-wake"]
        );
        sdk.close().await?;
        rig.clients.pop();
        rig.hosts[0].quit(&mut anchor).await?;
        Ok::<_, String>(())
    };
    let outcome = AssertUnwindSafe(phase("AGY steering order", work))
        .catch_unwind()
        .await;
    let cleanup = rig.cleanup().await;
    match outcome {
        Err(panic) => std::panic::resume_unwind(panic),
        Ok(Err(error)) => panic!("{error}; cleanup={cleanup:?}"),
        Ok(Ok(())) => assert!(cleanup.is_empty(), "{cleanup:?}"),
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn antigravity_accepts_steers_through_cancel_and_resume() {
    let mut rig = Rig::new().await.expect("isolated Host and ACP fixture");
    let work = async {
        let (mut anchor, bootstrap) = rig.start().await?;
        rig.configure(&mut anchor, &bootstrap, "antigravity")
            .await?;
        bootstrap.close().await?;
        rig.clients.pop();
        let sdk = connect_sdk(&mut rig, &anchor).await?;
        let (session, parent) = launch(
            &sdk,
            &rig.sandbox.workspace,
            "ACP-parent",
            "Handoff",
            true,
            "antigravity",
        )
        .await?;
        let child = rig.controller.event("ACP-child", "ready").await?;
        terminal_state(&sdk, &session, &parent, "completed").await?;
        let original = send_native(&sdk, &session, "ACP-handoff", "Handoff", true).await?;
        let original_prompt = rig.controller.event("ACP-handoff", "ready").await?;
        rig.controller.send(
            child["pid"].as_u64().unwrap(),
            json!({"action":"complete","promptId":child["promptId"]}),
        )?;
        let receipt = loop {
            let queue = query(&sdk, "agent", "queue", json!({"sessionId":session})).await?;
            if let Some(item) = queue["entries"]
                .as_array()
                .and_then(|entries| entries.first())
            {
                assert_eq!(item["origin"]["kind"], "session_completion", "{item}");
                break item["messageId"].clone();
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        };

        let steer = |label: &str, expected: Option<&Value>| {
            let mut input = json!({"sessionId":session, "message":format!("MAKA_EXTERNAL_CASE {}", json!({"label":label}))});
            if let Some(run) = expected {
                input["expectedRunId"] = run.clone();
            }
            mutate(&sdk, "agent", "send", input)
        };
        let enqueue = |label: &str| {
            mutate(
                &sdk,
                "agent",
                "send",
                json!({
                    "sessionId":session, "delivery":"queue",
                    "message":format!("MAKA_EXTERNAL_CASE {}", json!({"label":label}))
                }),
            )
        };
        let during_cancel = enqueue("ACP-steer-promote-cancel").await?;
        let during_resume = enqueue("ACP-steer-promote-resume").await?;
        let snapshot = || query(&sdk, "agent", "queue", json!({"sessionId":session}));
        let promote = |message: &Value, snapshot: &Value| {
            mutate(
                &sdk,
                "agent",
                "editQueue",
                json!({
                    "sessionId":session, "expectedRevision":snapshot["revision"],
                    "edit":{"kind":"promote", "messageId":message["messageId"]}
                }),
            )
        };
        let gate = rig.sandbox.workspace.join("hold-acp-resume");
        std::fs::write(&gate, []).map_err(|e| e.to_string())?;
        let first = steer("ACP-peer", Some(&original)).await?;
        assert_eq!(first["kind"], "queued", "{first}");
        let cancel = rig
            .controller
            .event("ACP-handoff", "cancel_pending")
            .await?;
        let initial = snapshot().await?;
        let (one, two) = tokio::try_join!(
            promote(&during_cancel, &initial),
            promote(&during_cancel, &initial),
        )?;
        let mut outcomes = [one["kind"].as_str(), two["kind"].as_str()];
        outcomes.sort();
        assert_eq!(outcomes, [Some("committed"), Some("revision_conflict")]);
        for (label, expected) in [("ACP-steer-2", Some(&original)), ("ACP-steer-3", None)] {
            let sent = steer(label, expected).await?;
            assert_eq!(sent["kind"], "queued", "{sent}");
        }
        let queue = snapshot().await?;
        assert_eq!(
            promote(&during_cancel, &queue).await?,
            json!({"kind":"committed","revision":queue["revision"]})
        );
        rig.controller.send(
            cancel["pid"].as_u64().unwrap(),
            json!({"action":"release_cancel"}),
        )?;
        let resume = rig
            .controller
            .event("ACP-handoff", "resume_pending")
            .await?;
        assert_eq!(original_prompt["thread"], resume["thread"]);
        let promoted = promote(&during_resume, &snapshot().await?).await?;
        assert_eq!(promoted["kind"], "committed", "{promoted}");
        for (label, expected) in [("ACP-steer-4", None), ("ACP-steer-5", Some(&original))] {
            let sent = steer(label, expected).await?;
            assert_eq!(sent["kind"], "queued", "{sent}");
        }
        let queue = snapshot().await?;
        let (repeat, concurrent) = tokio::try_join!(
            promote(&during_resume, &queue),
            promote(&during_resume, &queue),
        )?;
        assert_eq!(
            repeat,
            json!({"kind":"committed","revision":queue["revision"]})
        );
        assert_eq!(concurrent, repeat);
        let stale = steer("unexpected", Some(&parent)).await?;
        assert_eq!(stale["reason"], "turn_stopped", "{stale}");
        std::fs::remove_file(gate).map_err(|e| e.to_string())?;
        rig.controller.send(
            resume["pid"].as_u64().unwrap(),
            json!({"action":"release_resume"}),
        )?;
        let peer = rig.controller.event("ACP-peer", "ready").await?;
        let queue = snapshot().await?;
        assert_eq!(
            promote(&during_cancel, &queue).await?,
            json!({"kind":"committed","revision":queue["revision"]})
        );
        assert_eq!(promote(&first, &queue).await?["reason"], "missing");
        rig.controller.send(
            peer["pid"].as_u64().unwrap(),
            json!({"action":"complete","promptId":peer["promptId"]}),
        )?;
        let receipt_run = loop {
            let work = query(
                &sdk,
                "agent",
                "work",
                json!({"sessionId":session,"target":{"kind":"message","messageId":receipt}}),
            )
            .await?;
            if work["kind"] == "delivered" {
                break work["execution"]["runId"].clone();
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        };
        terminal_state(&sdk, &session, &receipt_run, "completed").await?;
        let events = rig.controller.events();
        let jobs: Vec<_> = events
            .iter()
            .filter(|e| e["kind"] == "ready" && e["thread"] == resume["thread"])
            .map(|e| e["job"].as_str().unwrap())
            .collect();
        assert_eq!(
            jobs,
            [
                "ACP-parent",
                "ACP-handoff",
                "ACP-peer",
                "ACP-steer-promote-cancel",
                "ACP-steer-2",
                "ACP-steer-3",
                "ACP-steer-promote-resume",
                "ACP-steer-4",
                "ACP-steer-5",
                "ACP-receipt"
            ]
        );
        assert_eq!(
            events
                .iter()
                .filter(|e| e["method"] == "session/cancel")
                .count(),
            1
        );
        let manual = send_native(&sdk, &session, "ACP-manual", "Manual stop", true).await?;
        rig.controller.event("ACP-manual", "ready").await?;
        let stopped = mutate(
            &sdk,
            "agent",
            "stop",
            json!({"sessionId":session, "runId":manual}),
        )
        .await?;
        assert_eq!(stopped["requested"], true);
        let cancel = rig.controller.event("ACP-manual", "cancel_pending").await?;
        let rejected = steer("unexpected", Some(&manual)).await?;
        assert_eq!(rejected["reason"], "turn_stopped", "{rejected}");
        let error = steer("unexpected", None)
            .await
            .expect_err("manual stop still owns the session");
        assert!(error.contains("agent_admission_failed"), "{error}");
        rig.controller.send(
            cancel["pid"].as_u64().unwrap(),
            json!({"action":"release_cancel"}),
        )?;
        terminal_state(&sdk, &session, &manual, "cancelled").await?;
        sdk.close().await?;
        rig.clients.pop();
        rig.hosts[0].quit(&mut anchor).await?;
        Ok::<_, String>(())
    };
    let outcome = AssertUnwindSafe(phase("ACP steering handoff", work))
        .catch_unwind()
        .await;
    let cleanup = rig.cleanup().await;
    match outcome {
        Err(panic) => std::panic::resume_unwind(panic),
        Ok(Err(error)) => panic!("{error}; cleanup={cleanup:?}"),
        Ok(Ok(())) => assert!(cleanup.is_empty(), "{cleanup:?}"),
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn antigravity_executor_change_releases_only_undelivered_steering() {
    let mut rig = Rig::new().await.expect("isolated Host and ACP fixture");
    let work = async {
        let (mut anchor, bootstrap) = phase("start original Host", rig.start()).await?;
        let deployment = phase(
            "enable Antigravity",
            rig.configure(&mut anchor, &bootstrap, "antigravity"),
        )
        .await?;
        bootstrap.close().await?;
        rig.clients.pop();
        let sdk = connect_sdk(&mut rig, &anchor).await?;
        let settings = query(&sdk, "agent", "externalAgents", json!({"inspect":true})).await?;
        let target = &settings["target"];
        let (session, run) = phase(
            "start the original prompt",
            launch(
                &sdk,
                &rig.sandbox.workspace,
                "ACP-original",
                "Executor change",
                true,
                "antigravity",
            ),
        )
        .await?;
        let original = phase(
            "original prompt delivered",
            rig.controller.event("ACP-original", "ready"),
        )
        .await?;
        let before = phase(
            "original output saved",
            checkpoint(&sdk, &session, &run, &original["checkpoint"]),
        )
        .await?;
        let message = format!(
            "MAKA_EXTERNAL_CASE {}",
            json!({"label":"ACP-wake","session":session})
        );
        let sent = mutate(
            &sdk,
            "agent",
            "send",
            json!({"sessionId":session,"message":message,"delivery":"queue"}),
        )
        .await?;
        assert_eq!(sent["kind"], "queued", "{sent}");
        sdk.close().await?;
        rig.clients.pop();
        phase("kill original Host", rig.hosts[0].sigkill()).await?;

        // Change the executor's basis without changing the AGY command that
        // owns the conversation. Leave the old Run with pending steering.
        let directory = rig.sandbox.directory.path();
        let owner = RootOwner::open(
            &rig.sandbox.root,
            &RootNamespaces {
                ownership: directory.join("upgrade-owners"),
                control: directory.join("upgrade-control"),
            },
        )
        .map_err(|e| e.to_string())?;
        let store =
            maka_transport::open_store(Arc::new(owner), &maka_product_native::root_migrations())
                .await
                .map_err(|e| e.to_string())?;
        let data = store.data_writer().map_err(|e| e.to_string())?;
        let domain = DriverDomain::new(data.clone()).map_err(|e| e.to_string())?;
        let state = Store::new(data, domain).map_err(|e| e.to_string())?;
        let queue = state
            .queue()
            .read(session.clone())
            .await
            .map_err(|e| e.to_string())?;
        let [pending] = queue.entries.as_slice() else {
            return Err("expected one pending message".into());
        };
        assert_eq!(pending.request.message_id, sent["messageId"]);
        let run_id: RunId = serde_json::from_value(run.clone()).map_err(|e| e.to_string())?;
        let original_view = state.frontier(run_id).await.map_err(|e| e.to_string())?;
        let Trigger::Message {
            message_id: original_message,
        } = &original_view.spec.trigger
        else {
            return Err("expected an interactive Run".into());
        };
        let at = UnixMillis(jiff::Timestamp::now().as_millisecond());
        state
            .queue()
            .execute(
                session.clone(),
                QueueCommand {
                    id: FactId::new(),
                    at,
                    expected_revision: queue.revision,
                    edit: QueueEdit::Promote {
                        request: pending.request.id.clone(),
                        target: SteeringTarget {
                            run: run_id,
                            expected_head: (&original_view).into(),
                        },
                    },
                },
                vec![],
            )
            .await
            .map_err(|e| e.to_string())?;
        let claim = state.claim(run_id).await.map_err(|e| e.to_string())?;
        state
            .append(
                &claim,
                (&original_view).into(),
                vec![Change::new(
                    Fact::Blocked {
                        blocker: BlockerId::new(),
                        reason: BlockerKind::CurrentAuthorityUnavailable {
                            stage: AuthorityStage::BackendScope,
                            diagnostic: "invalid execution input: agent_executor_changed".into(),
                        },
                    },
                    at,
                )],
                vec![],
            )
            .await
            .map_err(|e| e.to_string())?;
        drop(claim);
        let loaded = store
            .load_application_at(&deployment)
            .await
            .map_err(|e| e.to_string())?
            .ok_or("deployment missing")?;
        let (mut source, packages, plan, _) = loaded.into_parts();
        let namespace = serde_json::from_value(target["source"]["namespace"].clone())
            .map_err(|e| e.to_string())?;
        let instance = plan
            .instances()
            .get(&namespace)
            .ok_or("agent instance missing")?;
        let mut path: Vec<String> =
            serde_json::from_value(target["path"].clone()).map_err(|e| e.to_string())?;
        path.extend(["runtimes", "codex"].map(str::to_owned));
        source
            .input
            .configure(
                &instance.path,
                vec![ConfigurationField {
                    path,
                    value: Some(json!(true)),
                }],
            )
            .map_err(|e| e.to_string())?;
        store
            .commit_application(
                deployment.deployment,
                deployment.revision,
                source.input,
                source.remote_exports,
                packages,
            )
            .await
            .map_err(|e| e.to_string())?;
        drop(state);
        store.shutdown().await.map_err(|e| e.to_string())?;
        drop(store);

        let (mut reopened, recovery) = phase("start upgraded Host", rig.start()).await?;
        let pid = original["pid"].as_u64().unwrap();
        let transcript = phase("old ACP process exited", rig.transcript(pid)).await?;
        assert!(
            !transcript
                .output
                .iter()
                .any(|row| row["id"] == transcript.task_prompt()["id"]
                    && row.get("method").is_none())
        );
        phase(
            "retire old execution",
            terminal_state(&recovery, &session, &run, "cancelled"),
        )
        .await?;
        let resumed = phase(
            "undelivered steering reaches Antigravity",
            rig.controller.event("ACP-wake", "ready"),
        )
        .await?;
        assert_eq!(resumed["thread"], original["thread"]);
        let delivery = query(
            &recovery,
            "agent",
            "work",
            json!({
                "sessionId":session,"target":{"kind":"message","messageId":sent["messageId"]},
            }),
        )
        .await?;
        assert_eq!(delivery["kind"], "delivered", "{delivery}");
        let next = &delivery["execution"]["runId"];
        assert_ne!(*next, run);
        phase(
            "follow-up completes",
            terminal_state(&recovery, &session, next, "completed"),
        )
        .await?;
        let after = checkpoint(&recovery, &session, &run, &original["checkpoint"]).await?;
        assert_eq!(after["prefix"], before["prefix"]);
        let original_delivery = query(
            &recovery,
            "agent",
            "work",
            json!({
                "sessionId":session,"target":{"kind":"message","messageId":original_message},
            }),
        )
        .await?;
        assert_eq!(
            original_delivery["kind"], "delivered",
            "{original_delivery}"
        );
        assert_eq!(original_delivery["execution"]["runId"], run);
        let resumed_transcript = phase(
            "seal resumed ACP process",
            rig.transcript(resumed["pid"].as_u64().unwrap()),
        )
        .await?;
        let blocks = resumed_transcript.task_prompt()["params"]["prompt"]
            .as_array()
            .unwrap();
        let task = blocks.last().unwrap()["text"].as_str().unwrap();
        assert!(
            task.contains("ACP-wake") && !task.contains("ACP-original"),
            "{task}"
        );
        phase(
            "follow-up settles before Host quit",
            readiness(&recovery, &session, next),
        )
        .await?;
        let events = rig.controller.events();
        assert_eq!(
            events.iter().filter(|e| e["kind"] == "hello").count(),
            2,
            "{events:?}"
        );
        assert!(events.iter().all(|e| e["kind"] != "failure"), "{events:?}");
        recovery.close().await?;
        rig.clients.pop();
        phase("quit upgraded Host", rig.hosts[1].quit(&mut reopened)).await?;
        Ok::<_, String>(())
    };
    let outcome = AssertUnwindSafe(work).catch_unwind().await;
    let cleanup = rig.cleanup().await;
    match outcome {
        Err(panic) => std::panic::resume_unwind(panic),
        Ok(Err(error)) => panic!("{error}; cleanup={cleanup:?}"),
        Ok(Ok(())) => assert!(cleanup.is_empty(), "{cleanup:?}"),
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn antigravity_resumes_from_a_room_mention_and_replies_in_the_room() {
    let mut rig = Rig::new().await.expect("isolated Host and ACP fixture");
    let outcome =
        AssertUnwindSafe(async {
            let (mut anchor, bootstrap) = phase("start Host", rig.start()).await?;
            phase(
                "enable Antigravity",
                rig.configure(&mut anchor, &bootstrap, "antigravity"),
            )
            .await?;
            bootstrap.close().await?;
            rig.clients.pop();
            let sdk = connect_sdk(&mut rig, &anchor).await?;
            let (session, run) = phase(
                "open an ACP conversation",
                launch(
                    &sdk,
                    &rig.sandbox.workspace,
                    "ACP-wake",
                    "Room reviewer",
                    true,
                    "antigravity",
                ),
            )
            .await?;
            phase(
                "finish the initial turn",
                terminal_state(&sdk, &session, &run, "completed"),
            )
            .await?;
            let original = phase(
                "find the original ACP thread",
                rig.controller.event("ACP-wake", "ready"),
            )
            .await?;
            let room = mutate(&sdk, "agent", "create", json!({
            "kind":"room", "title":"Release discussion", "automaticTitle":false, "labels":[],
            "workspace":{"kind":"directory","path":rig.sandbox.workspace}
        })).await?;
            assert_eq!(room["kind"], "created", "{room}");
            let room = &room["session"]["id"];
            let first = mutate(
                &sdk,
                "agent",
                "send",
                json!({
                    "sessionId":room,"message":"The patch is ready."
                }),
            )
            .await?;
            assert_eq!(first["kind"], "posted", "{first}");
            let message = format!("MAKA_EXTERNAL_CASE {}", json!({"label":"ACP-room"}));
            let mention = mutate(&sdk, "agent", "send", json!({
            "sessionId":room, "message":message, "mentions":[session], "replyTo":first["messageId"]
        })).await?;
            assert_eq!(mention["deliveries"][0]["kind"], "accepted", "{mention}");
            phase(
                "ACP reads the earlier Room post and replies",
                rig.controller.event("ACP-room", "room_replied"),
            )
            .await?;
            let resumed = phase(
                "find the resumed ACP prompt",
                rig.controller.event("ACP-room", "ready"),
            )
            .await?;
            assert_eq!(resumed["thread"], original["thread"]);
            let transcript = phase(
                "read the sealed ACP request",
                rig.transcript(resumed["pid"].as_u64().unwrap()),
            )
            .await?;
            let prompt = transcript.task_prompt()["params"]["prompt"]
                .as_array()
                .unwrap()
                .last()
                .and_then(|block| block["text"].as_str())
                .ok_or("ACP mention prompt missing")?;
            let read = json!({"sessionId":room,"messageId":mention["messageId"],"anchor":"before"});
            let reply = json!({"sessionId":room,"replyTo":mention["messageId"]});
            assert!(prompt.contains(&format!("SessionRead({read})")), "{prompt}");
            assert!(prompt.contains(&reply.to_string()), "{prompt}");
            assert!(prompt.contains(&message), "{prompt}");
            let history = query(
                &sdk,
                "agent",
                "history",
                json!({
                    "sessionId":room,"position":{"kind":"tail"}
                }),
            )
            .await?;
            let posts = history["page"]["items"]
                .as_array()
                .ok_or("missing Room history")?;
            let posted = posts
                .iter()
                .find(|post| post["content"]["text"] == "ACP reply in the Room")
                .ok_or("ACP reply was not posted in the Room")?;
            assert_eq!(posted["replyTo"], mention["messageId"]);
            assert_eq!(posted["author"]["execution"]["sessionId"], session);
            sdk.close().await?;
            rig.clients.pop();
            phase("quit Host", rig.hosts[0].quit(&mut anchor)).await?;
            Ok::<_, String>(())
        })
        .catch_unwind()
        .await;
    let cleanup = rig.cleanup().await;
    match outcome {
        Err(panic) => std::panic::resume_unwind(panic),
        Ok(Err(error)) => panic!("{error}; cleanup={cleanup:?}"),
        Ok(Ok(())) => assert!(cleanup.is_empty(), "{cleanup:?}"),
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn antigravity_goal_resumes_after_stop_with_ui_approval() {
    let mut rig = Rig::new().await.expect("isolated Host and ACP fixture");
    let outcome = AssertUnwindSafe(async {
        let (mut anchor, bootstrap) = phase("start Host", rig.start()).await?;
        phase(
            "enable Antigravity",
            rig.configure(&mut anchor, &bootstrap, "antigravity"),
        )
        .await?;
        bootstrap.close().await?;
        rig.clients.pop();
        let sdk = connect_sdk(&mut rig, &anchor).await?;
        let (session, run) = phase(
            "start a prompt that creates a Goal",
            launch(
                &sdk,
                &rig.sandbox.workspace,
                "ACP-goal",
                "Create a persistent Goal",
                true,
                "antigravity",
            ),
        )
        .await?;
        let original = phase(
            "AGY creates the Goal through MCP",
            rig.controller.event("ACP-goal", "goal_created"),
        )
        .await?;
        let stopped = mutate(
            &sdk,
            "agent",
            "stop",
            json!({"sessionId":session,"runId":run}),
        )
        .await?;
        assert_eq!(stopped["requested"], true);
        let paused = phase("the stopped Goal becomes resumable", async {
            let mut tick = tokio::time::interval(Duration::from_millis(20));
            loop {
                tick.tick().await;
                let view = query(&sdk, "agent", "goal", json!({"sessionId":session})).await?;
                let current = &view["current"];
                if current["status"] == "paused" && current["pending"] == false {
                    return Ok(current.clone());
                }
            }
        })
        .await?;
        assert_eq!(paused["id"], original["goalId"]);

        let observed = query(&sdk, "agent", "observe", json!({"sessionId":session})).await?;
        let current = &observed["session"];
        let approval = json!({
            "target": {
                "sessionId":current["id"],
                "workspace":current["workspace"],
                "permissions":current["permissions"],
                "boundaryRevision":current["boundaryRevision"],
                "binding":current["binding"],
            },
            "backend": {
                "kind":"executor",
                "selection":{
                    "executor":"external",
                    "settings":{"runtime":"antigravity","model":"default"},
                },
            },
        });
        let resumed = mutate(
            &sdk,
            "agent",
            "changeGoal",
            json!({
                "kind":"control",
                "sessionId":session,
                "goalId":paused["id"],
                "revision":paused["revision"],
                "action":"resume",
                "approval":approval,
            }),
        )
        .await?;
        assert_eq!(resumed["kind"], "committed", "{resumed}");

        let continued = phase(
            "the resumed Goal submits another ACP turn",
            rig.controller.event("ACP-goal-resumed", "ready"),
        )
        .await?;
        assert_eq!(continued["thread"], original["thread"]);
        let achieved = phase("AGY reports Goal achievement and finishes", async {
            let mut tick = tokio::time::interval(Duration::from_millis(20));
            loop {
                tick.tick().await;
                let view = query(&sdk, "agent", "goal", json!({"sessionId":session})).await?;
                let current = &view["current"];
                if current["status"] == "achieved" && current["pending"] == false {
                    return Ok(current.clone());
                }
            }
        })
        .await?;
        assert_eq!(achieved["iterations"], 2);
        sdk.close().await?;
        rig.clients.pop();
        phase("quit Host", rig.hosts[0].quit(&mut anchor)).await?;
        Ok::<_, String>(())
    })
    .catch_unwind()
    .await;
    let cleanup = rig.cleanup().await;
    match outcome {
        Err(panic) => std::panic::resume_unwind(panic),
        Ok(Err(error)) => panic!("{error}; cleanup={cleanup:?}"),
        Ok(Ok(())) => assert!(cleanup.is_empty(), "{cleanup:?}"),
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn antigravity_automation_wakes_the_original_conversation_after_the_turn() {
    let mut rig = Rig::new().await.expect("isolated Host and ACP fixture");
    let outcome = AssertUnwindSafe(async {
        let (mut anchor, bootstrap) = phase("start Host", rig.start()).await?;
        phase(
            "enable Antigravity",
            rig.configure(&mut anchor, &bootstrap, "antigravity"),
        )
        .await?;
        bootstrap.close().await?;
        rig.clients.pop();
        let sdk = connect_sdk(&mut rig, &anchor).await?;
        let (session, run) = phase(
            "start the scheduling prompt",
            launch(
                &sdk,
                &rig.sandbox.workspace,
                "ACP-schedule",
                "Wake up",
                true,
                "antigravity",
            ),
        )
        .await?;
        let original = phase(
            "AGY creates an automation through MCP",
            rig.controller.event("ACP-schedule", "scheduled"),
        )
        .await?;
        let task = phase("scheduled fire waits for the busy conversation", async {
            let mut tick = tokio::time::interval(Duration::from_millis(20));
            loop {
                tick.tick().await;
                let result = query(
                    &sdk,
                    "agent",
                    "schedules",
                    json!({"kind":"get","taskId":original["taskId"]}),
                )
                .await?;
                assert_eq!(result["kind"], "task", "{result}");
                let detail = &result["detail"];
                if detail["pendingFire"].is_string() {
                    return Ok(detail.clone());
                }
            }
        })
        .await?;
        assert_eq!(task["task"]["effect"]["target"]["sessionId"], session);
        assert_eq!(task["task"]["effect"]["kind"], "executor_session");
        assert!(
            !rig.controller
                .events()
                .iter()
                .any(|event| event["job"] == "ACP-wake")
        );
        let pid = original["pid"].as_u64().unwrap();
        rig.controller.send(
            pid,
            json!({"action":"complete","promptId":original["promptId"]}),
        )?;
        phase(
            "the original prompt finishes",
            terminal_state(&sdk, &session, &run, "completed"),
        )
        .await?;
        let wake = phase(
            "the automation resumes AGY without user input",
            rig.controller.event("ACP-wake", "ready"),
        )
        .await?;
        assert_eq!(wake["thread"], original["thread"]);
        let transcript = phase(
            "the wake-up prompt finishes",
            rig.transcript(wake["pid"].as_u64().unwrap()),
        )
        .await?;
        let wake_prompts = transcript.task_prompt()["params"]["prompt"].as_array().unwrap();
        assert!(
            matches!(
                wake_prompts.as_slice(),
                [prompt] if prompt["text"].as_str().is_some_and(|text| text.contains("ACP-wake") && !text.contains("<maka_system_instructions>"))
            ),
            "wake-up turn must preserve instructions_digest without re-injecting system instructions: {wake_prompts:?}"
        );
        assert!(
            transcript
                .output
                .iter()
                .any(|row| row["id"] == transcript.task_prompt()["id"]
                    && row["result"]["stopReason"] == "end_turn")
        );
        assert_eq!(
            rig.controller
                .events()
                .iter()
                .filter(|event| event["job"] == "ACP-wake" && event["kind"] == "ready")
                .count(),
            1
        );
        sdk.close().await?;
        rig.clients.pop();
        phase("quit Host", rig.hosts[0].quit(&mut anchor)).await?;
        Ok::<_, String>(())
    })
    .catch_unwind()
    .await;
    let cleanup = rig.cleanup().await;
    match outcome {
        Err(panic) => std::panic::resume_unwind(panic),
        Ok(Err(error)) => panic!("{error}; cleanup={cleanup:?}"),
        Ok(Ok(())) => assert!(cleanup.is_empty(), "{cleanup:?}"),
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn antigravity_automatic_title_falls_back_to_first_message() {
    let mut rig = Rig::new().await.expect("isolated Host and ACP fixture");
    let outcome = AssertUnwindSafe(async {
        let (mut anchor, bootstrap) = phase("start Host", rig.start()).await?;
        phase(
            "enable Antigravity ACP",
            rig.configure(&mut anchor, &bootstrap, "antigravity"),
        )
        .await?;
        bootstrap.close().await?;
        rig.clients.pop();
        let sdk = connect_sdk(&mut rig, &anchor).await?;

        let created = mutate(
            &sdk,
            "agent",
            "create",
            json!({
                "title": "New conversation",
                "automaticTitle": true,
                "labels": [],
                "workspace": {"kind": "directory", "path": rig.sandbox.workspace},
                "backend": {
                    "kind": "executor",
                    "selection": {
                        "executor": "external",
                        "settings": {"runtime": "antigravity", "model": "default"}
                    }
                }
            }),
        )
        .await?;
        assert_eq!(created["kind"], "created", "{created}");
        let session = created["session"]["id"]
            .as_str()
            .ok_or("session ID missing")?
            .to_owned();
        let marker = format!(
            "MAKA_EXTERNAL_CASE {}",
            json!({"label": "ACP-steer-title", "session": session})
        );
        let message = format!("  Fix ACP   title fallback
{marker}");
        let expected: String = message
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
            .chars()
            .take(80)
            .collect();
        let sent = mutate(
            &sdk,
            "agent",
            "send",
            json!({"sessionId": session, "message": message, "delivery": "queue"}),
        )
        .await?;
        assert_eq!(sent["kind"], "queued", "{sent}");
        let run = phase("first turn admitted", async {
            let mut tick = tokio::time::interval(Duration::from_millis(20));
            loop {
                tick.tick().await;
                let work = query(
                    &sdk,
                    "agent",
                    "work",
                    json!({"sessionId": session, "target": {"kind": "message", "messageId": sent["messageId"]}}),
                )
                .await?;
                match work["kind"].as_str() {
                    Some("pending") => {}
                    Some("delivered") => return Ok::<_, String>(work["execution"]["runId"].clone()),
                    _ => return Err(format!("original admission unavailable: {work}")),
                }
            }
        })
        .await?;
        phase(
            "first turn completes",
            terminal_state(&sdk, &session, &run, "completed"),
        )
        .await?;
        let observed = phase("automatic fallback title is committed", async {
            loop {
                let state = query(&sdk, "agent", "observe", json!({"sessionId": session})).await?;
                if state["session"]["title"].as_str() == Some(expected.as_str()) {
                    return Ok::<_, String>(state);
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        })
        .await?;
        let revision = observed["session"]["revision"]
            .as_u64()
            .ok_or("session revision missing")?;
        let renamed = mutate(
            &sdk,
            "agent",
            "metadata",
            json!({
                "sessionId": session,
                "expectedRevision": revision,
                "title": "Manual override",
                "labels": []
            }),
        )
        .await?;
        assert_eq!(renamed["kind"], "committed", "{renamed}");
        assert_eq!(renamed["session"]["title"], "Manual override");

        let (manual_session, manual_run) = phase(
            "launch manual-title turn",
            launch(
                &sdk,
                &rig.sandbox.workspace,
                "ACP-steer-manual",
                "unused",
                false,
                "antigravity",
            ),
        )
        .await?;
        phase(
            "manual-title turn completes",
            terminal_state(&sdk, &manual_session, &manual_run, "completed"),
        )
        .await?;
        let manual_state = query(
            &sdk,
            "agent",
            "observe",
            json!({"sessionId": manual_session}),
        )
        .await?;
        assert_eq!(
            manual_state["session"]["title"],
            "External job ACP-steer-manual"
        );

        sdk.close().await?;
        rig.clients.pop();
        phase("quit Host", rig.hosts[0].quit(&mut anchor)).await?;
        Ok::<_, String>(())
    })
    .catch_unwind()
    .await;
    let cleanup = rig.cleanup().await;
    match outcome {
        Err(panic) => std::panic::resume_unwind(panic),
        Ok(Err(error)) => panic!("{error}; cleanup={cleanup:?}"),
        Ok(Ok(())) => assert!(cleanup.is_empty(), "{cleanup:?}"),
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn antigravity_falls_back_to_user_block_and_supersedes_after_upgrade() {
    let mut rig = Rig::new().await.expect("isolated Host and ACP fixture");
    let outcome = AssertUnwindSafe(async {
        let disable_flag = rig.sandbox.home.join("disable-acp-system-prompt-append");
        tokio::fs::write(&disable_flag, "1")
            .await
            .map_err(|e| e.to_string())?;
        let (mut anchor, bootstrap) = phase("start Host with legacy agy", rig.start()).await?;
        phase(
            "enable Antigravity ACP",
            rig.configure(&mut anchor, &bootstrap, "antigravity"),
        )
        .await?;
        bootstrap.close().await?;
        rig.clients.pop();
        let sdk = connect_sdk(&mut rig, &anchor).await?;

        let (session, first_run) = phase(
            "launch legacy ACP turn",
            launch(
                &sdk,
                &rig.sandbox.workspace,
                "ACP-steer-legacy",
                "unused",
                false,
                "antigravity",
            ),
        )
        .await?;
        let first_ready = phase(
            "legacy ACP turn admitted",
            rig.controller.event("ACP-steer-legacy", "ready"),
        )
        .await?;
        phase(
            "legacy ACP turn completes",
            terminal_state(&sdk, &session, &first_run, "completed"),
        )
        .await?;
        let legacy_wire = phase(
            "seal legacy ACP transcript",
            rig.transcript(first_ready["pid"].as_u64().unwrap()),
        )
        .await?;
        let legacy_open = legacy_wire
            .input
            .iter()
            .find(|row| row["method"] == "session/new")
            .unwrap();
        assert_eq!(
            legacy_open.pointer("/params/_meta/antigravity/systemPrompt"),
            None
        );
        let [instructions_block, user_block] = legacy_wire.task_prompt()["params"]["prompt"]
            .as_array()
            .unwrap()
            .as_slice()
        else {
            panic!("expected legacy [instructions, user] prompt blocks");
        };
        assert!(
            instructions_block["text"]
                .as_str()
                .unwrap()
                .starts_with("<maka_system_instructions>")
        );
        assert!(
            user_block["text"]
                .as_str()
                .unwrap()
                .contains("ACP-steer-legacy")
        );

        sdk.close().await?;
        rig.clients.pop();
        phase("quit legacy Host", rig.hosts[0].quit(&mut anchor)).await?;

        tokio::fs::remove_file(&disable_flag)
            .await
            .map_err(|e| e.to_string())?;
        tokio::fs::create_dir_all(rig.sandbox.home.join(".maka"))
            .await
            .map_err(|e| e.to_string())?;
        tokio::fs::write(
            rig.sandbox.home.join(".maka/AGENTS.md"),
            "Upgraded instruction set",
        )
        .await
        .map_err(|e| e.to_string())?;

        let (mut upgraded, next_sdk) = phase("reopen Host with upgraded agy", rig.start()).await?;
        let second_run = phase(
            "send upgraded ACP turn",
            send_native(&next_sdk, &session, "ACP-steer-upgraded", "unused", false),
        )
        .await?;
        let upgraded_ready = phase(
            "upgraded ACP turn admitted",
            rig.controller.event("ACP-steer-upgraded", "ready"),
        )
        .await?;
        assert_eq!(upgraded_ready["thread"], first_ready["thread"]);
        phase(
            "upgraded ACP turn completes",
            terminal_state(&next_sdk, &session, &second_run, "completed"),
        )
        .await?;
        let upgraded_wire = phase(
            "seal upgraded ACP transcript",
            rig.transcript(upgraded_ready["pid"].as_u64().unwrap()),
        )
        .await?;
        let resume_open = upgraded_wire
            .input
            .iter()
            .find(|row| row["method"] == "session/resume")
            .unwrap();
        let append = resume_open
            .pointer("/params/_meta/antigravity/systemPrompt/append")
            .and_then(Value::as_str)
            .unwrap();
        assert!(append.contains("replace all earlier Maka instruction blocks"));
        assert!(append.contains("Upgraded instruction set"));
        let [upgraded_user] = upgraded_wire.task_prompt()["params"]["prompt"]
            .as_array()
            .unwrap()
            .as_slice()
        else {
            panic!("expected only user prompt block after upgrading to systemPrompt.append");
        };
        assert!(
            upgraded_user["text"]
                .as_str()
                .unwrap()
                .contains("ACP-steer-upgraded")
        );

        next_sdk.close().await?;
        rig.clients.pop();
        phase("quit upgraded Host", rig.hosts[1].quit(&mut upgraded)).await?;
        Ok::<_, String>(())
    })
    .catch_unwind()
    .await;
    let cleanup = rig.cleanup().await;
    match outcome {
        Err(panic) => std::panic::resume_unwind(panic),
        Ok(Err(error)) => panic!("{error}; cleanup={cleanup:?}"),
        Ok(Ok(())) => assert!(cleanup.is_empty(), "{cleanup:?}"),
    }
}
