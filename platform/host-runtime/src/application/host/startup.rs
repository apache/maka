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

//! Discover and admit local callers while the trusted CLI owns Host startup.
use super::{
    Client,
    discovery::{self, Discovery},
};
use crate::application::{
    Result,
    transport::{HostEndpoint, NativeGrant, wire},
};
use crate::ipc;
use maka_event_log::root::RootNamespaces;
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};
use tokio::process::{Child, ChildStdin, Command};
use uuid::Uuid;

/// Whether a State Root ID has its canonical lowercase hexadecimal representation.
pub fn valid_root_id(root_id: &str) -> bool {
    root_id.len() == 64
        && root_id
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub root: PathBuf,
    pub state_domain: Option<String>,
    pub deployment: Uuid,
    pub endpoints: BTreeMap<String, HostEndpoint>,
    pub native: Vec<NativeGrant>,
}
impl Request {
    pub fn validate(&self) -> Result<()> {
        if !self.root.is_absolute()
            || self.deployment.is_nil()
            || self
                .state_domain
                .as_ref()
                .is_some_and(|domain| !valid_root_id(domain))
            || self.endpoints.is_empty()
        {
            return Err("invalid local Host startup selection".into());
        }
        for (name, endpoint) in &self.endpoints {
            if name.is_empty() {
                return Err("invalid Host endpoint name".into());
            }
            endpoint.validate()?;
        }
        for grant in &self.native {
            grant.validate()?;
        }
        Ok(())
    }
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Ready {
    pub root_id: String,
    pub epoch: Uuid,
}
/// Discover or start the explicitly selected Host and admit an owned caller.
/// `executable` must be an absolute path to the trusted CLI launcher. Startup
/// uses the current account's Root namespaces and never installs or repairs it.
/// Endpoint/native selections prepare startup; a live Host retains its published
/// catalogue and grants.
/// Close the returned Client to detach without cancelling accepted work.
/// Reconnecting never retries an unconfirmed mutation or confirms its cleanup.
pub async fn connect(executable: &Path, request: Request) -> Result<Client> {
    connect_target(executable, Target::Configured(&request)).await
}

/// Connect to a Root's live Host, or ask the trusted CLI to initialize/start it
/// under the existing deployment policy. The Root path must be absolute.
pub async fn connect_root(executable: &Path, root: &Path) -> Result<Client> {
    connect_target(executable, Target::Root(root)).await
}

#[derive(Clone, Copy)]
enum Target<'a> {
    Configured(&'a Request),
    Root(&'a Path),
}

impl<'a> Target<'a> {
    fn root(self) -> &'a Path {
        match self {
            Self::Configured(request) => &request.root,
            Self::Root(root) => root,
        }
    }

    fn request(self) -> Option<&'a Request> {
        match self {
            Self::Configured(request) => Some(request),
            Self::Root(_) => None,
        }
    }
}

async fn connect_target(executable: &Path, target: Target<'_>) -> Result<Client> {
    tokio::time::timeout(Duration::from_secs(40), async {
        let namespaces =
            RootNamespaces::for_current_account().map_err(|error| error.to_string())?;
        let prepared = prepare_target(executable, target, &namespaces).await?;
        let client = Client::connect(
            &prepared.discovery.endpoint,
            Some(prepared.discovery.host_epoch),
        )
        .await?;
        if client.source() != &prepared.discovery.source {
            return Err("local Host source changed during admission".into());
        }
        drop(prepared);
        Ok(client)
    })
    .await
    .map_err(|_| "local Host connection/startup deadline elapsed".to_owned())?
}

pub struct Prepared {
    discovery: Discovery,
    _startup: Anchor,
}

impl Prepared {
    pub fn discovery(&self) -> &Discovery {
        &self.discovery
    }
}

/// Retains startup residency until the caller's actual session is admitted.
pub async fn prepare(
    executable: &Path,
    request: &Request,
    namespaces: &RootNamespaces,
) -> Result<Prepared> {
    prepare_target(executable, Target::Configured(request), namespaces).await
}

async fn prepare_target(
    executable: &Path,
    target: Target<'_>,
    namespaces: &RootNamespaces,
) -> Result<Prepared> {
    if let Some(request) = target.request() {
        request.validate()?;
        wire::encode_bounded(request, usize::MAX)?;
    } else if !target.root().is_absolute() {
        return Err("local Host startup root must be absolute".into());
    }
    if !executable.is_absolute() {
        return Err("local Host startup executable must be absolute".into());
    }
    // The launcher owns update and retirement policy even when a Host is live.
    let (startup, ready) = launch(executable, target).await?;
    let discovered = discover(target.root(), namespaces)
        .await
        .map_err(|error| error.to_string())?;
    check_selection(&discovered, target)?;
    let stream = ipc::connect(&discovered.endpoint)
        .await
        .map_err(|error| error.to_string())?;
    let status = Client::status_stream(stream, Some(discovered.host_epoch)).await?;
    discovered
        .verify(&status)
        .map_err(|error| error.to_string())?;
    if discovered.host_epoch != ready.epoch || discovered.root_id != ready.root_id {
        return Err("local Host identity changed during startup".into());
    }
    Ok(Prepared {
        discovery: discovered,
        _startup: startup,
    })
}

fn check_selection(discovered: &Discovery, target: Target<'_>) -> Result<()> {
    if let Some(request) = target.request()
        && (discovered.source.deployment != request.deployment
            || request
                .state_domain
                .as_ref()
                .is_some_and(|expected| *expected != discovered.root_id))
    {
        return Err("discovered Host differs from its configured deployment or State Root".into());
    }
    Ok(())
}

async fn discover(root: &Path, namespaces: &RootNamespaces) -> std::io::Result<Discovery> {
    let root = root.to_owned();
    let namespaces = namespaces.clone();
    tokio::task::spawn_blocking(move || discovery::read_with_namespaces(&root, &namespaces))
        .await
        .map_err(std::io::Error::other)?
}

/// Owns only a finite helper's startup pipe, never a Host process or UI calls.
struct Anchor {
    _child: Child,
    _input: ChildStdin,
}
async fn launch(executable: &Path, target: Target<'_>) -> Result<(Anchor, Ready)> {
    let mut command = Command::new(executable);
    command.args(["host", "ensure"]);
    if let Target::Root(root) = target {
        command.arg("--root").arg(root);
    }
    let mut child = command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|error| format!("local Host startup helper: {error}"))?;
    let mut input = child.stdin.take().expect("piped startup input");
    let output = child.stdout.take().expect("piped startup output");
    if let Some(request) = target.request() {
        wire::write(&mut input, request).await?;
    }
    let ready: Ready = wire::Reader::new(output).read_bounded(4096).await?;
    if !valid_root_id(&ready.root_id)
        || ready.epoch.is_nil()
        || target
            .request()
            .and_then(|request| request.state_domain.as_ref())
            .is_some_and(|expected| *expected != ready.root_id)
    {
        return Err("local Host startup returned a foreign identity".into());
    }
    Ok((
        Anchor {
            _child: child,
            _input: input,
        },
        ready,
    ))
}
