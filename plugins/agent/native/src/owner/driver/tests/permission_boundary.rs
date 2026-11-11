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
use maka_agent_api::contract::WorkspaceAccess;

async fn update_permissions(
    rig: &Rig,
    session: &str,
    expected_revision: u64,
    access: WorkspaceAccess,
    request_permissions: bool,
    revoke_grants: bool,
) -> TestResult<Value> {
    let mut call = rig
        .client
        .as_ref()
        .unwrap()
        .call(
            "agent",
            "metadata".into(),
            json!({
                "sessionId":session,
                "expectedRevision":expected_revision,
                "title":"Permission metadata regression",
                "labels":[],
                "permissions":{
                    "settings":{"access":access,"requestPermissions":request_permissions},
                    "revokeGrants":revoke_grants,
                },
            }),
            Attachments::new(),
        )
        .await?;
    call.start().await?;
    assert!(matches!(call.receive().await?, Reply::Prepared { .. }));
    let Reply::Mutation { reply, cleanup } =
        call.confirm(json!({"test":"permission-boundary"})).await?
    else {
        return Err("metadata did not return a mutation receipt".into());
    };
    cleanup?;
    let Receipt::Recorded {
        outcome:
            OperationOutcome::Returned {
                result: OperationResult::Success { value },
            },
        cleanup: OperationCleanup::Confirmed,
    } = &reply.receipt
    else {
        return Err(format!("metadata did not commit: {:?}", reply.receipt).into());
    };
    let value = value.clone();
    call.close().await?;
    Ok(value)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn permission_metadata_preserves_boundary_and_checks_idle_before_enabling_requests() {
    let mut rig = Rig::new().unwrap();
    let outcome = AssertUnwindSafe(tokio::time::timeout(Duration::from_secs(60), async {
        let session = rig.start().await?;
        let owner = rig.captured.lock().unwrap().clone().unwrap();
        let mut previous = owner.mutable_session(&session).await?;
        let initial = previous.configuration.permissions.clone();
        let changed_access = match initial.access {
            WorkspaceAccess::ReadOnly => WorkspaceAccess::WorkspaceWrite,
            WorkspaceAccess::WorkspaceWrite | WorkspaceAccess::DangerFullAccess => {
                WorkspaceAccess::ReadOnly
            }
        };
        for (access, requests, revoke, preserves_basis) in [
            (initial.access, !initial.request_permissions, false, true),
            (initial.access, initial.request_permissions, false, true),
            (changed_access, false, false, false),
            (changed_access, false, true, false),
        ] {
            let result =
                update_permissions(&rig, &session, previous.revision, access, requests, revoke)
                    .await?;
            assert_eq!(result["kind"], "committed", "metadata mutation: {result}");
            let current = owner.mutable_session(&session).await?;
            assert_eq!(
                serde_json::to_value(&current.configuration.permissions)?,
                json!({"access":access,"requestPermissions":requests}),
            );
            assert_eq!(
                current.configuration.permission_basis()
                    == previous.configuration.permission_basis(),
                preserves_basis,
                "permission basis after access={access:?}, requests={requests}, revoke={revoke}",
            );
            previous = current;
        }
        let enabled = update_permissions(
            &rig,
            &session,
            previous.revision,
            changed_access,
            true,
            false,
        )
        .await?;
        assert_eq!(
            enabled["kind"], "committed",
            "enabling while idle: {enabled}"
        );
        let enabled = owner.mutable_session(&session).await?;
        assert_eq!(
            enabled.configuration.permission_basis(),
            previous.configuration.permission_basis()
        );

        rig.assemble(&session).await?;
        let disabled = update_permissions(
            &rig,
            &session,
            enabled.revision,
            changed_access,
            false,
            false,
        )
        .await?;
        assert_eq!(
            disabled["kind"], "committed",
            "disabling while active: {disabled}"
        );
        let disabled = owner.mutable_session(&session).await?;
        assert!(!disabled.configuration.permissions.request_permissions);
        assert_eq!(
            disabled.configuration.permission_basis(),
            enabled.configuration.permission_basis()
        );

        let rejected = update_permissions(
            &rig,
            &session,
            disabled.revision,
            changed_access,
            true,
            false,
        )
        .await?;
        assert_eq!(rejected, json!({"kind":"rejected","reason":"busy"}));
        let unchanged = owner.mutable_session(&session).await?;
        assert_eq!(unchanged.revision, disabled.revision);
        assert!(!unchanged.configuration.permissions.request_permissions);
        Ok::<_, Box<dyn Error + Send + Sync>>(())
    }))
    .catch_unwind()
    .await;
    let cleanup = rig.finish().await;
    assert!(
        matches!(&outcome, Ok(Ok(Ok(())))),
        "permission metadata regression: {outcome:?}"
    );
    assert!(
        cleanup.is_empty(),
        "permission metadata fixture cleanup: {cleanup:?}"
    );
}
