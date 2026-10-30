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
use maka_agent_facts::public_catalog::PublicCatalogBody;
use maka_config::{
    ConfigurationStore,
    public_catalog::{PublicCatalogRecord, PublicCatalogSnapshot, PublicCatalogSource},
};
use maka_event_log::root::{RootNamespaces, RootOwner};
use serde_json::{Value, json};
use std::sync::Arc;

fn record(body: Value, checked_at: i64) -> PublicCatalogRecord {
    PublicCatalogRecord {
        body: PublicCatalogBody::from_json(body.to_string()).unwrap(),
        etag: Some("\"original\"".into()),
        last_modified: None,
        checked_at,
    }
}

fn assert_snapshot_eq(actual: &PublicCatalogSnapshot, expected: &PublicCatalogSnapshot) {
    assert_eq!(actual.catalog_revision, expected.catalog_revision);
    assert_eq!(
        actual.sources.keys().collect::<Vec<_>>(),
        expected.sources.keys().collect::<Vec<_>>()
    );
    for (source, record) in &actual.sources {
        assert!(record.same_content(&expected.sources[source]).unwrap());
    }
}

#[tokio::test]
async fn sources_revalidate_independently_and_preserve_the_cached_snapshot() {
    let temp = tempfile::tempdir().unwrap();
    let owner = root(temp.path());
    let store = Arc::new(ConfigurationStore::for_root(owner.clone()).await.unwrap());
    let empty = store.public_catalog().await.unwrap();
    assert_eq!(empty.catalog_revision, 0);
    assert!(empty.sources.is_empty());

    let original = store.catalog().await.unwrap();
    let first = record(
        json!({"native":{"name":"Native","models":{"selected":{"name":"Initial"}}}}),
        100,
    );
    assert_eq!(
        store
            .put_public_catalog(PublicCatalogSource::ModelsDev, first.clone())
            .await
            .unwrap(),
        original.revision + 1
    );
    let router = record(
        json!({"data":[{"id":"vendor/selected","name":"Gateway"}]}),
        101,
    );
    assert_eq!(
        store
            .put_public_catalog(PublicCatalogSource::OpenRouter, router.clone())
            .await
            .unwrap(),
        original.revision + 2
    );
    // JSON whitespace/key order and conditional-response headers are not model changes.
    let revalidated = PublicCatalogRecord {
        body: PublicCatalogBody::from_json(
            "{ \"native\" : { \"models\" : { \"selected\" : { \"name\" : \"Initial\" } }, \"name\" : \"Native\" } }".into(),
        )
        .unwrap(),
        etag: None,
        last_modified: Some("Thu, 22 Oct 2026 00:00:00 GMT".into()),
        checked_at: 200,
    };
    assert_eq!(
        store
            .put_public_catalog(PublicCatalogSource::ModelsDev, revalidated.clone())
            .await
            .unwrap(),
        original.revision + 2
    );
    let mut changed = revalidated;
    let mut changed_body: Value = serde_json::from_str(changed.body.as_raw().get()).unwrap();
    changed_body["native"]["models"]["selected"]["name"] = json!("Current");
    changed.body = PublicCatalogBody::from_json(changed_body.to_string()).unwrap();
    changed.checked_at = 300;
    assert_eq!(
        store
            .put_public_catalog(PublicCatalogSource::ModelsDev, changed.clone())
            .await
            .unwrap(),
        original.revision + 3
    );
    let snapshot = store.public_catalog().await.unwrap();
    assert_eq!(snapshot.catalog_revision, original.revision + 3);
    assert_eq!(snapshot.sources.len(), 2);
    assert!(
        snapshot.sources[&PublicCatalogSource::ModelsDev]
            .same_content(&changed)
            .unwrap()
    );
    assert!(
        snapshot.sources[&PublicCatalogSource::OpenRouter]
            .same_content(&router)
            .unwrap()
    );
    let current = store.catalog().await.unwrap();
    assert_eq!(current.revision, snapshot.catalog_revision);
    assert_eq!(current.connections, original.connections);
    assert_eq!(current.default_target, original.default_target);
    store.shutdown().await.unwrap();
    drop(store);
    drop(owner);

    let reopened = ConfigurationStore::for_root(Arc::new(
        RootOwner::open(
            &temp.path().join("root"),
            &RootNamespaces {
                ownership: temp.path().join("owners"),
                control: temp.path().join("control"),
            },
        )
        .unwrap(),
    ))
    .await
    .unwrap();
    assert_snapshot_eq(&reopened.public_catalog().await.unwrap(), &snapshot);
    assert_eq!(reopened.catalog().await.unwrap(), current);
    reopened.close().await.unwrap();
}

#[tokio::test]
async fn raw_body_semantics_preserve_revisions_unknown_fields_and_original_json_value() {
    let temp = tempfile::tempdir().unwrap();
    let owner = root(temp.path());
    let store = ConfigurationStore::for_root(owner.clone()).await.unwrap();
    let raw = r#"{"unknown":1,"data":null,"data":[],"future":{"b":2,"a":1}}"#;
    let mut row = record(json!(null), 10);
    row.body = PublicCatalogBody::from_json(raw.into()).unwrap();
    assert_eq!(
        store
            .put_public_catalog(PublicCatalogSource::OpenRouter, row.clone())
            .await
            .unwrap(),
        1
    );
    let db = rusqlite::Connection::open(owner.canonical_path().join("configuration-rust.sqlite"))
        .unwrap();
    let stored: String = db
        .query_row("SELECT body FROM public_catalog", [], |row| row.get(0))
        .unwrap();
    assert_eq!(stored, raw);
    row.body =
        PublicCatalogBody::from_json(r#"{"future":{"a":1,"b":2},"data":[],"unknown":1}"#.into())
            .unwrap();
    row.checked_at = 20;
    assert_eq!(
        store
            .put_public_catalog(PublicCatalogSource::OpenRouter, row.clone())
            .await
            .unwrap(),
        1
    );
    row.body =
        PublicCatalogBody::from_json(r#"{"future":{"a":1,"b":2},"data":[],"unknown":1.0}"#.into())
            .unwrap();
    assert_eq!(
        store
            .put_public_catalog(PublicCatalogSource::OpenRouter, row.clone())
            .await
            .unwrap(),
        2
    );
    row.body =
        PublicCatalogBody::from_json(r#"{"future":{"a":1,"b":2},"data":[],"unknown":2}"#.into())
            .unwrap();
    assert_eq!(
        store
            .put_public_catalog(PublicCatalogSource::OpenRouter, row.clone())
            .await
            .unwrap(),
        3
    );
    // SQLite json_valid accepts lone surrogates, but Value always rejects them.
    db.execute(
        "UPDATE public_catalog SET body = ?",
        [r#"{"unknown":"\ud800","unknown":null}"#],
    )
    .unwrap();
    assert!(store.public_catalog().await.is_err());
    assert!(
        store
            .put_public_catalog(PublicCatalogSource::OpenRouter, row)
            .await
            .is_err()
    );
    assert_eq!(store.catalog().await.unwrap().revision, 3);
    drop(db);
    store.close().await.unwrap();
}
