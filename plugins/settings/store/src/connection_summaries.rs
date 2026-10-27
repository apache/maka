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

use maka_agent_facts::configuration::{ConnectionTarget, ConnectionVersionBasis};
use maka_agent_facts::provider::Identity;
use serde::Deserialize;

use crate::{ConfigurationStore, Result, TransactionMode};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionSummary {
    pub basis: ConnectionVersionBasis,
    pub slug: String,
    pub name: String,
    pub provider: Identity,
    pub enabled: bool,
    pub enabled_model_count: usize,
}

#[derive(Debug)]
pub struct ConnectionSummaries {
    pub revision: u64,
    pub default_target: Option<ConnectionTarget>,
    pub connections: Vec<ConnectionSummary>,
}

impl ConfigurationStore {
    pub async fn connection_summaries(&self) -> Result<ConnectionSummaries> {
        self.transaction(TransactionMode::Deferred, |tx| {
            Box::pin(async move {
                let (revision, default): (i64, Option<String>) = sqlx::query_as(
                    "SELECT revision, default_target FROM connection_catalog WHERE singleton = 1",
                )
                .fetch_one(&mut *tx)
                .await?;
                let rows: Vec<String> = sqlx::query_scalar(
                    "SELECT json_object(
                        'basis', json_object('connectionId', connection_id, 'revision', json_extract(document, '$.revision')),
                        'slug', json_extract(document, '$.slug'),
                        'name', json_extract(document, '$.name'),
                        'provider', json_extract(document, '$.provider'),
                        'enabled', json(CASE json_extract(document, '$.enabled') WHEN 1 THEN 'true' ELSE 'false' END),
                        'enabledModelCount', json_array_length(document, '$.enabledModelIds'))
                     FROM connections ORDER BY rowid",
                )
                .fetch_all(&mut *tx)
                .await?;
                Ok(ConnectionSummaries {
                    revision: crate::database::unsigned(revision)?,
                    default_target: default.map(|value| serde_json::from_str(&value)).transpose()?,
                    connections: rows.iter().map(|value| serde_json::from_str(value)).collect::<std::result::Result<_, _>>()?,
                })
            })
        })
        .await
    }
}
