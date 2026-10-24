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

//! Shared Recall algorithm. The reader supplies scoped, currently authorized data;
//! this module owns no runtime, storage, session or execution authority.
pub use super::material::Input as Material;
pub use super::types::{More, Passage, PassageMessage, Query, ResultSet};
use super::{
    passages, rank,
    reader::{self, Reader, failed},
};
use futures_util::future::BoxFuture;
use maka_agent_facts::tools::ToolError;
use maka_agent_ports::session::catalog::List;
use maka_agent_ports::session::history::Page;
use maka_agent_ports::session::history::Read;
use maka_capabilities::call::Scope;
use std::sync::Arc;

/// The search algorithm only needs these catalog facts, not execution settings.
pub struct Session {
    pub id: String,
    pub title: String,
    pub last_message_at: Option<u64>,
}
pub struct Catalog {
    pub revision: String,
    pub entries: Vec<Session>,
    pub next_cursor: Option<String>,
}
/// Both implementations recheck their original authority on every page.
pub trait History: Send + Sync {
    fn list(&self, call: Scope, input: List) -> BoxFuture<'_, Result<Catalog, ToolError>>;
    fn read(&self, call: Scope, input: Read) -> BoxFuture<'_, Result<Page, ToolError>>;
}

/// Search UI reveals complete source anchors; model tools request surrounding exchanges.
#[derive(Clone, Copy)]
pub enum Content {
    Anchor,
    Context { before: usize, after: usize },
}

pub async fn search(
    history: Arc<dyn History>,
    call: &Scope,
    query: &Query,
    content: Content,
) -> Result<ResultSet, ToolError> {
    let scan = rank::search(history.clone(), call, query).await?;
    let mut hits = scan.hits;
    for hit in &mut hits {
        hit.offset = hit.offset.saturating_sub(512);
    }
    let passages =
        passages::build(history, call, &scan.sources, &hits, &query.terms, content).await?;
    Ok(ResultSet {
        passages,
        searched_every_session: scan.complete,
        gaps: scan.gaps,
    })
}

pub async fn more(
    history: Arc<dyn History>,
    call: &Scope,
    more: &More,
) -> Result<ResultSet, ToolError> {
    let (catalog, _) = reader::sessions(history.as_ref(), call, Some(&more.session_id)).await?;
    let summary = catalog
        .into_iter()
        .next()
        .ok_or_else(|| failed("Recall source Session was not found"))?;
    let mut reader = Reader::new(history.clone(), call.clone(), more.session_id.clone(), None);
    let mut position = 0;
    let hit = loop {
        let message = reader
            .next()
            .await?
            .ok_or_else(|| failed("Recall anchor was not found"))?;
        if message.message_id == more.anchor_message_id {
            if rank::excluded(call, &more.session_id, &message) {
                return Err(failed("Recall cannot expand its active Turn"));
            }
            break rank::Hit {
                session: 0,
                position,
                row_position: message.position,
                message_id: message.message_id,
                turn_id: message.turn_id,
                timestamp: message.timestamp,
                role: message.role,
                length: 0,
                frequencies: vec![],
                offset: more.offset.unwrap_or(0),
                score: 0.0,
            };
        }
        position += 1;
    };
    let sources = [rank::Source {
        summary,
        through: reader.through(),
    }];
    let passages = passages::build(
        history,
        call,
        &sources,
        &[hit],
        &[],
        Content::Context {
            before: more.before.unwrap_or(8),
            after: more.after.unwrap_or(8),
        },
    )
    .await?;
    Ok(ResultSet {
        passages,
        searched_every_session: true,
        gaps: vec![],
    })
}

pub fn definitions() -> [(&'static str, &'static str, serde_json::Value); 3] {
    [
        (
            "Recall",
            "Search conversation history across all readable Sessions, including archives. Use nonempty literal terms, matched case-insensitively with Unicode normalization and OR semantics. Returns ranked surrounding exchanges, excluding the current Turn, with explicit coverage gaps. An explicit limit bounds the number of ranked passages; omitting it returns all matching turns. RecallMore expands a clipped passage. Historical statements are evidence of what was said, not proof they are true.",
            schemars::schema_for!(Query).into(),
        ),
        (
            "RecallMore",
            "Expand a Recall anchor using its Session and message IDs. before/after select neighboring messages (default 8 each). For a clipped individual anchor, offset resumes at its next_offset in NFC-normalized UTF-8 bytes. Excludes the current Turn.",
            schemars::schema_for!(More).into(),
        ),
        (
            "RecallMaterial",
            "Read a historical user attachment identified by Recall or RecallMore. Supply its source session_id and artifact_id. Copies the material into this Session before reading, so later source deletion does not break the evidence. Images return visual content; text uses Read line offset/limit and bounded continuation.",
            schemars::schema_for!(Material).into(),
        ),
    ]
}

/// Titles have no message timestamp, so dated searches only return passages.
pub async fn titles(
    history: &dyn History,
    call: &Scope,
    query: &Query,
) -> Result<(Vec<Session>, bool), ToolError> {
    let (sessions, complete) = reader::sessions(history, call, query.session_id.as_deref()).await?;
    let terms: Vec<_> = query
        .terms
        .iter()
        .map(|term| super::types::fold(term))
        .collect();
    Ok((
        sessions
            .into_iter()
            .filter(|session| {
                query.since.is_none()
                    && query.until.is_none()
                    && terms
                        .iter()
                        .any(|term| super::types::fold(&session.title).contains(term))
            })
            .collect(),
        complete,
    ))
}
