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

use crate::StoreError;
use rusqlite::{Connection, OptionalExtension, params};
use sha2::{Digest, Sha256};
use std::io::{self, Read};

/// Insert already-prepared immutable bytes in the caller's transaction.
/// Any error requires that transaction or its statement savepoint to roll back.
pub fn put_stream(
    connection: &Connection,
    digest: &str,
    bytes: u64,
    reader: &mut dyn Read,
) -> Result<i64, StoreError> {
    if !digest.strip_prefix("sha256:").is_some_and(|hash| {
        hash.len() == 64
            && hash
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    }) {
        return Err(StoreError::InvalidTransition(
            "invalid immutable content digest".into(),
        ));
    }
    let size = i32::try_from(bytes).map_err(|_| {
        StoreError::InvalidTransition(
            "immutable content exceeds SQLite incremental Blob length limit".into(),
        )
    })?;
    let existing: Option<(i64, i64)> = connection
        .prepare_cached("SELECT id, length(payload) FROM contents WHERE content_sha256=?")?
        .query_row([digest], |row| Ok((row.get(0)?, row.get(1)?)))
        .optional()?;
    if let Some((id, length)) = existing {
        if length != i64::from(size) {
            return Err(StoreError::InvalidTransition(
                "immutable content digest already has a different byte length".into(),
            ));
        }
        return Ok(id);
    }
    let id = connection
        .prepare_cached(
            "INSERT INTO contents(content_sha256,payload) VALUES(?1,zeroblob(?2)) RETURNING id",
        )?
        .query_row(params![digest, size], |row| row.get(0))?;
    let mut blob = connection.blob_open("main", "contents", "payload", id, false)?;
    let result = (|| {
        let mut hash = Sha256::new();
        let mut buffer = [0_u8; 64 * 1024];
        let mut offset = 0;
        let length = size as usize;
        while offset < length {
            let chunk = buffer.len().min(length - offset);
            reader.read_exact(&mut buffer[..chunk])?;
            blob.write_at(&buffer[..chunk], offset)?;
            hash.update(&buffer[..chunk]);
            offset += chunk;
        }
        if reader.read(&mut [0_u8; 1])? != 0 {
            return Err(StoreError::InvalidTransition(
                "immutable content stream exceeds its declared byte length".into(),
            ));
        }
        if format!("sha256:{}", hex::encode(hash.finalize())) != digest {
            return Err(StoreError::InvalidTransition(
                "immutable content stream does not match its declared digest".into(),
            ));
        }
        Ok(id)
    })();
    match (result, blob.close()) {
        (result, Ok(())) => result,
        (Ok(_), Err(close)) => Err(close.into()),
        (Err(stream), Err(close)) => Err(io::Error::other(StreamAndClose { stream, close }).into()),
    }
}

#[derive(Debug)]
struct StreamAndClose {
    stream: StoreError,
    close: rusqlite::Error,
}
impl std::fmt::Display for StreamAndClose {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "content stream failed: {}; closing its Blob also failed: {}",
            self.stream, self.close
        )
    }
}
impl std::error::Error for StreamAndClose {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(&self.stream)
    }
}
