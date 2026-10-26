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

//! Root control is a live read-only attachment, never an authority grant.

use crate::StoreError;
use sqlx::SqliteConnection;
use std::path::Path;

pub(crate) const STANDALONE_APP_VIEWS: &str = "
    CREATE TEMP VIEW root_app_requests AS
        SELECT request_id,session_id,created_at,record_json FROM main.interaction_requests WHERE 0;
    CREATE TEMP VIEW root_app_outcomes AS
        SELECT request_id,outcome_json FROM main.interaction_outcomes WHERE 0;
    CREATE TEMP VIEW root_app_pending AS
        SELECT request_id,session_id,created_at FROM main.interaction_pending WHERE 0;
    CREATE TEMP VIEW root_app_revision AS SELECT 0 AS revision;";

pub(crate) const ALL_INTERACTION_PENDING: &str = "
    CREATE TEMP VIEW all_interaction_pending AS
        SELECT request_id,session_id,created_at FROM main.interaction_pending
        UNION ALL SELECT request_id,session_id,created_at FROM root_app_pending;";

pub(crate) const ATTACHED_APP_VIEWS: &str = "
    CREATE TEMP VIEW root_app_requests AS
        SELECT request_id,session_id,created_at,record_json FROM root_control.interaction_requests
        WHERE json_extract(record_json,'$.request.kind')='computer_app';
    CREATE TEMP VIEW root_app_outcomes AS
        SELECT outcome.request_id,outcome.outcome_json FROM root_control.interaction_outcomes outcome
        JOIN root_app_requests request ON request.request_id=outcome.request_id;
    CREATE TEMP VIEW root_app_pending AS
        SELECT pending.request_id,pending.session_id,pending.created_at FROM root_control.interaction_pending pending
        JOIN root_app_requests request ON request.request_id=pending.request_id;
    CREATE TEMP VIEW root_app_revision AS
        SELECT revision FROM root_control.session_catalog_revision WHERE singleton=1;";

pub(crate) async fn initialize_views(
    connection: &mut SqliteConnection,
    control: Option<&ReadOnlyControl>,
) -> Result<(), StoreError> {
    if let Some(control) = control {
        control.attach(connection).await?;
    } else {
        sqlx::raw_sql(STANDALONE_APP_VIEWS)
            .execute(&mut *connection)
            .await?;
    }
    sqlx::raw_sql(ALL_INTERACTION_PENDING)
        .execute(&mut *connection)
        .await?;
    if let Some(control) = control {
        control.validate(connection).await?;
    }
    Ok(())
}

#[derive(Clone)]
pub(crate) struct ReadOnlyControl {
    uri: String,
}

impl ReadOnlyControl {
    pub(crate) fn new(path: &Path) -> Result<Self, StoreError> {
        let path = path.canonicalize()?;
        let path = path.to_str().ok_or_else(|| {
            StoreError::InvalidTransition("control database path must be UTF-8".into())
        })?;
        #[cfg(windows)]
        let path = path
            .strip_prefix(r"\\?\")
            .unwrap_or(path)
            .replace('\\', "/");
        // Escape URI delimiters as well as spaces: the filename cannot inject
        // another mode or immutable flag into SQLite's attachment URI.
        let mut uri = String::from("file:");
        for byte in path.as_bytes() {
            if byte.is_ascii_alphanumeric() || b"/-_.~:".contains(byte) {
                uri.push(char::from(*byte));
            } else {
                use std::fmt::Write;
                write!(&mut uri, "%{byte:02X}").expect("write URI");
            }
        }
        uri.push_str("?mode=ro");
        Ok(Self { uri })
    }

    pub(crate) async fn attach(&self, connection: &mut SqliteConnection) -> Result<(), StoreError> {
        sqlx::query("ATTACH DATABASE ? AS root_control")
            .bind(&self.uri)
            .execute(&mut *connection)
            .await?;
        sqlx::query(
            "CREATE TEMP VIEW workspace_bindings AS SELECT * FROM root_control.workspace_bindings",
        )
        .execute(&mut *connection)
        .await?;
        sqlx::query("CREATE TEMP VIEW application_sources AS SELECT * FROM root_control.application_sources")
            .execute(&mut *connection).await?;
        sqlx::raw_sql(ATTACHED_APP_VIEWS)
            .execute(&mut *connection)
            .await?;
        Ok(())
    }

    pub(crate) async fn validate(
        &self,
        connection: &mut SqliteConnection,
    ) -> Result<(), StoreError> {
        let readonly = {
            let mut handle = connection.lock_handle().await?;
            // SAFETY: the SQLx guard excludes worker FFI calls; the schema name
            // is static and NUL-terminated, and this only inspects its mode.
            unsafe {
                rusqlite::ffi::sqlite3_db_readonly(
                    handle.as_raw_handle().as_ptr(),
                    c"root_control".as_ptr(),
                )
            }
        };
        if readonly != 1 {
            return Err(StoreError::InvalidTransition(
                "root control attachment is not read-only".into(),
            ));
        }
        // SQLite defers resolving view bodies. Force resolution during startup
        // so a missing or malformed control schema cannot fall back to main.
        sqlx::query("SELECT id,owner_scope,selection_digest,workspace_json,permission_epoch,metadata_epoch FROM temp.workspace_bindings LIMIT 0")
            .execute(&mut *connection).await?;
        sqlx::query("SELECT deployment,revision,input_json,remote_exports_json FROM temp.application_sources LIMIT 0")
            .execute(&mut *connection).await?;
        sqlx::query("SELECT request_id,session_id,created_at,record_json FROM temp.root_app_requests LIMIT 0")
            .execute(&mut *connection).await?;
        sqlx::query("SELECT request_id,outcome_json FROM temp.root_app_outcomes LIMIT 0")
            .execute(&mut *connection)
            .await?;
        sqlx::query("SELECT request_id,session_id,created_at FROM temp.root_app_pending LIMIT 0")
            .execute(&mut *connection)
            .await?;
        sqlx::query(
            "SELECT request_id,session_id,created_at FROM temp.all_interaction_pending LIMIT 0",
        )
        .execute(&mut *connection)
        .await?;
        let revision: i64 = sqlx::query_scalar("SELECT revision FROM temp.root_app_revision")
            .fetch_one(connection)
            .await?;
        if !(0..=9_007_199_254_740_991).contains(&revision) {
            return Err(StoreError::InvalidTransition(
                "invalid root control revision".into(),
            ));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests;
