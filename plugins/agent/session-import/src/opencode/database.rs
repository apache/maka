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

use super::{Message, Part, Session, Snapshot};
use crate::{Error, Transcript, transcript::identity};
use maka_capabilities::filesystem::database::Cell;
use maka_capabilities::filesystem::database::Query;
use maka_capabilities::filesystem::database::Read;
use maka_capabilities::filesystem::database::Table;
use serde_json::value::RawValue;

/// Reads only the selected session through the caller's public Host-path authority.
/// All three tables come from one WAL-aware snapshot, with no source mutation.
pub async fn read(
    views: &(impl crate::access::ReadSource + ?Sized),
    path: String,
    session_id: &str,
) -> Result<Transcript, Error> {
    identity(session_id)?;
    let tables = views.query_database(Read {
        path,
        queries: [
            "SELECT id,parent_id,directory,title,revert FROM session WHERE id=?1",
            "SELECT id,time_created,data FROM message WHERE session_id=?1 ORDER BY time_created,id",
            "SELECT id,message_id,time_created,data FROM part WHERE session_id=?1 ORDER BY message_id,id",
        ].into_iter().map(|sql| Query {
            sql: sql.into(), parameters: vec![Cell::Text(session_id.into())],
        }).collect(),
    }).await?;
    super::convert(decode(tables)?, session_id)
}

fn decode(tables: Vec<Table>) -> Result<Snapshot, Error> {
    let [session, messages, parts]: [Table; 3] = tables
        .try_into()
        .map_err(|_| Error::Invalid("incomplete OpenCode snapshot"))?;
    let [session]: [Vec<Cell>; 1] = rows(
        session,
        &["id", "parent_id", "directory", "title", "revert"],
    )?
    .try_into()
    .map_err(|_| Error::Invalid("OpenCode session missing or ambiguous"))?;
    let [id, parent_id, directory, title, revert] = fields(session)?;
    let session = Session {
        id: text(id)?,
        parent_id: optional_text(parent_id)?,
        directory: optional_text(directory)?,
        title: optional_text(title)?,
        revert: optional_text(revert)?
            .map(|value| {
                serde_json::from_str(&value)
                    .map_err(|_| Error::Invalid("invalid OpenCode revert marker"))
            })
            .transpose()?,
    };
    let messages = rows(messages, &["id", "time_created", "data"])?
        .into_iter()
        .map(|row| {
            let [id, created_at, data] = fields(row)?;
            Ok(Message {
                id: text(id)?,
                created_at: timestamp(created_at)?,
                data: json(data)?,
            })
        })
        .collect::<Result<_, Error>>()?;
    let parts = rows(parts, &["id", "message_id", "time_created", "data"])?
        .into_iter()
        .map(|row| {
            let [id, message_id, created_at, data] = fields(row)?;
            Ok(Part {
                id: text(id)?,
                message_id: text(message_id)?,
                created_at: timestamp(created_at)?,
                data: json(data)?,
            })
        })
        .collect::<Result<_, Error>>()?;
    Ok(Snapshot {
        session,
        messages,
        parts,
    })
}

fn rows(table: Table, columns: &[&str]) -> Result<Vec<Vec<Cell>>, Error> {
    if table.columns != columns {
        return Err(Error::Invalid("unexpected OpenCode columns"));
    }
    Ok(table.rows)
}
fn fields<const N: usize>(row: Vec<Cell>) -> Result<[Cell; N], Error> {
    row.try_into()
        .map_err(|_| Error::Invalid("invalid OpenCode row width"))
}
fn text(cell: Cell) -> Result<String, Error> {
    match cell {
        Cell::Text(value) => Ok(value),
        _ => Err(Error::Invalid("OpenCode field is not text")),
    }
}
fn optional_text(cell: Cell) -> Result<Option<String>, Error> {
    match cell {
        Cell::Null => Ok(None),
        cell => text(cell).map(Some),
    }
}
fn timestamp(cell: Cell) -> Result<Option<u64>, Error> {
    match cell {
        Cell::Null => Ok(None),
        Cell::Integer(value) if (0..=9_007_199_254_740_991).contains(&value) => {
            Ok(Some(value as u64))
        }
        _ => Err(Error::Invalid("invalid OpenCode timestamp")),
    }
}
fn json(cell: Cell) -> Result<Box<RawValue>, Error> {
    RawValue::from_string(text(cell)?).map_err(|_| Error::Invalid("invalid OpenCode JSON"))
}
