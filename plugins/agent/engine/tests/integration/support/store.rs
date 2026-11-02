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

//! Real Root authority and fixed-partition Session custody for Engine tests.
//! The strong Root lives with the fixture; SessionStore deliberately stays weak.
use maka_event_log::root::{RootNamespaces, RootOwner};
use maka_event_log::root_store::{RootStore, SessionStore};
use maka_event_log::{SessionSubscription, StoreError};
use std::{
    ops::Deref,
    path::{Path, PathBuf},
    sync::Arc,
};

pub struct RootFixture {
    root: Arc<RootStore>,
    directory: PathBuf,
}
impl RootFixture {
    pub async fn open(path: &Path) -> Result<Self, StoreError> {
        let directory = path.with_extension("root");
        let namespaces = RootNamespaces {
            ownership: path.with_extension("ownership"),
            control: path.with_extension("control"),
        };
        let owner = if directory.exists() {
            RootOwner::open(&directory, &namespaces)?
        } else {
            RootOwner::create(&directory, &namespaces)?
        };
        Ok(Self {
            root: Arc::new(RootStore::open(Arc::new(owner)).await?),
            directory,
        })
    }
    pub async fn select(&self, id: &str) -> Result<SessionFixture, StoreError> {
        Ok(SessionFixture {
            root: self.root.clone(),
            directory: self.directory.clone(),
            selected: self.root.session(id).await?,
        })
    }
}
impl Deref for RootFixture {
    type Target = RootStore;
    fn deref(&self) -> &Self::Target {
        &self.root
    }
}

pub struct SessionFixture {
    root: Arc<RootStore>,
    directory: PathBuf,
    selected: SessionStore,
}
impl SessionFixture {
    pub async fn open(path: &Path) -> Result<Self, StoreError> {
        let fixture = RootFixture::open(path).await?;
        match fixture.root.session("session").await {
            Ok(_) => (),
            Err(StoreError::SessionNotFound) => {
                fixture
                    .root
                    .create_session("session", "fixture", &serde_json::json!({}), 1)
                    .await?;
            }
            Err(error) => return Err(error),
        }
        fixture.select("session").await
    }
    /// Benchmarks seed a new Root through the public bundle protocol. Root
    /// identity markers and physical partition databases are never copied.
    pub async fn from_bundle(
        path: &Path,
        bundle: &Path,
    ) -> Result<Self, Box<dyn std::error::Error + Send + Sync>> {
        let root = RootFixture::open(path).await?;
        let staged =
            maka_event_log::bundle::StagedBundle::read(tokio::fs::File::open(bundle).await?)
                .await?;
        root.import_bundle(
            staged,
            &maka_agent_facts::artifact::content_digest(b"engine fixture bundle"),
            std::collections::BTreeMap::from([("session".to_owned(), serde_json::json!({}))]),
        )
        .await?;
        Ok(root.select("session").await?)
    }
    pub async fn write_bundle(
        &self,
        path: &Path,
    ) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
        use std::io::Write;
        let inventory = self.root.preview_bundle(self.selected.id()).await?;
        let (bytes, _) = self
            .root
            .export_bundle(self.selected.id(), &inventory.subtree_digest, Vec::new())
            .await?;
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(path)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        Ok(())
    }
    pub fn storage_bytes(&self) -> (u64, u64) {
        let mut sizes = (0, 0);
        for directory in [
            self.directory.clone(),
            self.directory.join("runtime-partitions"),
        ] {
            for file in std::fs::read_dir(directory).unwrap() {
                let file = file.unwrap();
                let name = file.file_name();
                let name = name.to_string_lossy();
                if name.ends_with(".sqlite") {
                    sizes.0 += file.metadata().unwrap().len();
                } else if name.ends_with(".sqlite-wal") {
                    sizes.1 += file.metadata().unwrap().len();
                }
            }
        }
        sizes
    }
    pub fn store(&self) -> SessionStore {
        self.selected.clone()
    }
    pub fn root(&self) -> &RootStore {
        &self.root
    }
    pub async fn select(&self, id: &str) -> Result<Self, StoreError> {
        Ok(Self {
            root: self.root.clone(),
            directory: self.directory.clone(),
            selected: self.root.session(id).await?,
        })
    }
    pub fn subscribe_commits(&self) -> SessionSubscription {
        self.selected
            .subscribe_commits()
            .expect("live fixture Root")
    }
    pub async fn prefix(
        &self,
        max_events: usize,
        max_bytes: usize,
    ) -> Result<maka_agent_facts::event::LogPrefix, StoreError> {
        self.selected
            .scoped_prefix(
                maka_agent_facts::event::LogScope::Session {
                    id: self.selected.id().into(),
                },
                max_events,
                max_bytes,
            )
            .await
    }
    pub async fn close(self) -> Result<(), StoreError> {
        self.root.shutdown().await
    }
    pub async fn shutdown(&self) -> Result<(), StoreError> {
        self.root.shutdown().await
    }
}
impl Deref for SessionFixture {
    type Target = SessionStore;
    fn deref(&self) -> &Self::Target {
        &self.selected
    }
}
