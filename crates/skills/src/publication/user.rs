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
use super::{Error, Publisher, directory::Directory};
use maka_plugins::{call, filesystem::Files};
use std::sync::Arc;

/// Domain-owned paths beneath the user's explicitly granted directory.
#[derive(Clone, Copy)]
pub(crate) enum UserStore {
    MakaSkills,
    AgentSkills,
    ManagedSources,
}
pub(crate) struct UserFiles {
    root: Directory,
    namespace: String,
    call: call::Owned,
}
impl UserFiles {
    pub fn new(files: Arc<dyn Files>, call: call::Owned, namespace: uuid::Uuid) -> Self {
        Self {
            root: Directory::granted(files, call.scope()),
            namespace: namespace.to_string(),
            call,
        }
    }
    pub async fn finish(self) -> Result<(), Error> {
        self.call.finish().await.map_err(Into::into)
    }
    pub async fn open(
        &self,
        store: UserStore,
        private: Publisher,
        create: bool,
    ) -> Result<Option<Publisher>, Error> {
        let (parent, skills, journal) = store.paths();
        let open = async {
            let parent = if create {
                self.root.child(parent).await?
            } else {
                self.root.open(parent).await?
            };
            let data = if create {
                parent.child(journal).await?
            } else {
                parent.open(journal).await?
            };
            // Hosts sharing a user library recover only their own intents.
            let data = if create {
                data.child(&self.namespace).await?
            } else {
                data.open(&self.namespace).await?
            };
            let transactions = if create {
                data.child("transactions").await?
            } else {
                data.open("transactions").await?
            };
            let skills = if create {
                parent.child(skills).await?
            } else {
                parent.open(skills).await?
            };
            Ok(Publisher {
                skills,
                transactions,
                requests: private.requests,
                receipts: private.receipts,
                _lock: private._lock,
            })
        }
        .await;
        match open {
            Err(Error::Io(error)) if !create && error.kind() == std::io::ErrorKind::NotFound => {
                Ok(None)
            }
            result => result.map(Some),
        }
    }
}
impl UserStore {
    fn paths(self) -> (&'static str, &'static str, &'static str) {
        match self {
            Self::MakaSkills => (".maka", "skills", ".skills-publication"),
            Self::AgentSkills => (".agents", "skills", ".skills-publication"),
            Self::ManagedSources => (".maka", "skill-sources", ".skill-sources-publication"),
        }
    }
}
