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
use rusqlite::OptionalExtension;

pub(super) const ORDER: &str = "SELECT order_sequence,order_item FROM transcript_directory WHERE owner_key=?1 AND source_sequence=?2 AND item_index=?3";

#[derive(Clone, Copy, Debug)]
pub enum TranscriptDirection {
    Older,
    Newer,
}
pub struct TranscriptRead {
    pub through: u64,
    /// Inclusive display-order anchor (header.order); None starts at the beginning or tail.
    pub position: Option<RowPosition>,
    pub direction: TranscriptDirection,
    pub limit: usize,
}
#[derive(Debug)]
pub struct TranscriptRowHeader {
    pub order: RowPosition,
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
        sessions::validate_id(session)?;
        let session = session.to_owned();
        let fence = sql_number(through)?;
        let (source, item) = sql_position(cut)?;
        self.connection
            .observe(move |connection| {
                super::bodycache::run(connection, move |tx| {
                    {
                        super::directory::ensure(tx, &session, through)?;
                        let crossing: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM transcript_directory
                 WHERE owner_key = ?1 AND source_sequence <= ?2 AND order_sequence <= ?2
                 GROUP BY turn_id HAVING
                    SUM((order_sequence,order_item) <= (
                        COALESCE((SELECT order_sequence FROM transcript_directory WHERE owner_key=?1 AND source_sequence=?3 AND item_index=?4), ?3),
                        COALESCE((SELECT order_item FROM transcript_directory WHERE owner_key=?1 AND source_sequence=?3 AND item_index=?4), ?4)
                    )) > 0
                    AND SUM((order_sequence,order_item) > (
                        COALESCE((SELECT order_sequence FROM transcript_directory WHERE owner_key=?1 AND source_sequence=?3 AND item_index=?4), ?3),
                        COALESCE((SELECT order_item FROM transcript_directory WHERE owner_key=?1 AND source_sequence=?3 AND item_index=?4), ?4)
                    )) > 0)", rusqlite::params![session, fence, source, item], |row| row.get(0))
                        ?;
                        Ok(!crossing)
                    }
                })
            })
            .await
    }
    pub async fn transcript_headers(
        &self,
        session: &str,
        read: &TranscriptRead,
    ) -> Result<Vec<TranscriptRowHeader>, StoreError> {
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
        self.connection.observe(move |connection| super::bodycache::run(connection, move |tx| {
            super::directory::ensure(tx, &session, fence)?;
            let order_position = position;
            let query = match (direction, order_position.is_some()) {
                (TranscriptDirection::Older, true) => "SELECT source_sequence,item_index,turn_id,order_sequence,order_item FROM transcript_directory INDEXED BY directory_order WHERE owner_key=?1 AND source_sequence<=?2 AND (order_sequence,order_item)<=(?4,?5) ORDER BY order_sequence DESC,order_item DESC LIMIT ?3",
                (TranscriptDirection::Newer, true) => "SELECT source_sequence,item_index,turn_id,order_sequence,order_item FROM transcript_directory INDEXED BY directory_order WHERE owner_key=?1 AND source_sequence<=?2 AND order_sequence<=?2 AND (order_sequence,order_item)>=(?4,?5) ORDER BY order_sequence,order_item LIMIT ?3",
                (TranscriptDirection::Older, false) => "SELECT source_sequence,item_index,turn_id,order_sequence,order_item FROM transcript_directory WHERE owner_key=?1 AND source_sequence<=?2 AND order_sequence<=?2 ORDER BY order_sequence DESC,order_item DESC LIMIT ?3",
                (TranscriptDirection::Newer, false) => "SELECT source_sequence,item_index,turn_id,order_sequence,order_item FROM transcript_directory WHERE owner_key=?1 AND source_sequence<=?2 AND order_sequence<=?2 ORDER BY order_sequence,order_item LIMIT ?3",
            };
            let mut statement = tx.prepare_cached(query)?;
            let decode = |row: &rusqlite::Row<'_>| Ok((row.get::<_, i64>(0)?,row.get::<_, i64>(1)?,row.get::<_, String>(2)?,row.get::<_, i64>(3)?,row.get::<_, i64>(4)?));
            let selected = if let Some((source,item)) = order_position {
                statement.query_map(rusqlite::params![&session,through,limit,source,item], decode)?.collect::<Result<Vec<_>,_>>()?
            } else {
                statement.query_map(rusqlite::params![&session,through,limit], decode)?.collect::<Result<Vec<_>,_>>()?
            };
            let mut result = Vec::with_capacity(selected.len());
            for row in selected {
                let position = row_position(row.0, row.1)?;
                super::bodycache::ensure(tx, &session, position)?;
                let (bytes, digest): (i64, String) = tx.query_row("SELECT total_bytes,digest FROM temp.transcript_rows WHERE owner_key=?1 AND source_sequence=?2 AND item_index=?3", rusqlite::params![&session, sql_position(position)?.0, sql_position(position)?.1], |row| Ok((row.get(0)?, row.get(1)?,)))?;
                result.push(TranscriptRowHeader { position, order: row_position(row.3,row.4)?, turn_id: row.2, total_bytes: sequence_number(bytes)?, digest });
            }

            Ok(result)
        })).await
    }
    /// Slice immutable UTF-8 JSON bytes; assembly may cross code points.
    pub async fn transcript_fragment(
        &self,
        session: &str,
        position: RowPosition,
        offset: u64,
        length: u64,
    ) -> Result<Vec<u8>, StoreError> {
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
        self.connection.observe(move |connection| super::bodycache::run(connection, move |tx| {
            super::directory::ensure(tx, &session, position.source_sequence)?;
            super::bodycache::ensure(tx, &session, position)?;
            let total:i64=tx.query_row("SELECT total_bytes FROM temp.transcript_rows WHERE owner_key=?1 AND source_sequence=?2 AND item_index=?3", rusqlite::params![&session, source, item], |row| row.get(0)).optional()?.ok_or_else(||invalid("transcript message was not found"))?;
            let total = sequence_number(total)?;
            if offset.checked_add(length).is_none_or(|end|end>total) { return Err(invalid("transcript fragment exceeds message")); }
            let bytes:Vec<u8>=tx.query_row("SELECT substr(payload,?4,?5) FROM temp.transcript_rows WHERE owner_key=?1 AND source_sequence=?2 AND item_index=?3", rusqlite::params![&session, source, item, start, length as i64], |row| row.get(0))?;
            if bytes.len() as u64 != length { return Err(invalid("transcript payload length changed")); }

            Ok(bytes)
        })).await
    }
    pub async fn transcript_turn_bounds(
        &self,
        session: &str,
        turn: &str,
        through: u64,
    ) -> Result<Option<TranscriptTurnBounds>, StoreError> {
        sessions::validate_id(session)?;
        sessions::validate_id(turn)?;
        let fence = sql_number(through)?;
        let session = session.to_owned();
        let turn = turn.to_owned();
        self.connection.observe(move |connection| super::bodycache::run(connection, move |tx| {
            super::directory::ensure(tx,&session,through)?;
            let first:Option<(i64,i64)>=tx.query_row("SELECT source_sequence,item_index FROM transcript_directory WHERE owner_key=?1 AND turn_id=?2 AND source_sequence<=?3 AND order_sequence<=?3 ORDER BY order_sequence,order_item LIMIT 1", rusqlite::params![&session, &turn, fence], |row| Ok((row.get(0)?, row.get(1)?,))).optional()?;
            let Some((source,item))=first else {  return Ok(None) };
            let (last_source,last_item):(i64,i64)=tx.query_row("SELECT source_sequence,item_index FROM transcript_directory WHERE owner_key=?1 AND turn_id=?2 AND source_sequence<=?3 AND order_sequence<=?3 ORDER BY order_sequence DESC,order_item DESC LIMIT 1", rusqlite::params![&session, &turn, fence], |row| Ok((row.get(0)?, row.get(1)?,)))?;
            // Exact serialized bytes intentionally visit the whole requested Turn.
            // Page locators at the existing header batch size, rather than retaining
            // an unbounded Turn's positions while its selected bodies are generated.
            let rows: i64 = tx.query_row("SELECT COUNT(*) FROM transcript_directory WHERE owner_key=?1 AND turn_id=?2 AND source_sequence<=?3 AND order_sequence<=?3", rusqlite::params![&session, &turn, fence], |row| row.get(0))?;
            let rows=sequence_number(rows)?;
            let mut bytes=0u64;
            let mut cursor=(0i64,0i64);
            loop {
                let selected: Vec<(i64,i64)> = tx.prepare_cached("SELECT source_sequence,item_index FROM transcript_directory WHERE owner_key=?1 AND turn_id=?2 AND source_sequence<=?3 AND order_sequence<=?3 AND (source_sequence,item_index)>(?4,?5) ORDER BY source_sequence,item_index LIMIT 256")?.query_map(rusqlite::params![&session, &turn, fence, cursor.0, cursor.1], |row| Ok((row.get(0)?, row.get(1)?,)))?.collect::<Result<Vec<_>, _>>()?;
                if selected.is_empty() { break; }
                for (source,item) in selected {
                    super::bodycache::ensure(tx,&session,row_position(source,item)?)?;
                    let size: i64=tx.query_row("SELECT total_bytes FROM temp.transcript_rows WHERE owner_key=?1 AND source_sequence=?2 AND item_index=?3", rusqlite::params![&session, source, item], |row| row.get(0))?;
                    bytes=bytes.checked_add(sequence_number(size)?).ok_or(StoreError::PrefixTooLarge)?;
                    cursor=(source,item);
                }
            }
            let bounds = TranscriptTurnBounds { first:row_position(source,item)?,last:row_position(last_source,last_item)?,rows,bytes };

            Ok(Some(bounds))
        })).await
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
