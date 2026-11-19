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
use futures_util::StreamExt;
use maka_process::isolated::SessionSpool;
use serde_json::json;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::sync::{mpsc, watch};
use tokio_util::codec::{FramedRead, LinesCodec};

type Run = u64;
enum Event {
    Frame(Run, String),
    Detached(Run),
    CloseExpired(Run),
}

struct Route {
    spool: SessionSpool,
    written: watch::Sender<u64>,
    session: Option<String>,
    detached: bool,
    expired: bool,
}
impl Route {
    async fn emit(&mut self, frame: &Value) -> io::Result<()> {
        let bytes = line(frame)?;
        self.spool.output.write_all(&bytes).await?;
        self.spool.output.flush().await?;
        self.written.send_modify(|n| *n += bytes.len() as u64);
        Ok(())
    }
}
fn line(value: &Value) -> io::Result<Vec<u8>> {
    let mut bytes = serde_json::to_vec(value)?;
    bytes.push(b'\n');
    Ok(bytes)
}
fn frames(read: impl AsyncRead) -> FramedRead<impl AsyncRead, LinesCodec> {
    FramedRead::new(
        read,
        LinesCodec::new_with_max_length(runtime::MAX_MESSAGE_BYTES),
    )
}
async fn copy_committed(
    mut file: tokio::fs::File,
    mut destination: impl AsyncWrite + Unpin,
    mut committed: watch::Receiver<u64>,
) -> io::Result<()> {
    let mut offset = 0;
    loop {
        let end = *committed.borrow_and_update();
        if end > offset {
            let copied =
                tokio::io::copy(&mut (&mut file).take(end - offset), &mut destination).await?;
            if copied != end - offset {
                return Err(io::Error::other("short ACP session transcript"));
            }
            offset = end;
        }
        if committed.changed().await.is_err() {
            return Ok(());
        }
    }
}

struct Pending {
    run: Run,
    local: Option<u64>,
    method: String,
    resume: Option<String>,
}

struct Router {
    routes: BTreeMap<Run, Route>,
    sessions: BTreeMap<String, Run>,
    pending: BTreeMap<u64, Pending>,
    next_id: u64,
    next_run: u64,
    events: mpsc::Sender<Event>,
    initialized: Value,
    writer: maka_process::pipe::Input,
    clients: JoinSet<()>,
}
impl Router {
    async fn connect(&mut self, spec: Connect) -> io::Result<()> {
        let path = spec.resource.resource_ref.join("owner/stdout.bin");
        let spool = SessionSpool::open(spec.resource).await?;
        let socket = match UnixStream::connect(spec.socket).await {
            Ok(socket) => socket,
            Err(_) => return spool.seal().await,
        };
        let (read, write) = socket.into_split();
        let run = self.next_run;
        self.next_run += 1;
        let (written, committed) = watch::channel(0);
        let file = tokio::fs::File::open(path).await?;
        let tx = self.events.clone();
        self.clients.spawn(async move {
            let mut input = frames(read);
            while let Some(Ok(line)) = input.next().await {
                if tx.send(Event::Frame(run, line)).await.is_err() {
                    return;
                }
            }
            let _ = tx.send(Event::Detached(run)).await;
        });
        self.clients.spawn(async move {
            // A slow or disconnected observer cannot block another session's replies.
            if let Err(error) = copy_committed(file, write, committed).await
                && !matches!(
                    error.kind(),
                    io::ErrorKind::BrokenPipe | io::ErrorKind::ConnectionReset
                )
            {
                eprintln!("agy ACP session output: {error}");
            }
        });
        self.routes.insert(
            run,
            Route {
                spool,
                written,
                session: None,
                detached: false,
                expired: false,
            },
        );
        Ok(())
    }
    async fn request(
        &mut self,
        run: Run,
        local: Option<u64>,
        method: &str,
        mut message: Value,
    ) -> io::Result<()> {
        self.next_id += 1;
        message["id"] = self.next_id.into();
        self.pending.insert(
            self.next_id,
            Pending {
                run,
                local,
                method: method.into(),
                resume: message
                    .pointer("/params/sessionId")
                    .and_then(Value::as_str)
                    .filter(|_| method == "session/resume")
                    .map(str::to_owned),
            },
        );
        self.writer.write_all(&line(&message)?).await
    }
    async fn input(&mut self, run: Run, row: String) -> io::Result<()> {
        let Some(route) = self.routes.get_mut(&run) else {
            return Ok(());
        };
        route.spool.input.write_all(row.as_bytes()).await?;
        route.spool.input.write_all(b"\n").await?;
        let msg: Value = serde_json::from_str(&row)?;
        let method = msg["method"].as_str().unwrap_or("").to_owned();
        let local = msg["id"].as_u64();
        if method == "session/resume"
            && let Some(sid) = msg.pointer("/params/sessionId").and_then(Value::as_str)
            && (self.sessions.contains_key(sid)
                || self
                    .pending
                    .values()
                    .any(|p| p.resume.as_deref() == Some(sid)))
        {
            return route
                .emit(&json!({"jsonrpc":"2.0","id":local,"error":{
                    "code":-32602,"message":"This agy session is already open"
                }}))
                .await;
        }
        if method == "initialize" {
            return route
                .emit(&json!({"jsonrpc":"2.0","id":local,"result":self.initialized}))
                .await;
        }
        if let Some(id) = local
            && !method.is_empty()
        {
            self.request(run, Some(id), &method, msg).await
        } else {
            self.writer.write_all(&line(&msg)?).await
        }
    }
    async fn detach(&mut self, run: Run) -> io::Result<()> {
        let Some(route) = self.routes.get_mut(&run) else {
            return Ok(());
        };
        route.detached = true;
        let tx = self.events.clone();
        self.clients.spawn(async move {
            tokio::select! {
                () = tx.closed() => {}
                () = tokio::time::sleep(Duration::from_secs(2)) => {
                    let _ = tx.send(Event::CloseExpired(run)).await;
                }
            }
        });
        self.close_session(run).await
    }
    async fn close_session(&mut self, run: Run) -> io::Result<()> {
        if let Some(session) = self.routes[&run].session.clone() {
            self.request(
                run,
                None,
                "session/close",
                json!({"jsonrpc":"2.0","method":"session/close","params":{"sessionId":session}}),
            )
            .await?;
        } else if !self.pending.values().any(|p| p.run == run) {
            self.seal(run).await?;
        }
        Ok(())
    }
    async fn seal(&mut self, run: Run) -> io::Result<()> {
        let route = self.routes.remove(&run).expect("owned route");
        if let Some(session) = &route.session {
            self.sessions.remove(session);
        }
        self.pending.retain(|_, pending| pending.run != run);
        route.spool.seal().await
    }
    async fn response(&mut self, mut msg: Value, provider_alive: bool) -> io::Result<()> {
        if msg.get("method").is_some() {
            if let Some(run) = msg
                .pointer("/params/sessionId")
                .and_then(Value::as_str)
                .and_then(|s| self.sessions.get(s))
            {
                return self.routes.get_mut(run).unwrap().emit(&msg).await;
            }
            // Load notifications before the session/new acknowledgement are historical.
            if provider_alive && let Some(id) = msg.get("id") {
                let reply = json!({"jsonrpc":"2.0","id":id,"error":{
                    "code":-32601,"message":"Unsupported ACP callback"
                }});
                self.writer.write_all(&line(&reply)?).await?;
            }
            return Ok(());
        }
        let Some(pending) = msg["id"].as_u64().and_then(|id| self.pending.remove(&id)) else {
            return Ok(());
        };
        let run = pending.run;
        let Some(route) = self.routes.get_mut(&run) else {
            return Ok(());
        };
        let opened = matches!(pending.method.as_str(), "session/new" | "session/resume");
        if opened
            && msg.get("result").is_some()
            && let Some(session) = msg
                .pointer("/result/sessionId")
                .and_then(Value::as_str)
                .or(pending.resume.as_deref())
        {
            if self.sessions.contains_key(session) {
                return Err(io::Error::other(
                    "agy returned a session already owned by another Run",
                ));
            }
            self.sessions.insert(session.into(), run);
            route.session = Some(session.into());
        }
        if let Some(local) = pending.local {
            msg["id"] = local.into();
            route.emit(&msg).await?;
        }
        if pending.method == "session/close" && msg.get("result").is_some() {
            self.seal(run).await?;
        } else if provider_alive && opened && route.detached {
            self.close_session(run).await?;
        }
        Ok(())
    }
}

pub async fn serve_front() -> io::Result<()> {
    let mut registrations = BufReader::new(tokio::io::stdin()).lines();
    let first = registrations
        .next_line()
        .await?
        .ok_or(io::ErrorKind::UnexpectedEof)?;
    let launch: Launch = serde_json::from_str(&first)?;
    let profile = agy::host_agent_directory()
        .await
        .map_err(io::Error::other)?;
    let temp = tempfile::Builder::new().prefix("maka-agy-").tempdir()?;
    let mut cmd = maka_process::Command::new(launch.executable, &profile);
    for arg in launch.args {
        cmd.arg(arg);
    }
    for (key, value) in launch.env {
        cmd.env(key, value);
    }
    for key in ["TMPDIR", "TMP", "TEMP"] {
        cmd.env(key, temp.path());
    }
    cmd.args([
        "acp",
        "--process-per-session",
        "--dangerously-skip-permissions",
        "--agent",
        agy::HOST_AGENT,
        "--add-dir",
    ])
    .arg(&profile);
    let maka_process::pipe::Spawned {
        mut child,
        mut stdin,
        stdout,
        mut stderr,
    } = maka_process::pipe::spawn(cmd)
        .await
        .map_err(io::Error::other)?;
    let diagnostics =
        tokio::spawn(async move { tokio::io::copy(&mut stderr, &mut tokio::io::stderr()).await });
    let mut output = frames(stdout);
    let mut ready = tokio::io::stdout();
    let initialize = async {
        let request = json!({
            "jsonrpc":"2.0","id":1,"method":"initialize","params":agy_acp::initialize_params()
        });
        stdin.write_all(&line(&request)?).await?;
        let row = output
            .next()
            .await
            .ok_or(io::ErrorKind::UnexpectedEof)?
            .map_err(io::Error::other)?;
        let reply: Value = serde_json::from_str(&row)?;
        if reply["id"] != 1
            || reply["result"]["protocolVersion"] != 1
            || reply.pointer("/result/agentCapabilities/mcpCapabilities/http")
                != Some(&Value::Bool(true))
        {
            return Err(io::Error::other("agy must support ACP 1 with HTTP MCP"));
        }
        Ok(reply["result"].clone())
    };
    let initialized = match tokio::time::timeout(runtime::SETUP_TIMEOUT, initialize)
        .await
        .map_err(io::Error::other)
        .and_then(|r| r)
    {
        Ok(capabilities) => capabilities,
        Err(e) => {
            ready.write_all(format!("{e}\n").as_bytes()).await?;
            ready.flush().await?;
            child.terminate().await?;
            child.wait().await?;
            return Err(e);
        }
    };
    ready.write_all(b"ready\n").await?;
    ready.flush().await?;
    let (events, mut incoming) = mpsc::channel(16);
    let mut router = Router {
        routes: Default::default(),
        sessions: Default::default(),
        pending: Default::default(),
        next_id: 1,
        next_run: 1,
        events,
        initialized,
        writer: stdin,
        clients: JoinSet::new(),
    };
    let mut retiring = false;
    let mut draining = false;
    let pump: io::Result<()> = async {
        loop {
            if retiring && router.routes.values().all(|route| route.expired) {
                break;
            }
            tokio::select! {
                row = registrations.next_line(), if !retiring => match row? {
                    Some(row) => router.connect(serde_json::from_str(&row)?).await?,
                    None => retiring = true,
                },
                event = incoming.recv() => match event.expect("router owns sender") {
                    Event::Frame(run, row) => router.input(run, row).await?,
                    Event::Detached(run) => router.detach(run).await?,
                    Event::CloseExpired(run) => {
                        if let Some(route) = router.routes.get_mut(&run) {
                            route.expired = true;
                            if !retiring && !draining {
                                // EOF from a dead Host also retires admissions.
                                draining = true;
                                if ready.write_all(b"draining\n").await.is_ok() {
                                    let _ = ready.flush().await;
                                }
                            }
                        }
                    }
                },
                row = output.next() => match row {
                    Some(row) => {
                        let row = row.map_err(io::Error::other)?;
                        router.response(serde_json::from_str(&row)?, true).await?;
                    }
                    None => break,
                },
                Some(task) = router.clients.join_next(), if !router.clients.is_empty() => {
                    task.map_err(io::Error::other)?;
                }
            }
        }
        Ok(())
    }
    .await;
    child.terminate().await?;
    child.wait().await?;
    drop(incoming);
    // A final prompt reply can still be in the pipe after the group exits.
    while let Some(row) = output.next().await {
        let row = row.map_err(io::Error::other)?;
        router.response(serde_json::from_str(&row)?, false).await?;
    }
    let mut result = pump;
    for (_, route) in router.routes {
        if let Err(error) = route.spool.seal().await {
            result = Err(error);
        }
    }
    while let Some(task) = router.clients.join_next().await {
        task.map_err(io::Error::other)?;
    }
    diagnostics.await.map_err(io::Error::other)??;
    result
}
