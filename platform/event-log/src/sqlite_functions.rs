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

/// Register the functions required by ordinary writer and reader connections.
pub(crate) async fn register(connection: &mut SqliteConnection) -> Result<(), StoreError> {
    on_handle(connection, |db| {
        crate::sessions::register_functions(db)
            .and_then(|()| crate::message_identity::register(db))
            .and_then(|()| crate::transcript::navigation::register(db))
            .and_then(|()| crate::context::evidence::register(db))
    })
    .await
}
pub(crate) async fn register_migrations(
    connection: &mut SqliteConnection,
) -> Result<(), StoreError> {
    on_handle(connection, |db| {
        crate::context::semantic::migration::register(db)?;
        crate::canonical::migration::register(db)
    })
    .await
}
pub(crate) async fn unregister_migrations(
    connection: &mut SqliteConnection,
) -> Result<(), StoreError> {
    on_handle(connection, |db| {
        crate::context::semantic::migration::unregister(db)?;
        crate::canonical::migration::unregister(db)
    })
    .await
}

async fn on_handle(
    connection: &mut SqliteConnection,
    apply: impl FnOnce(&rusqlite::Connection) -> Result<(), StoreError> + Send,
) -> Result<(), StoreError> {
    let mut locked = connection.lock_handle().await?;
    // SAFETY: SQLx's guard excludes worker FFI calls while this borrowed,
    // non-owning connection exists. Both crates use the same libsqlite3-sys.
    // The synchronous callback cannot retain a wrapper or statement, and the
    // wrapper drops before the guard. Registered functions are Send + 'static.
    let borrowed = unsafe { rusqlite::Connection::from_handle(locked.as_raw_handle().as_ptr()) }?;
    let result = apply(&borrowed);
    // A borrowed rusqlite connection leaves SQLx's live connection and hooks intact.
    drop(borrowed);
    result
}
