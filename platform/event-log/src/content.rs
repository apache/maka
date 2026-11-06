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
use sqlx::{SqliteConnection, sqlite::SqliteWorkerConnection};

const INSERT: &str = "INSERT INTO contents(content_sha256,payload) VALUES(?,?) ON CONFLICT(content_sha256) DO NOTHING RETURNING id";
const READ_ID: &str = "SELECT id FROM contents WHERE content_sha256=?";

pub(crate) async fn put(
    connection: &mut SqliteConnection,
    digest: &str,
    bytes: &[u8],
) -> Result<i64, StoreError> {
    if let Some(id) = sqlx::query_scalar(INSERT)
        .bind(digest)
        .bind(bytes)
        .fetch_optional(&mut *connection)
        .await?
    {
        return Ok(id);
    }
    Ok(sqlx::query_scalar(READ_ID)
        .bind(digest)
        .fetch_one(connection)
        .await?)
}

pub(crate) async fn put_on_worker(
    connection: &mut SqliteWorkerConnection<'_>,
    digest: &str,
    bytes: &[u8],
) -> Result<i64, StoreError> {
    if let Some(id) = sqlx::query_scalar(INSERT)
        .bind(digest)
        .bind(bytes)
        .fetch_optional(&mut *connection)
        .await?
    {
        return Ok(id);
    }
    Ok(sqlx::query_scalar(READ_ID)
        .bind(digest)
        .fetch_one(connection)
        .await?)
}
