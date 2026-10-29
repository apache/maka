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
use maka_agent_facts::configuration::headers::*;
use sqlx::Connection;

async fn header_basis(fixture: &Fixture) -> RequestHeadersBasis {
    let RequestHeadersQueryResult::Found { basis, .. } = fixture
        .store
        .request_headers(fixture.id.clone())
        .await
        .unwrap()
    else {
        panic!("expected request headers snapshot")
    };
    basis
}

async fn replace_headers(
    fixture: &Fixture,
    expected: RequestHeadersBasis,
    headers: Value,
) -> maka_config::Result<RequestHeadersReplaceResult> {
    fixture
        .store
        .replace_request_headers(
            RequestHeadersReplace {
                expected,
                headers: serde_json::from_value(headers).unwrap(),
            },
            123,
        )
        .await
}

#[tokio::test]
async fn header_replacement_rolls_back_secret_test_and_revisions_and_preserves_aba() {
    let fixture = Fixture::new().await;
    fixture.key().await;
    let replace =
        async |headers| replace_headers(&fixture, header_basis(&fixture).await, headers).await;
    let locator = CredentialLocator::Connection {
        connection_id: fixture.id.clone(),
        kind: ConnectionCredentialKind::RequestHeaders,
    };
    assert!(matches!(
        replace(json!([{"name":"X-Keep","value":"old"},{"name":"X-Drop","value":"drop"}]))
            .await
            .unwrap(),
        RequestHeadersReplaceResult::Committed { .. }
    ));
    let before_status = fixture
        .store
        .credential_status(locator.clone())
        .await
        .unwrap();
    let secret = fixture
        .store
        .credential_secret(&locator, None)
        .await
        .unwrap();
    fixture
        .prepare(None)
        .await
        .complete(failed(ConnectionEffectFailureClass::Auth))
        .await
        .unwrap();
    let before = fixture.store.catalog().await.unwrap();
    let prepared = fixture.prepare(None).await;
    let mut sql = sqlx::SqliteConnection::connect_with(
        &sqlx::sqlite::SqliteConnectOptions::new()
            .filename(fixture.temp.path().join("root/configuration-rust.sqlite")),
    )
    .await
    .unwrap();
    let revision: i64 = sqlx::query_scalar("SELECT revision FROM credential_vault")
        .fetch_one(&mut sql)
        .await
        .unwrap();
    // Cuts both after secret write/delete and after lastTest invalidation.
    for statement in [
        "CREATE TRIGGER header_cut BEFORE UPDATE ON connections BEGIN SELECT RAISE(ABORT, 'injected'); END",
        "CREATE TRIGGER header_cut BEFORE UPDATE ON credential_vault BEGIN SELECT RAISE(ABORT, 'injected'); END",
    ] {
        sqlx::query(statement).execute(&mut sql).await.unwrap();
        for headers in [json!([{"name":"X-Keep","value":"new"}]), json!([])] {
            assert!(replace(headers).await.is_err());
            assert_eq!(fixture.store.catalog().await.unwrap(), before);
            assert_eq!(
                fixture
                    .store
                    .credential_status(locator.clone())
                    .await
                    .unwrap(),
                before_status
            );
            assert_eq!(
                fixture
                    .store
                    .credential_secret(&locator, None)
                    .await
                    .unwrap(),
                secret
            );
            assert_eq!(
                sqlx::query_scalar::<_, i64>("SELECT revision FROM credential_vault")
                    .fetch_one(&mut sql)
                    .await
                    .unwrap(),
                revision
            );
        }
        sqlx::query("DROP TRIGGER header_cut")
            .execute(&mut sql)
            .await
            .unwrap();
    }
    assert!(matches!(
        replace(json!([{"name":"X-Keep"},{"name":"X-Drop"}]))
            .await
            .unwrap(),
        RequestHeadersReplaceResult::Unchanged { .. }
    ));
    assert_eq!(fixture.store.catalog().await.unwrap(), before);
    assert!(replace(json!([{"name":"X-New"}])).await.is_err());
    assert_eq!(
        fixture
            .store
            .credential_status(locator.clone())
            .await
            .unwrap(),
        before_status
    );
    let RequestHeadersReplaceResult::Committed { basis, .. } =
        replace(json!([{"name":"x-keep"}])).await.unwrap()
    else {
        panic!("expected retained header commit")
    };
    assert_eq!(basis, header_basis(&fixture).await);
    assert_eq!(
        fixture
            .store
            .credential_secret(&locator, None)
            .await
            .unwrap()
            .unwrap(),
        r#"{"x-keep":"old"}"#
    );
    assert!(
        fixture.store.catalog().await.unwrap().connections[0]
            .last_test
            .is_none()
    );
    assert_eq!(
        prepared
            .complete(failed(ConnectionEffectFailureClass::Auth))
            .await
            .unwrap(),
        ConnectionTestRunResult::Superseded {
            changed: vec![ConnectionEffectChangedDomain::Credential]
        }
    );
    let pending = fixture.prepare(None).await;
    assert!(matches!(
        replace(json!([])).await.unwrap(),
        RequestHeadersReplaceResult::Committed { .. }
    ));
    assert!(matches!(
        replace(json!([])).await.unwrap(),
        RequestHeadersReplaceResult::Unchanged { .. }
    ));
    assert!(matches!(
        replace(json!([{"name":"X-Keep","value":"old"},{"name":"X-Drop","value":"drop"}]))
            .await
            .unwrap(),
        RequestHeadersReplaceResult::Committed { .. }
    ));
    assert_ne!(
        fixture
            .store
            .credential_status(locator.clone())
            .await
            .unwrap(),
        before_status
    );
    assert_eq!(
        pending
            .complete(failed(ConnectionEffectFailureClass::Auth))
            .await
            .unwrap(),
        ConnectionTestRunResult::Superseded {
            changed: vec![ConnectionEffectChangedDomain::Credential]
        }
    );
    // Retained and replacement fields preserve the complete resulting aggregate.
    let huge: Vec<_> = (0..5)
        .map(|i| json!({"name":format!("X-{i}"),"value":"ÿ".repeat(8192)}))
        .collect();
    assert!(replace(json!(huge[..3])).await.is_ok());
    let before = fixture
        .store
        .credential_status(locator.clone())
        .await
        .unwrap();
    let mut retained: Vec<_> = (0..3).map(|i| json!({"name":format!("X-{i}")})).collect();
    retained.extend_from_slice(&huge[3..]);
    assert!(matches!(
        replace(json!(retained)).await.unwrap(),
        RequestHeadersReplaceResult::Committed { .. }
    ));
    let current = fixture
        .store
        .credential_status(locator.clone())
        .await
        .unwrap();
    assert_ne!(current, before);
    let before = current;
    let headers: std::collections::BTreeMap<String, String> = serde_json::from_str(
        &fixture
            .store
            .credential_secret(&locator, None)
            .await
            .unwrap()
            .unwrap(),
    )
    .unwrap();
    assert_eq!(
        headers,
        (0..5)
            .map(|i| (format!("X-{i}"), "ÿ".repeat(8192)))
            .collect()
    );
    let saved = fixture
        .store
        .credential_secret(&locator, None)
        .await
        .unwrap()
        .unwrap();
    let locator_json = serde_json::to_string(&locator).unwrap();
    let expected = header_basis(&fixture).await;
    // Corrupt saved data cannot become an empty map or be overwritten by replacement.
    for invalid in [
        r#"[]"#,
        r#"{"X-Count":1}"#,
        r#"{"X-Keep":"old","x-keep":"ambiguous"}"#,
        r#"{"Host":"forbidden"}"#,
    ] {
        sqlx::query("UPDATE credentials SET secret = ? WHERE locator = ?")
            .bind(invalid)
            .bind(&locator_json)
            .execute(&mut sql)
            .await
            .unwrap();
        assert!(
            fixture
                .store
                .request_headers(fixture.id.clone())
                .await
                .is_err()
        );
        assert!(
            replace_headers(&fixture, expected.clone(), json!([]))
                .await
                .is_err()
        );
        assert_eq!(
            fixture
                .store
                .credential_status(locator.clone())
                .await
                .unwrap(),
            before
        );
        assert_eq!(
            sqlx::query_scalar::<_, String>("SELECT secret FROM credentials WHERE locator = ?")
                .bind(&locator_json)
                .fetch_one(&mut sql)
                .await
                .unwrap(),
            invalid
        );
    }
    sqlx::query("UPDATE credentials SET secret = ? WHERE locator = ?")
        .bind(saved)
        .bind(locator_json)
        .execute(&mut sql)
        .await
        .unwrap();
    sql.close().await.unwrap();
}

#[tokio::test]
async fn header_snapshots_reject_unseen_additions_secret_updates_and_connection_changes() {
    let fixture = Fixture::new().await;
    let empty = header_basis(&fixture).await;
    assert!(empty.credential.is_none());
    let created = replace_headers(
        &fixture,
        empty.clone(),
        json!([{"name":"X-Keep","value":"first-private-value"}]),
    )
    .await
    .unwrap();
    let RequestHeadersReplaceResult::Committed { basis: first, .. } = created else {
        panic!("expected header commit")
    };
    assert_eq!(first, header_basis(&fixture).await);
    assert!(matches!(
        replace_headers(&fixture, empty, json!([])).await.unwrap(),
        RequestHeadersReplaceResult::CredentialStale { expected: None, .. }
    ));

    let second = replace_headers(
        &fixture,
        first.clone(),
        json!([
            {"name":"X-Keep","value":"second-private-value"},
            {"name":"X-New","value":"new-private-value"}
        ]),
    )
    .await
    .unwrap();
    let RequestHeadersReplaceResult::Committed { basis: second, .. } = second else {
        panic!("expected second header commit")
    };
    let before = fixture.store.catalog().await.unwrap();
    for headers in [
        json!([{"name":"X-Keep"}]),
        json!([{"name":"X-Keep","value":"unseen-overwrite"}]),
    ] {
        assert_eq!(
            replace_headers(&fixture, first.clone(), headers)
                .await
                .unwrap(),
            RequestHeadersReplaceResult::CredentialStale {
                expected: first.credential.clone(),
                actual: second.credential.clone(),
            }
        );
    }
    assert_eq!(fixture.store.catalog().await.unwrap(), before);
    let locator = second.credential.as_ref().unwrap().locator.clone();
    assert_eq!(
        fixture
            .store
            .credential_secret(&locator, None)
            .await
            .unwrap()
            .unwrap(),
        r#"{"X-Keep":"second-private-value","X-New":"new-private-value"}"#
    );
    let query = fixture
        .store
        .request_headers(fixture.id.clone())
        .await
        .unwrap();
    assert!(
        !serde_json::to_string(&query)
            .unwrap()
            .contains("private-value")
    );

    fixture.edit(None).await;
    let latest = header_basis(&fixture).await;
    assert_eq!(
        replace_headers(&fixture, second.clone(), json!([]))
            .await
            .unwrap(),
        RequestHeadersReplaceResult::ConnectionStale {
            expected: second.connection,
            actual: latest.connection,
        }
    );
}

#[tokio::test]
async fn header_snapshot_allows_only_one_writer_and_rejects_recreated_credential() {
    let fixture = Fixture::new().await;
    let initial = header_basis(&fixture).await;
    let (left, right) = tokio::join!(
        replace_headers(
            &fixture,
            initial.clone(),
            json!([{"name":"X-Left","value":"left"}])
        ),
        replace_headers(
            &fixture,
            initial,
            json!([{"name":"X-Right","value":"right"}])
        )
    );
    let results = [left.unwrap(), right.unwrap()];
    assert_eq!(
        results
            .iter()
            .filter(|result| matches!(result, RequestHeadersReplaceResult::Committed { .. }))
            .count(),
        1
    );
    assert_eq!(
        results
            .iter()
            .filter(|result| matches!(result, RequestHeadersReplaceResult::CredentialStale { .. }))
            .count(),
        1
    );

    let original = header_basis(&fixture).await;
    let original_locator = &original.credential.as_ref().unwrap().locator;
    let secret = fixture
        .store
        .credential_secret(original_locator, None)
        .await
        .unwrap()
        .unwrap();
    let RequestHeadersReplaceResult::Committed { basis: empty, .. } =
        replace_headers(&fixture, original.clone(), json!([]))
            .await
            .unwrap()
    else {
        panic!("expected header deletion")
    };
    assert!(empty.credential.is_none());
    let recreated: Vec<_> =
        serde_json::from_str::<std::collections::BTreeMap<String, String>>(&secret)
            .unwrap()
            .into_iter()
            .map(|(name, value)| json!({"name":name,"value":value}))
            .collect();
    assert!(matches!(
        replace_headers(&fixture, empty, json!(recreated))
            .await
            .unwrap(),
        RequestHeadersReplaceResult::Committed { .. }
    ));
    let current = header_basis(&fixture).await;
    assert_eq!(
        original.credential.as_ref().unwrap().revision,
        current.credential.as_ref().unwrap().revision
    );
    assert_ne!(
        original.credential.as_ref().unwrap().credential_id,
        current.credential.as_ref().unwrap().credential_id
    );
    assert!(matches!(
        replace_headers(&fixture, original, json!([]))
            .await
            .unwrap(),
        RequestHeadersReplaceResult::CredentialStale { .. }
    ));
}
