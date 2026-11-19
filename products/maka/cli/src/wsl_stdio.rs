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
    application::host::{Client, discovery},
    ipc,
};
use maka_wsl_bridge::{Ready, Server};
use std::{path::PathBuf, process::ExitCode, time::Duration};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    task::JoinSet,
};

pub(super) fn entry() -> ExitCode {
    let result = (|| -> Result<(), HostError> {
        let mut args = std::env::args_os().skip(2);
        let root = PathBuf::from(args.next().ok_or("WSL stdio helper needs a Root")?);
        if !root.is_absolute() || args.next().is_some() {
            return Err("WSL stdio helper needs exactly one absolute Root path".into());
        }
        let runtime = tokio::runtime::Runtime::new()?;
        let result = runtime.block_on(serve(root));
        // Tokio stdin's blocking read is not cancellable. This helper exits next.
        runtime.shutdown_background();
        result
    })();
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("WSL stdio helper: {error}");
            ExitCode::FAILURE
        }
    }
}

async fn serve(root: PathBuf) -> Result<(), HostError> {
    let startup = tokio::time::timeout(
        Duration::from_secs(90),
        crate::deployment::connect_local(root.clone()),
    )
    .await??;
    let discovery = discovery::read(&root)?;
    if discovery.host_epoch != startup.epoch() || &discovery.source != startup.source() {
        return Err("application Host changed during WSL startup".into());
    }
    discovery.verify(&Client::status(&discovery.endpoint, Some(startup.epoch())).await?)?;
    let ready = Ready {
        root: discovery.root_id,
        epoch: discovery.host_epoch,
    };
    let mut mux = Server::new(tokio::io::join(tokio::io::stdin(), tokio::io::stdout()));
    let mut bootstrap = tokio::time::timeout(Duration::from_secs(15), mux.accept())
        .await??
        .ok_or("WSL Desktop disconnected before admission")?;
    let handoff = async move {
        let mut startup = startup;
        if bootstrap.read_u8().await? != 0 {
            return Err("invalid WSL startup request".into());
        }
        ready.send(&mut bootstrap).await?;
        if bootstrap.read_u8().await? != 1 {
            return Err("invalid WSL residency handoff".into());
        }
        startup.close().await?;
        bootstrap.write_u8(1).await?;
        bootstrap.flush().await?;
        Ok::<_, HostError>(bootstrap)
    };
    let mut handoff = std::pin::pin!(tokio::time::timeout(Duration::from_secs(30), handoff));
    let mut starting = true;
    let mut lifetime = None;
    let (closed, mut anchor_closed) = tokio::sync::oneshot::channel();
    let mut closed = Some(closed);
    let mut watching = true;
    let mut channels = JoinSet::new();
    loop {
        tokio::select! {
            result = &mut handoff, if starting => {
                lifetime = Some(result??);
                starting = false;
            }
            _ = &mut anchor_closed, if watching => {
                if starting {
                    return Err("WSL Host anchor ended during admission".into());
                }
                // Signal anchor loss without cutting off another stream's quit reply.
                drop(lifetime.take());
                watching = false;
            }
            Some(result) = channels.join_next(), if !channels.is_empty() => {
                match result {
                    Ok(Ok(())) => {}
                    Ok(Err(error)) => eprintln!("WSL IPC channel: {error}"),
                    Err(error) => return Err(error.into()),
                }
            }
            stream = mux.accept() => {
                let Some(mut stream) = stream? else { break };
                if channels.len() >= 128 {
                    return Err("too many WSL IPC channels".into());
                }
                let endpoint = discovery.endpoint.clone();
                let closed = closed.take();
                channels.spawn(async move {
                    let mut local = ipc::connect(&endpoint).await?;
                    if let Some(closed) = closed {
                        let (mut from_host, mut to_host) = local.split();
                        let (mut from_desktop, mut to_desktop) = tokio::io::split(stream);
                        let to_host = async {
                            tokio::io::copy(&mut from_desktop, &mut to_host).await?;
                            to_host.shutdown().await
                        };
                        let to_desktop = async {
                            let result = async {
                                tokio::io::copy(&mut from_host, &mut to_desktop).await?;
                                to_desktop.shutdown().await
                            }.await;
                            let _ = closed.send(());
                            result
                        };
                        tokio::try_join!(to_host, to_desktop)?;
                    } else {
                        tokio::io::copy_bidirectional(&mut stream, &mut local).await?;
                    }
                    Ok::<(), HostError>(())
                });
            }
        }
    }
    channels.shutdown().await;
    Ok(())
}
