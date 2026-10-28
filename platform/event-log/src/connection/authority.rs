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

use std::sync::Arc;

use crate::{
    StoreError,
    root::{FileLease, RootOwner},
};

/// Authority retained until the database worker has actually closed.
pub enum ConnectionAuthority {
    Writer {
        lease: Arc<FileLease>,
        root: Option<Arc<RootOwner>>,
    },
    Projection {
        source: Arc<FileLease>,
        root: Option<Arc<RootOwner>>,
    },
    Root(Arc<RootOwner>),
}

impl ConnectionAuthority {
    pub(super) fn validate(&self) -> Result<(), StoreError> {
        let root = match self {
            Self::Writer { root, lease } => {
                lease.validate()?;
                root.as_ref()
            }
            Self::Projection { source, root } => {
                source.validate()?;
                root.as_ref()
            }
            Self::Root(root) => Some(root),
        };
        if let Some(root) = root {
            root.validate_current()?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::connection::OwnedConnection;
    use sqlx::sqlite::SqliteConnectOptions;

    #[tokio::test]
    async fn root_authority_is_retained_and_validated_for_each_job() {
        use crate::root::{ROOT_MARKER, RootNamespaces};
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("root");
        let namespaces = RootNamespaces {
            ownership: directory.path().join("ownership"),
            control: directory.path().join("control"),
        };
        let root = Arc::new(RootOwner::create(&path, &namespaces).unwrap());
        let retained = Arc::downgrade(&root);
        let owner = OwnedConnection::open(
            SqliteConnectOptions::new().in_memory(true),
            ConnectionAuthority::Root(root),
            |_| Box::pin(async { Ok(()) }),
        )
        .await
        .unwrap();
        assert!(retained.upgrade().is_some());
        owner.run(|_| Box::pin(async { Ok(()) })).await.unwrap();
        std::fs::remove_file(path.join(ROOT_MARKER)).unwrap();
        assert!(matches!(
            owner
                .run::<()>(|_| Box::pin(async { panic!("invalid root must not execute a job") }))
                .await,
            Err(StoreError::Io(_))
        ));
        owner.shutdown().await.unwrap();
        assert!(retained.upgrade().is_none());
    }
}
