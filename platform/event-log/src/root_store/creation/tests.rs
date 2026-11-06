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
use serde_json::json;

#[tokio::test]
async fn failed_publication_leaves_no_session_and_retry_publishes_once_after_reopen() {
    let directory = tempfile::tempdir().unwrap();
    let owner = Arc::new(
        root::RootOwner::create(
            &directory.path().join("root"),
            &root::RootNamespaces {
                ownership: directory.path().join("ownership"),
                control: directory.path().join("control"),
            },
        )
        .unwrap(),
    );
    let store = RootStore::open(owner.clone()).await.unwrap();
    store.log.connection.run(|db|Box::pin(async move {
        sqlx::query("CREATE TRIGGER reject_creation BEFORE INSERT ON session_creations BEGIN SELECT RAISE(ABORT,'publication failed'); END").execute(db).await?;
        Ok(())
    })).await.unwrap();
    assert!(
        store
            .create_session("session", "create", &json!({"title":"original"}), 1)
            .await
            .is_err()
    );
    assert!(
        store
            .get_session::<Value>("session")
            .await
            .unwrap()
            .is_none()
    );
    store
        .log
        .connection
        .run(|db| {
            Box::pin(async move {
                sqlx::query("DROP TRIGGER reject_creation")
                    .execute(db)
                    .await?;
                Ok(())
            })
        })
        .await
        .unwrap();
    let configuration = json!({"title":"original"});
    let (first, second) = tokio::join!(
        store.create_session("session", "create", &configuration, 1),
        store.create_session("session", "create", &configuration, 2)
    );
    first.unwrap();
    second.unwrap();
    store.close().await.unwrap();
    let store = RootStore::open(owner).await.unwrap();
    let session = store
        .session("session")
        .await
        .unwrap()
        .get::<Value>()
        .await
        .unwrap()
        .unwrap();
    assert_eq!(session.configuration, json!({"title":"original"}));
    assert!(matches!(
        store
            .create_session("session", "create", &json!({"title":"different"}), 3)
            .await,
        Err(StoreError::SessionCreationRejected(
            CreationRejection::IdentityConflict
        ))
    ));
    store.close().await.unwrap();
}
