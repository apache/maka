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

fn create(attempt: &str) -> LoginStart {
    let mut input = super::create(attempt);
    if let Target::Create { slug, .. } = &mut input.target {
        *slug = attempt.into();
    }
    input
}

fn inventory() -> Vec<ModelInfo> {
    vec![
        ModelInfo {
            capabilities: Some(ModelCapabilities {
                chat: Some(false),
                ..Default::default()
            }),
            ..ModelInfo::new("not-chat")
        },
        ModelInfo::new("gpt-6-sol"),
        ModelInfo::new("gpt-6-luna"),
    ]
}

#[tokio::test]
async fn account_inventory_initializes_chat_choices_without_overwriting_user_intent() {
    let temp = tempfile::tempdir().unwrap();
    let store = open(temp.path(), true).await;
    let mut ticket = prepare(&store, create("first")).await;
    ticket.discovered_models(inventory(), 10).unwrap();
    let id = ticket.identity().connection_id.clone();
    assert!(matches!(
        ticket.complete(credential("grant"), 11).await.unwrap(),
        LoginCompletion::Committed(_)
    ));
    let first = store.catalog().await.unwrap();
    let row = &first.connections[0];
    assert_eq!(row.models, inventory());
    assert_eq!(row.enabled_model_ids, ["gpt-6-sol", "gpt-6-luna"]);
    assert_eq!(row.model_source, Some(ModelDiscoverySource::Fetched));
    assert_eq!(
        first.default_target,
        Some(ConnectionTarget {
            connection_id: id.clone(),
            model_id: "gpt-6-sol".into(),
        })
    );
    assert_eq!(
        first.revision, 1,
        "inventory, default and login publish together"
    );

    // A user deselects a model and explicitly clears the default.
    let edited = store
        .update_connection(UpdateCatalogConnectionInput {
            expected: ConnectionVersionBasis {
                connection_id: id.clone(),
                revision: row.revision,
            },
            changes: ConnectionCatalogEntryUpdate {
                name: Some(row.name.clone()),
                configuration: Some(row.configuration.clone()),
                enabled: Some(true),
                enabled_model_ids: Some(vec!["gpt-6-luna".into()]),
                model_overrides: Patch::Keep,
                request_body_overlay: Patch::Keep,
            },
        })
        .await
        .unwrap();
    assert!(matches!(edited, CatalogMutationResult::Committed { .. }));
    let revision = store.catalog().await.unwrap().revision;
    assert!(matches!(
        store
            .set_default_target(SetDefaultConnectionTargetInput {
                expected_catalog_revision: revision,
                target: None,
            })
            .await
            .unwrap(),
        CatalogMutationResult::Committed { .. }
    ));
    let mut ticket = prepare(&store, existing(&store, "again", &id).await).await;
    let mut models = inventory();
    models.push(ModelInfo::new("future-model-not-in-build"));
    ticket.discovered_models(models.clone(), 12).unwrap();
    assert!(matches!(
        ticket.complete(credential("new-grant"), 13).await.unwrap(),
        LoginCompletion::Committed(_)
    ));
    let after = store.catalog().await.unwrap();
    assert_eq!(after.connections[0].models, models);
    assert_eq!(after.connections[0].enabled_model_ids, ["gpt-6-luna"]);
    assert!(
        after.default_target.is_none(),
        "reauthorization preserves explicit clear"
    );

    // A clear admitted while the browser is open also wins over initialization.
    let mut ticket = prepare(&store, create("concurrent-clear")).await;
    ticket.discovered_models(inventory(), 14).unwrap();
    store
        .set_default_target(SetDefaultConnectionTargetInput {
            expected_catalog_revision: after.revision,
            target: None,
        })
        .await
        .unwrap();
    assert!(matches!(
        ticket
            .complete(credential("other-grant"), 15)
            .await
            .unwrap(),
        LoginCompletion::Committed(_)
    ));
    assert!(store.catalog().await.unwrap().default_target.is_none());

    // Invalid enrichment leaves the ticket usable with its original fallback.
    let mut ticket = prepare(&store, create("bad-inventory")).await;
    let before = ticket.connection().clone();
    assert!(
        ticket
            .discovered_models(vec![ModelInfo::new("")], 16)
            .is_err()
    );
    assert_eq!(ticket.connection(), &before);
    assert!(ticket.discovered_models(vec![], 16).is_err());
    assert_eq!(ticket.connection(), &before);
    store.shutdown().await.unwrap();
}
