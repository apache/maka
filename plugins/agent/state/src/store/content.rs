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

use super::invalid;
use maka_agent_facts::{artifact::content_digest, durable::ContentRef};
use maka_event_log::{StoreError, content};
use rusqlite::Connection;
use serde::Serialize;
use std::{
    io::{self, Read},
    sync::Arc,
};

/// A real owner of already-prepared local immutable bytes and their custody.
/// Opening a reader must not fetch remote data or start new effects.
pub trait ImmutableContentBody: Send + Sync + 'static {
    fn reader(&self) -> io::Result<Box<dyn Read + Send + '_>>;
}

/// Immutable content staged in the same Root commit as its canonical owner/pin.
#[derive(Clone)]
pub struct ContentBlob {
    pub(crate) reference: ContentRef,
    body: Body,
}
#[derive(Clone)]
enum Body {
    Memory(Arc<[u8]>),
    Prepared(Arc<dyn ImmutableContentBody>),
}
impl ContentBlob {
    pub fn new(bytes: Vec<u8>) -> Self {
        Self {
            reference: ContentRef {
                digest: content_digest(&bytes),
                bytes: bytes.len() as u64,
            },
            body: Body::Memory(bytes.into()),
        }
    }
    pub fn json<T: Serialize>(value: &T) -> Result<Self, StoreError> {
        Ok(Self::new(serde_json::to_vec(value)?))
    }
    pub fn reference(&self) -> &ContentRef {
        &self.reference
    }
    pub fn prepared(
        reference: ContentRef,
        body: Arc<dyn ImmutableContentBody>,
    ) -> Result<Self, StoreError> {
        reference.validate().map_err(invalid)?;
        Ok(Self {
            reference,
            body: Body::Prepared(body),
        })
    }
    #[cfg(test)]
    pub(crate) fn store_legacy(&self, connection: &Connection) -> Result<i64, StoreError> {
        use rusqlite::{OptionalExtension, params};
        let Body::Memory(bytes) = &self.body else {
            return Err(invalid("legacy test content must be in memory"));
        };
        if let Some(id) = connection
            .query_row(
                "SELECT id FROM contents WHERE content_sha256=?1",
                [&self.reference.digest],
                |r| r.get(0),
            )
            .optional()?
        {
            return Ok(id);
        }
        Ok(connection.query_row(
            "INSERT INTO contents(content_sha256,payload) VALUES(?1,?2) RETURNING id",
            params![&self.reference.digest, bytes.as_ref()],
            |r| r.get(0),
        )?)
    }
    pub(crate) fn store(&self, connection: &Connection) -> Result<i64, StoreError> {
        match &self.body {
            Body::Memory(bytes) => content::put(connection, &self.reference.digest, bytes),
            Body::Prepared(body) => {
                let mut reader = body.reader()?;
                content::put_stream(
                    connection,
                    &self.reference.digest,
                    self.reference.bytes,
                    reader.as_mut(),
                )
            }
        }
    }
}
