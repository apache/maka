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
