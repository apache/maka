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

use super::read::{sql_number, sql_position};
use crate::{EventLog, StoreError, artifacts::ImageChunk};
use maka_agent_facts::attachment::{AttachmentKind, AttachmentRef, StorageRef};
use maka_agent_facts::history::RowPosition;
use maka_agent_facts::tool_output::ImageOutput;
use rusqlite::OptionalExtension;

impl EventLog {
    /// Read only an immutable user upload belonging to this Session.
    pub async fn uploaded_image(
        &self,
        session: &str,
        id: &str,
        offset: u64,
        limit: usize,
    ) -> Result<ImageChunk, StoreError> {
        crate::sessions::validate_id(session)?;
        sql_number(offset)?;
        if limit == 0 || limit > 32 * 1024 {
            return Err(invalid("invalid attachment image window"));
        }
        let (session, id) = (session.to_owned(), id.to_owned());
        self.connection
            .read(move |connection| {
                let tx = rusqlite::Transaction::new_unchecked(
                    connection,
                    rusqlite::TransactionBehavior::Deferred,
                )?;
                let chunk = crate::artifacts::read_attachment_image(
                    &tx, &session, &id, None, offset, limit,
                )?;
                tx.commit()?;
                Ok(chunk)
            })
            .await
    }

    /// Resolve one attachment of the selected immutable user row at its fence.
    pub async fn attachment_image(
        &self,
        session: &str,
        through: u64,
        position: RowPosition,
        attachment_index: u32,
        offset: u64,
        limit: usize,
    ) -> Result<ImageChunk, StoreError> {
        crate::sessions::validate_id(session)?;
        sql_number(through)?;
        sql_number(offset)?;
        if position.source_sequence > through || limit == 0 || limit > 32 * 1024 {
            return Err(invalid("invalid attachment image window"));
        }
        let (source_sequence, item_index) = sql_position(position)?;
        let session = session.to_owned();
        self.connection
            .observe(move |connection| {
                super::bodycache::run(connection, move |tx| {
                    super::directory::ensure(tx, &session, through)?;
                    super::bodycache::ensure(tx, &session, position)?;
                    let raw: String = tx.query_row("SELECT a.value FROM temp.transcript_rows r, json_each(r.payload, '$.attachments') a
                         WHERE r.owner_key = ?1 AND r.source_sequence = ?2 AND r.item_index = ?3
                         AND json_extract(r.payload, '$.type') = 'user' AND a.key = ?4", rusqlite::params![&session, source_sequence, item_index, i64::from(attachment_index)], |row| row.get(0)).optional()
                    ?
                    .ok_or_else(|| invalid("canonical image attachment not found"))?;
                    let attachment: AttachmentRef = serde_json::from_str(&raw)?;
                    let StorageRef::SessionFile {
                        session_id,
                        relative_path,
                    } = &attachment.storage_ref
                    else {
                        return Err(invalid("image attachment has no immutable upload"));
                    };
                    if session_id != &session || attachment.kind != AttachmentKind::Image {
                        return Err(invalid("image attachment is outside this Session"));
                    }
                    let chunk = crate::artifacts::read_attachment_image(
                        tx,
                        &session,
                        relative_path,
                        Some(&attachment),
                        offset,
                        limit,
                    )
                    ?;

                    Ok(chunk)
                })
            })
            .await
    }

    /// Resolve only the immutable image selected by this canonical row/fence.
    pub async fn tool_image(
        &self,
        session: &str,
        through: u64,
        position: RowPosition,
        offset: u64,
        limit: usize,
    ) -> Result<ImageChunk, StoreError> {
        self.tool_image_at(session, through, position, None, offset, limit)
            .await
    }

    /// Without an index, the row's content must be the image. With one, select
    /// that image among those the model received beside the row's content.
    pub async fn tool_image_at(
        &self,
        session: &str,
        through: u64,
        position: RowPosition,
        index: Option<u32>,
        offset: u64,
        limit: usize,
    ) -> Result<ImageChunk, StoreError> {
        crate::sessions::validate_id(session)?;
        sql_number(through)?;
        if position.source_sequence > through || limit == 0 || limit > 32 * 1024 {
            return Err(invalid("invalid tool image window"));
        }
        let (source_sequence, item_index) = sql_position(position)?;
        sql_number(offset)?;
        let session = session.to_owned();
        self.connection
            .observe(move |connection| {
                super::bodycache::run(connection, move |tx| {
                    super::directory::ensure(tx, &session, through)?;
                    super::bodycache::ensure(tx, &session, position)?;
                    let query = match index {
                        None => "SELECT json_remove(json_extract(payload, '$.content'), '$.kind')
                 FROM temp.transcript_rows WHERE owner_key = ?1 AND source_sequence = ?2 AND item_index = ?3
                 AND json_extract(payload, '$.type') = 'tool_result'
                 AND json_extract(payload, '$.content.kind') = 'image' AND ?4 IS NULL",
                        Some(_) => "SELECT image.value
                 FROM temp.transcript_rows, json_each(payload, '$.images') image
                 WHERE owner_key = ?1 AND source_sequence = ?2 AND item_index = ?3
                 AND json_extract(payload, '$.type') = 'tool_result'
                 AND image.key = ?4 AND image.type = 'object'",
                    };
                    let raw: String = tx.query_row(query, rusqlite::params![&session,source_sequence,item_index,index.map(i64::from)], |row| row.get(0)).optional()?.ok_or_else(|| invalid("canonical tool image not found"))?;
                    let image: ImageOutput = serde_json::from_str(&raw)?;
                    let StorageRef::SessionFile {
                        session_id,
                        relative_path,
                    } = image.reference
                    else {
                        return Err(invalid("tool image has no immutable artifact"));
                    };
                    if session_id != session {
                        return Err(invalid("tool image belongs to another Session"));
                    }
                    let chunk = crate::artifacts::read_image(
                        tx,
                        &session,
                        &relative_path,
                        &image.mime_type,
                        offset,
                        limit,
                        position.source_sequence,
                    )
                    ?;

                    Ok(chunk)
                })
            })
            .await
    }
}
fn invalid(message: &str) -> StoreError {
    StoreError::InvalidTransition(message.into())
}
