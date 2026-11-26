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

use maka_event_log::checkpoints::{
    HistorySnapshot, Manifest, Scope,
    execution::{Claim, ClaimResult, ExecutionAuthority, Grant, Permissions, Renewal, Status},
    repository::{
        Commit, CommitReceipt, SessionRepository, Source, VerifiedCheckpoint, files::FileRepository,
    },
};
use maka_plugin_core::composition::InstanceId;
use serde::{Deserialize, Serialize};
use std::{path::Path, sync::Arc};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Capsule {
    claim: Claim,
    claimed: ClaimResult,
    renewal: Renewal,
    renewed: Status,
    commit: Commit,
    committed: CommitReceipt,
}

pub async fn produce(directory: &Path) -> Capsule {
    let repo = FileRepository::open(&directory.join("execution-authority")).unwrap();
    let source = Source {
        root_id: "a".repeat(64),
        scope: Scope {
            state_domain: "b".repeat(64),
            deployment: Uuid::new_v4(),
            namespace: InstanceId(vec![Uuid::new_v4()]),
        },
        session: "compat-execution".into(),
    };
    let binding = repo.bind(source.clone(), Uuid::new_v4()).await.unwrap();
    let claim = Claim {
        activation: Uuid::new_v4(),
        binding: binding.clone(),
        start: None,
        permissions: Permissions {
            sandbox: maka_sandbox::Sandbox::Disabled,
            tools: None,
        },
        lease_millis: 60_000,
    };
    let claimed = repo.claim(claim.clone()).await.unwrap();
    let ClaimResult::Granted { grant, .. } = &claimed else {
        panic!("grant missing")
    };
    let grant = Arc::new(grant.as_ref().clone());
    let renewal = Renewal {
        operation: Uuid::new_v4(),
        grant: grant.as_ref().clone(),
        lease_millis: 120_000,
    };
    let renewed = repo.renew(renewal.clone()).await.unwrap();
    let history = repo
        .objects()
        .put(&mut &b"execution compatibility history"[..])
        .unwrap();
    let manifest = Manifest {
        root_id: source.root_id,
        scope: source.scope,
        session_id: source.session,
        history: HistorySnapshot {
            object: history,
            inventory: vec![],
            cut: vec![],
        },
        workspace: None,
    };
    let manifest = repo
        .objects()
        .put(&mut &serde_json::to_vec(&manifest).unwrap()[..])
        .unwrap();
    let verified = VerifiedCheckpoint::verify(repo.objects().as_ref(), manifest.clone()).unwrap();
    let commit = Commit {
        binding,
        operation: Uuid::new_v4(),
        fingerprint: "c".repeat(64),
        expected_revision: None,
        manifest,
    };
    let committed = ExecutionAuthority::commit(&repo, grant.clone(), commit.clone(), verified)
        .await
        .unwrap();
    assert_eq!(repo.revoke(grant).await.unwrap(), Status::Draining);
    Capsule {
        claim,
        claimed,
        renewal,
        renewed,
        commit,
        committed,
    }
}

pub async fn verify(directory: &Path, saved: &Capsule) {
    let repo = FileRepository::open(&directory.join("execution-authority")).unwrap();
    assert_eq!(
        repo.claim(saved.claim.clone()).await.unwrap(),
        saved.claimed
    );
    let ClaimResult::Granted { grant, .. } = &saved.claimed else {
        panic!("old grant missing")
    };
    let grant: Arc<Grant> = Arc::new(grant.as_ref().clone());
    assert_eq!(
        repo.renew(saved.renewal.clone()).await.unwrap(),
        saved.renewed
    );
    assert_eq!(repo.observe(grant.clone()).await.unwrap(), Status::Draining);
    assert_eq!(
        ExecutionAuthority::receipt(&repo, grant.clone(), saved.commit.clone())
            .await
            .unwrap(),
        Some(saved.committed.clone())
    );
    let verified =
        VerifiedCheckpoint::verify(repo.objects().as_ref(), saved.commit.manifest.clone()).unwrap();
    assert_eq!(
        ExecutionAuthority::commit(&repo, grant.clone(), saved.commit.clone(), verified)
            .await
            .unwrap(),
        saved.committed
    );
    let CommitReceipt::Published { head } = &saved.committed else {
        panic!("old Head missing")
    };
    assert_eq!(
        repo.read_head(saved.commit.binding.identity.clone())
            .await
            .unwrap()
            .unwrap()
            .head,
        *head
    );
    let mut next = saved.claim.clone();
    next.activation = Uuid::new_v4();
    next.start = Some(head.revision);
    assert_eq!(repo.claim(next).await.unwrap(), ClaimResult::Busy);
    let mut commit = saved.commit.clone();
    commit.operation = Uuid::new_v4();
    commit.expected_revision = Some(head.revision);
    let verified =
        VerifiedCheckpoint::verify(repo.objects().as_ref(), commit.manifest.clone()).unwrap();
    assert!(
        ExecutionAuthority::commit(&repo, grant, commit, verified)
            .await
            .is_err()
    );
}
