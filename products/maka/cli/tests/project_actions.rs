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

#![cfg(unix)]

#[path = "support/host.rs"]
mod host;
use futures_util::FutureExt;
use host::{Host, Result, Sandbox};
use maka_app_client::{Client, Journal};
use maka_capabilities::call::Attachments;
use maka_host_runtime::application::host::Client as HostClient;
use maka_plugin_core::operation::{OperationOutcome, OperationReply, OperationResult, Receipt};
use serde_json::{Value, json};
use std::{
    future::Future,
    panic::AssertUnwindSafe,
    path::{Path, PathBuf},
    time::Duration,
};
use uuid::Uuid;

async fn phase<T>(name: &str, work: impl Future<Output = Result<T>>) -> Result<T> {
    tokio::time::timeout(Duration::from_secs(45), work)
        .await
        .map_err(|_| format!("deadline waiting for {name}"))?
        .map_err(|error| format!("{name}: {error}"))
}

fn returned(reply: &OperationReply) -> Result<Value> {
    match &reply.receipt {
        Receipt::Recorded {
            outcome:
                OperationOutcome::Returned {
                    result: OperationResult::Success { value },
                },
            ..
        } => Ok(value.clone()),
        other => Err(format!("expected recorded returned success, got {other:?}")),
    }
}

fn completed(value: Value) -> Result<Value> {
    if value["kind"] != "completed" {
        return Err(format!("Action rejected: {value}"));
    }
    value
        .get("value")
        .cloned()
        .ok_or("completed value missing".into())
}

async fn mutate_with_id(
    client: &Client,
    id: Uuid,
    endpoint: &str,
    method: &str,
    input: Value,
) -> Result<OperationReply> {
    let mutation = client
        .mutation(
            id,
            endpoint,
            method,
            input,
            Attachments::new(),
            None,
            json!({"kind":"project-actions-contract"}),
        )
        .await?;
    phase(&format!("prepare {endpoint}.{method}"), mutation.prepare()).await?;
    phase(&format!("confirm {endpoint}.{method}"), mutation.confirm()).await
}

async fn action(client: &Client, method: &str, input: Value) -> Result<Value> {
    completed(returned(
        &mutate_with_id(client, Uuid::new_v4(), "projectActions", method, input).await?,
    )?)
}

async fn query(client: &Client, method: &str, input: Value) -> Result<Value> {
    completed(
        phase(
            &format!("query projectActions.{method}"),
            client.query("projectActions", method, input),
        )
        .await?,
    )
}

struct RunningHost {
    process: Host,
    control: HostClient,
    address: PathBuf,
}

struct Rig {
    sandbox: Sandbox,
    hosts: Vec<RunningHost>,
    clients: Vec<Client>,
}

impl Rig {
    async fn new() -> Result<Self> {
        Ok(Self {
            sandbox: Sandbox::new().await?,
            hosts: vec![],
            clients: vec![],
        })
    }

    async fn start(&mut self) -> Result<Client> {
        let mut process = Host::spawn(&self.sandbox)?;
        let started = phase("real Host registration", process.ready()).await;
        let (control, address) = match started {
            Ok(ready) => ready,
            Err(error) => {
                phase("failed Host cleanup", process.cleanup()).await?;
                return Err(error);
            }
        };
        self.hosts.push(RunningHost {
            process,
            control,
            address,
        });
        self.connect().await
    }

    async fn connect(&mut self) -> Result<Client> {
        self.connect_journal(&self.sandbox.journal.clone()).await
    }

    async fn connect_journal(&mut self, journal: &Path) -> Result<Client> {
        let host = self.hosts.last().ok_or("no held Host")?;
        let client = Client::new(
            HostClient::connect(&host.address, Some(host.control.epoch())).await?,
            Journal::open(journal).await?,
            "receipts".into(),
        )?;
        loop {
            if client
                .describe("projectActions")
                .await?
                .registration_epoch
                .is_some()
            {
                self.clients.push(client.clone());
                return Ok(client);
            }
            client.refresh().await?;
            tokio::task::yield_now().await;
        }
    }

    async fn quit(&mut self) -> Result<()> {
        for client in &self.clients {
            phase("close owned client before Host quit", client.close()).await?;
        }
        self.clients.clear();
        let host = self.hosts.last_mut().ok_or("no held Host")?;
        phase(
            "last client Host quit and child exit",
            host.process.quit(&mut host.control),
        )
        .await
    }

    async fn cleanup(&mut self) -> Result<()> {
        let mut failures = vec![];
        for host in self.hosts.iter_mut().rev() {
            if let Err(error) = phase("cleanup original Host child", host.process.cleanup()).await {
                failures.push(error);
            }
        }
        if failures.is_empty() {
            Ok(())
        } else {
            Err(failures.join("; "))
        }
    }
}

async fn register(client: &Client, path: &Path) -> Result<String> {
    let observed = client
        .query("agent", "projects", json!({"kind":"directory","path":path}))
        .await?;
    let expected = observed["location"]["project"]["reference"].clone();
    let project = returned(
        &mutate_with_id(
            client,
            Uuid::new_v4(),
            "agent",
            "project",
            json!({"kind":"register","path":path,"expected":expected}),
        )
        .await?,
    )?;
    if project["kind"] != "committed" {
        return Err(format!("project registration: {project}"));
    }
    project["project"]["reference"]["id"]
        .as_str()
        .map(str::to_owned)
        .ok_or("project id missing".into())
}

macro_rules! real_host_test {
    ($name:ident, $body:ident) => {
        #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
        async fn $name() {
            let mut rig = Rig::new()
                .await
                .expect("isolated HOME, State Root and project");
            let outcome = AssertUnwindSafe(async {
                tokio::time::timeout(Duration::from_secs(180), $body(&mut rig))
                    .await
                    .map_err(|_| "contract case deadline".to_owned())?
            })
            .catch_unwind()
            .await;
            let cleanup = rig.cleanup().await;
            cleanup.expect("reap exact Host children");
            match outcome {
                Ok(result) => result.expect(stringify!($name)),
                Err(panic) => std::panic::resume_unwind(panic),
            }
        }
    };
}

#[path = "project_actions/definitions.rs"]
mod definitions;
#[path = "project_actions/terminal.rs"]
mod terminal;
