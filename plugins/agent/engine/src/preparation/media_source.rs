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

//! One renderer's media reads from live evidence or an actual bound Root snapshot.
use maka_agent_facts::artifact::{Artifact, PublishedArtifact};
use maka_agent_state::{
    artifacts::{ArtifactReadScope, ArtifactScope, ArtifactStore, SessionScope},
    session_history::snapshot::Snapshot,
};
use maka_event_log::StoreError;
use std::io::Read;

#[derive(Clone)]
pub enum MediaSource<'a> {
    Live {
        artifacts: &'a ArtifactStore,
        scope: ArtifactReadScope,
    },
    LiveWithSession {
        artifacts: &'a ArtifactStore,
        run: ArtifactScope,
    },
    Snapshot {
        snapshot: &'a Snapshot,
        scope: ArtifactReadScope,
    },
}
impl MediaSource<'_> {
    pub fn session(&self) -> &str {
        let scope = match self {
            Self::Live { scope, .. } | Self::Snapshot { scope, .. } => scope,
            Self::LiveWithSession { run, .. } => return &run.session,
        };
        match scope {
            ArtifactReadScope::Run { scope } => &scope.session,
            ArtifactReadScope::Session { scope } => &scope.session,
        }
    }
    pub async fn get(&self, id: String) -> Result<Option<PublishedArtifact>, StoreError> {
        match self {
            Self::Live { artifacts, scope } => artifacts.get(scope.clone(), id).await,
            Self::LiveWithSession { artifacts, run } => {
                match artifacts.get(run.clone(), id.clone()).await? {
                    Some(record) => Ok(Some(record)),
                    None => artifacts.get(session_scope(run), id).await,
                }
            }
            Self::Snapshot { snapshot, scope } => match scope {
                ArtifactReadScope::Run { scope } => {
                    snapshot
                        .artifact(
                            scope.owner.clone(),
                            scope.session.clone(),
                            Some(scope.run),
                            id,
                        )
                        .await
                }
                ArtifactReadScope::Session { scope } => {
                    snapshot
                        .artifact(scope.owner.clone(), scope.session.clone(), None, id)
                        .await
                }
            },
        }
    }
    pub async fn with_content<T: Send + 'static>(
        &self,
        id: String,
        consume: impl FnOnce(&Artifact, &mut dyn Read) -> T + Send + 'static,
    ) -> Result<Option<T>, StoreError> {
        match self {
            Self::Live { artifacts, scope } => {
                artifacts.with_content(scope.clone(), id, consume).await
            }
            Self::LiveWithSession { artifacts, run } => {
                let scope = if artifacts.get(run.clone(), id.clone()).await?.is_some() {
                    ArtifactReadScope::from(run.clone())
                } else {
                    ArtifactReadScope::from(session_scope(run))
                };
                artifacts.with_content(scope, id, consume).await
            }
            Self::Snapshot { snapshot, scope } => match scope {
                ArtifactReadScope::Run { scope } => {
                    snapshot
                        .with_artifact(
                            scope.owner.clone(),
                            scope.session.clone(),
                            Some(scope.run),
                            id,
                            move |artifact, reader| Ok(consume(artifact, reader)),
                        )
                        .await
                }
                ArtifactReadScope::Session { scope } => {
                    snapshot
                        .with_artifact(
                            scope.owner.clone(),
                            scope.session.clone(),
                            None,
                            id,
                            move |artifact, reader| Ok(consume(artifact, reader)),
                        )
                        .await
                }
            },
        }
    }
}

fn session_scope(run: &ArtifactScope) -> SessionScope {
    SessionScope {
        owner: run.owner.clone(),
        session: run.session.clone(),
    }
}
