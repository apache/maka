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
use maka_agent_facts::history::RowPosition;
use rusqlite::{Connection, params};

pub(crate) fn record(
    db: &Connection,
    session: &str,
    position: RowPosition,
    payload: &[u8],
) -> Result<(), StoreError> {
    let sequence = position.source_sequence as i64;
    let item = position.item_index as i64;
    let body: String = db
        .prepare_cached(&format!(
            "WITH source(payload) AS (VALUES(?1)) SELECT {} FROM source",
            crate::transcript::directory::RECALL_BODY
        ))?
        .query_row([payload], |row| row.get(0))?;
    let folded = super::fold(&body);
    let inserted = db.prepare_cached(
        "INSERT INTO recall_documents(session_id,source_sequence,item_index,message_id,turn_id,timestamp,role,body,folded,attachments)
         SELECT session_id,source_sequence,item_index,message_id,turn_id,timestamp,role,?4,?5,
             CASE WHEN role='user' THEN COALESCE(json_extract(?6,'$.attachments'),'[]') ELSE '[]' END
         FROM transcript_directory WHERE session_id=?1 AND source_sequence=?2 AND item_index=?3"
    )?.execute(params![session, sequence, item, body, folded, payload])?;
    if inserted != 1 {
        return Err(StoreError::TranscriptConflict);
    }
    if !folded.is_empty() {
        let id = db.last_insert_rowid();
        db.prepare_cached("INSERT INTO recall_terms(rowid,grams) VALUES(?1,?2)")?
            .execute(params![id, super::grams(&folded)])?;
    }
    Ok(())
}
