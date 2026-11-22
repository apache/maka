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

use super::{Deployment, Record};
use crate::deployment::{store, updates};
use maka_event_log::{StoreError, root::FileLease};
use maka_host_runtime::HostError;
use rusqlite::{Connection, OptionalExtension, params};
use std::{path::Path, sync::Arc};

pub(in crate::deployment) async fn read(directory: &Path) -> Result<Record, HostError> {
    store::read_database(directory.join("deployment.sqlite"), |connection| {
        Ok(load(connection)?)
    })
    .await
}

fn load(connection: &Connection) -> Result<Record, StoreError> {
    let value: Option<String> = connection
        .query_row(
            "SELECT configuration FROM deployment_update_policy WHERE singleton = 1",
            [],
            |row| row.get(0),
        )
        .optional()?;
    Ok(value
        .map(|value| serde_json::from_str(&value))
        .transpose()?
        .unwrap_or_default())
}

pub(in crate::deployment) async fn write(
    directory: &Path,
    lease: Arc<FileLease>,
    deployment: &Deployment,
    previous: &Record,
    next: &Record,
) -> Result<(), HostError> {
    let (deployment, previous, next) = (deployment.clone(), previous.clone(), next.clone());
    let connection = store::open_writer(directory, lease, None).await?;
    let result = connection.run(move |connection| {
        let transaction = connection.transaction()?;
        let (active, _) = updates::load(&transaction)?;
        if active != deployment || load(&transaction)? != previous {
            return Err(StoreError::InvalidTransition("deployment or update policy changed".into()))
        }
        transaction.execute("INSERT INTO deployment_update_policy(singleton, configuration) VALUES (1, ?) ON CONFLICT(singleton) DO UPDATE SET configuration = excluded.configuration", params![serde_json::to_string(&next)?])?;
        transaction.commit().map_err(StoreError::CommitUnknown)?;
        Ok(())
    }).await;
    let closed = connection.close().await;
    result?;
    closed?;
    Ok(())
}
