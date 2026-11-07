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

//! Existing application inspection under the original Root and database leases.

use std::path::Path;

use rusqlite::Connection;

use crate::{StoreError, connection::OpenOptions};

pub(super) fn options(path: &Path) -> Result<OpenOptions, StoreError> {
    // The caller holds both original leases before examining this representation.
    // Immutable would omit committed WAL facts, while an ordinary read-only WAL
    // open can modify SHM. Exclusive WAL indexing stays in connection-local memory.
    let mut wal = path.as_os_str().to_os_string();
    wal.push("-wal");
    let wal_present = match Path::new(&wal).symlink_metadata() {
        Ok(_) => true,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
        Err(error) => return Err(error.into()),
    };
    let options = OpenOptions::file(path).create(false);
    Ok(if wal_present {
        // The native exclusive lock requires a write-capable descriptor. The
        // initializer enforces query_only before any database read.
        options.read_only(false).exclusive(true)
    } else {
        options.read_only(true).immutable(true)
    })
}

pub(super) fn initialize(connection: &Connection) -> Result<(), StoreError> {
    connection.pragma_update(None, "query_only", "ON")?;
    let query_only: i64 = connection.pragma_query_value(None, "query_only", |row| row.get(0))?;
    if query_only != 1 {
        return Err(StoreError::InvalidTransition(
            "application inspection requires query-only SQL".into(),
        ));
    }
    let application_id: i64 =
        connection.pragma_query_value(None, "application_id", |row| row.get(0))?;
    let version: i64 = connection.pragma_query_value(None, "user_version", |row| row.get(0))?;
    if application_id != 0x4d414b52 || version != 1 {
        return Err(StoreError::UnsupportedDatabase);
    }
    Ok(())
}
