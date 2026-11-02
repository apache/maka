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
use maka_agent_facts::pricing::Entry;
use maka_agent_facts::pricing::Mutation;
use maka_agent_facts::pricing::Page;
use maka_agent_facts::pricing::Pricing;
use maka_agent_facts::pricing::Query;
use maka_agent_facts::pricing::ResetEffect;
use maka_agent_facts::pricing::Update;
use maka_agent_facts::pricing::Updated;
use maka_config::ConfigurationStore;

async fn entries(store: &ConfigurationStore) -> (u64, Vec<Entry>) {
    let mut query = Query::Start;
    let mut all = Vec::new();
    loop {
        let page = store.query_pricing(query).await.unwrap();
        let page_bytes = serde_json::to_vec(&page).unwrap().len();
        let Page::Page {
            revision,
            offset,
            entries,
            next_offset,
        } = page
        else {
            panic!("stable snapshot")
        };
        assert_eq!(offset, all.len() as u64);
        assert!(entries.len() <= 128);
        assert!(page_bytes <= 48 * 1024 || entries.len() == 1);
        if let Some(next) = next_offset {
            assert!(next > offset);
        }
        all.extend(entries);
        match next_offset {
            Some(offset) => query = Query::Continue { revision, offset },
            None => return (revision, all),
        }
    }
}

fn price(entry: &Entry) -> &Pricing {
    match entry {
        Entry::Builtin { pricing } | Entry::Custom { pricing, .. } => pricing,
    }
}

async fn quote(store: &ConfigurationStore, key: &str) -> (u64, Option<Pricing>) {
    let (provider, model) = key.split_once(':').unwrap();
    let quote = store
        .quote_model(provider.into(), model.into())
        .await
        .unwrap();
    (quote.revision, quote.pricing)
}

#[tokio::test]
async fn pricing_overrides_pages_and_captured_quotes_preserve_user_prices() {
    let temp = tempfile::tempdir().unwrap();
    let owner = root(temp.path());
    let store = ConfigurationStore::for_root(owner.clone()).await.unwrap();
    let (revision, initial) = entries(&store).await;
    assert_eq!(revision, 0);
    assert!(
        initial.len() > 128,
        "exercise pagination against the real offline catalog"
    );
    let original = price(&initial[0]).clone();
    let mut custom = original.clone();
    custom.input_usd_per_million += 10.0;
    let update = Update {
        expected_revision: 0,
        mutation: Mutation::Upsert {
            pricing: custom.clone(),
        },
    };
    assert_eq!(
        store.update_pricing(update.clone()).await.unwrap(),
        Updated::Committed { revision: 1 }
    );
    // A lost mutation reply cannot overwrite a later state on retry.
    assert_eq!(
        store.update_pricing(update).await.unwrap(),
        Updated::RevisionConflict {
            expected_revision: 0,
            actual_revision: 1
        }
    );
    assert!(matches!(
        store
            .query_pricing(Query::Continue {
                revision: 0,
                offset: 128
            })
            .await
            .unwrap(),
        Page::RevisionChanged {
            expected_revision: 0,
            actual_revision: 1
        }
    ));
    assert_eq!(
        store
            .update_pricing(Update {
                expected_revision: 1,
                mutation: Mutation::Upsert {
                    pricing: custom.clone()
                },
            })
            .await
            .unwrap(),
        Updated::Unchanged { revision: 1 }
    );
    let captured = quote(&store, &custom.model_key).await;
    assert_eq!(captured, (1, Some(custom.clone())));
    assert!(entries(&store).await.1.iter().any(|entry| *entry
        == Entry::Custom {
            pricing: custom.clone(),
            reset_effect: ResetEffect::RestoreBuiltin,
        }));

    // Supplementary-plane keys sort before U+E000 in JS, unlike UTF-8 ordering.
    let mut revision = 1;
    for key in ["fixture:\u{e000}", "fixture:\u{10000}"] {
        revision += 1;
        assert_eq!(
            store
                .update_pricing(Update {
                    expected_revision: revision - 1,
                    mutation: Mutation::Upsert {
                        pricing: Pricing {
                            model_key: key.into(),
                            ..custom.clone()
                        }
                    },
                })
                .await
                .unwrap(),
            Updated::Committed { revision }
        );
    }
    let (_, all) = entries(&store).await;
    assert!(all.windows(2).all(|pair| {
        price(&pair[0])
            .model_key
            .encode_utf16()
            .cmp(price(&pair[1]).model_key.encode_utf16())
            .is_lt()
    }));
    assert!(
        all.iter()
            .filter(|entry| matches!(
                entry,
                Entry::Custom {
                    reset_effect: ResetEffect::BecomeUnpriced,
                    ..
                }
            ))
            .count()
            >= 2
    );
    assert!(
        store
            .query_pricing(Query::Continue {
                revision,
                offset: all.len() as u64
            })
            .await
            .is_err()
    );
    store.close().await.unwrap();

    let store = ConfigurationStore::for_root(owner.clone()).await.unwrap();
    assert_eq!(
        quote(&store, &custom.model_key).await,
        (3, Some(custom.clone()))
    );
    assert_eq!(
        store
            .update_pricing(Update {
                expected_revision: 3,
                mutation: Mutation::Delete {
                    model_key: custom.model_key.clone()
                }
            })
            .await
            .unwrap(),
        Updated::Committed { revision: 4 }
    );
    assert_eq!(quote(&store, &custom.model_key).await, (4, Some(original)));
    assert_eq!(
        captured,
        (1, Some(custom)),
        "captured quote is not a mutable pricing reference"
    );
    assert_eq!(
        store
            .update_pricing(Update {
                expected_revision: 4,
                mutation: Mutation::Delete {
                    model_key: "missing:model".into()
                }
            })
            .await
            .unwrap(),
        Updated::Unchanged { revision: 4 }
    );
    store.close().await.unwrap();
}
