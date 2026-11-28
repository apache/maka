/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements. See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership. The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License. You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied. See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

use super::*;
use maka_agent_state::discovery::DiscoveryStore;
use maka_agent_state::session_catalog::{Filter, Position, Record, SessionCatalog, SideQuestions};
use maka_event_log::sessions::{CatalogFilter, CatalogScope};

pub(super) const SESSION_QUIET_MS: i64 = 5 * 60 * 1000;
const SESSION_LOOKBACK_MS: i64 = 24 * 3_600_000;
const SESSION_DELTA_LIMIT: usize = 5;

#[derive(Serialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum ConversationKind {
    Session,
    Room,
    Bot,
}

pub(super) struct SessionDelta {
    pub kind: ConversationKind,
    pub id: String,
    pub title: String,
    pub activity_at: UnixMillis,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TopicMetadata {
    title: String,
    parent_session_id: Option<serde::de::IgnoredAny>,
    dossier_seed: Option<serde::de::IgnoredAny>,
    #[serde(default)]
    incognito: bool,
    #[serde(default)]
    discovery_worker: bool,
}

pub(super) async fn recent_conversations(
    catalog: SessionCatalog,
) -> Result<Vec<(Record, String)>, String> {
    let page = catalog
        .page(
            CatalogScope::Profile,
            None,
            Position::Start,
            Filter {
                base: CatalogFilter {
                    roots_only: true,
                    archived_only: false,
                    include_archived: false,
                },
                needs_you_only: false,
                room: Some(false),
                side: SideQuestions::Hidden,
            },
            32,
        )
        .await
        .map_err(reason)?;
    let mut conversations = Vec::new();
    for record in page.sessions {
        let config = TopicMetadata::deserialize(&record.metadata.configuration).map_err(reason)?;
        if config.parent_session_id.is_none()
            && !config.incognito
            && !config.discovery_worker
            && !record.legacy_discovery_worker
            && config.dossier_seed.is_none()
        {
            conversations.push((record, config.title));
        }
    }
    Ok(conversations)
}

impl Owner {
    pub(super) fn discovery_reads_sessions(&self, tools: &[String]) -> bool {
        tools.iter().any(|name| name == "SessionRead")
            && self
                .tool_basis
                .iter()
                .any(|tool| tool.name() == "SessionRead" && tool.reads_session_transcript())
    }

    pub(super) async fn discovery_session_deltas(
        &self,
        at: UnixMillis,
        quiet_ms: i64,
    ) -> Result<Vec<SessionDelta>, String> {
        let catalog = self
            .canonical_catalog()?
            .with_cancellation(self.stop.clone());
        session_deltas(catalog, &self.bot, &self.discovery, at, quiet_ms).await
    }
}

async fn session_deltas(
    catalog: SessionCatalog,
    bot: &bot::Bot,
    discovery: &DiscoveryStore,
    at: UnixMillis,
    quiet_ms: i64,
) -> Result<Vec<SessionDelta>, String> {
    let mut deltas = Vec::new();
    let since = UnixMillis(at.0.saturating_sub(SESSION_LOOKBACK_MS));
    let through = UnixMillis(at.0.saturating_sub(quiet_ms));
    let current_bot = bot.session();
    let candidates = catalog
        .discovery_activity_page(current_bot.clone(), since, through, 32)
        .await
        .map_err(reason)?;
    for record in candidates {
        let id = record.metadata.id;
        let (kind, activity_at) = if current_bot.as_ref() == Some(&id) {
            if !bot.is(&id) {
                continue;
            }
            let Some(activity_at) = discovery
                .latest_session_user_message_at(&id)
                .await
                .map_err(reason)?
            else {
                continue;
            };
            (ConversationKind::Bot, activity_at)
        } else {
            let Some(message) = record.last_message else {
                continue;
            };
            let kind = if record.is_room {
                ConversationKind::Room
            } else {
                ConversationKind::Session
            };
            (
                kind,
                UnixMillis(i64::try_from(message.recorded_at).map_err(reason)?),
            )
        };
        if activity_at > since && activity_at <= through {
            let title = TopicMetadata::deserialize(&record.metadata.configuration)
                .map_err(reason)?
                .title;
            deltas.push(SessionDelta {
                id,
                title,
                kind,
                activity_at,
            });
        }
    }
    let ids: Vec<_> = deltas.iter().map(|delta| delta.id.clone()).collect();
    let explored = discovery.session_explored_at(&ids).await.map_err(reason)?;
    deltas.retain(|delta| {
        explored
            .get(&delta.id)
            .is_none_or(|last| delta.activity_at.0 > *last)
    });
    deltas.sort_by_key(|delta| std::cmp::Reverse(delta.activity_at));
    deltas.truncate(SESSION_DELTA_LIMIT);
    Ok(deltas)
}

#[cfg(test)]
mod tests {
    use super::*;
    use maka_agent_facts::room::RoomAuthor;
    use maka_agent_state::{
        discovery::changes::OpeningSources,
        room::{Post, RoomStore},
    };
    use serde_json::{Value, json};

    #[tokio::test]
    async fn discovery_session_candidates_exclude_internal_archived_empty_and_stale_roots() {
        let (_dir, root, owner) = test_store().await;
        let writer = root.data_writer().unwrap();
        let store = DiscoveryStore::new(writer.clone(), &owner).unwrap();
        let catalog = SessionCatalog::new(writer.clone(), owner.clone(), "s-".into()).unwrap();
        let bot = bot::Bot::new(root.clone(), "s-".into());
        let rooms = RoomStore::new(writer.clone(), owner);
        let at = UnixMillis(2 * SESSION_LOOKBACK_MS);
        let ready = at.0 - SESSION_QUIET_MS;
        let add = async |id: &str, fp: &str, config: Value, activity: Option<i64>| {
            root.create_session(id, fp, &config, at.0 as u64)
                .await
                .unwrap();
            writer
                .write(rooms.create_statement(id.into()))
                .await
                .unwrap();
            if let Some(ms) = activity {
                writer
                    .write(rooms.post_statement(Post {
                        session: id.into(),
                        id: format!("post-{id}"),
                        at: UnixMillis(ms),
                        author: RoomAuthor::Human,
                        content: "Release notes".into(),
                        mentions: vec![],
                        deliveries: vec![],
                        reply_to: None,
                    }))
                    .await
                    .unwrap();
            }
        };
        let fp = "a".repeat(64);
        add(
            &format!("s-{}", &fp[..32]),
            &fp,
            json!({"title":"Legacy","tools":["FinishNoChange"]}),
            Some(ready),
        )
        .await;
        for (id, config, ms) in [
            (
                "s-worker",
                json!({"title":"Worker","discoveryWorker":true}),
                Some(ready),
            ),
            (
                "s-dossier",
                json!({"title":"Elevated","dossierSeed":"seed","dossierElevated":true}),
                Some(ready),
            ),
            (
                "s-child",
                json!({"title":"Child","parentSessionId":"s-parent"}),
                Some(ready),
            ),
            ("s-archived", json!({"title":"Archived"}), Some(ready)),
            ("s-former", json!({"title":"Former Bot"}), Some(ready)),
            ("s-empty", json!({"title":"Newly renamed"}), None),
            (
                "s-private",
                json!({"title":"Private","incognito":true}),
                Some(ready),
            ),
            (
                "s-old",
                json!({"title":"Pinned","pinned":true}),
                Some(at.0 - SESSION_LOOKBACK_MS),
            ),
            ("s-fresh", json!({"title":"Active"}), Some(ready + 1)),
        ] {
            add(id, id, config, ms).await;
        }
        root.set_session_archived::<Value>("s-archived", true, at.0 as u64)
            .await
            .unwrap();
        let (_, marker) = bot
            .prepare_creation_storage(
                vec![Mutation {
                    key: "former/s-former".into(),
                    expected_revision: None,
                    data: Data::Present(json!({})),
                }],
                &writer,
            )
            .unwrap();
        writer.write(marker).await.unwrap();
        // A full sidebar page of pinned, acknowledged conversations must not hide other roots.
        let mut explored = Vec::new();
        for i in 0..32 {
            let id = format!("s-pinned-{i}");
            add(
                &id,
                &id,
                json!({"title":"Reviewed","pinned":true}),
                Some(ready),
            )
            .await;
            explored.push((id, UnixMillis(ready)));
        }
        writer
            .write(store.record_opening(
                OpeningSources::FollowUp {
                    files: vec![],
                    sessions: explored,
                },
                at,
            ))
            .await
            .unwrap();
        for i in 0..6 {
            let id = format!("s-room-{i}");
            add(&id, &id, json!({"title":"Team room"}), Some(ready - i)).await;
        }
        let read = async |quiet| {
            session_deltas(catalog.clone(), &bot, &store, at, quiet)
                .await
                .unwrap()
                .into_iter()
                .map(|delta| (delta.id, delta.activity_at))
                .collect::<Vec<_>>()
        };
        let first = read(SESSION_QUIET_MS).await;
        assert_eq!(
            first,
            (0..5)
                .map(|i| (format!("s-room-{i}"), UnixMillis(ready - i)))
                .collect::<Vec<_>>()
        );
        writer
            .write(store.record_opening(
                OpeningSources::FollowUp {
                    files: vec![],
                    sessions: first,
                },
                at,
            ))
            .await
            .unwrap();
        assert_eq!(
            read(SESSION_QUIET_MS).await,
            [("s-room-5".into(), UnixMillis(ready - 5))]
        );
        assert_eq!(
            read(0).await,
            [
                ("s-fresh".into(), UnixMillis(ready + 1)),
                ("s-room-5".into(), UnixMillis(ready - 5))
            ]
        );
    }
}
