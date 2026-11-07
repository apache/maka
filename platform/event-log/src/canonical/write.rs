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

//! Bind a frozen canonical token to shared immutable bytes.
use crate::StoreError;
use std::ops::Range;

pub(crate) struct PreparedCanonical {
    pub(crate) json: String,
    pub(crate) header: Option<String>,
    body: Option<PreparedBody>,
    pub(crate) semantic: Result<crate::context::semantic::Prepared, StoreError>,
}
struct PreparedBody {
    range: Range<usize>,
    digest: String,
    json_bytes: i64,
    offset: i64,
}
impl PreparedCanonical {
    pub(crate) fn new(
        event: &maka_agent_facts::event::RuntimeEvent,
        json: String,
    ) -> Result<Self, StoreError> {
        let projection = super::recipe::projection(event.fact.kind(), &json)?;
        let header = projection
            .as_ref()
            .map(|projection| projection.header(&json))
            .transpose()?;
        let body = projection
            .map(|projection| {
                Ok::<_, StoreError>(PreparedBody {
                    range: projection.offset..projection.offset + projection.json.len(),
                    digest: maka_agent_facts::artifact::content_digest(projection.json.as_bytes()),
                    json_bytes: projection.sqlite_json_bytes() as i64,
                    offset: i64::try_from(projection.offset)
                        .map_err(|_| StoreError::PrefixTooLarge)?,
                })
            })
            .transpose()?;
        let semantic = crate::context::semantic::Prepared::new(event, &json);
        Ok(Self {
            json,
            header,
            body,
            semantic,
        })
    }
    pub(crate) fn bind_body(
        &self,
        connection: &rusqlite::Connection,
    ) -> Result<Option<crate::canonical_insert::BodyReference>, StoreError> {
        self.body
            .as_ref()
            .map(|body| {
                Ok(crate::canonical_insert::BodyReference {
                    id: crate::content::put(
                        connection,
                        &body.digest,
                        &self.json.as_bytes()[body.range.clone()],
                    )?,
                    json_bytes: body.json_bytes,
                    offset: body.offset,
                })
            })
            .transpose()
    }
}
