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

use super::*;
use crate::session_catalog::{ControlCommand, ControlEdit, Filter, Position, SessionCatalog};
use maka_agent_facts::durable::{ExecutionIdentity, FactId, RunId};
use maka_event_log::{
    RootStore,
    root::{RootNamespaces, RootOwner},
    sessions::{CatalogFilter, CatalogScope},
};
use maka_plugin_core::composition::InstanceId;
use serde_json::json;
use std::{path::Path, sync::Arc};
use uuid::Uuid;

struct Fixture {
    root: RootStore,
    data: DataWriter,
    rooms: RoomStore,
    catalog: SessionCatalog,
}

impl Fixture {
    async fn open(base: &Path, initialize: bool, owner: RunOwner) -> Self {
        let namespaces = RootNamespaces {
            ownership: base.join("owners"),
            control: base.join("control"),
        };
        let root_owner = if initialize {
            RootOwner::create(&base.join("root"), &namespaces)
        } else {
            RootOwner::open_existing(&base.join("root"), &namespaces)
        }
        .unwrap();
        let migrations: Vec<_> = maka_event_log::ROOT_MIGRATIONS
            .iter()
            .chain(crate::MIGRATIONS)
            .copied()
            .collect();
        let root = RootStore::open(Arc::new(root_owner), &migrations)
            .await
            .unwrap();
        let data = root.data_writer().unwrap();
        Self {
            rooms: RoomStore::new(data.clone(), owner.clone()),
            catalog: SessionCatalog::new(data.clone(), owner, "room-".into()).unwrap(),
            root,
            data,
        }
    }

    async fn create(&self, session: &str, room: bool, at: u64) {
        self.root
            .create_session(session, session, &json!({"title": session}), at)
            .await
            .unwrap();
        if room {
            self.data
                .write(self.rooms.create_statement(session.into()))
                .await
                .unwrap();
        }
    }

    async fn post(&self, post: Post) -> RoomMessage {
        self.data
            .write(self.rooms.post_statement(post))
            .await
            .unwrap()
    }
}

fn owner() -> RunOwner {
    RunOwner {
        deployment: Uuid::new_v4(),
        namespace: InstanceId(Vec::new()),
    }
}

fn post(id: &str, at: i64) -> Post {
    Post {
        session: "room-one".into(),
        id: id.into(),
        at: UnixMillis(at),
        author: RoomAuthor::Human,
        content: MessageInput::from(format!("message {id}")),
        reply_to: None,
        mentions: Vec::new(),
        deliveries: Vec::new(),
    }
}

fn filter(room: Option<bool>) -> Filter {
    Filter {
        base: CatalogFilter {
            roots_only: false,
            archived_only: false,
            include_archived: true,
        },
        needs_you_only: false,
        room,
    }
}

#[tokio::test]
async fn room_posts_keep_authors_replies_and_frozen_pages_after_reopening() {
    let temp = tempfile::tempdir().unwrap();
    let owner = owner();
    let f = Fixture::open(temp.path(), true, owner.clone()).await;
    f.create("room-one", true, 10).await;
    let first = f.post(post("first", 20)).await;
    let mut original = post("first", 25);
    assert_eq!(f.post(original.clone()).await, first);
    original.content.text = "a changed message".into();
    assert!(matches!(
        f.data.write(f.rooms.post_statement(original)).await,
        Err(StoreError::EventConflict)
    ));

    let mut request = post("second", 30);
    request.reply_to = Some("first".into());
    request.mentions = vec!["reviewer".into(), "unavailable".into()];
    request.deliveries = vec![
        RoomDelivery::Accepted {
            session_id: "reviewer".into(),
            message_id: "delivery-second-reviewer".into(),
        },
        RoomDelivery::Rejected {
            session_id: "unavailable".into(),
            reason: "agent_model_unavailable".into(),
        },
    ];
    f.post(request).await;
    let mut reply = post("third", 40);
    reply.author = RoomAuthor::Session {
        execution: ExecutionIdentity {
            session_id: "reviewer".into(),
            turn_id: "review-turn".into(),
            run_id: RunId::new(),
        },
    };
    reply.reply_to = Some("second".into());
    let reply = f.post(reply).await;

    let tail = f
        .rooms
        .page("room-one".into(), None, RoomPosition::Tail, 2)
        .await
        .unwrap();
    assert_eq!(tail.through, 3);
    assert_eq!(
        tail.items.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(),
        ["second", "third"]
    );
    assert_eq!(tail.before.as_deref(), Some("second"));
    assert_eq!(tail.after, None);
    assert_eq!(tail.items[1], reply);
    f.post(post("fourth", 50)).await;
    let frozen = f
        .rooms
        .page(
            "room-one".into(),
            Some(tail.through),
            RoomPosition::After {
                message_id: "second".into(),
            },
            10,
        )
        .await
        .unwrap();
    assert_eq!(frozen.items, [reply.clone()]);
    let earlier = f
        .rooms
        .page(
            "room-one".into(),
            Some(tail.through),
            RoomPosition::Before {
                message_id: "second".into(),
            },
            2,
        )
        .await
        .unwrap();
    assert_eq!(earlier.items, [first]);
    assert_eq!(earlier.after.as_deref(), Some("first"));
    assert_eq!(f.data.query(RunCount).await.unwrap(), 0);
    f.root.close().await.unwrap();

    let f = Fixture::open(temp.path(), false, owner).await;
    assert!(f.rooms.exists("room-one").await.unwrap());
    assert_eq!(f.rooms.get("room-one", "third").await.unwrap(), Some(reply));
    let restored = f
        .rooms
        .page("room-one".into(), None, RoomPosition::Start, 10)
        .await
        .unwrap();
    assert_eq!(restored.items.len(), 4);
    assert_eq!(restored.items[1].deliveries.len(), 2);
    f.root.close().await.unwrap();
}

#[tokio::test]
async fn room_catalog_tracks_unread_recency_and_kind_across_rebuild() {
    let temp = tempfile::tempdir().unwrap();
    let f = Fixture::open(temp.path(), true, owner()).await;
    f.create("room-one", true, 10).await;
    f.create("room-agent", false, 100).await;
    f.post(post("first", 200)).await;
    let record = f.catalog.record("room-one").await.unwrap().unwrap();
    assert!(record.is_room);
    assert!(record.read_state.has_unread);
    assert!(!record.status.working);
    assert_eq!(record.last_message.unwrap().tail_message_id, "first");

    let page = f
        .catalog
        .page(
            CatalogScope::Profile,
            None,
            Position::Start,
            filter(None),
            10,
        )
        .await
        .unwrap();
    assert_eq!(
        page.sessions
            .iter()
            .map(|record| record.metadata.id.as_str())
            .collect::<Vec<_>>(),
        ["room-one", "room-agent"]
    );
    let first = f
        .catalog
        .page(
            CatalogScope::Profile,
            None,
            Position::Start,
            filter(None),
            1,
        )
        .await
        .unwrap();
    let second = f
        .catalog
        .page(
            CatalogScope::Profile,
            Some(first.revision.clone()),
            Position::After(first.next_cursor.unwrap()),
            filter(None),
            1,
        )
        .await
        .unwrap();
    assert_eq!(second.sessions[0].metadata.id, "room-agent");
    let previous = f
        .catalog
        .page(
            CatalogScope::Profile,
            Some(first.revision),
            Position::Before(second.previous_cursor.unwrap()),
            filter(None),
            1,
        )
        .await
        .unwrap();
    assert_eq!(previous.sessions[0].metadata.id, "room-one");
    for (kind, expected) in [(true, "room-one"), (false, "room-agent")] {
        let page = f
            .catalog
            .page(
                CatalogScope::Profile,
                None,
                Position::Start,
                filter(Some(kind)),
                10,
            )
            .await
            .unwrap();
        assert_eq!(page.sessions.len(), 1);
        assert_eq!(page.sessions[0].metadata.id, expected);
    }

    f.catalog
        .apply(
            "room-one".into(),
            ControlCommand {
                id: FactId::new(),
                at: UnixMillis(210),
                expected_revision: record.control_revision,
                edit: ControlEdit::MarkRead {
                    message_id: "first".into(),
                },
            },
        )
        .await
        .unwrap();
    f.catalog.rebuild("room-one".into()).await.unwrap();
    assert!(
        !f.catalog
            .record("room-one")
            .await
            .unwrap()
            .unwrap()
            .read_state
            .has_unread
    );
    f.post(post("second", 220)).await;
    let record = f.catalog.record("room-one").await.unwrap().unwrap();
    assert!(record.read_state.has_unread);
    assert_eq!(record.last_message.unwrap().tail_message_id, "second");
    assert_eq!(f.data.query(RunCount).await.unwrap(), 0);
    f.root.close().await.unwrap();
}

#[tokio::test]
async fn room_post_rolls_back_with_composed_work_and_rejects_missing_reply() {
    let temp = tempfile::tempdir().unwrap();
    let f = Fixture::open(temp.path(), true, owner()).await;
    f.create("room-one", true, 10).await;
    assert!(
        f.data
            .write(RejectedWork(f.rooms.post_statement(post("first", 20))))
            .await
            .is_err()
    );
    assert!(f.rooms.get("room-one", "first").await.unwrap().is_none());
    let mut missing = post("second", 30);
    missing.reply_to = Some("first".into());
    assert!(f.data.write(f.rooms.post_statement(missing)).await.is_err());
    let page = f
        .rooms
        .page("room-one".into(), None, RoomPosition::Tail, 10)
        .await
        .unwrap();
    assert!(page.items.is_empty());
    assert_eq!(page.through, 0);
    assert_eq!(f.post(post("third", 40)).await.sequence, 1);
    f.root.close().await.unwrap();
}

struct RunCount;

impl Query for RunCount {
    type Output = u64;

    fn execute(self, c: &Connection) -> Result<u64, StoreError> {
        unsigned(c.query_row("SELECT COUNT(*) FROM agent_run_specs", [], |row| row.get(0))?)
    }
}

struct RejectedWork(PostStatement);

impl Statement for RejectedWork {
    type Value = RoomMessage;
    type Output = RoomMessage;

    fn execute(self, c: &Connection) -> Result<Prepared<RoomMessage>, StoreError> {
        self.0.execute(c)?;
        Err(invalid("fixture delivery rejected"))
    }

    fn committed(value: RoomMessage) -> RoomMessage {
        value
    }

    fn isolated_rejection(error: &StoreError) -> bool {
        PostStatement::isolated_rejection(error)
    }
}
