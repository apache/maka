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

use serde::{Serialize, de::DeserializeOwned};
use std::{
    error::Error,
    path::Path,
    process::{ExitStatus, Stdio},
    time::Duration,
};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
    process::{Child, Command},
};

pub type Result<T> = std::result::Result<T, Box<dyn Error + Send + Sync>>;
const CONTROL: &str = "MAKA_DURABLE_RECOVERY_CONTROL";
const MAX_FRAME: usize = 16 * 1024 * 1024;

pub struct Channel(TcpStream);
/// Only for a closed, disposable fixture. Callers first kill+join every Host.
/// Restore SQLite bytes in place, never Root markers, directories or leases.
pub struct FrozenDatabase {
    root: std::path::PathBuf,
    files: Vec<(std::path::PathBuf, Option<Vec<u8>>)>,
    markers: Vec<(std::path::PathBuf, Vec<u8>)>,
}
impl FrozenDatabase {
    pub async fn capture(directory: &Path) -> Result<Self> {
        use maka_event_log::root::{ROOT_DATABASE, ROOT_MARKER, RUST_ROOT_MARKER};
        let root = directory.join("root");
        let mut files = Vec::new();
        for suffix in ["", "-wal", "-shm", "-journal"] {
            let path = root.join(format!("{ROOT_DATABASE}{suffix}"));
            let bytes = match tokio::fs::read(&path).await {
                Ok(bytes) => Some(bytes),
                Err(error)
                    if error.kind() == std::io::ErrorKind::NotFound && !suffix.is_empty() =>
                {
                    None
                }
                Err(error) => return Err(error.into()),
            };
            files.push((path, bytes));
        }
        let mut markers = Vec::new();
        for name in [ROOT_MARKER, RUST_ROOT_MARKER] {
            let path = root.join(name);
            markers.push((path.clone(), tokio::fs::read(path).await?));
        }
        Ok(Self {
            root,
            files,
            markers,
        })
    }
    pub async fn restore(&self) -> Result<()> {
        assert!(tokio::fs::metadata(&self.root).await?.is_dir());
        for (path, bytes) in &self.markers {
            assert_eq!(&tokio::fs::read(path).await?, bytes);
        }
        for (path, bytes) in &self.files {
            let mut file = match tokio::fs::OpenOptions::new()
                .write(true)
                .truncate(true)
                .open(path)
                .await
            {
                Ok(file) => file,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound && bytes.is_none() => {
                    continue;
                }
                Err(error) => return Err(error.into()),
            };
            if let Some(bytes) = bytes {
                file.write_all(bytes).await?;
            }
            file.sync_all().await?;
            let expected = bytes.as_deref().unwrap_or_default();
            assert_eq!(tokio::fs::read(path).await?, expected);
        }
        for (path, bytes) in &self.markers {
            assert_eq!(&tokio::fs::read(path).await?, bytes);
        }
        Ok(())
    }
}
impl Channel {
    pub async fn send<T: Serialize>(&mut self, value: &T) -> Result<()> {
        let bytes = serde_json::to_vec(value)?;
        if bytes.len() > MAX_FRAME {
            return Err("cold Host control frame exceeds its byte budget".into());
        }
        self.0.write_u32(bytes.len() as u32).await?;
        self.0.write_all(&bytes).await?;
        Ok(())
    }

    pub async fn receive<T: DeserializeOwned>(&mut self) -> Result<T> {
        let length = self.0.read_u32().await? as usize;
        if length > MAX_FRAME {
            return Err("cold Host control frame exceeds its byte budget".into());
        }
        let mut bytes = vec![0; length];
        self.0.read_exact(&mut bytes).await?;
        Ok(serde_json::from_slice(&bytes)?)
    }
}

/// Only the exact libtest worker consumes this channel. The NativeFixture still
/// locates the real profile/maka executable for Native TaskOwner helpers.
pub async fn worker_channel() -> Result<Option<Channel>> {
    let address = match std::env::var(CONTROL) {
        Ok(address) => address,
        Err(std::env::VarError::NotPresent) => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    let mut channel = Channel(TcpStream::connect(address).await?);
    channel.send(&std::process::id()).await?;
    Ok(Some(channel))
}

pub struct ColdHost {
    child: HostProcess,
    channel: Channel,
}
enum HostProcess {
    Single(Child),
    Owned(OwnedTree),
}
struct Drain {
    label: &'static str,
    task: tokio::task::JoinHandle<std::io::Result<Vec<u8>>>,
    result: Option<std::result::Result<Vec<u8>, String>>,
}
impl Drain {
    fn start(label: &'static str, mut stream: impl AsyncRead + Unpin + Send + 'static) -> Self {
        let task = tokio::spawn(async move {
            const BUDGET: usize = 32 * 1024;
            let mut tail = Vec::new();
            let mut buffer = [0; 8192];
            loop {
                let read = stream.read(&mut buffer).await?;
                if read == 0 {
                    break;
                }
                let excess = (tail.len() + read).saturating_sub(BUDGET);
                if excess > 0 {
                    tail.drain(..excess);
                }
                tail.extend_from_slice(&buffer[..read]);
            }
            Ok(tail)
        });
        Self {
            label,
            task,
            result: None,
        }
    }
    async fn finish(&mut self) -> std::io::Result<()> {
        if self.result.is_none() {
            self.result = Some(
                (&mut self.task)
                    .await
                    .map_err(|error| error.to_string())
                    .and_then(|result| result.map_err(|error| error.to_string())),
            );
            if let Some(Ok(bytes)) = &self.result
                && !bytes.is_empty()
            {
                eprintln!(
                    "owned cold Host {} tail (32 KiB): {}",
                    self.label,
                    String::from_utf8_lossy(bytes)
                );
            }
        }
        match self.result.as_ref().unwrap() {
            Ok(_) => Ok(()),
            Err(error) => Err(std::io::Error::other(error.clone())),
        }
    }
    fn text(&self) -> String {
        match &self.result {
            Some(Ok(bytes)) => String::from_utf8_lossy(bytes).into_owned(),
            Some(Err(error)) => format!("diagnostic pipe failed: {error}"),
            None => "diagnostic pipe has not reached EOF".into(),
        }
    }
}
struct OwnedTree {
    child: maka_process::pipe::Child,
    stdout: Drain,
    stderr: Drain,
    status: Option<ExitStatus>,
}
impl OwnedTree {
    async fn wait(&mut self) -> std::io::Result<ExitStatus> {
        if self.status.is_none() {
            self.status = Some(self.child.wait().await?);
        }
        self.stdout.finish().await?;
        self.stderr.finish().await?;
        Ok(self.status.unwrap())
    }
    async fn terminate(&mut self) -> std::io::Result<()> {
        if self.status.is_none() {
            self.child.terminate().await?;
        }
        Ok(())
    }
}
impl HostProcess {
    fn id(&self) -> Option<u32> {
        match self {
            Self::Single(child) => child.id(),
            Self::Owned(tree) => Some(tree.child.id()),
        }
    }
    async fn wait(&mut self) -> std::io::Result<ExitStatus> {
        match self {
            Self::Single(child) => child.wait().await,
            Self::Owned(tree) => tree.wait().await,
        }
    }
    async fn wait_terminated(&mut self) -> std::io::Result<ExitStatus> {
        match self {
            Self::Single(child) => child.wait().await,
            Self::Owned(tree) => tokio::time::timeout(Duration::from_secs(15), tree.wait())
                .await
                .map_err(|_| {
                    std::io::Error::other("owned cold Host tree/diagnostic EOF remains unconfirmed")
                })?,
        }
    }
    fn diagnostics(&self) -> String {
        match self {
            Self::Single(_) => String::new(),
            Self::Owned(tree) => format!(
                "\nstdout tail (32 KiB): {}\nstderr tail (32 KiB): {}",
                tree.stdout.text(),
                tree.stderr.text()
            ),
        }
    }
}
impl ColdHost {
    pub async fn spawn<T: Serialize>(input: &T) -> Result<Self> {
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let mut child = Command::new(std::env::current_exe()?)
            .args([
                "--exact",
                "cold_host_worker",
                "--nocapture",
                "--test-threads=1",
            ])
            .env(CONTROL, listener.local_addr()?.to_string())
            .stdin(Stdio::null())
            .stdout(Stdio::inherit())
            .stderr(Stdio::inherit())
            .kill_on_drop(true)
            .spawn()?;
        let (stream, _) = tokio::select! {
            socket = listener.accept() => socket?,
            status = child.wait() => return Err(format!("cold Host exited before control connection: {:?}", status?).into()),
        };
        let mut channel = Channel(stream);
        let pid: u32 = channel.receive().await?;
        assert_eq!(Some(pid), child.id());
        assert_ne!(
            pid,
            std::process::id(),
            "the Host must have a separate address space"
        );
        channel.send(input).await?;
        Ok(Self {
            child: HostProcess::Single(child),
            channel,
        })
    }

    /// Python has a separate real worker. Own its original native group/Job
    /// from spawn; serialized VM identities never authorize signalling a PID.
    pub async fn spawn_owned<T: Serialize>(input: &T, cwd: &Path) -> Result<Self> {
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let mut command = maka_process::Command::new(std::env::current_exe()?, cwd);
        command.args([
            "--exact",
            "cold_host_worker",
            "--nocapture",
            "--test-threads=1",
        ]);
        command.env(CONTROL, listener.local_addr()?.to_string());
        let spawned = maka_process::pipe::spawn(command).await?;
        drop(spawned.stdin);
        let mut tree = OwnedTree {
            child: spawned.child,
            stdout: Drain::start("stdout", spawned.stdout),
            stderr: Drain::start("stderr", spawned.stderr),
            status: None,
        };
        let connected = tokio::select! {
            socket = listener.accept() => socket.map(|(stream, _)| stream),
            status = tree.wait() => Err(std::io::Error::other(format!("owned cold Host exited before connection: {:?}\n{}\n{}", status?, tree.stdout.text(), tree.stderr.text()))),
        };
        let initialize = async {
            let mut channel = Channel(connected?);
            let pid: u32 = channel.receive().await?;
            assert_eq!(pid, tree.child.id());
            assert_ne!(pid, std::process::id());
            channel.send(input).await?;
            Ok::<_, Box<dyn Error + Send + Sync>>(channel)
        }
        .await;
        match initialize {
            Ok(channel) => Ok(Self {
                child: HostProcess::Owned(tree),
                channel,
            }),
            Err(error) => {
                tree.terminate().await?;
                tokio::time::timeout(Duration::from_secs(15), tree.wait()).await
                    .map_err(|_| "failed Python Host initialization did not settle its original native tree")??;
                Err(error)
            }
        }
    }

    pub fn id(&self) -> Option<u32> {
        self.child.id()
    }

    pub async fn receive<T: DeserializeOwned>(&mut self) -> Result<T> {
        tokio::select! {
            event = self.channel.receive() => event,
            status = self.child.wait() => Err(format!("cold Host exited before its evidence: {:?}{}", status?, self.child.diagnostics()).into()),
        }
    }

    pub async fn send<T: Serialize>(&mut self, value: &T) -> Result<()> {
        self.channel.send(value).await
    }

    /// Tokio delegates to the OS's forcible Child kill, on Windows as well as
    /// Unix. Drop also kills an outstanding worker if the parent deadline fires.
    pub async fn kill(&mut self) -> Result<()> {
        match &mut self.child {
            HostProcess::Single(child) => child.kill().await?,
            HostProcess::Owned(tree) => tree.terminate().await?,
        }
        let status = self.child.wait_terminated().await?;
        assert!(
            !status.success(),
            "the first Host must not shut down gracefully"
        );
        #[cfg(unix)]
        {
            use std::os::unix::process::ExitStatusExt;
            assert_eq!(status.signal(), Some(libc::SIGKILL));
        }
        Ok(())
    }

    pub async fn finish(&mut self) -> Result<()> {
        self.channel.send(&()).await?;
        let status = self.child.wait().await?;
        if !status.success() {
            return Err(format!(
                "recovered Host failed: {status}{}",
                self.child.diagnostics()
            )
            .into());
        }
        Ok(())
    }

    pub async fn terminate(&mut self) -> Result<()> {
        match &mut self.child {
            HostProcess::Single(child) => {
                if child.try_wait()?.is_none() {
                    child.kill().await?;
                }
            }
            HostProcess::Owned(tree) => tree.terminate().await?,
        }
        self.child.wait_terminated().await?;
        Ok(())
    }
}
