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

use super::{Admission, Deployment, RootId, directory, service, store, updates};
use crate::host_client::{HostClient, LiveHost};
use clap::Args;
use maka_host_runtime::HostError;
use serde::Serialize;
use sqlx::{Connection, SqliteConnection, sqlite::SqliteConnectOptions};
use std::path::{Path, PathBuf};

#[derive(Args)]
#[group(required = true, multiple = false)]
pub(crate) struct Status {
    #[arg(long, value_name = "DIRECTORY")]
    root: Option<PathBuf>,
    #[arg(long)]
    root_id: Option<RootId>,
}

#[derive(Serialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
enum Observation {
    NotInstalled,
    Incomplete,
    Installed(Box<Installed>),
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Installed {
    deployment: Deployment,
    pending_update: Option<updates::Pending>,
    supervisor: service::Observation,
    host: HostObservation,
    operation: OperationState,
}

#[derive(Serialize)]
#[serde(rename_all = "snake_case")]
enum OperationState {
    Idle,
    InProgress,
    Unknown,
}

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
enum HostObservation {
    Connected {
        identity: LiveHost,
        activity: maka_host_runtime::application::host::Status,
    },
    Unavailable {
        message: String,
    },
    NotAdmitted,
}

impl Status {
    pub async fn run(self) -> Result<(), HostError> {
        if let Some(root) = self.root {
            let mut client = HostClient::connect(&root, None).await?;
            println!("{}", serde_json::to_string(&client.status().await?)?);
            return Ok(());
        }
        let id = self.root_id.ok_or("missing State Root target")?;
        let observation = observe(&id).await?;
        println!("{}", serde_json::to_string(&observation)?);
        Ok(())
    }
}

async fn observe(id: &RootId) -> Result<Observation, HostError> {
    let directory = match directory(&id.0) {
        Ok(directory) => directory,
        Err(error)
            if error
                .downcast_ref::<std::io::Error>()
                .is_some_and(|error| error.kind() == std::io::ErrorKind::NotFound) =>
        {
            return Ok(Observation::NotInstalled);
        }
        Err(error) => return Err(error),
    };
    let observation = match store::read(&directory).await? {
        store::Installation::Missing => Observation::NotInstalled,
        store::Installation::Incomplete => Observation::Incomplete,
        store::Installation::Installed(deployment) => {
            if deployment.root_id != id.0 {
                return Err("deployment root identity differs".into());
            }
            deployment.validate_record(&directory)?;
            let pending_update = pending(&directory, &deployment).await?;
            let (supervisor, host) = tokio::join!(
                service::observe(deployment.clone()),
                observe_host(&deployment),
            );
            // Only configuration is bracketed. OS and Host observations can
            // differ in time, including a restart that keeps this revision.
            match store::read(&directory).await? {
                store::Installation::Installed(after) if after == deployment => {}
                _ => return Err("deployment changed during observation; query again".into()),
            }
            Observation::Installed(Box::new(Installed {
                operation: match maka_event_log::root::FileLease::is_held(
                    &directory.join("executor.lock"),
                ) {
                    Ok(true) => OperationState::InProgress,
                    Ok(false) => OperationState::Idle,
                    Err(_) => OperationState::Unknown,
                },
                deployment,
                pending_update,
                supervisor,
                host,
            }))
        }
    };
    Ok(observation)
}

async fn observe_host(deployment: &Deployment) -> HostObservation {
    if deployment.admission == Admission::Revoked {
        return HostObservation::NotAdmitted;
    }
    let result = async {
        let mut client =
            HostClient::connect(&deployment.root_path, Some(&deployment.generation())).await?;
        let identity = client.live_host(deployment.websocket.port()).await?;
        let activity = client.status().await?;
        Ok::<_, HostError>(HostObservation::Connected { identity, activity })
    }
    .await;
    result.unwrap_or_else(|error| HostObservation::Unavailable {
        message: error.to_string().chars().take(2048).collect(),
    })
}

pub(super) async fn pending(
    directory: &Path,
    current: &Deployment,
) -> Result<Option<updates::Pending>, HostError> {
    let mut connection = SqliteConnection::connect_with(
        &SqliteConnectOptions::new()
            .filename(directory.join("deployment.sqlite"))
            .read_only(true),
    )
    .await?;
    let result = async {
        let value: Option<String> = sqlx::query_scalar(
            "SELECT CASE WHEN length(CAST(target AS BLOB)) <= 65536 THEN target ELSE '' END FROM deployment_update WHERE singleton = 1",
        ).fetch_optional(&mut connection).await?;
        let target = value.map(|value| serde_json::from_str::<updates::Pending>(&value)).transpose()?;
        if let Some(target) = &target {
            target.deployment.validate_record(directory)?;
            updates::validate_target(current, target)?;
        }
        Ok::<_, HostError>(target)
    }.await;
    let closed = connection.close().await;
    let target = result?;
    closed?;
    Ok(target)
}
