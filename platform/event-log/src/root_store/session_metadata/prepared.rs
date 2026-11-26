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
use super::super::*;
use crate::{
    sessions::metadata::MetadataChange,
    writeback::{Notification, Prepared, Statement},
};

impl RootStore {
    pub async fn prepare_session_metadata<T, F, S>(
        &self,
        id: &str,
        expected: u64,
        update: F,
        writer: &DataWriter,
        statement: S,
    ) -> Result<(SessionRecord<T>, DataChange), StoreError>
    where
        T: Serialize + DeserializeOwned + Clone + PartialEq + Send + 'static,
        F: FnOnce(&mut T) -> Result<(), StoreError> + Send + 'static,
        S: Statement,
    {
        let statement = self
            .session_metadata_statement(id, expected, update, writer, statement)
            .await?;
        Ok((statement.change.record.clone(), writer.prepare(statement)))
    }

    pub async fn write_session_metadata_with<T, F, S>(
        &self,
        id: &str,
        expected: u64,
        update: F,
        writer: &DataWriter,
        statement: S,
    ) -> Result<S::Output, StoreError>
    where
        T: Serialize + DeserializeOwned + Clone + PartialEq + Send + 'static,
        F: FnOnce(&mut T) -> Result<(), StoreError> + Send + 'static,
        S: Statement,
    {
        let statement = self
            .session_metadata_statement(id, expected, update, writer, statement)
            .await?;
        writer.write(statement).await
    }

    async fn session_metadata_statement<T, F, S>(
        &self,
        id: &str,
        expected: u64,
        update: F,
        writer: &DataWriter,
        statement: S,
    ) -> Result<SessionMetadataChange<T, S>, StoreError>
    where
        T: Serialize + DeserializeOwned + Clone + PartialEq + Send + 'static,
        F: FnOnce(&mut T) -> Result<(), StoreError> + Send + 'static,
        S: Statement,
    {
        if !self.data_writer()?.same_root(writer) {
            return Err(StoreError::InvalidTransition(
                "foreign Root data writer".into(),
            ));
        }
        let selected = self.session(id).await?;
        let (custody, change) = selected.metadata_change(id, expected, update).await?;
        Ok(SessionMetadataChange {
            change,
            statement,
            custody: Arc::new(custody),
        })
    }
}
struct SessionMetadataChange<T, S> {
    change: MetadataChange<T>,
    statement: S,
    custody: Arc<EventLog>,
}
impl<T: Send + 'static, S: Statement> Statement for SessionMetadataChange<T, S> {
    type Value = S::Value;
    type Output = S::Output;
    const PREPARE_OFF_THREAD: bool = S::PREPARE_OFF_THREAD;
    fn retain(&self) -> Vec<Arc<dyn Send + Sync>> {
        let mut inputs = self.statement.retain();
        inputs.push(self.custody.clone());
        inputs
    }
    fn prepare(mut self) -> Result<Self, StoreError> {
        self.statement = self.statement.prepare()?;
        Ok(self)
    }
    fn execute(self, connection: &SqliteConnection) -> Result<Prepared<Self::Value>, StoreError> {
        self.change.validate(connection)?;
        let (record, changed) = self.change.apply(connection)?;
        let domain = self.statement.execute(connection)?;
        let root = if changed {
            Notification::METADATA.with_sessions([record.id])
        } else {
            Notification::NONE
        };
        Ok(Prepared {
            value: domain.value,
            changed: changed || domain.changed,
            notification: domain.notification.combine(root),
        })
    }
    fn committed(value: Self::Value) -> Self::Output {
        S::committed(value)
    }
    fn isolated_rejection(error: &StoreError) -> bool {
        S::isolated_rejection(error)
            || matches!(
                error,
                StoreError::SessionNotFound
                    | StoreError::SessionRetired
                    | StoreError::SessionBusy
                    | StoreError::SessionRevisionConflict { .. }
                    | StoreError::InvalidTransition(_)
            )
    }
}

impl RootStore {
    pub async fn workspace_change_family(
        &self,
        id: &str,
        owner_prefix: &str,
    ) -> Result<WorkspaceChangeFamily, StoreError> {
        self.require_open()?;
        let id = id.to_owned();
        let owner_prefix = owner_prefix.to_owned();
        self.log
            .connection
            .read(move |connection| {
                let members = workspace_change_family(connection, &id, &owner_prefix)?;
                Ok(WorkspaceChangeFamily {
                    id,
                    owner_prefix,
                    members,
                })
            })
            .await
    }

    pub async fn prepare_session_workspace_change<S, G>(
        &self,
        expected: u64,
        family: WorkspaceChangeFamily,
        workspace: S,
        guard: G,
        writer: &DataWriter,
    ) -> Result<impl Statement<Value = G::Value, Output = G::Output> + use<S, G>, StoreError>
    where
        S: Statement<Value = maka_sandbox::workspace::BindingRef>,
        G: Statement,
    {
        self.validate_data_writer(writer)?;
        let revision = self
            .session(&family.id)
            .await?
            .revision_guard(writer, expected)?;
        // Shared Session pins protect the attachment until a reader has pinned
        // its binding. Changing the reference needs both exclusive gates.
        let pins = self
            .gates
            .try_write(family.members.iter().flat_map(|member| {
                [
                    gates::Key::Session(member.clone()),
                    gates::Key::Work(member.clone()),
                ]
            }))?
            .ok_or(StoreError::SessionBusy)?;
        let custody = Arc::new(self.log.scoped(Arc::new(pins)));
        let revision = custody
            .connection
            .read(move |connection| {
                revision.validate(connection)?;
                Ok(revision)
            })
            .await?;
        Ok(SessionWorkspaceChange {
            custody,
            revision,
            family,
            workspace,
            guard,
        })
    }
}

pub struct WorkspaceChangeFamily {
    id: String,
    owner_prefix: String,
    members: Vec<String>,
}

impl WorkspaceChangeFamily {
    pub fn members(&self) -> &[String] {
        &self.members
    }
}

fn workspace_change_family(
    connection: &SqliteConnection,
    id: &str,
    owner_prefix: &str,
) -> Result<Vec<String>, StoreError> {
    // Strip the CTE column's TEXT affinity so SQLite can seek the JSON expression index.
    let mut query = connection.prepare_cached(
        "WITH RECURSIVE family(id, binding) AS (
           SELECT id, json_extract(configuration, '$.workspace.id') FROM session_control WHERE id=?1
           UNION
           SELECT s.id, f.binding FROM family f
           CROSS JOIN session_control s INDEXED BY session_catalog_children
             ON json_extract(s.configuration, '$.parentSessionId')=+f.id
           JOIN session_creations r ON r.session_id=s.id AND r.ready=1 AND r.visible=1
           WHERE json_extract(s.configuration, '$.workspace.id')=f.binding AND s.archived=0
             AND substr(s.id,1,length(?2))=?2
             AND NOT EXISTS(SELECT 1 FROM session_retirements d WHERE d.session_id=s.id AND d.remove_session=1)
         ) SELECT id FROM family ORDER BY id",
    )?;
    Ok(query
        .query_map(rusqlite::params![id, owner_prefix], |row| row.get(0))?
        .collect::<Result<_, _>>()?)
}

struct SessionWorkspaceChange<S, G> {
    custody: Arc<EventLog>,
    revision: SessionRevisionGuard,
    family: WorkspaceChangeFamily,
    workspace: S,
    guard: G,
}

#[cfg(test)]
mod workspace_change_tests {
    use super::*;
    use crate::{
        ROOT_MIGRATIONS,
        root::{RootNamespaces, RootOwner},
    };
    use serde_json::{Value, json};

    struct CheckIdle(bool);

    impl Statement for CheckIdle {
        type Value = ();
        type Output = ();

        fn execute(self, _: &SqliteConnection) -> Result<Prepared<()>, StoreError> {
            if self.0 {
                return Err(StoreError::SessionBusy);
            }
            Ok(Prepared {
                value: (),
                changed: false,
                notification: Notification::NONE,
            })
        }

        fn committed(_: ()) {}

        fn isolated_rejection(_: &StoreError) -> bool {
            false
        }
    }

    #[tokio::test]
    async fn workspace_change_moves_only_the_shared_descendant_branch() {
        let temp = tempfile::tempdir().unwrap();
        let base = temp.path();
        let namespaces = RootNamespaces {
            ownership: base.join("owners"),
            control: base.join("control"),
        };
        let root = RootOwner::create(&base.join("root"), &namespaces).unwrap();
        let store = RootStore::open(Arc::new(root), ROOT_MIGRATIONS)
            .await
            .unwrap();
        let shared = store
            .attach_workspace("agent-", &json!({"path": "/before"}))
            .await
            .unwrap();
        let independent = store
            .attach_workspace("agent-", &json!({"path": "/worktree"}))
            .await
            .unwrap();
        let moving = [
            ("agent-parent", None, shared),
            ("agent-child", Some("agent-parent"), shared),
            ("agent-grandchild", Some("agent-child"), shared),
        ];
        let retained = [
            ("agent-worktree", Some("agent-parent"), independent),
            ("agent-under-worktree", Some("agent-worktree"), shared),
            ("agent-unrelated", None, shared),
        ];
        for (id, parent, binding) in moving.iter().chain(&retained) {
            store.create_session(
                id,
                "create",
                &json!({"title":id, "parentSessionId":parent, "workspace":binding, "boundary_revision":0}),
                1,
            ).await.unwrap();
        }
        let writer = store.data_writer().unwrap();
        let revision = store
            .get_session::<Value>("agent-parent")
            .await
            .unwrap()
            .unwrap()
            .revision;
        for busy in [true, false] {
            let family = store
                .workspace_change_family("agent-parent", "agent-")
                .await
                .unwrap();
            let (destination, workspace) = store
                .prepare_creation_workspace("agent-", |_| json!({"path":"/after"}), None, &writer)
                .await
                .unwrap();
            let change = store
                .prepare_session_workspace_change(
                    revision,
                    family,
                    workspace,
                    CheckIdle(busy),
                    &writer,
                )
                .await
                .unwrap();
            let result = writer.write(change).await;
            if busy {
                assert!(matches!(result, Err(StoreError::SessionBusy)), "{result:?}");
            } else {
                result.unwrap();
            }
            for (id, _, before) in moving.iter().chain(&retained) {
                let session = store.get_session::<Value>(id).await.unwrap().unwrap();
                let moved = !busy && moving.iter().any(|(member, _, _)| member == id);
                assert_eq!(
                    session.workspace_binding.unwrap().id,
                    if moved { destination.id } else { before.id },
                    "{id}"
                );
                assert_eq!(
                    session.configuration["boundary_revision"],
                    u64::from(moved),
                    "{id}"
                );
            }
        }
    }
}

impl<S, G> Statement for SessionWorkspaceChange<S, G>
where
    S: Statement<Value = maka_sandbox::workspace::BindingRef>,
    G: Statement,
{
    type Value = G::Value;
    type Output = G::Output;
    const PREPARE_OFF_THREAD: bool = S::PREPARE_OFF_THREAD || G::PREPARE_OFF_THREAD;

    fn retain(&self) -> Vec<Arc<dyn Send + Sync>> {
        let mut retained = self.workspace.retain();
        retained.extend(self.guard.retain());
        retained.push(self.custody.clone());
        retained
    }

    fn prepare(mut self) -> Result<Self, StoreError> {
        self.workspace = self.workspace.prepare()?;
        self.guard = self.guard.prepare()?;
        Ok(self)
    }

    fn execute(self, connection: &SqliteConnection) -> Result<Prepared<Self::Value>, StoreError> {
        self.revision.validate(connection)?;
        let id = self.revision.session_id();
        if workspace_change_family(connection, id, &self.family.owner_prefix)?
            != self.family.members
        {
            return Err(StoreError::SessionBusy);
        }
        let guard = self.guard.execute(connection)?;
        let workspace = self.workspace.execute(connection)?;
        let mut changed_sessions = Vec::new();
        for member in self.family.members {
            let revision = if member == id {
                self.revision.expected
            } else {
                crate::workspace_bindings::current_session_revision(connection, &member)?
                    .ok_or(StoreError::SessionNotFound)?
            };
            let change = crate::sessions::metadata::preview_metadata(
                connection,
                &member,
                revision,
                false,
                |configuration: &mut serde_json::Value| {
                    let binding = serde_json::to_value(workspace.value)?;
                    if configuration["workspace"] != binding {
                        let boundary = configuration["boundary_revision"]
                            .as_u64()
                            .and_then(|revision| revision.checked_add(1))
                            .filter(|revision| *revision <= crate::sessions::MAX_SAFE_INTEGER)
                            .ok_or_else(|| {
                                StoreError::InvalidTransition(
                                    "invalid permission boundary revision".into(),
                                )
                            })?;
                        configuration["workspace"] = binding;
                        configuration["boundary_revision"] = boundary.into();
                    }
                    Ok(())
                },
            )?;
            if change.apply(connection)?.1 {
                changed_sessions.push(member);
            }
        }
        let changed = !changed_sessions.is_empty();
        let notification = if changed {
            Notification::METADATA.with_sessions(changed_sessions)
        } else {
            Notification::NONE
        };
        Ok(Prepared {
            value: guard.value,
            changed: changed || workspace.changed || guard.changed,
            notification: notification
                .combine(workspace.notification)
                .combine(guard.notification),
        })
    }

    fn committed(value: Self::Value) -> Self::Output {
        G::committed(value)
    }

    fn isolated_rejection(error: &StoreError) -> bool {
        S::isolated_rejection(error)
            || G::isolated_rejection(error)
            || matches!(
                error.underlying(),
                StoreError::SessionRevisionConflict { .. }
                    | StoreError::SessionNotFound
                    | StoreError::SessionRetired
                    | StoreError::SessionBusy
            )
    }
}
