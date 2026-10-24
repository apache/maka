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

use crate::RunError;
use maka_agent_facts::attachment::StorageRef;
use maka_event_log::root_store::SessionStore;
use std::collections::HashMap;
use tokio_util::sync::CancellationToken;

/// Request-local rendering aliases. Canonical references and evidence stay intact.
pub(super) struct Resources<'a> {
    session: &'a str,
    inherited: HashMap<(&'a str, &'a str), Option<StorageRef>>,
}

impl<'a> Resources<'a> {
    pub fn native(session: &'a str) -> Self {
        Self {
            session,
            inherited: HashMap::new(),
        }
    }

    pub async fn load_references(
        log: &SessionStore,
        session: &'a str,
        references: impl IntoIterator<Item = &'a StorageRef>,
        cancellation: &CancellationToken,
    ) -> Result<Self, RunError> {
        let mut resources = Self::native(session);
        for reference in references {
            let StorageRef::SessionFile {
                session_id,
                relative_path,
            } = reference
            else {
                continue;
            };
            if session_id == session
                || resources
                    .inherited
                    .contains_key(&(session_id.as_str(), relative_path.as_str()))
            {
                continue;
            }
            if cancellation.is_cancelled() {
                return Err(RunError::Cancelled);
            }
            let resolved = log
                .resolve_history_artifact(session, session_id, relative_path)
                .await?;
            resources
                .inherited
                .insert((session_id, relative_path), resolved);
        }
        Ok(resources)
    }

    pub fn from_manifest(
        session: &'a str,
        aliases: &'a [maka_agent_facts::history::media::ResourceAlias],
    ) -> Self {
        let mut resources = Self::native(session);
        for alias in aliases {
            if let StorageRef::SessionFile {
                session_id,
                relative_path,
            } = &alias.source
            {
                resources
                    .inherited
                    .insert((session_id, relative_path), alias.resolved.clone());
            }
        }
        resources
    }

    pub fn aliases(&self) -> Vec<maka_agent_facts::history::media::ResourceAlias> {
        let mut aliases: Vec<_> = self
            .inherited
            .iter()
            .map(|((session, artifact), resolved)| {
                maka_agent_facts::history::media::ResourceAlias {
                    source: StorageRef::SessionFile {
                        session_id: (*session).to_owned(),
                        relative_path: (*artifact).to_owned(),
                    },
                    resolved: resolved.clone(),
                }
            })
            .collect();
        aliases.sort_by(|left, right| match (&left.source, &right.source) {
            (
                StorageRef::SessionFile {
                    session_id: a,
                    relative_path: x,
                },
                StorageRef::SessionFile {
                    session_id: b,
                    relative_path: y,
                },
            ) => (a, x).cmp(&(b, y)),
            _ => std::cmp::Ordering::Equal,
        });
        aliases
    }

    pub fn resolve<'b>(&'b self, reference: &'b StorageRef) -> Option<&'b StorageRef> {
        match reference {
            StorageRef::SessionFile {
                session_id,
                relative_path,
            } if session_id != self.session => self
                .inherited
                .get(&(session_id.as_str(), relative_path.as_str()))
                .and_then(Option::as_ref),
            _ => Some(reference),
        }
    }
}
