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
    artifacts::{ArtifactReadScope, ArtifactStore},
    session_history::snapshot::Snapshot,
};
use maka_event_log::StoreError;
use std::io::Read;

pub enum MediaSource<'a> {
    Live {
        artifacts: &'a ArtifactStore,
        scope: ArtifactReadScope,
    },
    Snapshot {
        snapshot: &'a Snapshot,
        scope: ArtifactReadScope,
    },
}
impl MediaSource<'_> {
    pub fn session(&self) -> &str {
        let (Self::Live { scope, .. } | Self::Snapshot { scope, .. }) = self;
        match scope {
            ArtifactReadScope::Run { scope } => &scope.session,
            ArtifactReadScope::Session { scope } => &scope.session,
        }
    }
    pub async fn get(&self, id: String) -> Result<Option<PublishedArtifact>, StoreError> {
        match self {
            Self::Live { artifacts, scope } => artifacts.get(scope.clone(), id).await,
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
