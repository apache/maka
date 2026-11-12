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

#![cfg(target_os = "macos")]

#[path = "support/host.rs"]
mod host;

use futures_util::FutureExt;
use host::{Host, Result, Sandbox};
use maka_app_client::{Client, Journal};
use maka_capabilities::call::Attachments;
use maka_host_runtime::application::host::Client as HostClient;
use maka_plugin_core::deployment::DeploymentRef;
use maka_plugin_core::operation::{
    OperationCleanup, OperationOutcome, OperationReply, OperationResult, Receipt, RecoveryRef,
};
use maka_process::isolated::{self, Descriptor, EvidenceInterest, EvidenceWatch};
use serde_json::{Value, json};
use std::{
    future::Future,
    io::Read,
    os::unix::fs::PermissionsExt,
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
    let mut input = BufReader::new(input);
    let mut line = String::new();
    loop {
        line.clear();
        tokio::select! {
            () = stop.cancelled() => return Ok(()),
            command = commands.recv() => {
                let Some(command) = command else { return Ok(()); };
                output.write_all(format!("{}\n", command).as_bytes()).await.map_err(|e| e.to_string())?;
            }
            read = input.read_line(&mut line) => {
                if read.map_err(|e| e.to_string())? == 0 { return Ok(()); }
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
    async fn node(&mut self) -> Result<PathBuf> {
        let paths = std::env::var_os("PATH").ok_or("Node discovery requires the actual PATH")?;
        let mut found = None;
        for directory in std::env::split_paths(&paths) {
            let path = directory.join("node");
            match tokio::fs::metadata(&path).await {
                Ok(metadata)
                    if metadata.is_file() && metadata.permissions().mode() & 0o111 != 0 =>
                {
                    found = Some(path);
                    break;
                }
                Ok(_) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.to_string()),
            }
        }
        let node = tokio::fs::canonicalize(found.ok_or("Node executable not found")?)
            .await
            .map_err(|e| e.to_string())?;
        if node
            .to_str()
            .ok_or("Node path is not UTF-8")?
            .chars()
            .any(char::is_whitespace)
        {
            return Err("Node path cannot form an executable shebang".into());
        }
        let child = Command::new(&node).args(["--input-type=module", "-e",
            "if(Number(process.versions.node.split('.')[0]) < 24 || typeof fetch !== 'function') process.exit(1)"])
            .env_clear().env("HOME", &self.sandbox.home).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::inherit())
            .spawn().map_err(|e| e.to_string())?;
        self.commands.push(child);
        if !self
            .commands
            .last_mut()
            .unwrap()
            .wait()
            .await
            .map_err(|e| e.to_string())?
            .success()
        {
            return Err("discovered Node cannot execute the protocol adapter".into());
        }
        Ok(node)
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
    async fn configure(&mut self, anchor: &mut HostClient, sdk: &Client) -> Result<DeploymentRef> {
        let node = self.node().await?;
        let path = self.sandbox.workspace.join("external-codex-cli.mjs");
        tokio::fs::write(
            &path,
            format!(
                "#!{}\n{}",
                node.display(),
                include_str!("support/external_codex_cli.mjs")
            ),
        )
        .await
        .map_err(|e| e.to_string())?;
        tokio::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700))
            .await
            .map_err(|e| e.to_string())?;
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
        let mut changes = vec![json!({"path":target["path"]})];
        for (tail, value) in [
            (
                vec!["runtimes", "codex"],
                json!({"kind":"boolean","value":true}),
            ),
            (
                vec!["commands", "codex", "executable"],
                json!({"kind":"text","text":"./external-codex-cli.mjs"}),
            ),
            (
                vec!["commands", "codex", "env", "FAKE_CONTROL"],
                json!({"kind":"text","text":self.controller.address}),
            ),
            (
                vec!["commands", "codex", "env", "FAKE_ROOT_PID"],
                json!({"kind":"text","text":status.pid.get().to_string()}),
            ),
        ] {
            let mut path = target["path"]
                .as_array()
                .ok_or("external target path missing")?
                .clone();
            path.extend(tail.into_iter().map(|part| json!(part)));
            changes.push(json!({"path":path,"value":value}));
        }
        let configured = mutate(
            sdk,
            "management",
            "configureBatch",
            json!({
                "expectedRevision":source["source"]["reference"]["revision"],
                "edits":[{"instance":target["source"]["namespace"],"changes":changes}]
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
    async fn transcript(&mut self, pid: u64) -> Result<Transcript> {
        let descriptor = self.controller.resource(pid)?;
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
) -> Result<(String, Value)> {
    let created = mutate(client, "agent", "create", json!({
        "title":format!("External job {label}"),"automaticTitle":false,"labels":[],
        "workspace":{"kind":"directory","path":workspace},
        "backend":{"kind":"executor","selection":{"executor":"external","settings":{"runtime":"codex","model":"external-model"}}}
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
            json!({"sessionId":session,"position":{"kind":"start"},"includeThinking":false}),
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
    let events: Vec<_> = facts
        .iter()
        .filter(|fact| fact["kind"] == "external_effect")
        .map(|fact| &fact["event"])
        .collect();
    let admitted: Vec<_> = events
        .iter()
        .filter(|event| event["kind"] == "admitted")
        .collect();
    assert_eq!(admitted.len(), 1, "one original Host effect admission");
    let key = &admitted[0]["key"];
    assert_eq!(key["task"], *task);
    assert!(
        events.iter().all(|event| &event["key"] == key),
        "no replacement effect key"
    );
    let bindings: Vec<_> = events
        .iter()
        .filter(|event| event["kind"] == "bound")
        .collect();
    assert_eq!(bindings.len(), 1, "one SessionCreate Host effect binding");
    let reference: RecoveryRef = serde_json::from_value(bindings[0]["reference"].clone())
        .expect("complete original Host reference");
    reference.validate().expect("valid original Host reference");
    assert_eq!(
        events
            .iter()
            .filter(|event| event["kind"] == "returned")
            .count(),
        1,
        "one canonical return for the original effect key"
    );
    let observed: Vec<OperationReply> = events
        .iter()
        .filter(|event| event["kind"] == "observed")
        .map(|event| {
            serde_json::from_value(event["observation"].clone())
                .expect("complete original operation observation")
        })
        .collect();
    let final_observation = observed
        .last()
        .expect("final original Host operation observation");
    let created = receipt_value(final_observation)
        .expect("final Host effect Recorded Returned Success with cleanup Confirmed");
    let Receipt::Recorded {
        outcome: final_outcome,
        ..
    } = &final_observation.receipt
    else {
        unreachable!("receipt_value requires a recorded success");
    };
    let cleanup = events
        .iter()
        .rev()
        .find(|event| event["kind"] == "cleanup_observed")
        .expect("original Host effect CleanupObserved");
    let cleanup: OperationCleanup = serde_json::from_value(cleanup["cleanup"].clone())
        .expect("typed original Host cleanup evidence");
    assert_eq!(cleanup, OperationCleanup::Confirmed);
    assert_eq!(effect["title"], title);
    for observation in &observed {
        assert_eq!(
            observation.reference, reference,
            "Bound and Observed full reference"
        );
        if let Receipt::Recorded { outcome, .. } = &observation.receipt
            && matches!(
                outcome,
                OperationOutcome::Returned { .. } | OperationOutcome::NotExecuted { .. }
            )
        {
            assert_eq!(
                outcome, final_outcome,
                "known original business outcome cannot change"
            );
        }
    }
    assert_eq!(created["kind"], "created");
    let child = &created["session"];
    assert!(child["id"].as_str().is_some_and(|id| !id.trim().is_empty()));
    assert_eq!(child["id"], effect["session"]);
    assert_eq!(child["title"], title);
    assert_eq!(child["parentSessionId"], parent);
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
            let committed_source = phase("configure actual external runtime", rig.configure(&mut anchor, &bootstrap)).await?;
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
                launch(&sdk, &rig.sandbox.workspace, label, &title, true)).await?;
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
                let failed = phase("read original immutable transcript, not BackendScope rejection",
                    terminal_state(&recovery,&session,&run,"failed")).await?;
                assert_eq!(failed["state"]["reason"], json!({
                    "kind":"external_task_unobservable", "descriptor":bound["descriptor"]
                }), "must retain the original bound native resource: {failed}");
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
                assert!(!recovered.iter().any(|f| f["kind"] == "external_task_closed"),"Unknown remains Unknown");
                assert_eq!(recovered.iter().filter(|f| f["kind"] == "run_admitted").count(),1);
            } else {
                let (session_b,run_b) = phase("parallel original job B",
                    launch(&sdk,&rig.sandbox.workspace,"B",&title,false)).await?;
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
                    assert_eq!(Path::new(hello["cwd"].as_str().unwrap()), workspace);
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

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn quitting_host_reaps_the_active_original_external_process() {
    let mut rig = Rig::new().await.expect("owned external job fixture");
    let outcome = AssertUnwindSafe(async {
        let (mut anchor, bootstrap) = phase("start original Host", rig.start()).await?;
        phase(
            "configure external runtime",
            rig.configure(&mut anchor, &bootstrap),
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
async fn sigkill_reopens_original_external_transcript_without_resubmission() {
    run_case(true).await;
}
