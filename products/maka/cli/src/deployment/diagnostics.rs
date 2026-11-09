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

//! Failure-only, read-only queries isolated from the Host's execution lifetime.

use super::{Deployment, HostError, service};
use base64::Engine;
use maka_host_runtime::logs::HostLogPage;
use maka_process::{Command, pipe};
use serde::Deserialize;
use std::{io, time::Duration};
use tokio::{
    io::AsyncReadExt,
    time::{Instant, timeout_at},
};

#[derive(Clone, Copy)]
enum Query {
    Status,
    Logs,
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum Status {
    Installed {
        deployment: Box<Deployment>,
        supervisor: service::Observation,
    },
}

pub(super) async fn startup_failure(
    deployment: &Deployment,
    error: HostError,
    deadline: Instant,
    budget: Duration,
) -> HostError {
    let deadline = deadline.min(Instant::now() + budget);
    if deadline <= Instant::now() {
        return error;
    }
    let (service, log) = tokio::join!(
        query(deployment, Query::Status, deadline),
        query(deployment, Query::Logs, deadline),
    );
    let service = service.unwrap_or_else(|error| format!("status unavailable: {error}"));
    let log = log.unwrap_or_else(|error| format!("log unavailable: {error}"));
    startup_failure_message(&error.to_string(), &service, &log).into()
}

async fn query(
    deployment: &Deployment,
    query: Query,
    deadline: Instant,
) -> Result<String, HostError> {
    let mut command = Command::new(std::env::current_exe()?, std::env::current_dir()?);
    command.args([
        "--operation-worker",
        "host",
        match query {
            Query::Status => "status",
            Query::Logs => "logs",
        },
        "--root-id",
        &deployment.root_id,
    ]);
    // Only status/logs: terminating this worker cannot cancel accepted Host work.
    // Its process group/Job also owns launchctl or systemctl children.
    let bytes = read_only_worker(command, deadline).await?;
    match query {
        Query::Status => {
            let Status::Installed {
                deployment: observed,
                supervisor,
            } = serde_json::from_slice(&bytes)?;
            if observed.as_ref() != deployment {
                return Err("deployment changed during startup observation".into());
            }
            Ok(serde_json::to_string(&supervisor)?)
        }
        Query::Logs => match serde_json::from_slice(&bytes)? {
            HostLogPage::Missing => Ok("No Host log captured".into()),
            HostLogPage::Data { bytes, .. } => {
                let raw = base64::engine::general_purpose::STANDARD.decode(bytes)?;
                Ok(String::from_utf8_lossy(&raw).into_owned())
            }
        },
    }
}

async fn read_only_worker(command: Command, deadline: Instant) -> Result<Vec<u8>, HostError> {
    let remaining = deadline.saturating_duration_since(Instant::now());
    if remaining.is_zero() {
        return Err("diagnostic query timed out".into());
    }
    // Cancellation and native cleanup fit inside the same observation budget.
    let read_deadline = deadline - (remaining / 4).min(Duration::from_millis(500));
    let pipe::Spawned {
        mut child,
        stdin,
        stdout,
        stderr,
    } = timeout_at(read_deadline, pipe::spawn(command)).await??;
    drop(stdin);
    let result = timeout_at(read_deadline, async {
        tokio::try_join!(
            read_bounded(stdout, 512 * 1024),
            read_bounded(stderr, 8192),
            child.wait()
        )
    })
    .await;
    match result {
        Ok(Ok((stdout, stderr, status))) => {
            if !status.success() {
                return Err(format!(
                    "diagnostic query exited ({status}): {}",
                    String::from_utf8_lossy(&stderr)
                )
                .into());
            }
            Ok(stdout)
        }
        failure => {
            child.terminate().await?;
            let cleanup = timeout_at(deadline, child.wait()).await;
            let cause: HostError = match failure {
                Err(_) => "diagnostic query timed out".into(),
                Ok(Err(error)) => error.into(),
                Ok(Ok(_)) => unreachable!(),
            };
            match cleanup {
                Ok(Ok(_)) => Err(cause),
                Ok(Err(error)) => Err(format!("{cause}; query cleanup: {error}").into()),
                Err(_) => Err(format!("{cause}; query cleanup unconfirmed").into()),
            }
        }
    }
}

async fn read_bounded(
    input: impl tokio::io::AsyncRead + Unpin,
    limit: usize,
) -> io::Result<Vec<u8>> {
    let mut bytes = Vec::new();
    input.take(limit as u64 + 1).read_to_end(&mut bytes).await?;
    if bytes.len() > limit {
        return Err(io::Error::other("diagnostic output exceeds its limit"));
    }
    Ok(bytes)
}

fn startup_failure_message(error: &str, service: &str, log: &str) -> String {
    // Keep each observation useful within the existing 2 KiB activation frame message.
    let error = &error[..error.floor_char_boundary(512)];
    let service = &service[..service.floor_char_boundary(384)];
    let log = &log[log.ceil_char_boundary(log.len().saturating_sub(1024))..];
    format!("{error}\nService: {service}\nRecent service log (may predate this attempt):\n{log}")
}
