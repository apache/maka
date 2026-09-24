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

use super::{Query, Recall, reader, types::fold};
use futures_util::future::BoxFuture;
use maka_plugins::{
    authorization::{Capability, Request, Target},
    contributions::Staged,
    remote::{Caller, Endpoint, Error, Handler, Method},
};
use serde::Serialize;
use serde_json::Value;
use std::sync::Arc;

pub(super) fn publish(
    staged: &mut Staged,
    package: &str,
    recall: Arc<Recall>,
) -> Result<(), String> {
    staged
        .insert(
            maka_plugins::remote::key(package, "search").map_err(|e| e.to_string())?,
            Endpoint::standalone(Handler::Method(Arc::new(Search(recall)))),
        )
        .map_err(|e| e.to_string())
}
pub(super) struct Search(pub(super) Arc<Recall>);
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Page {
    matches: Vec<Match>,
    complete: bool,
}
#[derive(Serialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
enum Match {
    Title {
        session_id: String,
        title: String,
    },
    Passage {
        session_id: String,
        title: String,
        turn_id: String,
        message_id: String,
        sequence: u64,
        text: String,
        truncated: bool,
    },
}
impl Method for Search {
    fn call(&self, input: Value, caller: Caller) -> BoxFuture<'static, Result<Value, Error>> {
        let recall = self.0.clone();
        Box::pin(async move {
            let mut query: Query = serde_json::from_value(input).map_err(invalid)?;
            query.validate().map_err(invalid)?;
            let target = match &caller.session_id {
                Some(session_id) => {
                    if query.session_id.as_ref().is_some_and(|id| id != session_id) {
                        return Err(invalid("search exceeds the calling Session"));
                    }
                    query.session_id = Some(session_id.clone());
                    Target::Session {
                        session_id: session_id.clone(),
                    }
                }
                None => Target::Profile,
            };
            let owned = caller
                .views
                .authorize(Request {
                    operation_id: caller.document_id,
                    title: "Search conversation history".into(),
                    target,
                    capabilities: [Capability::ReadHistory].into(),
                })
                .await?;
            let call = owned.scope();
            let result = async {
                recall.check_privacy().await.map_err(provider)?;
                let permit = tokio::select! {
                    biased;
                    _ = call.cancellation.cancelled() => return Err(Error::Cancelled),
                    permit = recall.workers.clone().acquire_owned() => Arc::new(permit.map_err(provider)?),
                };
                let (sessions, catalog_complete) = reader::sessions(
                    recall.history.as_ref(), &call, query.session_id.as_deref(),
                ).await.map_err(provider)?;
                let terms: Vec<_> = query.terms.iter().map(|term| fold(term)).collect();
                let mut matches = Vec::new();
                for session in sessions {
                    // Titles have no message timestamp; time-bounded searches
                    // must be satisfied by an actual historical message.
                    if query.since.is_none() && query.until.is_none()
                        && terms.iter().any(|term| fold(&session.session.name).contains(term)) {
                        matches.push(Match::Title {
                            session_id: session.session.session_id,
                            title: session.session.name,
                        });
                    }
                }
                let result = recall.search(&call, &query, permit).await.map_err(provider)?;
                for passage in result.passages {
                    let anchor = passage.messages.iter().find(|message| message.is_anchor)
                        .ok_or_else(|| provider("search anchor is no longer readable"))?;
                    matches.push(Match::Passage {
                        session_id: passage.session_id, title: passage.session_title,
                        turn_id: passage.turn_id, message_id: passage.anchor_message_id,
                        sequence: passage.anchor_sequence,
                        text: anchor.text.chars().take(1024).collect(),
                        truncated: passage.truncated || anchor.text.chars().count() > 1024,
                    });
                }
                matches.truncate(query.limit.unwrap_or(8));
                recall.check_privacy().await.map_err(provider)?;
                recall.history.list(call, Default::default()).await.map_err(provider)?;
                let mut page = Page {
                    matches, complete: catalog_complete && result.searched_every_session,
                };
                loop {
                    let value = serde_json::to_value(&page).map_err(provider)?;
                    if serde_json::to_vec(&value).map_err(provider)?.len() <= 48 * 1024 {
                        break Ok(value);
                    }
                    page.matches.pop();
                    page.complete = false;
                }
            }.await;
            // Cancel and settle the actual user-request scope, including errors.
            owned.finish().await.map_err(provider)?;
            result
        })
    }
}
fn invalid(error: impl std::fmt::Display) -> Error {
    Error::Invalid(error.to_string())
}
fn provider(error: impl std::fmt::Display) -> Error {
    Error::Provider(error.to_string())
}
