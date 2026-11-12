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

//! Recall results are assembled from scoped indexed matches and direct context reads.
pub use super::material::Input as Material;
pub use super::types::{More, Passage, PassageMessage, Query, ResultSet, ToolQuery};
use futures_util::future::BoxFuture;
use maka_agent_facts::{attachment::AttachmentRef, tools::ToolError};
use maka_agent_ports::session::{
    catalog::List,
    history::{Role, RowPosition},
};
use maka_capabilities::call::Scope;
use std::sync::Arc;

#[derive(Clone)]
pub struct Session {
    pub id: String,
    pub title: String,
    pub last_message_at: Option<u64>,
}
pub struct Catalog {
    pub revision: String,
    pub entries: Vec<Session>,
    pub next_cursor: Option<String>,
    pub gaps: Vec<String>,
}
pub struct Message {
    pub message_id: String,
    pub position: RowPosition,
    pub turn_id: String,
    pub timestamp: u64,
    pub role: Role,
    pub text: String,
    pub attachments: Vec<AttachmentRef>,
}
pub struct Hit {
    pub session: Session,
    pub message: Message,
    pub matched_terms: Vec<String>,
    pub score: f64,
    pub through: u64,
}
pub struct Matches {
    pub hits: Vec<Hit>,
    pub gaps: Vec<String>,
}
pub struct Anchor {
    pub message_id: String,
    pub position: RowPosition,
    pub turn_id: String,
}
pub struct Context {
    pub session: Session,
    pub anchor: Anchor,
    pub messages: Vec<Message>,
    pub has_more_before: bool,
    pub has_more_after: bool,
}
/// Each operation retains and rechecks the caller's original authority.
pub trait History: Send + Sync {
    fn list(&self, call: Scope, input: List) -> BoxFuture<'_, Result<Catalog, ToolError>>;
    fn find(&self, call: Scope, query: Query) -> BoxFuture<'_, Result<Matches, ToolError>>;
    fn context(
        &self,
        call: Scope,
        input: More,
        through: Option<u64>,
    ) -> BoxFuture<'_, Result<Context, ToolError>>;
}

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
    let found = history.find(call.clone(), query.clone()).await?;
    let mut passages = Vec::with_capacity(found.hits.len());
    for hit in found.hits {
        if call.cancellation.is_cancelled() {
            return Err(failed("Recall cancelled"));
        }
        let context = match content {
            Content::Anchor => Context {
                session: hit.session,
                anchor: Anchor {
                    message_id: hit.message.message_id.clone(),
                    position: hit.message.position.clone(),
                    turn_id: hit.message.turn_id.clone(),
                },
                messages: vec![hit.message],
                has_more_before: false,
                has_more_after: false,
            },
            Content::Context { before, after } => {
                let input = More {
                    session_id: hit.session.id,
                    anchor_message_id: hit.message.message_id.clone(),
                    before: Some(before),
                    after: Some(after),
                    text_offset: None,
                };
                drop(hit.message);
                history
                    .context(call.clone(), input, Some(hit.through))
                    .await?
            }
        };
        passages.push(passage(context, hit.matched_terms, hit.score));
    }
    Ok(ResultSet {
        passages,
        searched_every_session: found.gaps.is_empty(),
        gaps: found.gaps,
        more_passages: false,
    })
}

pub async fn more(
    history: Arc<dyn History>,
    call: &Scope,
    more: &More,
) -> Result<ResultSet, ToolError> {
    let context = history.context(call.clone(), more.clone(), None).await?;
    Ok(ResultSet {
        passages: vec![passage(context, vec![], 0.0)],
        searched_every_session: true,
        gaps: vec![],
        more_passages: false,
    })
}

fn passage(context: Context, matched_terms: Vec<String>, score: f64) -> Passage {
    let anchor_id = context.anchor.message_id;
    Passage {
        session_id: context.session.id,
        session_title: context.session.title,
        anchor_position: context.anchor.position,
        turn_id: context.anchor.turn_id,
        messages: context
            .messages
            .into_iter()
            .map(|message| PassageMessage {
                is_anchor: message.message_id == anchor_id,
                message_id: message.message_id,
                role: message.role,
                text: message.text,
                next_text_offset: None,
                timestamp: message.timestamp,
                attachments: message.attachments,
            })
            .collect(),
        anchor_message_id: anchor_id,
        matched_terms,
        score,
        has_more_before: context.has_more_before,
        has_more_after: context.has_more_after,
    }
}

pub fn definitions() -> [(&'static str, &'static str, serde_json::Value); 3] {
    [
        (
            "Recall",
            "Search original conversation history (user, assistant, tool calls, and tool results) across all readable Sessions, including archives and compacted earlier prefixes of the current Turn. Literal terms match case-insensitively with Unicode normalization and OR semantics, ranked by distinct matched terms first so multi-term queries surface passages combining your terms. Excludes only the uncompacted live tail of the current Turn. before/after select neighboring messages (default 4 each; pass 0 for an anchor-only scan). Results are byte-bounded; narrow the search if results were omitted. Use RecallMore to expand an anchor or continue a message at its next_text_offset. Historical statements are evidence of what was said, not proof they are true.",
            schemars::schema_for!(ToolQuery).into(),
        ),
        (
            "RecallMore",
            "Read bounded messages around a Recall anchor using its Session and message IDs. before/after select neighboring messages (default 8 each). To continue a long message, use its message_id as anchor_message_id and pass its next_text_offset as text_offset; this returns only that message's next chunk. Compacted earlier prefixes of the current Turn are readable; only the uncompacted live tail of the current Turn is excluded.",
            schemars::schema_for!(More).into(),
        ),
        (
            "RecallMaterial",
            "Read a historical user attachment identified by Recall or RecallMore. Supply its source session_id and artifact_id. Copies the material into this Session before reading, so later source deletion does not break the evidence. Images return visual content; text uses Read line offset/limit and continuation.",
            schemars::schema_for!(Material).into(),
        ),
    ]
}

pub const CATALOG_REVISION_CHANGED: &str = "Recall catalog revision changed";

/// Titles have no message timestamp, so dated searches only return passages.
pub async fn titles(
    history: &dyn History,
    call: &Scope,
    query: &Query,
) -> Result<(Vec<Session>, Vec<String>), ToolError> {
    if query.since.is_some() || query.until.is_some() {
        return Ok((vec![], vec![]));
    }
    let terms: Vec<_> = query
        .terms
        .iter()
        .map(|term| super::types::fold(term))
        .collect();
    for attempt in 0..3 {
        let mut input = List {
            include_archived: true,
            ..Default::default()
        };
        let mut matches = Vec::new();
        let mut gaps = Vec::new();
        let mut cursors = std::collections::BTreeSet::new();
        let mut revision_changed = false;
        loop {
            if call.cancellation.is_cancelled() {
                return Err(failed("Recall cancelled"));
            }
            let page = match history.list(call.clone(), input.clone()).await {
                Ok(page) => page,
                Err(ToolError::Failed(reason))
                    if reason == CATALOG_REVISION_CHANGED && attempt < 2 =>
                {
                    revision_changed = true;
                    break;
                }
                Err(error) => return Err(error),
            };
            if input
                .revision
                .as_ref()
                .is_some_and(|revision| revision != &page.revision)
            {
                if attempt < 2 {
                    revision_changed = true;
                    break;
                }
                return Err(failed(CATALOG_REVISION_CHANGED));
            }
            gaps.extend(page.gaps.into_iter().filter(|gap| {
                query
                    .session_id
                    .as_ref()
                    .is_none_or(|id| gap.starts_with(&format!("Session {id} ")))
            }));
            matches.extend(page.entries.into_iter().filter(|session| {
                if query
                    .session_id
                    .as_ref()
                    .is_some_and(|id| id != &session.id)
                {
                    return false;
                }
                let title = super::types::fold(&session.title);
                terms.iter().any(|term| title.contains(term))
            }));
            let Some(cursor) = page.next_cursor else {
                break;
            };
            if !cursors.insert(cursor.clone()) {
                return Err(failed("Recall catalog continuation repeated"));
            }
            input.revision = Some(page.revision);
            input.cursor = Some(cursor);
        }
        if revision_changed {
            continue;
        }
        matches.sort_by(|a, b| {
            b.last_message_at
                .cmp(&a.last_message_at)
                .then_with(|| a.id.cmp(&b.id))
        });
        return Ok((matches, gaps));
    }
    Err(failed(CATALOG_REVISION_CHANGED))
}

fn failed(error: impl std::fmt::Display) -> ToolError {
    ToolError::Failed(error.to_string())
}
