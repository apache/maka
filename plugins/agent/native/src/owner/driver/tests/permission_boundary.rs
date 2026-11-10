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

async fn update_permissions(
    rig: &Rig,
    session: &str,
    expected_revision: u64,
    access: &str,
    request_permissions: bool,
    revoke_grants: bool,
) -> TestResult<()> {
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
    assert_eq!(value["kind"], "committed", "metadata mutation: {value}");
    call.close().await?;
    Ok(())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn permission_request_toggle_preserves_boundary_but_access_and_revoke_advance_it() {
    let mut rig = Rig::new().unwrap();
    let outcome = AssertUnwindSafe(tokio::time::timeout(Duration::from_secs(60), async {
        let session = rig.start().await?;
        let owner = rig.captured.lock().unwrap().clone().unwrap();
        let initial = owner.mutable_session(&session).await?;
        let basis = initial.configuration.permission_basis();
        let boundary = initial.configuration.boundary_revision;
        let initial_access = serde_json::to_value(initial.configuration.permissions.access)?;
        let initial_access = initial_access
            .as_str()
            .ok_or("permission access is not a string")?;
        let changed_access = if initial_access == "read_only" {
            "workspace_write"
        } else {
            "read_only"
        };
        let initial_requests = initial.configuration.permissions.request_permissions;
        let mut previous_revision = initial.revision;
        for requests in [!initial_requests, initial_requests] {
            update_permissions(
                &rig,
                &session,
                previous_revision,
                initial_access,
                requests,
                false,
            )
            .await?;
            let current = owner.mutable_session(&session).await?;
            assert_eq!(
                current.configuration.permissions.request_permissions,
                requests
            );
            assert_eq!(current.configuration.boundary_revision, boundary);
            assert_eq!(
                current.configuration.permission_basis(),
                basis,
                "request availability must not change the basis attached to existing grants"
            );
            assert!(current.revision > previous_revision);
            previous_revision = current.revision;
        }
        update_permissions(
            &rig,
            &session,
            previous_revision,
            changed_access,
            false,
            false,
        )
        .await?;
        let changed = owner.mutable_session(&session).await?;
        assert_eq!(changed.configuration.boundary_revision, boundary + 1);
        assert_ne!(changed.configuration.permission_basis(), basis);
        update_permissions(
            &rig,
            &session,
            changed.revision,
            changed_access,
            false,
            true,
        )
        .await?;
        let revoked = owner.mutable_session(&session).await?;
        assert_eq!(revoked.configuration.boundary_revision, boundary + 2);
        assert_ne!(
            revoked.configuration.permission_basis(),
            changed.configuration.permission_basis()
        );
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
