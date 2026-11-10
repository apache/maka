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

//! Immutable bytes are shared; domain bindings retain ownership and access policy.
use crate::StoreError;
use rusqlite::OptionalExtension;

const INSERT: &str = "INSERT INTO contents(content_sha256,payload) VALUES(?,?) ON CONFLICT(content_sha256) DO NOTHING RETURNING id";
const READ_ID: &str = "SELECT id FROM contents WHERE content_sha256=?";

/// Trusted native SQL content insertion; the domain owns the durable reference.
pub fn put(
    connection: &rusqlite::Connection,
    digest: &str,
    bytes: &[u8],
) -> Result<i64, StoreError> {
    if let Some(id) = connection
        .prepare_cached(READ_ID)?
        .query_row([digest], |row| row.get(0))
        .optional()?
    {
        return Ok(id);
    }
    Ok(connection
        .prepare_cached(INSERT)?
        .query_row(rusqlite::params![digest, bytes], |row| row.get(0))?)
}

/// Read immutable bytes by digest in the caller's already authorized Root view.
pub fn read(
    connection: &rusqlite::Connection,
    digest: &str,
) -> Result<Option<Vec<u8>>, StoreError> {
    Ok(connection
        .prepare_cached("SELECT payload FROM contents WHERE content_sha256=?")?
        .query_row([digest], |row| row.get(0))
        .optional()?)
}

mod stream;
pub use stream::put_stream;
