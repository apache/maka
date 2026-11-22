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
use maka_config::connection_test::{ConnectionTestPreparation, PreparedConnectionTest};
use maka_config::model_fetch::{ModelFetchPreparation, PreparedModelFetch};

async fn fetch(store: &Arc<ConfigurationStore>, id: &str) -> PreparedModelFetch {
    let ModelFetchPreparation::Ready(prepared) = store.prepare_model_fetch(id).await.unwrap()
    else {
        panic!("OAuth discovery must be prepared");
    };
    *prepared
}

async fn test(store: &Arc<ConfigurationStore>, id: &str) -> PreparedConnectionTest {
    let ConnectionTestPreparation::Ready(prepared) = store
        .prepare_connection_test(ConnectionTestRunInput {
            connection_id: id.into(),
            model_id: None,
        })
        .await
        .unwrap()
    else {
        panic!("OAuth connection test must be prepared")
    };
    *prepared
}

fn verified() -> ConnectionTestProjection {
    ConnectionTestProjection::Verified {
        checked_at: "2026-09-13T00:00:00Z".into(),
        model_id: "discovered".into(),
        latency_ms: 1,
    }
}

#[tokio::test]
async fn discovery_tracks_authenticated_generation_without_losing_edits_or_accepting_relogin() {
    let temp = tempfile::tempdir().unwrap();
    let store = open(temp.path(), true).await;
    {
        let ticket = prepare(&store, create("discovery-account")).await;
        let id = ticket.identity().connection_id.clone();
        assert!(matches!(
            ticket
                .complete(credential("original-grant"), 1)
                .await
                .unwrap(),
            LoginCompletion::Committed(_)
        ));
        let mut observation = fetch(&store, &id).await;
        let mut verification = test(&store, &id).await;
        let admitted = observation.provider_credential().unwrap().unwrap();
        assert_eq!(admitted.credential().secret.as_str(), "original-grant");
        admitted
            .commit_refresh(credential("replacement-grant"), 2)
            .await
            .unwrap()
            .unwrap();
        let resolved = admitted.current_generation().await.unwrap().unwrap();
        observation.accept_credential(resolved.clone()).unwrap();
        verification.accept_credential(resolved.clone()).unwrap();
        let original_row = observation.connection().clone();
        store
            .update_connection(UpdateCatalogConnectionInput {
                expected: ConnectionVersionBasis {
                    connection_id: id.clone(),
                    revision: original_row.revision,
                },
                changes: ConnectionCatalogEntryUpdate {
                    name: Some("Edited while fetching".into()),
                    configuration: Some(original_row.configuration),
                    enabled: Some(true),
                    enabled_model_ids: Some(original_row.enabled_model_ids),
                    model_overrides: Patch::Keep,
                    request_body_overlay: Patch::Keep,
                },
            })
            .await
            .unwrap();
        let models = vec![ModelInfo {
            context_window: Some(8192),
            ..ModelInfo::new("discovered")
        }];
        assert!(matches!(
            verification.complete(verified()).await.unwrap(),
            ConnectionTestRunResult::Committed { .. }
        ));
        assert!(matches!(
            observation.complete(models.clone(), 3).await.unwrap(),
            ConnectionModelFetchResult::Committed { .. }
        ));
        let row = store
            .catalog()
            .await
            .unwrap()
            .connections
            .into_iter()
            .find(|row| row.connection_id == id)
            .unwrap();
        assert_eq!(row.name, "Edited while fetching");
        assert_eq!(row.models, models);
        // A later credential change invalidates an already-observed response.
        let observation = fetch(&store, &id).await;
        let verification = test(&store, &id).await;
        resolved
            .commit_refresh(credential("later-grant"), 4)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            verification.complete(verified()).await.unwrap(),
            ConnectionTestRunResult::Superseded {
                changed: vec![ConnectionEffectChangedDomain::Credential]
            }
        );
        assert_eq!(
            observation
                .complete(vec![ModelInfo::new("stale")], 5)
                .await
                .unwrap(),
            ConnectionModelFetchResult::Superseded {
                changed: vec![ConnectionEffectChangedDomain::Credential]
            }
        );
        let mut observation = fetch(&store, &id).await;
        let mut verification = test(&store, &id).await;
        assert!(
            observation.accept_credential(admitted).is_err(),
            "cannot move an observation backwards"
        );
        let old = observation.provider_credential().unwrap().unwrap();
        // Direct re-login must rotate identity without requiring an earlier logout.
        let ticket = prepare(&store, existing(&store, "relogin-account", &id).await).await;
        assert!(matches!(
            ticket.complete(credential("later-grant"), 6).await.unwrap(),
            LoginCompletion::Committed(_)
        ));
        let new = fetch(&store, &id)
            .await
            .provider_credential()
            .unwrap()
            .unwrap();
        assert_ne!(old.basis().credential_id, new.basis().credential_id);
        assert!(old.current_generation().await.unwrap().is_none());
        assert!(
            old.commit_refresh(credential("stale-login-refresh"), 7)
                .await
                .unwrap()
                .is_none()
        );
        assert!(verification.accept_credential(new.clone()).is_err());
        assert!(matches!(verification.complete(verified()).await.unwrap(),
            ConnectionTestRunResult::Superseded { changed }
                if changed.contains(&ConnectionEffectChangedDomain::Credential)));
        assert!(
            observation.accept_credential(new).is_err(),
            "same token bytes do not authorize a new identity"
        );
        assert!(
            matches!(observation.complete(vec![ModelInfo::new("stale-login")],7).await.unwrap(),
            ConnectionModelFetchResult::Superseded { changed } if changed.contains(&ConnectionEffectChangedDomain::Credential))
        );
    }
    store.shutdown().await.unwrap();
}
