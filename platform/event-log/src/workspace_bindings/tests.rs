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
use crate::{
    root::{RootNamespaces, RootOwner},
    root_store::RootStore,
};
use serde_json::json;
use std::sync::Arc;
use tokio_util::sync::CancellationToken;

#[tokio::test]
async fn work_scope_rejects_an_old_binding_even_when_numeric_boundary_matches() {
    let directory = tempfile::tempdir().unwrap();
    let root = RootStore::open(
        Arc::new(
            RootOwner::create(
                &directory.path().join("root"),
                &RootNamespaces {
                    ownership: directory.path().join("owners"),
                    control: directory.path().join("control"),
                },
            )
            .unwrap(),
        ),
        crate::ROOT_MIGRATIONS,
    )
    .await
    .unwrap();
    let first = root
        .attach_workspace("owner_", &json!({"path":"/first"}))
        .await
        .unwrap();
    let second = root
        .attach_workspace("owner_", &json!({"path":"/second"}))
        .await
        .unwrap();
    assert_ne!(first.id, second.id);
    assert_eq!(first.permission_epoch_at_attach, 0);
    assert_eq!(second.permission_epoch_at_attach, 0);
    let session = root
        .create_session(
            "session",
            "create",
            &json!({"workspace":first,"boundary_revision":0}),
            1,
        )
        .await
        .unwrap();
    let old = PermissionBasis {
        boundary_revision: 0,
        binding: BindingStamp {
            id: first.id,
            permission_epoch: 0,
        },
    };
    let scope = session.work_scope(Some(old)).await.unwrap();
    let (lease, _effects) = scope.accept(CancellationToken::new());
    let original = lease.store();
    let custody = original.work_custody().unwrap();
    assert_eq!(
        root.session_for_work(custody.as_ref(), session.id())
            .unwrap()
            .get::<Value>()
            .await
            .unwrap()
            .unwrap()
            .configuration["workspace"]["id"],
        json!(first.id),
    );
    lease.finish();
    assert!(
        root.session_for_work(custody.as_ref(), session.id())
            .is_err()
    );

    let new = PermissionBasis {
        binding: BindingStamp {
            id: second.id,
            permission_epoch: 0,
        },
        ..old
    };
    let current = session.get::<Value>().await.unwrap().unwrap();
    session
        .update_session_metadata(
            session.id(),
            current.revision,
            move |configuration: &mut Value| {
                configuration["workspace"] = serde_json::to_value(second)?;
                Ok(())
            },
        )
        .await
        .unwrap();
    assert!(matches!(
        session.work_scope(Some(old)).await,
        Err(StoreError::PermissionRevoked),
    ));
    assert!(original.get::<Value>().await.is_err());
    let scope = session.work_scope(Some(new)).await.unwrap();
    let (lease, _effects) = scope.accept(CancellationToken::new());
    let current = lease.store();
    let current_custody = current.work_custody().unwrap();
    let metadata = root
        .session_for_work(current_custody.as_ref(), session.id())
        .unwrap()
        .get::<Value>()
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        metadata.configuration["workspace"]["id"],
        json!(new.binding.id)
    );
    assert_eq!(metadata.configuration["boundary_revision"], json!(0));
    assert!(
        root.data_writer_for_work(current_custody.as_ref(), session.id())
            .is_ok()
    );
    assert!(matches!(
        session.work_scope(Some(old)).await,
        Err(StoreError::PermissionRevoked),
    ));
    lease.finish();
    assert!(
        root.session_for_work(current_custody.as_ref(), session.id())
            .is_err()
    );
    root.close().await.unwrap();
}
