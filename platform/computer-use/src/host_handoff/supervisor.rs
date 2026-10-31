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

use super::{STARTUP, failed, process, transaction::Registration};
use cua_driver_core::browser::{
    discover_installed_extension_endpoints,
    host_handoff::{
        ConfiguredHandoff,
        transport::{Connection, Listener, Message},
    },
};
use maka_agent_facts::tools::ToolError;
use std::{collections::HashMap, time::Duration};
use tokio::{
    sync::watch,
    task::{Id, JoinSet},
};

async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, ToolError> + Send + 'static,
) -> Result<T, ToolError> {
    tokio::task::spawn_blocking(work).await.map_err(failed)?
}

/// Called by native hosts after losing their guardian, without acquiring a user lease.
pub(super) async fn recover(config: ConfiguredHandoff) -> Result<(), ToolError> {
    let Some(transaction) = Registration::open(config.recovery_directory()).await? else {
        return Err(failed(
            "browser handoff is still owned by a live supervisor",
        ));
    };
    cleanup(&config, &transaction, Vec::new()).await
}

pub(super) async fn run(config: ConfiguredHandoff) -> Result<(), ToolError> {
    let Some(transaction) = Registration::open(config.recovery_directory()).await? else {
        return Ok(());
    };
    // Retire receipts from previous executables before publishing a new generation.
    cleanup(&config, &transaction, Vec::new()).await?;
    let mut listener = Listener::bind(&config.recovery_directory())
        .await
        .map_err(failed)?;
    let mut natives = Vec::new();
    let result = serve(&config, &mut listener, &transaction, &mut natives).await;
    let directory = config.recovery_directory();
    let closed = blocking(move || listener.close(&directory).map_err(failed)).await;
    let restored = cleanup(&config, &transaction, natives).await;
    let cleanup = closed.and(restored);
    match result {
        Ok(Some(mut connection)) => {
            let message = match &cleanup {
                Ok(()) => Message::Released { users: 0 },
                Err(error) => Message::Failed {
                    message: error.to_string(),
                },
            };
            connection.send(&message).await.map_err(failed)?;
            cleanup
        }
        Ok(None) => cleanup,
        Err(error) => match cleanup {
            Ok(()) => Err(error),
            Err(cleanup) => Err(failed(format!(
                "{error}; browser handoff cleanup: {cleanup}"
            ))),
        },
    }
}

struct Native {
    host: process::HostProcess,
    connection: Connection,
}

async fn cleanup(
    config: &ConfiguredHandoff,
    transaction: &Registration,
    mut natives: Vec<Native>,
) -> Result<(), ToolError> {
    // The transaction lock stays held through host exit and descriptor retirement.
    let mut errors = Vec::new();
    let config_copy = config.clone();
    let hosts = match blocking(move || config_copy.native_hosts().map_err(failed)).await {
        Ok(hosts) => hosts,
        Err(error) => {
            errors.push(error.to_string());
            Vec::new()
        }
    };
    if let Err(error) = transaction.restore().await {
        errors.push(error.to_string());
    }
    for native in &mut natives {
        // EOF also terminates the native, but StopNative avoids starting recovery.
        let _ = native.connection.send(&Message::StopNative).await;
    }
    let stopped = hosts.clone();
    if let Err(error) = blocking(move || {
        let mut errors = Vec::new();
        for host in &stopped {
            if let Err(error) = process::stop(host) {
                errors.push(error.to_string());
            }
        }
        if errors.is_empty() {
            Ok(())
        } else {
            Err(failed(errors.join("; ")))
        }
    })
    .await
    {
        errors.push(error.to_string());
    }
    if let Err(error) = wait_for_exit(hosts).await {
        errors.push(error.to_string());
    }
    if let Err(error) = retire_dead_endpoints(config.extension_id()).await {
        errors.push(error.to_string());
    }
    if errors.is_empty() {
        let config = config.clone();
        blocking(move || config.remember_native_hosts(&[]).map_err(failed)).await
    } else {
        Err(failed(errors.join("; ")))
    }
}

async fn wait_for_exit(hosts: Vec<process::HostProcess>) -> Result<(), ToolError> {
    tokio::time::timeout(STARTUP, async {
        loop {
            let observed = hosts.clone();
            if blocking(move || {
                for host in &observed {
                    if process::is_alive(host)? {
                        return Ok(false);
                    }
                }
                Ok(true)
            })
            .await?
            {
                return Ok(());
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    })
    .await
    .map_err(failed)?
}

async fn serve(
    config: &ConfiguredHandoff,
    listener: &mut Listener,
    transaction: &Registration,
    natives: &mut Vec<Native>,
) -> Result<Option<Connection>, ToolError> {
    let mut first = tokio::time::timeout(STARTUP, listener.accept())
        .await
        .map_err(failed)?
        .map_err(failed)?;
    let owner = match tokio::time::timeout(STARTUP, first.receive())
        .await
        .map_err(failed)?
        .map_err(failed)?
    {
        Some(Message::Acquire {
            owner,
            extension_id,
        }) if extension_id == config.extension_id() => owner,
        _ => return Err(failed("browser handoff requires an acquire request")),
    };
    let setup_config = config.clone();
    let (plan, originals) = blocking(move || {
        let plan = setup_config.prepare().map_err(failed)?;
        let origin = format!("chrome-extension://{}/", setup_config.extension_id());
        let hosts = process::find(&plan.original.executable, &origin, setup_config.browser())?;
        setup_config.remember_selection().map_err(failed)?;
        setup_config
            .remember_original(&plan.original)
            .map_err(failed)?;
        Ok((plan, hosts))
    })
    .await?;
    transaction.publish(plan).await.map_err(failed)?;
    let stopped = originals.clone();
    blocking(move || {
        for host in &stopped {
            process::stop(host)?;
        }
        Ok(())
    })
    .await?;

    let (ready, readiness) = watch::channel(false);
    let mut users = JoinSet::new();
    let mut owners = HashMap::<Id, (uuid::Uuid, tokio::task::AbortHandle)>::new();
    let task = users.spawn(hold(first, readiness.clone()));
    owners.insert(task.id(), (owner, task));
    let mut greetings = JoinSet::new();
    let mut ticks = tokio::time::interval(Duration::from_millis(25));
    let mut deadline = tokio::time::Instant::now() + STARTUP;
    loop {
        tokio::select! {
            accepted = listener.accept() => {
                let mut connection = accepted.map_err(failed)?;
                greetings.spawn(async move {
                    let message = tokio::time::timeout(STARTUP, connection.receive()).await.map_err(failed)?.map_err(failed)?;
                    Ok::<_, ToolError>((connection, message))
                });
            }
            greeting = greetings.join_next(), if !greetings.is_empty() => {
                let (mut connection, message) = match greeting {
                    Some(Ok(Ok(greeting))) => greeting,
                    Some(Ok(Err(error))) => { eprintln!("Maka browser handoff connection: {error}"); continue; }
                    Some(Err(error)) => { eprintln!("Maka browser handoff connection task: {error}"); continue; }
                    None => continue,
                };
                match message {
                    Some(Message::Acquire { owner, extension_id }) => {
                        if extension_id != config.extension_id() {
                            let _ = connection.send(&Message::Failed { message: "another extension is using this browser host; release it before selecting a different extension".into() }).await;
                            continue;
                        }
                        // Readiness proves current admitted native custody, not a
                        // historical endpoint that may have exited between users.
                        if *ready.borrow() {
                            ready.send_replace(false);
                            deadline = tokio::time::Instant::now() + STARTUP;
                        }
                        let task = users.spawn(hold(connection, readiness.clone()));
                        owners.insert(task.id(), (owner, task));
                    }
                    Some(Message::Native { pid }) => {
                        let selected = config.clone();
                        let recorded = natives.iter().map(|native| native.host.clone()).collect::<Vec<_>>();
                        let host = blocking(move || {
                            let origin = format!("chrome-extension://{}/", selected.extension_id());
                            process::find(selected.executable(), &origin, selected.browser())?.into_iter()
                                .find(|host| host.pid == pid).ok_or_else(|| failed("native host is not the selected browser child"))
                        }).await;
                        let host = match host {
                            Ok(host) => host,
                            Err(error) => {
                                let _ = connection.send(&Message::Failed { message: error.to_string() }).await;
                                continue;
                            }
                        };
                        let selected = config.clone();
                        let (host, retained) = blocking(move || {
                            let mut retained = Vec::new();
                            for previous in recorded { if process::is_alive(&previous)? { retained.push(previous); } }
                            retained.push(host.clone());
                            selected.remember_native_hosts(&retained).map_err(failed)?;
                            Ok((host, retained))
                        }).await?;
                        natives.retain(|native| retained.iter().any(|host| host.pid == native.host.pid && host.identity == native.host.identity));
                        // Custody is durable even if the acknowledgement or adapter startup fails.
                        if let Err(error) = connection.send(&Message::NativeReady).await {
                            eprintln!("Maka browser native admission acknowledgement: {error}");
                        }
                        natives.push(Native { host, connection });
                    }
                    Some(Message::ReleaseOwner { owner }) => {
                        // Retrying cleanup removes only this runtime owner's lease.
                        owners.retain(|_, (current, task)| {
                            if *current == owner { task.abort(); false } else { true }
                        });
                        if owners.is_empty() { return Ok(Some(connection)); }
                        if let Err(error) = connection.send(&Message::Released { users: owners.len() }).await {
                            eprintln!("Maka browser handoff acknowledgement: {error}");
                        }
                    }
                    _ => {},
                }
            }
            joined = users.join_next_with_id(), if !users.is_empty() => {
                let (id, result) = match joined {
                    Some(Ok((id, result))) => (id, result),
                    Some(Err(error)) if error.is_cancelled() => { owners.remove(&error.id()); continue; }
                    Some(Err(error)) => {
                        owners.remove(&error.id());
                        eprintln!("Maka browser handoff user task: {error}");
                        if owners.is_empty() { return Ok(None); }
                        continue;
                    },
                    None => continue,
                };
                owners.remove(&id);
                let result = match result {
                    Ok(connection) => connection,
                    Err(error) => { eprintln!("Maka browser handoff user: {error}"); None }
                };
                if owners.is_empty() { return Ok(result); }
                if let Some(mut connection) = result
                    && let Err(error) = connection.send(&Message::Released { users: owners.len() }).await
                {
                    eprintln!("Maka browser handoff release acknowledgement: {error}");
                }
            }
            _ = ticks.tick(), if !*ready.borrow() => {
                if tokio::time::Instant::now() >= deadline { return Err(failed("browser handoff did not become ready before the startup deadline")); }
                let old = originals.clone();
                let new = natives.iter().map(|native| native.host.clone()).collect::<Vec<_>>();
                let current = blocking(move || {
                    for host in &old { if process::is_alive(host)? { return Ok(Vec::new()); } }
                    let mut current = Vec::new();
                    for host in new { if process::is_alive(&host)? { current.push(host.pid); } }
                    Ok(current)
                }).await?;
                if current.is_empty() { continue; }
                let discovered = discover_installed_extension_endpoints().await.map_err(failed)?;
                for endpoint in discovered.endpoints {
                    if endpoint.identity().extension_id == config.extension_id()
                        && current.contains(&endpoint.identity().host_pid)
                        && endpoint.connect().await.is_ok() {
                        ready.send_replace(true);
                        break;
                    }
                }
            }
        }
    }
}

async fn hold(
    mut connection: Connection,
    mut ready: watch::Receiver<bool>,
) -> Result<Option<Connection>, ToolError> {
    while !*ready.borrow_and_update() {
        tokio::select! {
            changed = ready.changed() => changed.map_err(failed)?,
            message = connection.receive() => return match message.map_err(failed)? {
                None => Ok(None),
                Some(Message::Release) => Ok(Some(connection)),
                _ => Err(failed("unexpected browser handoff message before readiness")),
            },
        }
    }
    connection.send(&Message::Ready).await.map_err(failed)?;
    match connection.receive().await.map_err(failed)? {
        Some(Message::Release) => Ok(Some(connection)),
        None => Ok(None),
        _ => Err(failed("unexpected browser handoff user message")),
    }
}

async fn retire_dead_endpoints(extension_id: &str) -> Result<(), ToolError> {
    let discovered = discover_installed_extension_endpoints()
        .await
        .map_err(failed)?;
    let endpoints: Vec<_> = discovered
        .endpoints
        .into_iter()
        .filter(|endpoint| endpoint.identity().extension_id == extension_id)
        .collect();
    blocking(move || {
        for endpoint in endpoints {
            if crate::identity::live_process(endpoint.identity().host_pid)?.is_none() {
                endpoint.cleanup_after_host_exit().map_err(failed)?;
            }
        }
        Ok(())
    })
    .await
}
