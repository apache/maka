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

//! Immutable acceptance metadata and scope-specific live keyset indexes.
use super::*;
use maka_capabilities::storage::Scan;
use maka_event_log::RootStore;

const MAX_TIME: u64 = (1 << 53) - 1;

pub(super) struct Catalog<'a> {
    pub(super) store: &'a RootStore,
    pub(super) prefix: &'a str,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Batch {
    source: Invocation,
    tool_operation: String,
    accepted_at: u64,
    tasks: BTreeMap<String, Summary>,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Summary {
    worker: String,
    title: String,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Pointer {
    batch: String,
}
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Cursor {
    owner: String,
    scope: Option<String>,
    index_key: String,
    next_offset: usize,
}
pub(super) struct Metadata {
    pub(super) title: String,
    pub(super) accepted_at: u64,
}

impl Catalog<'_> {
    fn batch_key(&self, digest: &str) -> String {
        format!("{}task_catalog/batches/{digest}", self.prefix)
    }
    fn scope_prefix(&self, session: Option<&str>) -> String {
        match session {
            None => format!("{}task_catalog/all/", self.prefix),
            Some(session) => format!(
                "{}task_catalog/sessions/{}/",
                self.prefix,
                hex::encode(Sha256::digest(session.as_bytes()))
            ),
        }
    }
    fn index_key(&self, digest: &str, batch: &Batch, session: Option<&str>) -> String {
        format!(
            "{}{:016}/{digest}",
            self.scope_prefix(session),
            MAX_TIME - batch.accepted_at
        )
    }
    pub(super) fn acceptance_mutations(
        &self,
        context: &ToolCallContext,
        summaries: Vec<(String, String, String)>,
        accepted_at: u64,
    ) -> Result<Vec<Mutation>, String> {
        let mut tasks = BTreeMap::new();
        for (id, worker, title) in summaries {
            if tasks.insert(id, Summary { worker, title }).is_some() {
                return Err("workhub_task_catalog_invalid".into());
            }
        }
        let batch = Batch {
            source: context.invocation.clone(),
            tool_operation: context.operation_id.clone(),
            accepted_at,
            tasks,
        };
        let digest = batch_digest(&batch.source, &batch.tool_operation);
        self.validate_batch(&digest, &batch)?;
        let pointer = serde_json::to_value(Pointer {
            batch: digest.clone(),
        })
        .map_err(|_| "workhub_encoding_failed")?;
        Ok(vec![
            Mutation {
                key: self.batch_key(&digest),
                expected_revision: None,
                data: Data::Present(
                    serde_json::to_value(&batch).map_err(|_| "workhub_encoding_failed")?,
                ),
            },
            Mutation {
                key: self.index_key(&digest, &batch, None),
                expected_revision: None,
                data: Data::Present(pointer.clone()),
            },
            Mutation {
                key: self.index_key(&digest, &batch, Some(&batch.source.session_id)),
                expected_revision: None,
                data: Data::Present(pointer),
            },
        ])
    }
    fn validate_batch(&self, digest: &str, batch: &Batch) -> Result<(), String> {
        if batch_digest(&batch.source, &batch.tool_operation) != digest
            || !crate::owner::owns_session(self.prefix, &batch.source.session_id)
            || batch.accepted_at > MAX_TIME
            || batch.tasks.is_empty()
            || batch.tasks.iter().any(|(id, summary)| {
                id.len() != 67
                    || !id.starts_with("wt_")
                    || !is_digest(&id[3..])
                    || summary.worker.is_empty()
            })
        {
            return Err("workhub_task_catalog_invalid".into());
        }
        Ok(())
    }
    async fn batch(&self, digest: &str) -> Result<Batch, String> {
        if !is_digest(digest) {
            return Err("workhub_task_catalog_invalid".into());
        }
        let record = self
            .store
            .plugin_data(&namespace(), &self.batch_key(digest))
            .await
            .map_err(|_| "workhub_store_unavailable")?
            .ok_or("workhub_task_catalog_missing")?;
        let Data::Present(value) = record.data else {
            return Err("workhub_task_catalog_invalid".into());
        };
        let batch: Batch =
            serde_json::from_value(value).map_err(|_| "workhub_task_catalog_invalid")?;
        self.validate_batch(digest, &batch)?;
        Ok(batch)
    }
    async fn indexed_batch(
        &self,
        key: &str,
        value: Value,
        session: Option<&str>,
    ) -> Result<Batch, String> {
        let pointer: Pointer =
            serde_json::from_value(value).map_err(|_| "workhub_task_catalog_invalid")?;
        let batch = self.batch(&pointer.batch).await?;
        if self.index_key(&pointer.batch, &batch, session) != key
            || session.is_some_and(|session| session != batch.source.session_id)
        {
            return Err("workhub_task_cursor_invalid".into());
        }
        Ok(batch)
    }
    pub(super) async fn metadata(
        &self,
        id: &str,
        assignment: &Assignment,
    ) -> Result<Metadata, String> {
        let batch = self
            .batch(&batch_digest(
                &assignment.source,
                &assignment.tool_operation,
            ))
            .await?;
        let summary = batch.tasks.get(id).ok_or("workhub_task_catalog_missing")?;
        if batch.source != assignment.source
            || batch.tool_operation != assignment.tool_operation
            || summary.worker != assignment.worker
        {
            return Err("workhub_task_catalog_invalid".into());
        }
        Ok(Metadata {
            title: summary.title.clone(),
            accepted_at: batch.accepted_at,
        })
    }
    pub(super) async fn list(
        &self,
        after: Option<String>,
        session: Option<&str>,
    ) -> Result<Value, String> {
        let prefix = self.scope_prefix(session);
        let mut entries = vec![];
        let mut position = None;
        if let Some(after) = after {
            let cursor: Cursor = serde_json::from_slice(
                &hex::decode(after).map_err(|_| "workhub_task_cursor_invalid")?,
            )
            .map_err(|_| "workhub_task_cursor_invalid")?;
            let key_valid = cursor
                .index_key
                .strip_prefix(&prefix)
                .is_some_and(|suffix| {
                    suffix.len() == 81
                        && suffix.as_bytes()[..16].iter().all(u8::is_ascii_digit)
                        && suffix.as_bytes()[16] == b'/'
                        && is_digest(&suffix[17..])
                        && suffix[..16]
                            .parse::<u64>()
                            .is_ok_and(|time| time <= MAX_TIME)
                });
            if cursor.owner != self.prefix || cursor.scope.as_deref() != session || !key_valid {
                return Err("workhub_task_cursor_invalid".into());
            }
            let record = self
                .store
                .plugin_data(&namespace(), &cursor.index_key)
                .await
                .map_err(|_| "workhub_store_unavailable")?
                .ok_or("workhub_task_cursor_invalid")?;
            let Data::Present(value) = record.data else {
                return Err("workhub_task_cursor_invalid".into());
            };
            let batch = self
                .indexed_batch(&cursor.index_key, value, session)
                .await?;
            if cursor.next_offset == 0 || cursor.next_offset > batch.tasks.len() {
                return Err("workhub_task_cursor_invalid".into());
            }
            let offset = emit(&batch, cursor.next_offset, &mut entries);
            position = Some((cursor.index_key, offset));
            if offset < batch.tasks.len() {
                return self.page(entries, session, position.unwrap().0, offset, true);
            }
        }
        let page = self
            .store
            .plugin_data_scan(
                &namespace(),
                Scan {
                    prefix,
                    after: position.as_ref().map(|(key, _)| key.clone()),
                },
            )
            .await
            .map_err(|_| "workhub_store_unavailable")?;
        if entries.len() == 16 {
            let (key, offset) = position.unwrap();
            return self.page(
                entries,
                session,
                key,
                offset,
                !page.entries.is_empty() || page.next_after.is_some(),
            );
        }
        for (index, entry) in page.entries.iter().enumerate() {
            let Data::Present(value) = &entry.record.data else {
                return Err("workhub_task_catalog_invalid".into());
            };
            let batch = self
                .indexed_batch(&entry.key, value.clone(), session)
                .await?;
            let offset = emit(&batch, 0, &mut entries);
            if entries.len() == 16 {
                return self.page(
                    entries,
                    session,
                    entry.key.clone(),
                    offset,
                    offset < batch.tasks.len()
                        || index + 1 < page.entries.len()
                        || page.next_after.is_some(),
                );
            }
        }
        Ok(serde_json::json!({ "entries": entries, "after": null }))
    }
    fn page(
        &self,
        entries: Vec<Value>,
        session: Option<&str>,
        index_key: String,
        next_offset: usize,
        more: bool,
    ) -> Result<Value, String> {
        let after = if more {
            let bytes = serde_json::to_vec(&Cursor {
                owner: self.prefix.into(),
                scope: session.map(str::to_owned),
                index_key,
                next_offset,
            })
            .map_err(|_| "workhub_encoding_failed")?;
            let token = hex::encode(bytes);
            Some(token)
        } else {
            None
        };
        Ok(serde_json::json!({ "entries": entries, "after": after }))
    }
}
fn emit(batch: &Batch, offset: usize, entries: &mut Vec<Value>) -> usize {
    let count = (16 - entries.len()).min(batch.tasks.len() - offset);
    for (id, task) in batch.tasks.iter().skip(offset).take(count) {
        entries.push(serde_json::json!({ "taskId": id, "worker": task.worker, "title": task.title, "acceptedAt": batch.accepted_at }));
    }
    offset + count
}
fn batch_digest(source: &Invocation, operation: &str) -> String {
    task_id(source, operation)[3..].to_owned()
}
fn is_digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

#[cfg(test)]
mod tests {
    use super::*;
    use maka_graph::{
        Mode, WorkId,
        repository::Repository,
        schedule::{Source, Stop, Target as GraphTarget, Update, Work},
    };
    use serde_json::json;

    async fn open_store(path: &std::path::Path) -> RootStore {
        let parent = path.parent().unwrap();
        let namespaces = maka_event_log::root::RootNamespaces {
            ownership: parent.join("ownership"),
            control: parent.join("control"),
        };
        let owner = if path.exists() {
            maka_event_log::root::RootOwner::open(path, &namespaces)
        } else {
            maka_event_log::root::RootOwner::create(path, &namespaces)
        }
        .unwrap();
        RootStore::open(Arc::new(owner)).await.unwrap()
    }
    const OWNER: &str = "catalog-owner-";
    fn context(session: char, operation: &str) -> ToolCallContext {
        ToolCallContext {
            execution: None,
            invocation: Invocation {
                session_id: format!("{OWNER}{}", session.to_string().repeat(32)),
                turn_id: "turn".into(),
                run_id: "run".into(),
                invocation_id: "invocation".into(),
            },
            operation_id: operation.into(),
        }
    }
    async fn workspace_binding(
        log: &RootStore,
    ) -> maka_event_log::workspace_bindings::WorkspaceBinding<Value> {
        let workspace = json!({ "path": "/workspace", "directoryIdentity": format!("sha256:{}", "a".repeat(64)), "identity": "workspace:v1:11111111-1111-4111-8111-111111111111" });
        let reference = log.attach_workspace(OWNER, &workspace).await.unwrap();
        log.workspace_binding(reference.id).await.unwrap().unwrap()
    }
    fn assignment(
        binding: &maka_event_log::workspace_bindings::WorkspaceBinding<Value>,
        context: &ToolCallContext,
        id: &str,
        graph: Option<(&maka_graph::GraphId, &WorkId)>,
    ) -> Assignment {
        let workspace = &binding.workspace;
        let stamp = binding.stamp();
        serde_json::from_value(json!({
            "graph": graph.map(|(graph, work)| json!({ "graphId": graph, "workId": work,
                "authority": {"sessionId": context.invocation.session_id, "workspace": workspace, "permissions": { "access": "workspace_write", "requestPermissions": false }, "boundaryRevision": 1, "binding": stamp},
                "route": {"kind":"operator", "workId": work} })),
            "dependencies": [], "source": context.invocation, "tool_operation": context.operation_id,
            "worker": "worker", "binding": "original-binding", "operation": child_id(id), "delivery": "send",
            "input": { "message": "unparsed original worker input" }, "target": {"kind":"existing", "sessionId":"worker-session"}, "attachments": [],
            "return_route": {"workspace": workspace, "binding": stamp, "model": {
                "binding": {"connection_id":"connection", "connection_slug":"connection", "model":"fixture-model"}, "thinking_level": null,
                "tool_mode": "direct", "editing_tools": null, "public_model": null,
                "context": {"provider_id":"provider"},
                "provider": {"packageId":"provider", "entryId":"provider", "scope": maka_plugin_core::scope::Scope::Profile, "name":"provider"}, "provider_configuration": {},
                "basis": {"adapter":"openai-chat-completions", "protocol":"openai_chat_completions", "base_url":"http://localhost", "capabilities":{}, "options":{}, "main_output_limit":null, "body_overlay":null}
            }}, "notification": null
        })).unwrap()
    }
    async fn accept(
        binding: &maka_event_log::workspace_bindings::WorkspaceBinding<Value>,
        catalog: &Catalog<'_>,
        context: &ToolCallContext,
        title: &str,
        time: u64,
    ) -> String {
        let id = task_id(&context.invocation, &context.operation_id);
        let mut mutations = catalog
            .acceptance_mutations(
                context,
                vec![(id.clone(), "worker".into(), title.into())],
                time,
            )
            .unwrap();
        mutations.push(Mutation {
            key: format!("{OWNER}tasks/{id}"),
            expected_revision: None,
            data: Data::Present(
                serde_json::to_value(assignment(binding, context, &id, None)).unwrap(),
            ),
        });
        catalog
            .store
            .plugin_data_batch(&namespace(), mutations)
            .await
            .unwrap();
        id
    }
    fn ids(page: &Value) -> Vec<String> {
        page["entries"]
            .as_array()
            .unwrap()
            .iter()
            .map(|entry| entry["taskId"].as_str().unwrap().into())
            .collect()
    }
    fn after(page: &Value) -> Option<String> {
        page["after"].as_str().map(str::to_owned)
    }

    #[tokio::test]
    async fn scoped_live_pages_preserve_acceptance_and_reject_foreign_or_stale_cursors() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("catalog.sqlite");
        let log = open_store(&path).await;
        let binding = workspace_binding(&log).await;
        let catalog = Catalog {
            store: &log,
            prefix: OWNER,
        };
        let root = context('a', "root").invocation.session_id;
        let other = context('b', "root").invocation.session_id;
        let mut accepted = vec![];
        for index in 0..18 {
            let ctx = context('a', &format!("route-{index}"));
            accepted.push(
                accept(
                    &binding,
                    &catalog,
                    &ctx,
                    &format!("Task {index}"),
                    if index >= 16 { 200 } else { 100 + index },
                )
                .await,
            );
            accept(
                &binding,
                &catalog,
                &context('b', &format!("other-{index}")),
                "Other coordinator",
                300 + index,
            )
            .await;
        }
        let mut expected = accepted[..16].iter().rev().cloned().collect::<Vec<_>>();
        let mut ties = accepted[16..].to_vec();
        ties.sort();
        ties.extend(expected);
        expected = ties;
        let first = catalog.list(None, Some(&root)).await.unwrap();
        assert_eq!(ids(&first), expected[..16]);
        assert_eq!(first["entries"][0]["acceptedAt"], 200);
        assert!(
            first["entries"]
                .as_array()
                .unwrap()
                .iter()
                .all(|entry| entry["title"].as_str().unwrap().starts_with("Task "))
        );
        let cursor = after(&first).unwrap();
        for scope in [None, Some(other.as_str())] {
            assert!(catalog.list(Some(cursor.clone()), scope).await.is_err());
        }
        assert!(
            Catalog {
                store: &log,
                prefix: "foreign-owner-"
            }
            .list(Some(cursor.clone()), Some(&root))
            .await
            .is_err()
        );
        assert!(
            catalog
                .list(Some(accepted[0].clone()), Some(&root))
                .await
                .is_err()
        );
        let mut invalid: Cursor = serde_json::from_slice(&hex::decode(&cursor).unwrap()).unwrap();
        invalid.next_offset = 33;
        assert!(
            catalog
                .list(
                    Some(hex::encode(serde_json::to_vec(&invalid).unwrap())),
                    Some(&root)
                )
                .await
                .is_err()
        );
        let newest = accept(
            &binding,
            &catalog,
            &context('a', "new-between-pages"),
            "New arrival",
            1000,
        )
        .await;
        let second = catalog
            .list(Some(cursor.clone()), Some(&root))
            .await
            .unwrap();
        assert_eq!(ids(&second), expected[16..]);
        assert_eq!(after(&second), None);
        assert_eq!(
            catalog.list(None, Some(&root)).await.unwrap()["entries"][0]["taskId"],
            newest
        );
        assert_eq!(
            catalog.list(None, None).await.unwrap()["entries"][0]["taskId"],
            newest
        );
        // A failed compare rolls back metadata and both pointers with the task.
        let failed_context = context('a', "failed-acceptance");
        let failed_id = task_id(&failed_context.invocation, &failed_context.operation_id);
        let mut failed = catalog
            .acceptance_mutations(
                &failed_context,
                vec![(failed_id.clone(), "worker".into(), "Never accepted".into())],
                2000,
            )
            .unwrap();
        failed.push(Mutation {
            key: format!("{OWNER}tasks/{failed_id}"),
            expected_revision: Some(1),
            data: Data::Present(
                serde_json::to_value(assignment(&binding, &failed_context, &failed_id, None))
                    .unwrap(),
            ),
        });
        assert!(matches!(
            log.plugin_data_batch(&namespace(), failed).await,
            Err(maka_event_log::StoreError::RevisionConflict { .. })
        ));
        assert!(
            catalog
                .batch(&batch_digest(
                    &failed_context.invocation,
                    &failed_context.operation_id
                ))
                .await
                .is_err()
        );
        assert_eq!(
            catalog.list(None, Some(&root)).await.unwrap()["entries"][0]["taskId"],
            newest
        );
        // Reusing an accepted identity cannot write a new timestamp or index.
        let retry = catalog
            .acceptance_mutations(
                &context('a', "new-between-pages"),
                vec![(newest.clone(), "worker".into(), "Changed".into())],
                3000,
            )
            .unwrap();
        assert!(matches!(
            log.plugin_data_batch(&namespace(), retry).await,
            Err(maka_event_log::StoreError::RevisionConflict { .. })
        ));
        let metadata = catalog
            .metadata(
                &newest,
                &assignment(&binding, &context('a', "new-between-pages"), &newest, None),
            )
            .await
            .unwrap();
        assert_eq!(
            (metadata.title.as_str(), metadata.accepted_at),
            ("New arrival", 1000)
        );
        log.close().await.unwrap();
        let log = open_store(&path).await;
        let catalog = Catalog {
            store: &log,
            prefix: OWNER,
        };
        assert_eq!(
            ids(&catalog
                .list(Some(cursor.clone()), Some(&root))
                .await
                .unwrap()),
            expected[16..]
        );
        // A missing immutable anchor is an error, never a silent first page.
        let anchor: Cursor = serde_json::from_slice(&hex::decode(&cursor).unwrap()).unwrap();
        let revision = log
            .plugin_data(&namespace(), &anchor.index_key)
            .await
            .unwrap()
            .unwrap()
            .revision;
        log.plugin_data_batch(
            &namespace(),
            vec![Mutation {
                key: anchor.index_key,
                expected_revision: Some(revision),
                data: Data::Deleted,
            }],
        )
        .await
        .unwrap();
        assert!(catalog.list(Some(cursor), Some(&root)).await.is_err());
        log.close().await.unwrap();
    }

    async fn revisions(log: &RootStore) -> BTreeMap<String, u64> {
        let mut revisions = BTreeMap::new();
        let mut after = None;
        loop {
            let page = log
                .plugin_data_scan(
                    &namespace(),
                    Scan {
                        prefix: String::new(),
                        after,
                    },
                )
                .await
                .unwrap();
            for entry in page.entries {
                revisions.insert(entry.key, entry.record.revision);
            }
            after = page.next_after;
            if after.is_none() {
                return revisions;
            }
        }
    }
    fn update(
        context: &ToolCallContext,
        graph: &maka_graph::GraphId,
        start: usize,
        count: usize,
    ) -> Update {
        Update {
            graph_id: graph.clone(),
            source: Source {
                invocation: context.invocation.clone(),
                operation_id: context.operation_id.clone(),
            },
            add_work: (start..start + count)
                .map(|index| Work {
                    work_id: format!("graph_work_{index:03}").try_into().unwrap(),
                    target: GraphTarget::Agent {
                        agent_id: "worker".into(),
                    },
                    instruction: format!("Work {index}"),
                    input_ids: vec![],
                    selected_result_inputs: vec![],
                    replaces: None,
                })
                .collect(),
            stop: vec![],
            finish: None,
        }
    }
    #[tokio::test]
    async fn maximal_graph_acceptance_commits_tasks_and_catalog_in_one_real_transaction() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("maximal.sqlite");
        let log = Arc::new(open_store(&path).await);
        let binding = workspace_binding(&log).await;
        let storage = Arc::new(maka_host_runtime::storage::Storage::new(
            log.clone(),
            String::new(),
            namespace(),
        ));
        let repository = Repository::new(storage.clone(), OWNER).unwrap();
        let setup = context('a', "setup-32");
        let epoch = repository
            .open(&setup.invocation.session_id, Mode::Graph, None, 1)
            .await
            .unwrap();
        repository
            .commit_update_with(update(&setup, &epoch.graph_id, 0, 32), 0, 2, vec![])
            .await
            .unwrap();
        repository
            .commit_update_with(
                update(&context('a', "setup-20"), &epoch.graph_id, 32, 20),
                1,
                3,
                vec![],
            )
            .await
            .unwrap();
        let context = context('a', "maximum-replacements-and-stops");
        let mut decision = update(&context, &epoch.graph_id, 52, 32);
        for (index, work) in decision.add_work.iter_mut().enumerate() {
            work.replaces = Some(format!("graph_work_{index:03}"));
        }
        decision.stop = (32..52)
            .map(|index| Stop {
                target_id: format!("graph_work_{index:03}"),
                reason: "Stop original work".into(),
            })
            .collect();
        let catalog = Catalog {
            store: &log,
            prefix: OWNER,
        };
        let mut summaries = vec![];
        let mut mutations = vec![];
        let mut expected = vec![];
        for work in &decision.add_work {
            let id = graph::graph_task_id(&epoch.graph_id, &work.work_id);
            expected.push(id.clone());
            summaries.push((id.clone(), "worker".into(), work.instruction.clone()));
            let assignment = assignment(
                &binding,
                &context,
                &id,
                Some((&epoch.graph_id, &work.work_id)),
            );
            mutations.push(Mutation {
                key: format!("{OWNER}tasks/{id}"),
                expected_revision: None,
                data: Data::Present(serde_json::to_value(assignment).unwrap()),
            });
        }
        mutations.extend(
            catalog
                .acceptance_mutations(&context, summaries, 500)
                .unwrap(),
        );
        let committed = repository
            .commit_update_with(decision.clone(), 2, 500, mutations)
            .await
            .unwrap();
        let after_commit = revisions(&log).await;
        assert_eq!((committed.revision, committed.committed_at), (3, 500));
        let replay = repository
            .commit_update_with(decision, 2, 999, vec![])
            .await
            .unwrap();
        assert_eq!((replay.revision, replay.committed_at), (3, 500));
        assert_eq!(revisions(&log).await, after_commit);
        expected.sort();
        let first = catalog.list(None, None).await.unwrap();
        let second = catalog.list(after(&first), None).await.unwrap();
        let mut listed = ids(&first);
        listed.extend(ids(&second));
        assert_eq!(listed, expected);
        assert_eq!(first["entries"].as_array().unwrap().len(), 16);
        assert_eq!(second["entries"].as_array().unwrap().len(), 16);
        assert_eq!(after(&second), None);
        for page in [&first, &second] {
            assert!(
                page["entries"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .all(|entry| entry["acceptedAt"] == 500)
            );
        }
        drop(repository);
        drop(storage);
        Arc::try_unwrap(log).ok().unwrap().close().await.unwrap();
        let log = open_store(&path).await;
        let catalog = Catalog {
            store: &log,
            prefix: OWNER,
        };
        assert_eq!(catalog.list(None, None).await.unwrap(), first);
        assert_eq!(catalog.list(after(&first), None).await.unwrap(), second);
        log.close().await.unwrap();
    }
}
