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

async fn fixture() -> (tempfile::TempDir, RootStore, SessionStore, SessionStore) {
    let directory = tempfile::tempdir().unwrap();
    let p = directory.path();
    let root = RootStore::open(
        Arc::new(
            root::RootOwner::create(
                &p.join("root"),
                &root::RootNamespaces {
                    ownership: p.join("owners"),
                    control: p.join("control"),
                },
            )
            .unwrap(),
        ),
        crate::ROOT_MIGRATIONS,
    )
    .await
    .unwrap();
    let source = root
        .create_session("source", "source", &json!({}), 1)
        .await
        .unwrap();
    let target_id = "target".to_owned();
    let target = root
        .create_session(&target_id, &target_id, &json!({}), 1)
        .await
        .unwrap();
    (directory, root, source, target)
}
#[tokio::test]
async fn cancelled_accepted_pair_sql_keeps_both_session_and_binding_pins_until_target_cleanup() {
    use tokio::sync::oneshot;
    let (directory, root, source, target) = fixture().await;
    let mut bindings = Vec::new();
    for session in [&source, &target] {
        let path = directory.path().join(session.id());
        std::fs::create_dir_all(&path).unwrap();
        let binding = root
            .attach_workspace("pair-fixture", &json!({"path":path}))
            .await
            .unwrap();
        let binding_id = binding.id;
        let record = session.get::<serde_json::Value>().await.unwrap().unwrap();
        session
            .update_session_metadata(
                session.id(),
                record.revision,
                move |value: &mut serde_json::Value| {
                    value["workspace"] = serde_json::to_value(binding)?;
                    value["boundary_revision"] = json!(0);
                    Ok(())
                },
            )
            .await
            .unwrap();
        bindings.push(binding_id);
    }
    let (source_owner, target_owner) = root
        .pin_session_pair(source.id(), target.id(), None)
        .await
        .unwrap();
    let (entered, started) = oneshot::channel();
    let (release, released) = oneshot::channel();
    let owner = target.owner().unwrap();
    let blocker = tokio::spawn(async move {
        owner
            .connection
            .run(move |_| {
                entered.send(()).unwrap();
                released.blocking_recv().unwrap();
                Ok(())
            })
            .await
            .unwrap();
    });
    started.await.unwrap();
    drop(source_owner);
    let mut operation = Box::pin(target_owner.connection.run(|db| {
        assert_eq!(
            db.execute(
                "UPDATE session_control SET updated_at=27 WHERE id='target'",
                []
            )?,
            1
        );
        Ok(())
    }));
    assert!(futures_util::poll!(&mut operation).is_pending());
    drop(operation);
    drop(target_owner);
    for id in [source.id(), target.id()] {
        assert!(
            root.gates
                .try_write([gates::Key::Session(id.into())])
                .unwrap()
                .is_none()
        );
    }
    for id in &bindings {
        assert!(
            root.gates
                .try_write([gates::Key::Binding(*id)])
                .unwrap()
                .is_none()
        );
    }
    release.send(()).unwrap();
    blocker.await.unwrap();
    target
        .owner()
        .unwrap()
        .connection
        .run(|_| Ok(()))
        .await
        .unwrap();
    assert_eq!(
        target
            .get::<serde_json::Value>()
            .await
            .unwrap()
            .unwrap()
            .updated_at,
        27
    );
    for id in [source.id(), target.id()] {
        drop(
            tokio::time::timeout(
                std::time::Duration::from_secs(10),
                root.gates.write([gates::Key::Session(id.into())]),
            )
            .await
            .unwrap()
            .unwrap(),
        );
    }
    for id in bindings {
        drop(
            tokio::time::timeout(
                std::time::Duration::from_secs(10),
                root.gates.write([gates::Key::Binding(id)]),
            )
            .await
            .unwrap()
            .unwrap(),
        );
    }
    root.close().await.unwrap();
}
