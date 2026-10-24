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
        self.validate(connection).await
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
            .execute(connection).await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests;
