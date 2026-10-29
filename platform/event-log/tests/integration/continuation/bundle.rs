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
use maka_event_log::{
    StoreError,
    bundle::{BundleError, StagedBundle},
};
use serde_json::json;
use std::collections::BTreeMap;

use crate::bundle::{frames, import};

#[tokio::test]
async fn foreign_history_cannot_consume_a_local_handoff_reservation() {
    let dir = tempfile::tempdir().unwrap();
    let local = EventLog::open(&dir.path().join("local.sqlite"))
        .await
        .unwrap();
    local
        .create_session("session", "local", &json!({}), 1)
        .await
        .unwrap();
    let prior = opening("local-prior", None);
    append(&local, &prior).await;
    close(&local, &prior).await;
    let source = opening("local-source", None);
    append(&local, &source).await;
    let (pause, base) = handoff_consumers::seal(&local, &source).await;
    let before = *local.subscribe_commits().borrow();

    for variant in 0..3 {
        let foreign = EventLog::open(&dir.path().join(format!("foreign-{variant}.sqlite")))
            .await
            .unwrap();
        foreign
            .create_session("foreign", "foreign", &json!({}), 1)
            .await
            .unwrap();
        let mut first = opening("foreign-root", None);
        first.invocation.session_id = "foreign".into();
        if variant == 0 {
            first.invocation.invocation_id = pause.intent.successor_invocation_id.clone();
        } else if variant == 1 {
            first.invocation.run_id = pause.intent.successor_run_id.clone();
        }
        append(&foreign, &first).await;
        close(&foreign, &first).await;
        if variant == 2 {
            let context = foreign
                .context_before_run(&first.invocation, 100, 65536)
                .await
                .unwrap();
            let inherited = claim(
                &foreign,
                &pause.intent.claim_id,
                &first,
                SessionBase {
                    high_water: context.source_evidence.high_water,
                    digest: context.source_evidence.digest,
                },
            )
            .await;
            let mut next = opening("foreign-next", Some(inherited));
            next.invocation.session_id = "foreign".into();
            append(&foreign, &next).await;
            close(&foreign, &next).await;
        }
        let inventory = foreign.preview_bundle("foreign").await.unwrap();
        let (bytes, _) = foreign
            .export_bundle("foreign", &inventory.subtree_digest, Vec::new())
            .await
            .unwrap();
        foreign.close().await.unwrap();
        assert!(matches!(
            local
                .import_bundle(
                    StagedBundle::read(bytes.as_slice()).await.unwrap(),
                    &maka_agent_facts::artifact::content_digest(b"selected destination"),
                    BTreeMap::from([("foreign".into(), json!({}))])
                )
                .await,
            Err(BundleError::Store(StoreError::SessionConflict))
        ));
        assert_eq!(*local.subscribe_commits().borrow(), before);
        assert!(
            local
                .get_session::<serde_json::Value>("foreign")
                .await
                .unwrap()
                .is_none()
        );
    }
    // Rejection must leave the actual local successor usable, not merely absent.
    let claim = claim(&local, &pause.intent.claim_id, &source, base).await;
    let Fact::InvocationOpened { configuration, .. } = &source.fact else {
        unreachable!()
    };
    let next = RuntimeEvent::new(
        pause.intent.successor(&source.invocation),
        Fact::InvocationOpened {
            configuration: configuration.clone(),
            input: InvocationInput::Handoff {
                claim: Box::new(claim),
                pause: Box::new(pause),
            },
        },
    );
    append(&local, &next).await;
    close(&local, &next).await;
    let inventory = local.preview_bundle("session").await.unwrap();
    let (bytes, summary) = local
        .export_bundle("session", &inventory.subtree_digest, Vec::new())
        .await
        .unwrap();
    assert!(!frames::records(&bytes, &summary.digest).is_empty());
    import::roundtrip(&bytes).await;
    let truncated = frames::rewrite_events(&bytes, |event| {
        !(event["invocation"]["invocation_id"] == next.invocation.invocation_id
            && event["fact"]["kind"] == "invocation_ended")
    });
    let mut staged = StagedBundle::read(truncated.as_slice()).await.unwrap();
    assert!(matches!(
        staged.validate_history().await,
        Err(BundleError::Store(StoreError::InvalidTransition(message)))
            if message == "bundle selected Session contains unfinished work"
    ));
    staged.close().await.unwrap();
    local.close().await.unwrap();
}
