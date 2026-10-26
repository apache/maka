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

use super::*;
use serde::Deserialize;

#[derive(Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub(super) enum Creation {
    Session {
        configuration: serde_json::Value,
        created_at: u64,
    },
    Plugin {
        origin: super::family::Origin,
        configuration: serde_json::Value,
        created_at: u64,
    },
    Copy {
        request: crate::sessions::SessionCopy,
        origin: Option<super::family::Origin>,
        configuration: serde_json::Value,
        created_at: u64,
    },
    Bundle {
        stage: String,
        digest: String,
        binding: String,
        configurations: std::collections::BTreeMap<String, serde_json::Value>,
        members: Vec<String>,
    },
    Import {
        origin: super::family::Origin,
        source: maka_agent_facts::import::Source,
        records: Vec<maka_agent_facts::import::Record>,
        configuration: serde_json::Value,
        created_at: u64,
    },
}

impl Creation {
    /// Pin every existing dependency and every destination attachment, including
    /// unpublished bundle history identities. Session guards are acquired before
    /// reading current attachments; binding guards use the shared global order.
    fn pin_inputs(
        &self,
        id: &str,
    ) -> Result<(Vec<String>, Vec<maka_agent_facts::workspace::BindingRef>), StoreError> {
        let mut sessions = std::collections::BTreeSet::from([id.to_owned()]);
        let mut configurations = Vec::new();
        match self {
            Self::Session { configuration, .. } => configurations.push(configuration),
            Self::Plugin {
                origin,
                configuration,
                ..
            }
            | Self::Import {
                origin,
                configuration,
                ..
            } => {
                sessions.extend(origin.dependencies()?);
                configurations.push(configuration);
            }
            Self::Copy {
                request,
                origin,
                configuration,
                ..
            } => {
                sessions.extend([
                    request.source_session_id.clone(),
                    request.target_session_id.clone(),
                ]);
                if let Some(origin) = origin {
                    sessions.extend(origin.dependencies()?);
                }
                configurations.push(configuration);
            }
            Self::Bundle {
                members,
                configurations: destinations,
                ..
            } => {
                sessions.extend(members.iter().cloned());
                sessions.extend(destinations.keys().cloned());
                configurations.extend(destinations.values());
            }
        }
        let bindings = configurations
            .into_iter()
            .map(crate::workspace_bindings::attached)
            .collect::<Result<Vec<_>, _>>()?
            .into_iter()
            .flatten()
            .collect();
        Ok((sessions.into_iter().collect(), bindings))
    }

    // A retry's wall clock is not request identity. All semantic inputs are.
    pub(super) fn identity(&self) -> Result<serde_json::Value, StoreError> {
        let mut value = serde_json::to_value(self)?;
        value
            .as_object_mut()
            .expect("tagged command")
            .remove("created_at");
        value
            .as_object_mut()
            .expect("tagged command")
            .remove("stage");
        Ok(value)
    }
}

impl RootStore {
    pub async fn session(&self, id: &str) -> Result<SessionStore, StoreError> {
        self.require_open()?;
        crate::sessions::validate_id(id)?;
        let id = id.to_owned();
        let query_id = id.clone();
        let partition: Option<i64> = self
            .control
            .connection
            .read(move |connection| {
                Box::pin(async move {
                    Ok(sqlx::query_scalar(
                        "SELECT partition FROM session_routes WHERE session_id=? AND ready=1 AND visible=1",
                    )
                    .bind(query_id)
                    .fetch_optional(connection)
                    .await?)
                })
            })
            .await?;
        Ok(self.handle(id, partition.ok_or(StoreError::SessionNotFound)? as usize))
    }

    /// Root identity is reserved before the partition commit. Retrying or
    /// reopening uses the original durable command and cannot move a Session.
    pub async fn create_session<T: Serialize>(
        &self,
        id: &str,
        fingerprint: &str,
        configuration: &T,
        now: u64,
    ) -> Result<SessionStore, StoreError> {
        self.require_open()?;
        crate::sessions::validate_id(id)?;
        crate::sessions::validate_time(now)?;
        if fingerprint.is_empty() {
            return Err(StoreError::InvalidTransition(
                "invalid session fingerprint".into(),
            ));
        }
        let configuration = serde_json::to_value(configuration)?;
        creation::validate_configuration(&configuration)?;
        let _creation = self.creation_gates[partition_for(b"session", id)]
            .lock()
            .await;
        self.require_open()?;
        let command = Creation::Session {
            configuration,
            created_at: now,
        };
        let (partition, command) = self.reserve_creation(id, fingerprint, command).await?;
        self.finish_creation(id, fingerprint, partition, command)
            .await?;
        Ok(self.handle(id.to_owned(), partition))
    }

    pub(super) async fn reserve_creation(
        &self,
        id: &str,
        fingerprint: &str,
        command: Creation,
    ) -> Result<(usize, Creation), StoreError> {
        self.reserve_family(
            id,
            fingerprint,
            command,
            partition_for(b"session", id),
            vec![id.to_owned()],
        )
        .await
    }

    pub(super) async fn reserve_family(
        &self,
        id: &str,
        fingerprint: &str,
        command: Creation,
        partition: usize,
        members: Vec<String>,
    ) -> Result<(usize, Creation), StoreError> {
        let reserved = self
            .control
            .connection
            .write(
                creation::WriteReservation {
                    id: id.to_owned(),
                    fingerprint: fingerprint.to_owned(),
                    command,
                    partition,
                    members,
                },
                self.control.commits.notice(),
            )
            .await?;
        Ok((reserved.partition, reserved.command))
    }

    pub(super) async fn finish_creation(
        &self,
        id: &str,
        fingerprint: &str,
        partition: usize,
        command: Creation,
    ) -> Result<(), StoreError> {
        let query_id = id.to_owned();
        let (ready, failure): (i64, Option<String>) = self
            .control
            .connection
            .read(move |db| {
                Box::pin(async move {
                    Ok(sqlx::query_as(
                        "SELECT ready,failure FROM session_routes WHERE session_id=?",
                    )
                    .bind(query_id)
                    .fetch_one(db)
                    .await?)
                })
            })
            .await?;
        if ready == 1 {
            return Ok(());
        }
        if let Some(failure) = failure {
            return Err(StoreError::SessionCreationRejected(serde_json::from_str(
                &failure,
            )?));
        }
        let (sessions, bindings) = command.pin_inputs(id)?;
        let partition = pin_partition(
            self.partitions[partition].clone(),
            &self.gates,
            &sessions,
            &bindings,
        )
        .await?;
        let outcome = match command {
            Creation::Session {
                configuration,
                created_at,
            } => creation::commit(&partition, id, fingerprint, configuration, created_at).await?,
            command => super::family::commit(self, &partition, command).await?,
        };
        self.control
            .connection
            .write(
                creation::WritePublication {
                    id: id.to_owned(),
                    rejection: outcome.clone(),
                },
                self.control.commits.notice(),
            )
            .await?;
        match outcome {
            Some(rejection) => Err(StoreError::SessionCreationRejected(rejection)),
            None => Ok(()),
        }
    }

    pub(super) async fn partition_has_routes(&self, partition: usize) -> Result<bool, StoreError> {
        self.control
            .connection
            .read(move |connection| {
                Box::pin(async move {
                    Ok(sqlx::query_scalar(
                        "SELECT EXISTS(SELECT 1 FROM session_routes WHERE partition=?)",
                    )
                    .bind(partition as i64)
                    .fetch_one(connection)
                    .await?)
                })
            })
            .await
    }

    pub(super) async fn recover_creations(&self) -> Result<(), StoreError> {
        loop {
            let page: Vec<(String, String, i64, String)> = self.control.connection.read(|connection| Box::pin(async move {
                Ok(sqlx::query_as("SELECT session_id, fingerprint, partition, command FROM session_routes WHERE ready=0 AND session_id=creation_id ORDER BY session_id LIMIT 64")
                    .fetch_all(connection).await?)
            })).await?;
            if page.is_empty() {
                self.cleanup_stages().await?;
                return Ok(());
            }
            for (id, fingerprint, partition, command) in page {
                match self
                    .finish_creation(
                        &id,
                        &fingerprint,
                        partition as usize,
                        serde_json::from_str(&command)?,
                    )
                    .await
                {
                    Ok(()) | Err(StoreError::SessionCreationRejected(_)) => {}
                    Err(error) => return Err(error),
                }
            }
        }
    }
}
