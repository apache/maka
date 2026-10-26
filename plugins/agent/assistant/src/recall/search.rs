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
pub use super::types::{More, Passage, PassageMessage, Query, ResultSet};
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
                    position: hit.message.position,
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
            "Search original conversation history across all readable Sessions, including archives. Literal terms match case-insensitively with Unicode normalization and OR semantics. Returns ranked matching turns with complete surrounding messages, excluding the current Turn. An explicit limit selects the number of ranked passages; omitting it returns all matching turns. RecallMore selects a wider context around an anchor. Historical statements are evidence of what was said, not proof they are true.",
            schemars::schema_for!(Query).into(),
        ),
        (
            "RecallMore",
            "Read complete messages around a Recall anchor using its Session and message IDs. before/after select neighboring messages (default 8 each). Excludes the current Turn.",
            schemars::schema_for!(More).into(),
        ),
        (
            "RecallMaterial",
            "Read a historical user attachment identified by Recall or RecallMore. Supply its source session_id and artifact_id. Copies the material into this Session before reading, so later source deletion does not break the evidence. Images return visual content; text uses Read line offset/limit and continuation.",
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
    if query.since.is_some() || query.until.is_some() {
        return Ok((vec![], true));
    }
    let terms: Vec<_> = query
        .terms
        .iter()
        .map(|term| super::types::fold(term))
        .collect();
    let mut input = List {
        include_archived: true,
        ..Default::default()
    };
    let mut matches = Vec::new();
    let mut cursors = std::collections::BTreeSet::new();
    loop {
        if call.cancellation.is_cancelled() {
            return Err(failed("Recall cancelled"));
        }
        let page = history.list(call.clone(), input.clone()).await?;
        if input
            .revision
            .as_ref()
            .is_some_and(|revision| revision != &page.revision)
        {
            return Err(failed("Recall catalog revision changed"));
        }
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
    matches.sort_by(|a, b| {
        b.last_message_at
            .cmp(&a.last_message_at)
            .then_with(|| a.id.cmp(&b.id))
    });
    Ok((matches, true))
}

fn failed(error: impl std::fmt::Display) -> ToolError {
    ToolError::Failed(error.to_string())
}
