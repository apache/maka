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

use crate::{Error, client::Client};
use maka_agent_api::contract::{HistoryChunk, HistoryPage, HistoryPosition};
use maka_agent_ports::session::history::{HistoryField, RowPosition};
use serde_json::json;
use std::{collections::HashSet, future::Future};

/// Freeze the original raw-event fence, including while the durable view prepares.
pub async fn read(
    client: &Client,
    session: &str,
    through: Option<u64>,
    after: Option<u64>,
) -> Result<Vec<HistoryChunk>, Error> {
    Ok(read_pages(
        |through, position| client.query("agent", "history", json!({"sessionId":session,"through":through,"position":position,"includeThinking":true})),
        through,
        after.map_or(HistoryPosition::Start, |sequence| HistoryPosition::Event { sequence: sequence + 1 }),
        None,
    ).await?.chunks)
}

pub(crate) struct Snapshot {
    pub through: u64,
    pub chunks: Vec<HistoryChunk>,
}

pub(crate) async fn since(
    client: &Client,
    session: &str,
    through: u64,
    after: u64,
) -> Result<Snapshot, Error> {
    since_with(
        |through, position| client.query("agent", "history", json!({"sessionId":session,"through":through,"position":position,"includeThinking":true})),
        through,
        after,
    ).await
}

async fn since_with<Q, F>(query: Q, through: u64, after: u64) -> Result<Snapshot, Error>
where
    Q: FnMut(Option<u64>, HistoryPosition) -> F,
    F: Future<Output = Result<HistoryPage, Error>>,
{
    if through <= after {
        return Ok(Snapshot {
            through: after,
            chunks: Vec::new(),
        });
    }
    read_pages(
        query,
        Some(through),
        HistoryPosition::Event {
            sequence: after + 1,
        },
        None,
    )
    .await
}

pub(crate) async fn row(
    client: &Client,
    session: &str,
    through: u64,
    position: RowPosition,
) -> Result<Vec<HistoryChunk>, Error> {
    Ok(read_pages(
        |through, position| client.query("agent", "history", json!({"sessionId":session,"through":through,"position":position,"includeThinking":true})),
        Some(through),
        HistoryPosition::Row { position, field: HistoryField::Body },
        Some(position),
    ).await?.chunks)
}

pub(crate) async fn model_metadata(
    client: &Client,
    session: &str,
    through: u64,
    position: RowPosition,
    field: HistoryField,
) -> Result<HistoryChunk, Error> {
    metadata_with(
        |through, position| client.query("agent", "history", json!({"sessionId":session,"through":through,"position":position,"includeThinking":true})),
        through, position, field,
    ).await
}

async fn metadata_with<Q, F>(
    mut query: Q,
    through: u64,
    position: RowPosition,
    field: HistoryField,
) -> Result<HistoryChunk, Error>
where
    Q: FnMut(Option<u64>, HistoryPosition) -> F,
    F: Future<Output = Result<HistoryPage, Error>>,
{
    let HistoryPage::Ready {
        through: fence,
        chunks,
        ..
    } = query(Some(through), HistoryPosition::Row { position, field }).await?;
    freeze(&mut Some(through), fence)?;
    let chunk = chunks
        .into_iter()
        .next()
        .ok_or("History omitted the requested model row")?;
    if chunk.position != position || chunk.field != field {
        return Err("History changed the requested model row".into());
    }
    Ok(chunk)
}

async fn read_pages<Q, F>(
    mut query: Q,
    mut through: Option<u64>,
    mut position: HistoryPosition,
    row: Option<RowPosition>,
) -> Result<Snapshot, Error>
where
    Q: FnMut(Option<u64>, HistoryPosition) -> F,
    F: Future<Output = Result<HistoryPage, Error>>,
{
    let mut history = Vec::new();
    let mut cursors = HashSet::new();
    loop {
        let HistoryPage::Ready {
            through: fence,
            chunks,
            after: next,
            ..
        } = query(through, position).await?;
        freeze(&mut through, fence)?;
        for chunk in chunks {
            if let Some(row) = row {
                if chunk.position != row || chunk.field != HistoryField::Body {
                    return Err("History omitted the requested tool row".into());
                }
                let complete = chunk.offset + chunk.text.len() as u64 == chunk.total_bytes;
                history.push(chunk);
                if complete {
                    return Ok(Snapshot {
                        through: fence,
                        chunks: history,
                    });
                }
            } else {
                history.push(chunk);
            }
        }
        let Some(cursor) = next else {
            if row.is_some() {
                return Err("History tool row is incomplete".into());
            }
            return Ok(Snapshot {
                through: fence,
                chunks: history,
            });
        };
        if !cursors.insert(serde_json::to_string(&cursor)?) {
            return Err("History cursor repeated".into());
        }
        position = HistoryPosition::After { cursor };
    }
}

fn freeze(through: &mut Option<u64>, fence: u64) -> Result<(), Error> {
    if through.is_some_and(|through| through != fence) {
        return Err("History fence changed during replay".into());
    }
    *through = Some(fence);
    Ok(())
}

#[cfg(test)]
mod tests;

#[cfg(test)]
mod model_metadata_tests;
