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

use crate::{EventLog, StoreError, sequence_number, sessions};
use maka_agent_facts::history::RowPosition;
use sqlx::Row;

#[derive(Clone, Copy, Debug)]
pub enum TranscriptDirection {
    Older,
    Newer,
}
pub struct TranscriptRead {
    pub through: u64,
    /// Inclusive row position; None starts at the beginning or tail.
    pub position: Option<RowPosition>,
    pub direction: TranscriptDirection,
    pub limit: usize,
}
#[derive(Debug)]
pub struct TranscriptRowHeader {
    pub position: RowPosition,
    pub turn_id: String,
    pub total_bytes: u64,
    pub digest: String,
}
#[derive(Debug)]
pub struct TranscriptTurnBounds {
    pub first: RowPosition,
    pub last: RowPosition,
    pub rows: u64,
    pub bytes: u64,
}
impl EventLog {
    /// True only when no logical Turn straddles the cut, including resumed Turns.
    pub async fn transcript_between_turns(
        &self,
        session: &str,
        through: u64,
        cut: RowPosition,
    ) -> Result<bool, StoreError> {
        self.validate_root()?;
        sessions::validate_id(session)?;
        let session = session.to_owned();
        let fence = sql_number(through)?;
        let (source, item) = sql_position(cut)?;
        self.connection
            .read(move |connection| {
                Box::pin(async move {
                    super::directory::check_read(connection, &session, through).await?;
                    let crossing: bool = sqlx::query_scalar(
                        "SELECT EXISTS(SELECT 1 FROM transcript_directory
                 WHERE session_id = ?1 AND source_sequence <= ?2
                 GROUP BY turn_id HAVING
                    SUM((source_sequence,item_index) <= (?3,?4)) > 0
                    AND SUM((source_sequence,item_index) > (?3,?4)) > 0)",
                    )
                    .bind(session)
                    .bind(fence)
                    .bind(source)
                    .bind(item)
                    .fetch_one(connection)
                    .await?;
                    Ok(!crossing)
                })
            })
            .await
    }
    pub async fn transcript_headers(
        &self,
        session: &str,
        read: &TranscriptRead,
    ) -> Result<Vec<TranscriptRowHeader>, StoreError> {
        self.validate_root()?;
        sessions::validate_id(session)?;
        if read.limit == 0 || read.limit > 256 {
            return Err(invalid("invalid transcript header limit"));
        }
        let through = sql_number(read.through)?;
        let mut position = read.position.map(sql_position).transpose()?;
        // Older anchors beyond the fence read from its tail. Otherwise the
        // anchor itself implies the fence and supplies the sole seek upper bound.
        if matches!(read.direction, TranscriptDirection::Older)
            && read
                .position
                .is_some_and(|position| position.source_sequence > read.through)
        {
            position = None;
        }
        let session = session.to_owned();
        let fence = read.through;
        let direction = read.direction;
        let limit = read.limit as i64;
        self.connection.observe(move |connection| super::bodycache::run(connection, move |tx| Box::pin(async move {
            super::directory::check_read(tx, &session, fence).await?;
            let query = match (direction, position.is_some()) {
                (TranscriptDirection::Older, true) => "SELECT source_sequence,item_index,turn_id FROM transcript_directory WHERE session_id=?1 AND (source_sequence,item_index)<=(?3,?4) ORDER BY source_sequence DESC,item_index DESC LIMIT ?2",
                (TranscriptDirection::Newer, true) => "SELECT source_sequence,item_index,turn_id FROM transcript_directory WHERE session_id=?1 AND source_sequence<=?2 AND (source_sequence,item_index)>=(?4,?5) ORDER BY source_sequence,item_index LIMIT ?3",
                (TranscriptDirection::Older, false) => "SELECT source_sequence,item_index,turn_id FROM transcript_directory WHERE session_id=?1 AND source_sequence<=?2 ORDER BY source_sequence DESC,item_index DESC LIMIT ?3",
                (TranscriptDirection::Newer, false) => "SELECT source_sequence,item_index,turn_id FROM transcript_directory WHERE session_id=?1 AND source_sequence<=?2 ORDER BY source_sequence,item_index LIMIT ?3",
            };
            let mut query = sqlx::query(sqlx::AssertSqlSafe(query)).bind(&session);
            if !(matches!(direction, TranscriptDirection::Older) && position.is_some()) {
                query=query.bind(through);
            }
            query=query.bind(limit);
            if let Some((source,item))=position { query=query.bind(source).bind(item); }
            let selected = query.fetch_all(&mut *tx).await?;
            let mut result = Vec::with_capacity(selected.len());
            for row in selected {
                let position = row_position(row.try_get(0)?, row.try_get(1)?)?;
                super::bodycache::ensure(tx, &session, position).await?;
                let (bytes, digest): (i64, String) = sqlx::query_as("SELECT total_bytes,digest FROM temp.transcript_rows WHERE session_id=?1 AND source_sequence=?2 AND item_index=?3")
                    .bind(&session).bind(sql_position(position)?.0).bind(sql_position(position)?.1).fetch_one(&mut *tx).await?;
                result.push(TranscriptRowHeader { position, turn_id: row.try_get(2)?, total_bytes: sequence_number(bytes)?, digest });
            }

            Ok(result)
        }))).await
    }
    /// Slice immutable UTF-8 JSON bytes; assembly may cross code points.
    pub async fn transcript_fragment(
        &self,
        session: &str,
        position: RowPosition,
        offset: u64,
        length: u64,
    ) -> Result<Vec<u8>, StoreError> {
        self.validate_root()?;
        sessions::validate_id(session)?;
        if length == 0 || length > 512 * 1024 {
            return Err(invalid("invalid transcript fragment length"));
        }
        let (source, item) = sql_position(position)?;
        let start = sql_number(
            offset
                .checked_add(1)
                .ok_or_else(|| invalid("invalid transcript byte offset"))?,
        )?;
        let session = session.to_owned();
        self.connection.observe(move |connection| super::bodycache::run(connection, move |tx| Box::pin(async move {
            super::directory::check_read(tx, &session, position.source_sequence).await?;
            super::bodycache::ensure(tx, &session, position).await?;
            let total:i64=sqlx::query_scalar("SELECT total_bytes FROM temp.transcript_rows WHERE session_id=?1 AND source_sequence=?2 AND item_index=?3")
                .bind(&session).bind(source).bind(item).fetch_optional(&mut *tx).await?.ok_or_else(||invalid("transcript message was not found"))?;
            let total = sequence_number(total)?;
            if offset.checked_add(length).is_none_or(|end|end>total) { return Err(invalid("transcript fragment exceeds message")); }
            let bytes:Vec<u8>=sqlx::query_scalar("SELECT substr(payload,?4,?5) FROM temp.transcript_rows WHERE session_id=?1 AND source_sequence=?2 AND item_index=?3")
                .bind(&session).bind(source).bind(item).bind(start).bind(length as i64).fetch_one(&mut *tx).await?;
            if bytes.len() as u64 != length { return Err(invalid("transcript payload length changed")); }

            Ok(bytes)
        }))).await
    }
    pub async fn transcript_turn_bounds(
        &self,
        session: &str,
        turn: &str,
        through: u64,
    ) -> Result<Option<TranscriptTurnBounds>, StoreError> {
        self.validate_root()?;
        sessions::validate_id(session)?;
        sessions::validate_id(turn)?;
        let fence = sql_number(through)?;
        let session = session.to_owned();
        let turn = turn.to_owned();
        self.connection.observe(move |connection| super::bodycache::run(connection, move |tx| Box::pin(async move {
            super::directory::check_read(tx,&session,through).await?;
            let first:Option<(i64,i64)>=sqlx::query_as("SELECT source_sequence,item_index FROM transcript_directory WHERE session_id=?1 AND turn_id=?2 AND source_sequence<=?3 ORDER BY source_sequence,item_index LIMIT 1")
                .bind(&session).bind(&turn).bind(fence).fetch_optional(&mut *tx).await?;
            let Some((source,item))=first else {  return Ok(None) };
            let (last_source,last_item):(i64,i64)=sqlx::query_as("SELECT source_sequence,item_index FROM transcript_directory WHERE session_id=?1 AND turn_id=?2 AND source_sequence<=?3 ORDER BY source_sequence DESC,item_index DESC LIMIT 1")
                .bind(&session).bind(&turn).bind(fence).fetch_one(&mut *tx).await?;
            // Exact serialized bytes intentionally visit the whole requested Turn.
            // Page locators at the existing header batch size, rather than retaining
            // an unbounded Turn's positions while its selected bodies are generated.
            let rows: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM transcript_directory WHERE session_id=?1 AND turn_id=?2 AND source_sequence<=?3")
                .bind(&session).bind(&turn).bind(fence).fetch_one(&mut *tx).await?;
            let rows=sequence_number(rows)?;
            let mut bytes=0u64;
            let mut cursor=(0i64,0i64);
            loop {
                let selected: Vec<(i64,i64)> = sqlx::query_as("SELECT source_sequence,item_index FROM transcript_directory WHERE session_id=?1 AND turn_id=?2 AND source_sequence<=?3 AND (source_sequence,item_index)>(?4,?5) ORDER BY source_sequence,item_index LIMIT 256")
                    .bind(&session).bind(&turn).bind(fence).bind(cursor.0).bind(cursor.1).fetch_all(&mut *tx).await?;
                if selected.is_empty() { break; }
                for (source,item) in selected {
                    super::bodycache::ensure(tx,&session,row_position(source,item)?).await?;
                    let size: i64=sqlx::query_scalar("SELECT total_bytes FROM temp.transcript_rows WHERE session_id=?1 AND source_sequence=?2 AND item_index=?3")
                        .bind(&session).bind(source).bind(item).fetch_one(&mut *tx).await?;
                    bytes=bytes.checked_add(sequence_number(size)?).ok_or(StoreError::PrefixTooLarge)?;
                    cursor=(source,item);
                }
            }
            let bounds = TranscriptTurnBounds { first:row_position(source,item)?,last:row_position(last_source,last_item)?,rows,bytes };

            Ok(Some(bounds))
        }))).await
    }
}
pub(super) fn sql_number(value: u64) -> Result<i64, StoreError> {
    if value > 9_007_199_254_740_991 {
        return Err(invalid("invalid transcript integer"));
    }
    Ok(value as i64)
}
pub(super) fn sql_position(position: RowPosition) -> Result<(i64, i64), StoreError> {
    position.validate().map_err(invalid)?;
    Ok((
        sql_number(position.source_sequence)?,
        sql_number(position.item_index)?,
    ))
}
pub(super) fn row_position(source: i64, item: i64) -> Result<RowPosition, StoreError> {
    let position = RowPosition {
        source_sequence: sequence_number(source)?,
        item_index: sequence_number(item)?,
    };
    position.validate().map_err(invalid)?;
    Ok(position)
}
fn invalid(message: &str) -> StoreError {
    StoreError::InvalidTransition(message.into())
}
