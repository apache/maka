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

use sqlx::SqliteConnection;

use crate::StoreError;

/// Startup only, before installing application hooks. rusqlite supplies its
/// safe scalar-function trampoline; SQLx retains sole connection ownership and
/// executes the SQL. No borrowed wrapper or statement may escape this scope.
pub(crate) async fn register(connection: &mut SqliteConnection) -> Result<(), StoreError> {
    let mut locked = connection.lock_handle().await?;
    // SAFETY: SQLx's guard prevents every worker FFI call while this borrowed
    // non-owning handle exists. Both crates share libsqlite3-sys's sqlite3 type
    // (no cast); from_handle does not close the underlying connection. Only
    // Send + 'static UDFs are registered, and no await occurs before wrapper
    // drop. SQLite owns their closures until replacement or connection close.
    let borrowed = unsafe { rusqlite::Connection::from_handle(locked.as_raw_handle().as_ptr()) }?;
    let registered = crate::sessions::register_functions(&borrowed)
        .and_then(|()| crate::message_identity::register(&borrowed))
        .and_then(|()| crate::transcript::navigation::register(&borrowed))
        .and_then(|()| crate::context::evidence::register(&borrowed));
    // rusqlite 0.39 removes hooks only for an owned connection; this borrowed
    // wrapper leaves SQLx's connection and hooks intact.
    drop(borrowed);
    registered
}
