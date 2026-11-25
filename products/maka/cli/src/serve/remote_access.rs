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

use maka_host_runtime::{
    HostError,
    application::host::{
        AuthenticatedPeerStream, Host,
        remote_access::{ApplyRemoteAccess, RemoteTransport},
    },
};
use maka_remote_transport::{Relay, host::HostPeerTransport};
use std::{
    fs::OpenOptions,
    io::Read,
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};
use tokio::{sync::mpsc, task::JoinHandle};
use tokio_util::sync::CancellationToken;

pub(super) async fn supervise(
    host: &Arc<Host>,
    ingress: mpsc::Sender<AuthenticatedPeerStream>,
    mut updates: mpsc::Receiver<ApplyRemoteAccess>,
    stop: CancellationToken,
) -> Result<(), HostError> {
    let mut transport = start(host, &ingress, &stop).await;
    loop {
        let command = tokio::select! {
            biased;
            () = stop.cancelled() => break,
            () = ingress.closed() => break,
            command = updates.recv() => command.expect("Host owns the update sender"),
        };
        let result = host.save_remote_access(command.update).await;
        if result.is_ok() {
            if let Some(running) = transport.take() {
                running.stop().await?;
            }
            transport = start(host, &ingress, &stop).await;
        }
        // The caller can disconnect while the accepted update is being applied.
        let _ = command.reply.send(result);
    }
    drop(updates);
    if let Some(running) = transport {
        running.stop().await?;
    }
    host.remote_access_reset(false, false);
    Ok(())
}

async fn start(
    host: &Arc<Host>,
    ingress: &mpsc::Sender<AuthenticatedPeerStream>,
    stop: &CancellationToken,
) -> Option<Running> {
    let config = match host.remote_transport_config().await {
        Ok(config) => config,
        Err(_) => {
            host.remote_access_error("could not read remote access configuration".into());
            return None;
        }
    };
    host.remote_access_reset(config.enabled, false);
    if !config.enabled {
        return None;
    }
    let cancel = stop.child_token();
    let task = tokio::spawn({
        let cancel = cancel.clone();
        let ingress = ingress.clone();
        let host = host.clone();
        async move {
            if let Err(error) = run(&host, config, ingress, cancel).await {
                host.remote_access_error(error.to_string());
            }
        }
    });
    Some(Running { cancel, task })
}

struct Running {
    cancel: CancellationToken,
    task: JoinHandle<()>,
}

impl Running {
    async fn stop(self) -> Result<(), HostError> {
        self.cancel.cancel();
        Ok(self.task.await?)
    }
}

async fn run(
    host: &Arc<Host>,
    config: RemoteTransport,
    ingress: mpsc::Sender<AuthenticatedPeerStream>,
    cancel: CancellationToken,
) -> Result<(), HostError> {
    let bind = async {
        let mut relays = Vec::with_capacity(config.relays.len());
        for relay in config.relays {
            let ca = match relay.ca_der_path {
                Some(path) => Some(read_ca(path).await?),
                None => None,
            };
            relays.push(Relay::new(&relay.endpoint, ca, relay.auth_token).map_err(
                |_| "invalid relay configuration; check the URL, TLS trust and Bearer settings",
            )?);
        }
        HostPeerTransport::bind(host, &relays, config.relay_only)
            .await
            .map_err(|_| -> HostError {
                "could not start relay transport; check relay configuration and local networking"
                    .into()
            })
    };
    let transport = tokio::select! {
        biased;
        () = cancel.cancelled() => return Ok(()),
        () = ingress.closed() => return Ok(()),
        result = bind => result?,
    };
    let result = tokio::select! {
        biased;
        () = cancel.cancelled() => Ok(false),
        () = ingress.closed() => Ok(false),
        result = tokio::time::timeout(Duration::from_secs(30), transport.wait_for_relay()) => {
            match result {
                Ok(result) => result.map(|_| true),
                Err(_) => Err("timed out waiting for a relay connection".into()),
            }
        }
    };
    match result {
        Ok(true) => transport
            .serve(ingress, cancel, |_, _| {})
            .await
            .map_err(|_| "relay transport stopped unexpectedly".into()),
        result => {
            transport.close().await;
            result.map(|_| ())
        }
    }
}

pub(super) async fn read_ca(path: PathBuf) -> Result<Vec<u8>, HostError> {
    tokio::task::spawn_blocking(move || read_ca_file(&path))
        .await
        .map_err(|_| "could not read relay CA certificate")?
        .map_err(Into::into)
}

const MAX_CA_BYTES: u64 = 64 * 1024;

fn read_ca_file(path: &Path) -> Result<Vec<u8>, &'static str> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.custom_flags(libc::O_NONBLOCK);
    }
    let check = |metadata: std::fs::Metadata| {
        if !metadata.is_file() {
            Err("relay CA certificate must be a regular file")
        } else if metadata.len() > MAX_CA_BYTES {
            Err("relay CA certificate exceeds 64 KiB")
        } else {
            Ok(())
        }
    };
    const READ_ERROR: &str = "could not read relay CA certificate";
    check(path.metadata().map_err(|_| READ_ERROR)?)?;
    let file = options.open(path).map_err(|_| READ_ERROR)?;
    check(file.metadata().map_err(|_| READ_ERROR)?)?;
    let mut data = Vec::new();
    file.take(MAX_CA_BYTES + 1)
        .read_to_end(&mut data)
        .map_err(|_| READ_ERROR)?;
    if data.len() as u64 > MAX_CA_BYTES {
        return Err("relay CA certificate exceeds 64 KiB");
    }
    Ok(data)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn relay_ca_read_accepts_regular_files_and_caps_the_size() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("relay.der");
        std::fs::write(&path, vec![42; MAX_CA_BYTES as usize]).unwrap();
        assert_eq!(read_ca_file(&path).unwrap().len() as u64, MAX_CA_BYTES);
        std::fs::OpenOptions::new()
            .write(true)
            .open(&path)
            .unwrap()
            .set_len(MAX_CA_BYTES + 1)
            .unwrap();
        assert_eq!(
            read_ca_file(&path).unwrap_err(),
            "relay CA certificate exceeds 64 KiB"
        );
        assert_eq!(
            read_ca_file(dir.path()).unwrap_err(),
            "relay CA certificate must be a regular file"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn relay_ca_read_rejects_fifo_without_waiting_for_a_writer() {
        use std::{ffi::CString, os::unix::ffi::OsStrExt as _};
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("pipe");
        let name = CString::new(path.as_os_str().as_bytes()).unwrap();
        // SAFETY: name is valid NUL-terminated storage inside the test directory.
        assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
        let error = tokio::time::timeout(Duration::from_secs(2), read_ca(path))
            .await
            .unwrap()
            .unwrap_err();
        assert_eq!(
            error.to_string(),
            "relay CA certificate must be a regular file"
        );
    }
}
