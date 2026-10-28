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

use crate::EventLog;

/// Run test inspection/fault injection on the original serialized writer. No
/// borrowed SQLite state or connection escapes the native worker callback.
pub(crate) async fn inspect<T: Send + 'static>(
    log: &EventLog,
    operation: impl FnOnce(&rusqlite::Connection) -> T + Send + 'static,
) -> T {
    log.connection
        .run(move |db| {
            Box::pin(async move {
                db.run_on_worker(move |handle| {
                    // SAFETY: SQLx owns this callback's handle and fences its statements.
                    let borrowed = unsafe { rusqlite::Connection::from_handle(handle.as_ptr()) }?;
                    Ok(operation(&borrowed))
                })
                .await?
            })
        })
        .await
        .unwrap()
}

/// Inspect or corrupt the observation owner's private cache; main stays read-only.
pub(crate) async fn inspect_cache<T: Send + 'static>(
    log: &EventLog,
    operation: impl FnOnce(&rusqlite::Connection) -> T + Send + 'static,
) -> T {
    log.connection
        .observe(move |db| {
            Box::pin(async move {
                db.run_on_worker(move |handle| {
                    // SAFETY: SQLx fences this borrowed handle for the callback.
                    let borrowed = unsafe { rusqlite::Connection::from_handle(handle.as_ptr()) }?;
                    Ok(operation(&borrowed))
                })
                .await?
            })
        })
        .await
        .unwrap()
}
