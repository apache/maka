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

//! Shared mutable workspace selections. Session configurations retain references;
//! permission evidence captures immutable stamps instead of following this pointer.
use crate::{EventLog, StoreError};
use maka_agent_facts::workspace::{BindingRef, BindingStamp, PermissionBasis};
use serde::{Serialize, de::DeserializeOwned};
use serde_json::Value;
use sqlx::{Row, SqliteConnection};

const MAX: u64 = maka_agent_facts::interaction::MAX_SAFE_INTEGER;

#[derive(Clone, Debug, PartialEq)]
pub struct WorkspaceBinding<W = Value> {
    pub id: uuid::Uuid,
    pub workspace: W,
    pub permission_epoch: u64,
    pub metadata_epoch: u64,
}

impl<W> WorkspaceBinding<W> {
    pub fn reference(&self) -> BindingRef {
        BindingRef {
            id: self.id,
            permission_epoch_at_attach: self.permission_epoch,
            metadata_epoch_at_attach: self.metadata_epoch,
        }
    }
    pub fn stamp(&self) -> BindingStamp {
        BindingStamp {
            id: self.id,
            permission_epoch: self.permission_epoch,
        }
    }
}

fn invalid(message: impl Into<String>) -> StoreError {
    StoreError::InvalidTransition(message.into())
}

fn canonical(mut workspace: Value) -> Result<(String, String), StoreError> {
    if !workspace.is_object() {
        return Err(invalid("workspace selection must be an object"));
    }
    workspace.sort_all_objects();
    let encoded = serde_json::to_string(&workspace)?;
    let digest = maka_agent_facts::artifact::content_digest(encoded.as_bytes());
    Ok((encoded, digest))
}

impl EventLog {
    /// Reuse the exact normalized selection within this owner's namespace. The
    /// writer transaction prevents concurrent attaches creating per-Session rows.
    pub async fn attach_workspace<T: Serialize>(
        &self,
        owner_scope: &str,
        workspace: &T,
    ) -> Result<BindingRef, StoreError> {
        self.validate_root()?;
        if owner_scope.is_empty() {
            return Err(invalid("workspace owner scope is empty"));
        }
        let owner_scope = owner_scope.to_owned();
        let (workspace, digest) = canonical(serde_json::to_value(workspace)?)?;
        self.connection
            .write(
                WriteAttachment {
                    owner_scope,
                    workspace,
                    digest,
                },
                self.commits.notice(),
            )
            .await
    }

    pub async fn workspace_binding<T: DeserializeOwned + Send + 'static>(
        &self,
        id: uuid::Uuid,
    ) -> Result<Option<WorkspaceBinding<T>>, StoreError> {
        self.validate_root()?;
        self.connection
            .read(move |connection| Box::pin(async move { read(connection, id).await }))
            .await
    }
}

pub(crate) struct WriteAttachment {
    owner_scope: String,
    workspace: String,
    digest: String,
}

impl crate::writeback::Statement for WriteAttachment {
    type Value = BindingRef;
    type Output = BindingRef;

    fn execute(
        self,
        connection: &mut SqliteConnection,
    ) -> crate::connection::BoxFuture<'_, Result<crate::writeback::Prepared<BindingRef>, StoreError>>
    {
        Box::pin(async move {
            let Self {
                owner_scope,
                workspace,
                digest,
            } = self;
            let existing: Option<String> = sqlx::query_scalar(
                "SELECT id FROM workspace_bindings
                 WHERE owner_scope=? AND selection_digest=? AND workspace_json=? ORDER BY id LIMIT 1",
            ).bind(&owner_scope).bind(&digest).bind(&workspace).fetch_optional(&mut *connection).await?;
            let changed = existing.is_none();
            let id = match existing {
                Some(id) => uuid::Uuid::parse_str(&id)
                    .map_err(|_| invalid("invalid workspace binding ID"))?,
                None => {
                    let id = uuid::Uuid::new_v4();
                    sqlx::query("INSERT INTO workspace_bindings VALUES(?,?,?,?,0,0)")
                        .bind(id.to_string())
                        .bind(owner_scope)
                        .bind(digest)
                        .bind(workspace)
                        .execute(&mut *connection)
                        .await?;
                    id
                }
            };
            let binding = read::<Value>(connection, id)
                .await?
                .ok_or_else(|| invalid("workspace binding disappeared"))?;
            Ok(crate::writeback::Prepared {
                value: binding.reference(),
                changed,
                notification: crate::writeback::Notification::None,
            })
        })
    }

    fn committed(value: BindingRef) -> BindingRef {
        value
    }

    fn isolated_rejection(_error: &StoreError) -> bool {
        false
    }
}

pub(crate) async fn read<T: DeserializeOwned>(
    connection: &mut SqliteConnection,
    id: uuid::Uuid,
) -> Result<Option<WorkspaceBinding<T>>, StoreError> {
    let row = sqlx::query(
        "SELECT workspace_json,permission_epoch,metadata_epoch FROM workspace_bindings WHERE id=?",
    )
    .bind(id.to_string())
    .fetch_optional(connection)
    .await?;
    row.map(|row| {
        let binding = WorkspaceBinding {
            id,
            workspace: serde_json::from_str(&row.try_get::<String, _>(0)?)?,
            permission_epoch: u64::try_from(row.try_get::<i64, _>(1)?)
                .map_err(|_| invalid("invalid permission epoch"))?,
            metadata_epoch: u64::try_from(row.try_get::<i64, _>(2)?)
                .map_err(|_| invalid("invalid metadata epoch"))?,
        };
        binding.reference().validate().map_err(invalid)?;
        Ok(binding)
    })
    .transpose()
}

pub(crate) fn attached(configuration: &Value) -> Result<Option<BindingRef>, StoreError> {
    // EventLog also stores non-Agent configurations without a workspace. A
    // present workspace must be the new reference shape; no inline fallback.
    configuration
        .get("workspace")
        .map(|workspace| {
            let reference: BindingRef = serde_json::from_value(workspace.clone())?;
            reference.validate().map_err(invalid)?;
            Ok(reference)
        })
        .transpose()
}

pub(crate) async fn resolve(
    connection: &mut SqliteConnection,
    configuration: &Value,
) -> Result<Option<WorkspaceBinding>, StoreError> {
    let Some(reference) = attached(configuration)? else {
        return Ok(None);
    };
    let binding = read(connection, reference.id)
        .await?
        .ok_or_else(|| invalid("Session workspace binding does not exist"))?;
    reference
        .session_revision(0, binding.metadata_epoch)
        .map_err(invalid)?;
    reference
        .boundary_revision(0, binding.stamp())
        .map_err(invalid)?;
    Ok(Some(binding))
}

pub(crate) fn effective_revision(
    local: u64,
    configuration: &Value,
    binding: Option<&WorkspaceBinding>,
) -> Result<u64, StoreError> {
    match (attached(configuration)?, binding) {
        (Some(reference), Some(binding)) => reference
            .session_revision(local, binding.metadata_epoch)
            .map_err(invalid),
        (None, None) if local <= MAX => Ok(local),
        _ => Err(invalid("invalid Session workspace revision")),
    }
}

/// Lightweight effective CAS token; no execution/history projection is needed.
pub(crate) async fn current_session_revision(
    connection: &mut SqliteConnection,
    session: &str,
) -> Result<Option<u64>, StoreError> {
    let row: Option<(i64, String)> =
        sqlx::query_as("SELECT revision,configuration FROM session_control WHERE id=?")
            .bind(session)
            .fetch_optional(&mut *connection)
            .await?;
    let Some((local, encoded)) = row else {
        return Ok(None);
    };
    let configuration = serde_json::from_str(&encoded)?;
    let binding = resolve(connection, &configuration).await?;
    effective_revision(
        u64::try_from(local).map_err(|_| invalid("invalid Session revision"))?,
        &configuration,
        binding.as_ref(),
    )
    .map(Some)
}

pub(crate) fn effective_boundary(
    configuration: &Value,
    binding: &WorkspaceBinding,
) -> Result<PermissionBasis, StoreError> {
    let reference =
        attached(configuration)?.ok_or_else(|| invalid("Session workspace binding is missing"))?;
    let local = configuration
        .get("boundary_revision")
        .and_then(Value::as_u64)
        .ok_or_else(|| invalid("Session permission boundary is missing"))?;
    Ok(PermissionBasis {
        boundary_revision: reference
            .boundary_revision(local, binding.stamp())
            .map_err(invalid)?,
        binding: binding.stamp(),
    })
}

/// Called inside the same transaction as grant/T1 verification.
pub(crate) async fn permission_basis(
    connection: &mut SqliteConnection,
    session: &str,
) -> Result<Option<PermissionBasis>, StoreError> {
    let raw: Option<String> =
        sqlx::query_scalar("SELECT configuration FROM session_control WHERE id=? AND archived=0")
            .bind(session)
            .fetch_optional(&mut *connection)
            .await?;
    let Some(raw) = raw else {
        return Ok(None);
    };
    let configuration = serde_json::from_str(&raw)?;
    let Some(binding) = resolve(connection, &configuration).await? else {
        return Ok(None);
    };
    effective_boundary(&configuration, &binding).map(Some)
}

/// Before a metadata closure or rebind, materialize both effective counters and
/// reset the old attachment baselines. The closure then operates on current bases.
pub(crate) fn normalize(
    configuration: &mut Value,
    binding: Option<&WorkspaceBinding>,
) -> Result<(), StoreError> {
    if let Some(binding) = binding {
        let boundary = effective_boundary(configuration, binding)?;
        configuration["boundary_revision"] = Value::from(boundary.boundary_revision);
        configuration["workspace"] = serde_json::to_value(binding.reference())?;
    }
    Ok(())
}

pub(crate) async fn require_current_reference(
    connection: &mut SqliteConnection,
    configuration: &Value,
) -> Result<(), StoreError> {
    if let Some(reference) = attached(configuration)? {
        let binding = resolve(connection, configuration)
            .await?
            .ok_or_else(|| invalid("workspace binding is missing"))?;
        if reference != binding.reference() {
            return Err(invalid("workspace attachment changed before commit"));
        }
        effective_boundary(configuration, &binding)?;
    }
    Ok(())
}

/// Check one indexed maximum per counter, never enumerate member Sessions.
pub(crate) async fn require_headroom(
    connection: &mut SqliteConnection,
    id: uuid::Uuid,
    permission: u64,
    metadata: u64,
) -> Result<(), StoreError> {
    for (query, epoch) in [
        (
            "SELECT revision-json_extract(configuration,'$.workspace.metadataEpochAtAttach') FROM session_control INDEXED BY session_binding_metadata_headroom WHERE json_extract(configuration,'$.workspace.id')=? ORDER BY revision-json_extract(configuration,'$.workspace.metadataEpochAtAttach') DESC LIMIT 1",
            metadata,
        ),
        (
            "SELECT json_extract(configuration,'$.boundary_revision')-json_extract(configuration,'$.workspace.permissionEpochAtAttach') FROM session_control INDEXED BY session_binding_permission_headroom WHERE json_extract(configuration,'$.workspace.id')=? ORDER BY json_extract(configuration,'$.boundary_revision')-json_extract(configuration,'$.workspace.permissionEpochAtAttach') DESC LIMIT 1",
            permission,
        ),
    ] {
        let offset: Option<i64> = sqlx::query_scalar(query)
            .bind(id.to_string())
            .fetch_optional(&mut *connection)
            .await?;
        if offset.is_some_and(|offset| {
            offset
                .checked_add(epoch as i64)
                .is_none_or(|value| !(0..=MAX as i64).contains(&value))
        }) {
            return Err(invalid(
                "workspace relocation would exhaust a Session revision",
            ));
        }
    }
    Ok(())
}

pub(crate) async fn replace(
    connection: &mut SqliteConnection,
    id: uuid::Uuid,
    workspace: Value,
    permission_changed: bool,
) -> Result<(), StoreError> {
    let current = read::<Value>(connection, id)
        .await?
        .ok_or_else(|| invalid("workspace binding disappeared"))?;
    let metadata = current
        .metadata_epoch
        .checked_add(1)
        .filter(|value| *value <= MAX)
        .ok_or_else(|| invalid("workspace metadata epoch exhausted"))?;
    let permission = current
        .permission_epoch
        .checked_add(u64::from(permission_changed))
        .filter(|value| *value <= MAX)
        .ok_or_else(|| invalid("workspace permission epoch exhausted"))?;
    require_headroom(connection, id, permission, metadata).await?;
    let (workspace, digest) = canonical(workspace)?;
    sqlx::query("UPDATE workspace_bindings SET workspace_json=?,selection_digest=?,permission_epoch=?,metadata_epoch=? WHERE id=?")
        .bind(workspace).bind(digest).bind(permission as i64).bind(metadata as i64).bind(id.to_string())
        .execute(connection).await?;
    Ok(())
}

#[cfg(test)]
mod tests;
