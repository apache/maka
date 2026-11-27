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

//! One stdio ACP front per resolved command in this activation. A private
//! supervisor owns its group and the original transcripts across Host loss.
use super::*;
use maka_host_runtime::ipc::{LocalListener, LocalStream};
use maka_process::isolated::{Descriptor, TaskOwner};
use std::{io, path::Path, process::Stdio};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::ChildStdin,
    sync::Mutex,
    task::JoinSet,
};
mod router;
pub use router::serve_front;
pub const FRONT_HELPER: &str = "--maka-agy-acp-front";

#[derive(Serialize, Deserialize)]
struct Launch {
    executable: PathBuf,
    args: Vec<String>,
    env: BTreeMap<String, String>,
}

#[derive(Serialize, Deserialize)]
struct Connect {
    socket: PathBuf,
    resource: Descriptor,
}

#[derive(Default)]
pub(super) struct Fronts(Mutex<Pool>);
#[derive(Default)]
struct Pool {
    fronts: BTreeMap<PathBuf, Front>,
    supervisors: JoinSet<io::Result<()>>,
}
#[derive(Clone)]
struct Front {
    #[cfg(windows)]
    pid: u32,
    ready: futures_util::future::Shared<BoxFuture<'static, Result<(), String>>>,
    registrations: tokio::sync::mpsc::UnboundedSender<Vec<u8>>,
    retire: CancellationToken,
    exited: CancellationToken,
}
pub(super) struct Lease {
    pub socket: LocalStream,
    pub exited: CancellationToken,
}
impl Fronts {
    pub(super) async fn open(
        &self,
        config: &NativeCommand,
        cwd: &str,
        owner: &mut Option<TaskOwner>,
    ) -> Result<Lease, Error> {
        let resolved = runtime::resolve(config, cwd).await.require()?.executable;
        let task = owner.as_ref().expect("unregistered Run");
        #[cfg(unix)]
        let dir = tempfile::Builder::new()
            .prefix("maka-acp-")
            .permissions(std::os::unix::fs::PermissionsExt::from_mode(0o700))
            .tempdir_in("/tmp")
            .map_err(provider)?;
        #[cfg(unix)]
        let socket = dir.path().join("run");
        #[cfg(windows)]
        let socket = PathBuf::from(format!(r"\\.\pipe\maka-agy-{}", uuid::Uuid::new_v4()));
        let mut listener = LocalListener::bind(&socket).map_err(provider)?;
        let front = {
            let mut pool = self.0.lock().await;
            while let Some(result) = pool.supervisors.try_join_next() {
                if let Err(error) = result.map_err(io::Error::other).and_then(|r| r) {
                    tracing::warn!(%error,"agy ACP supervisor exited");
                }
            }
            if pool
                .fronts
                .get(&resolved)
                .is_none_or(|f| f.retire.is_cancelled() || f.exited.is_cancelled())
            {
                let launch = Launch {
                    executable: resolved.clone(),
                    args: config.args.clone(),
                    env: config.env.clone(),
                };
                let front = Front::start(task.helper_executable(), launch, &mut pool.supervisors)
                    .map_err(provider)?;
                pool.fronts.insert(resolved.clone(), front);
            }
            pool.fronts[&resolved].clone()
        };
        front.ready.clone().await.map_err(provider)?;
        let resource = task.prepare_session(resolved).await.map_err(provider)?;
        let registration = serde_json::to_vec(&Connect { socket, resource }).map_err(provider)?;
        front
            .registrations
            .send(registration)
            .map_err(|_| Error::Provider("agy ACP supervisor exited before admission".into()))?;
        owner.take();
        #[cfg_attr(not(windows), allow(clippy::never_loop))]
        let socket = loop {
            let socket = tokio::select! {
                connection = listener.accept() => connection.map_err(provider)?,
                () = front.exited.cancelled() => return Err(provider("agy ACP supervisor exited during admission")),
            };
            #[cfg(windows)]
            if socket.client_pid().map_err(provider)? != front.pid {
                continue;
            }
            break socket;
        };
        Ok(Lease {
            socket,
            exited: front.exited,
        })
    }
    pub(super) async fn finish(&self) -> Result<(), String> {
        let mut pool = self.0.lock().await;
        for (_, front) in std::mem::take(&mut pool.fronts) {
            front.retire.cancel();
        }
        let mut jobs = std::mem::take(&mut pool.supervisors);
        drop(pool);
        let mut result = Ok(());
        while let Some(job) = jobs.join_next().await {
            if let Err(error) = job.map_err(io::Error::other).and_then(|r| r) {
                result = Err(error.to_string());
            }
        }
        result
    }
}
pub(super) async fn wait_for_close(
    resource: &Descriptor,
    exited: CancellationToken,
) -> io::Result<()> {
    use maka_process::isolated::{EvidenceInterest, EvidenceWatch, cleanup_evidence};
    let mut watch = EvidenceWatch::open(resource, EvidenceInterest::Cleanup)
        .await
        .map_err(io::Error::other)?;
    let observed = tokio::select! {
        result = watch.wait() => result.map_err(io::Error::other),
        () = exited.cancelled() => match cleanup_evidence(resource).await.map_err(io::Error::other)? {
            Some(_) => Ok(()),
            None => Err(io::Error::other("agy ACP supervisor exited without a session closure receipt")),
        },
    };
    watch.close().await.map_err(io::Error::other)?;
    observed
}

fn provider(error: impl std::fmt::Display) -> Error {
    Error::Provider(error.to_string())
}

impl Front {
    fn start(
        helper: &Path,
        launch: Launch,
        jobs: &mut JoinSet<io::Result<()>>,
    ) -> io::Result<Self> {
        let mut command = tokio::process::Command::new(helper);
        #[cfg(windows)]
        command.creation_flags(windows_sys::Win32::System::Threading::CREATE_BREAKAWAY_FROM_JOB);
        let mut child = command
            .arg(FRONT_HELPER)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()?;
        #[cfg(windows)]
        let pid = child.id().expect("just spawned supervisor");
        let mut input: ChildStdin = child.stdin.take().unwrap();
        let mut status = BufReader::new(child.stdout.take().unwrap()).lines();
        let (send, mut receive) = tokio::sync::mpsc::unbounded_channel::<Vec<u8>>();
        let retire = CancellationToken::new();
        let stop = retire.clone();
        let exited = CancellationToken::new();
        let finished = exited.clone().drop_guard();
        let start = serde_json::to_vec(&launch)?;
        let (ready, initialized) = tokio::sync::oneshot::channel();
        jobs.spawn(async move {
            let _finished = finished;
            let write = async move {
                input.write_all(&start).await?;
                input.write_all(b"\n").await?;
                let first = status.next_line().await?;
                if first.as_deref() != Some("ready") {
                    let reason =
                        first.unwrap_or_else(|| "agy ACP supervisor exited during startup".into());
                    let _ = ready.send(Err(reason.clone()));
                    return Err(io::Error::other(reason));
                }
                let _ = ready.send(Ok(()));
                loop {
                    let registration = tokio::select! {
                        row = receive.recv() => row,
                        () = stop.cancelled() => break,
                        row = status.next_line() => {
                            if row?.as_deref() != Some("draining") {
                                return Err(io::Error::other("agy ACP supervisor disconnected"));
                            }
                            stop.cancel();
                            break;
                        }
                    };
                    let Some(row) = registration else {
                        break;
                    };
                    input.write_all(&row).await?;
                    input.write_all(b"\n").await?;
                }
                // All registrations accepted before retirement belong to this generation.
                receive.close();
                while let Some(row) = receive.recv().await {
                    input.write_all(&row).await?;
                    input.write_all(b"\n").await?;
                }
                Ok::<_, io::Error>(())
            };
            let status = tokio::select! {
                result = write => {
                    let status = child.wait().await?;
                    result?;
                    status
                }
                status = child.wait() => status?,
            };
            if status.success() {
                Ok(())
            } else {
                Err(io::Error::other(format!(
                    "agy ACP supervisor exited with {status}"
                )))
            }
        });
        let ready = async move {
            tokio::time::timeout(runtime::SETUP_TIMEOUT, initialized)
                .await
                .map_err(|error| error.to_string())?
                .map_err(|_| "agy ACP supervisor exited before initialization".to_owned())?
        }
        .boxed()
        .shared();
        Ok(Self {
            #[cfg(windows)]
            pid,
            ready,
            registrations: send,
            retire,
            exited,
        })
    }
}
