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

use crate::support::root;
use maka_agent_facts::execution::SandboxMode;
use maka_agent_facts::execution::WorkspaceIdentity;
use maka_capabilities::authorization::Capability;
use maka_capabilities::authorization::Request;
use maka_capabilities::authorization::SessionBoundary;
use maka_capabilities::authorization::Target;
use maka_capabilities::storage::Namespace;
use maka_config::{
    ConfigurationStore,
    plugin_authorization::{Approval, Boundary, Principal},
};
use maka_plugin_core::scope::Scope;
use uuid::Uuid;

#[tokio::test]
async fn consent_retries_preserve_original_boundary_and_revocation_across_restart() {
    let temp = tempfile::tempdir().unwrap();
    let owner = root(temp.path());
    let store = ConfigurationStore::for_root(owner.clone()).await.unwrap();
    let namespace = Namespace::new("example.background", Scope::Profile).unwrap();
    let title = format!(
        "Review complete authorization: {}final purpose",
        "完整说明 ".repeat(8_000)
    );
    let request = Request {
        operation_id: Uuid::new_v4(),
        title: title.clone(),
        target: Target::Session {
            session_id: "session".into(),
        },
        capabilities: [Capability::Executions].into(),
    };
    let boundary = |revision, sandbox_mode| Boundary::Session {
        boundary: SessionBoundary {
            workspace_origin: maka_agent_facts::execution::WorkspaceOrigin::Selected,
            session_id: "session".into(),
            boundary_revision: revision,
            sandbox_mode,
            approval_policy: maka_agent_facts::execution::ApprovalPolicy::OnRequest,
            cwd: temp.path().to_str().unwrap().into(),
        },
        workspace_identity: WorkspaceIdentity::from_marker_id(
            "00000000-0000-4000-8000-000000000001",
        )
        .unwrap(),
    };
    let approve = |principal, request, boundary| {
        store.approve_plugin_authorization(namespace.clone(), principal, request, boundary)
    };
    let first = boundary(1, SandboxMode::WorkspaceWrite);
    let (left, right) = tokio::join!(
        approve(
            Principal::LocalUser {
                client_instance_id: "client".into()
            },
            request.clone(),
            first.clone()
        ),
        approve(
            Principal::LocalUser {
                client_instance_id: "client".into()
            },
            request.clone(),
            first.clone()
        ),
    );
    let (Approval::Granted(left), Approval::Granted(right)) = (left.unwrap(), right.unwrap())
    else {
        panic!("identical approval conflicted")
    };
    assert_eq!(left.grant, right.grant);
    assert_eq!(left.grant.request.title, title);
    let id = left.grant.id;
    // Lost reply retries cannot recapture a newer/wider Session configuration.
    let Approval::Granted(retry) = approve(
        Principal::LocalUser {
            client_instance_id: "client".into(),
        },
        request.clone(),
        boundary(2, SandboxMode::DangerFullAccess),
    )
    .await
    .unwrap() else {
        panic!("retry conflicted")
    };
    assert_eq!(retry.boundary, first);
    assert_eq!(retry.grant.request.title, title);
    let mut changed = request.clone();
    changed.capabilities.insert(Capability::Notifications);
    assert!(matches!(
        approve(
            Principal::LocalUser {
                client_instance_id: "client".into()
            },
            changed,
            first.clone()
        )
        .await
        .unwrap(),
        Approval::Conflict
    ));
    assert!(matches!(
        approve(
            Principal::Credential {
                credential_id: "another-user".into(),
                client_instance_id: "desktop".into()
            },
            request.clone(),
            first.clone()
        )
        .await
        .unwrap(),
        Approval::Conflict
    ));
    for other in [
        Namespace::new("other", Scope::Profile).unwrap(),
        Namespace::new("example.background", Scope::Session("session".into())).unwrap(),
    ] {
        assert!(
            store
                .plugin_authorization(other.clone(), id)
                .await
                .unwrap()
                .is_none()
        );
        store.revoke_plugin_authorization(other, id).await.unwrap();
    }
    assert!(
        !store
            .plugin_authorization(namespace.clone(), id)
            .await
            .unwrap()
            .unwrap()
            .grant
            .revoked
    );
    store
        .revoke_plugin_authorization(namespace.clone(), id)
        .await
        .unwrap();
    store.close().await.unwrap();
    let store = ConfigurationStore::for_root(owner).await.unwrap();
    let Approval::Granted(retry) = store
        .approve_plugin_authorization(
            namespace.clone(),
            Principal::LocalUser {
                client_instance_id: "client".into(),
            },
            request,
            first.clone(),
        )
        .await
        .unwrap()
    else {
        panic!("revoked retry conflicted")
    };
    assert_eq!(retry.grant.id, id);
    assert!(retry.grant.revoked);
    assert_eq!(retry.boundary, first);
    assert_eq!(retry.grant.request.title, title);
    assert!(
        store
            .plugin_authorization(namespace, id)
            .await
            .unwrap()
            .unwrap()
            .grant
            .revoked
    );
    store.close().await.unwrap();
}
