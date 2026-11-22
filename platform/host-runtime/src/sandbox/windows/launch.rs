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

use super::{
    Installation,
    guards::{self, Guards},
    policy, store,
};
use maka_process::bootstrap::{self, Preparation};
use maka_sandbox::{
    Network,
    filesystem::{Access, Policy, Rule},
    windows::{ExecutionJob, WriteCapability, mxc},
};
use std::{
    io,
    path::{Path, PathBuf},
    sync::Arc,
};

/// Captured Host installation and trusted bootstrap binary. Plugins receive
/// authorized process capabilities, never this provisioning authority.
#[derive(Clone)]
pub struct Backend {
    state_root: PathBuf,
    helper: PathBuf,
}

enum NativePreparation {
    Ready {
        filesystem: Policy,
        lease: bootstrap::MxcLease,
    },
    Unsupported(String),
}

impl Backend {
    pub fn new(state_root: &Path, helper: &Path) -> Self {
        Self {
            state_root: state_root.to_owned(),
            helper: helper.to_owned(),
        }
    }
}
impl bootstrap::Backend for Backend {
    fn prepare(
        &self,
        filesystem: Policy,
        network: Network,
        route: maka_network::Policy,
        executable: PathBuf,
        cwd: PathBuf,
    ) -> Preparation {
        let backend = self.clone();
        Box::pin(async move {
            let policy_executable = executable.clone();
            let policy_cwd = cwd.clone();
            let policy_network = network.clone();
            let (filesystem, native) = tokio::task::spawn_blocking(move || {
                let filesystem = filesystem
                    .compile()
                    .and_then(|policy| policy.process_snapshot())
                    .map_err(io::Error::other)?;
                let compiled = filesystem.compile().map_err(io::Error::other)?;
                if [&policy_executable, &policy_cwd]
                    .into_iter()
                    .any(|path| !compiled.access(path).can_read())
                {
                    return Err(io::Error::new(
                        io::ErrorKind::PermissionDenied,
                        "sandbox denies its working directory or executable",
                    ));
                }
                let native = prepare_native(
                    &filesystem,
                    &policy_network,
                    &policy_executable,
                    &policy_cwd,
                )?;
                Ok((filesystem, native))
            })
            .await
            .map_err(io::Error::other)??;
            let mxc_unsupported = match native {
                NativePreparation::Ready {
                    filesystem,
                    mut lease,
                } => {
                    // MXC owns isolation per command tree. Its proxy has no account
                    // slot or installation lifetime and remains with that same tree.
                    let (proxy_address, proxy) = if matches!(network, Network::Restricted { .. }) {
                        let (address, proxy) =
                            match maka_network::proxy::Proxy::start(network.clone(), route).await {
                                Ok(proxy) => proxy,
                                Err(error) => {
                                    lease.finish().await.map_err(cleanup_error)?;
                                    return Err(error);
                                }
                            };
                        (Some(address), Some(Arc::new(proxy)))
                    } else {
                        (None, None)
                    };
                    return Ok(bootstrap::Launch::Mxc {
                        executable: backend.helper,
                        filesystem,
                        network,
                        proxy,
                        proxy_address,
                        lease,
                    });
                }
                NativePreparation::Unsupported(reason) => reason,
            };
            let root = backend.state_root.clone();
            let helper = backend.helper.clone();
            let account_network = network.clone();
            let (execution, guards) = tokio::task::spawn_blocking(move || {
                let installation = Installation::new(&root);
                let _lease = store::shared_lease(&installation.root.join("lifecycle.lock"))
                    .map_err(|error| {
                        if error.kind() == io::ErrorKind::NotFound {
                            super::setup_required()
                        } else {
                            error
                        }
                    })?;
                if installation.status()? != super::Status::Ready {
                    return Err(super::setup_required());
                }
                let compiled = filesystem.compile().map_err(io::Error::other)?;
                let guards = Guards::prepare(&compiled)
                    .map_err(|error| context("protect filesystem boundaries", error))?;
                let result = (|| {
                    let plan = policy::Plan::compile(&filesystem, &helper, &executable, &cwd)
                        .map_err(|error| context("compile filesystem access", error))?;
                    let execution = installation
                        .execution(account_network, &plan.reads, &plan.writes)
                        .map_err(|error| context("prepare execution account", error))?;
                    guards.bind(execution.id)?;
                    Ok::<_, io::Error>(execution)
                })();
                match result {
                    Ok(execution) => Ok((execution, guards)),
                    Err(error) => match guards.finish() {
                        Ok(()) => Err(error),
                        Err(cleanup) => Err(cleanup_error(cleanup)),
                    },
                }
            })
            .await
            .map_err(cleanup_error)?
            .map_err(|error| {
                context(
                    &format!(
                        "prepare account isolation (Microsoft MXC cannot enforce this policy: {mxc_unsupported})"
                    ),
                    error,
                )
            })?;
            let id = execution.id;
            let capability = execution.capability;
            let mut guards = Some(guards);
            let mut proxy = None;
            let result = async {
                let proxy_address = execution.proxy_port.map(|port| {
                    std::net::SocketAddr::from((std::net::Ipv4Addr::LOCALHOST, port.get()))
                });
                proxy = match execution.proxy_port {
                    Some(port) => Some(super::network::acquire(port, network, route).await?),
                    None => None,
                };
                let participants = vec![
                    execution.account.sid().to_owned(),
                    WriteCapability::new(capability).sid().to_owned(),
                ];
                let desktop = Arc::new(
                    bootstrap::desktop(
                        &backend.helper,
                        &execution.account,
                        &execution.password,
                        &participants,
                    )
                    .await
                    .map_err(|error| context("create private desktop", error))?,
                );
                let endpoint = bootstrap::Endpoint::new(&execution.account)
                    .map_err(|error| context("create runner channel", error))?;
                let runner = bootstrap::Identity {
                    account: execution.account,
                    password: execution.password,
                    job: execution.job,
                    leases: execution.leases,
                    desktop,
                }
                .start(backend.helper.clone(), endpoint.id())
                .await?;
                let root = backend.state_root.clone();
                let read_helper = backend.helper.clone();
                let guards = guards.take().expect("one execution owner");
                Ok::<_, io::Error>(bootstrap::Launch::Account {
                    runner: runner.with_proxy(proxy.take()).with_cleanup(move || {
                        Installation::new(&root).settle(id)?;
                        guards.finish()?;
                        super::reads::start(&root, &read_helper);
                        Ok(())
                    }),
                    endpoint,
                    capabilities: vec![capability],
                    proxy_address,
                })
            }
            .await;
            match result {
                Ok(launch) => {
                    super::reads::start(&backend.state_root, &backend.helper);
                    Ok(launch)
                }
                Err(error) => {
                    // Shared gateways remain owned by peers. If this is the
                    // last owner, await its actual close before settling startup.
                    let proxy_cleanup = match proxy.and_then(Arc::into_inner) {
                        Some(mut proxy) => proxy.close().await,
                        None => Ok(()),
                    };
                    let root = backend.state_root;
                    let cleanup = tokio::task::spawn_blocking(move || {
                        let settled = Installation::new(&root).settle(id);
                        let guards = guards
                            .expect("failed startup retains protection ownership")
                            .finish();
                        settled.and(guards)
                    })
                    .await
                    .map_err(cleanup_error)?;
                    match cleanup.and(proxy_cleanup) {
                        Ok(()) => Err(error),
                        Err(cleanup) => Err(cleanup_error(cleanup)),
                    }
                }
            }
        })
    }
}

fn prepare_native(
    filesystem: &Policy,
    network: &Network,
    executable: &Path,
    cwd: &Path,
) -> io::Result<NativePreparation> {
    guards::recover().map_err(cleanup_error)?;
    if !mxc::is_available() {
        return Ok(NativePreparation::Unsupported(
            "native Windows process security environments are unavailable".into(),
        ));
    }
    let registry = guards::registry_root()?;
    maka_event_log::root::private_directory(&registry)?;
    let ceiling = Policy {
        default: Access::Write,
        rules: vec![Rule::subtree(registry, Access::Deny)],
        deny_globs: Vec::new(),
    };
    let compiled = filesystem
        .compile()
        .and_then(|policy| policy.intersect(&ceiling.compile()?))
        .map_err(io::Error::other)?;
    if !compiled.access(executable).can_read() || !compiled.access(cwd).can_read() {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "sandbox denies its working directory or executable",
        ));
    }
    let filesystem = compiled.policy().clone();
    let mut guards = Some(match Guards::prepare_native(&compiled) {
        Ok(guards) => guards,
        Err(error) if error.kind() == io::ErrorKind::Unsupported => {
            return Ok(NativePreparation::Unsupported(error.to_string()));
        }
        Err(error) => return Err(context("protect native filesystem boundaries", error)),
    });
    let prepared = (|| {
        match mxc::PreparedPolicy::new(&filesystem, network, cwd) {
            Ok(_) => {}
            Err(maka_sandbox::Error::Unsupported(reason)) => {
                return Ok(NativePreparation::Unsupported(reason));
            }
            Err(error) => return Err(io::Error::other(error)),
        }
        let id = uuid::Uuid::new_v4();
        let job = ExecutionJob::create(id)?;
        if let Some(guards) = &guards {
            guards.bind(id)?;
        }
        let guards = guards.take();
        let lease = bootstrap::MxcLease::new(job, move || match guards {
            Some(guards) => guards.finish(),
            None => Ok(()),
        });
        Ok(NativePreparation::Ready { filesystem, lease })
    })();
    if let Some(guards) = guards {
        guards.finish().map_err(cleanup_error)?;
    }
    prepared
}

fn cleanup_error(error: impl std::fmt::Display) -> io::Error {
    io::Error::other(maka_agent_facts::tools::ToolError::CleanupUnconfirmed(
        error.to_string(),
    ))
}

fn context(action: &str, error: io::Error) -> io::Error {
    if error
        .get_ref()
        .is_some_and(|inner| inner.is::<maka_agent_facts::tools::ToolError>())
    {
        return error;
    }
    io::Error::new(
        error.kind(),
        format!("Windows sandbox could not {action}: {error}"),
    )
}
