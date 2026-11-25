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
use std::{sync::Arc, time::Duration};
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
        Err(error) => {
            host.remote_access_error(error);
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
                Some(path) => Some(tokio::fs::read(path).await?),
                None => None,
            };
            relays.push(Relay::new(&relay.endpoint, ca, relay.auth_token)?);
        }
        HostPeerTransport::bind(host, &relays, config.relay_only).await
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
        Ok(true) => transport.serve(ingress, cancel, |_, _| {}).await,
        result => {
            transport.close().await;
            result.map(|_| ())
        }
    }
}
