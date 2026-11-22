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

#[tokio::test]
async fn login_rollback_unknown_commit_and_stale_tickets_never_publish_partial_success() {
    let temp = tempfile::tempdir().unwrap();
    let store = open(temp.path(), true).await;
    let input = create("atomic");
    let before = store.catalog().await.unwrap();
    let sql = sql(temp.path());
    sql.execute("CREATE TRIGGER fail_receipt BEFORE INSERT ON oauth_login_receipts BEGIN SELECT RAISE(ABORT, 'injected'); END", rusqlite::params![]).unwrap();
    assert!(
        prepare(&store, input.clone())
            .await
            .complete(credential("grant"), 1)
            .await
            .is_err()
    );
    assert_eq!(store.catalog().await.unwrap(), before);
    assert!(
        store
            .oauth_login_receipt("atomic".into())
            .await
            .unwrap()
            .is_none()
    );
    let count: i64 = sql
        .prepare_cached("SELECT COUNT(*) FROM credentials")
        .unwrap()
        .query_row(rusqlite::params![], |row| row.get(0))
        .unwrap();
    assert_eq!(
        count, 0,
        "receipt failure rolls back both connection and secret"
    );
    sql.execute("DROP TRIGGER fail_receipt", rusqlite::params![])
        .unwrap();
    sql.execute("CREATE TABLE deferred_failure (parent INTEGER REFERENCES credential_vault(singleton) DEFERRABLE INITIALLY DEFERRED)", rusqlite::params![]).unwrap();
    sql.execute("CREATE TRIGGER fail_commit AFTER INSERT ON oauth_login_receipts BEGIN INSERT INTO deferred_failure VALUES(2); END", rusqlite::params![]).unwrap();
    assert!(matches!(
        prepare(&store, input.clone())
            .await
            .complete(credential("grant"), 2)
            .await,
        Err(ConfigError::CommitUnknown)
    ));
    assert!(
        store
            .oauth_login_receipt("atomic".into())
            .await
            .unwrap()
            .is_none()
    );
    assert_eq!(store.catalog().await.unwrap(), before);
    sql.execute("DROP TRIGGER fail_commit", rusqlite::params![])
        .unwrap();
    let LoginCompletion::Committed(receipt) = prepare(&store, input)
        .await
        .complete(credential("grant"), 3)
        .await
        .unwrap()
    else {
        panic!("enrolled")
    };
    let id = &receipt.connection.connection_id;
    let input = existing(&store, "credential-race", id).await;
    let stale = prepare(&store, input.clone()).await;
    assert!(stale.claim().await.unwrap());
    let locator = CredentialLocator::Connection {
        connection_id: id.clone(),
        kind: ConnectionCredentialKind::Provider,
    };
    let CredentialVaultQueryResult::Status { status } =
        store.credential_status(locator.clone()).await.unwrap()
    else {
        panic!("connection exists")
    };
    let CredentialState::Configured {
        credential_id,
        revision,
        ..
    } = status.state
    else {
        panic!("configured")
    };
    sql.execute("CREATE TRIGGER fail_relogin BEFORE INSERT ON oauth_login_receipts BEGIN SELECT RAISE(ABORT, 'injected replacement failure'); END", rusqlite::params![]).unwrap();
    assert!(
        prepare(&store, existing(&store, "failed-relogin", id).await)
            .await
            .complete(credential("different-account"), 4)
            .await
            .is_err()
    );
    let restored: (String, i64, String) = sql
        .prepare_cached("SELECT credential_id, revision, secret FROM credentials WHERE locator = ?")
        .unwrap()
        .query_row(
            rusqlite::params![serde_json::to_string(&locator).unwrap()],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap();
    assert_eq!(
        restored,
        (
            credential_id.clone(),
            revision as i64,
            serde_json::to_string(&credential("grant")).unwrap()
        ),
        "failed enrollment must restore the old generation and grant"
    );
    assert!(
        store
            .oauth_login_receipt("failed-relogin".into())
            .await
            .unwrap()
            .is_none()
    );
    sql.execute("DROP TRIGGER fail_relogin", rusqlite::params![])
        .unwrap();
    assert!(matches!(
        store
            .delete_credential(DeleteCredentialInput {
                expected_connection: Some(match &input.target {
                    Target::Existing { expected, .. } => expected.clone(),
                    _ => unreachable!(),
                }),
                expected: CredentialVersionBasis {
                    locator: locator.clone(),
                    credential_id,
                    revision,
                }
            })
            .await
            .unwrap(),
        CredentialMutationResult::Committed { .. }
    ));
    assert!(matches!(
        stale.complete(credential("late"), 4).await.unwrap(),
        LoginCompletion::CredentialChanged
    ));
    assert_eq!(
        store
            .oauth_login_receipt(input.attempt_id)
            .await
            .unwrap()
            .unwrap()
            .phase,
        maka_agent_facts::oauth::Phase::Failed {
            failure: maka_agent_facts::oauth::Failure::CredentialChanged
        }
    );
    let stale = prepare(&store, existing(&store, "connection-race", id).await).await;
    assert!(stale.claim().await.unwrap());
    let row = store.catalog().await.unwrap().connections.remove(0);
    store
        .update_connection(UpdateCatalogConnectionInput {
            expected: ConnectionVersionBasis {
                connection_id: id.clone(),
                revision: row.revision,
            },
            changes: ConnectionCatalogEntryUpdate {
                name: Some("User edit".into()),
                enabled: Some(false),
                configuration: Some(row.configuration),
                enabled_model_ids: Some(row.enabled_model_ids),
                model_overrides: Patch::Keep,
                request_body_overlay: Patch::Keep,
            },
        })
        .await
        .unwrap();
    assert!(matches!(
        stale.complete(credential("late"), 5).await.unwrap(),
        LoginCompletion::ConnectionChanged
    ));
    assert_eq!(
        stale.complete(credential("late"), 5).await.unwrap(),
        LoginCompletion::ConnectionChanged,
        "lost conflict receipt must not become unknown or change its cause",
    );
    let ticket = prepare(&store, existing(&store, "reenable", id).await).await;
    assert!(ticket.connection().enabled);
    assert!(matches!(
        ticket.complete(credential("new-grant"), 6).await.unwrap(),
        LoginCompletion::Committed(_)
    ));
    assert!(store.catalog().await.unwrap().connections[0].enabled);
    let row = store.catalog().await.unwrap().connections.remove(0);
    store
        .remove_connection(RemoveCatalogConnectionInput {
            expected: ConnectionVersionBasis {
                connection_id: id.clone(),
                revision: row.revision,
            },
        })
        .await
        .unwrap();
    // A receipt is historical completion, not proof that the credential still exists.
    assert_eq!(
        store.oauth_login_receipt("atomic".into()).await.unwrap(),
        Some(*receipt)
    );
    assert!(matches!(
        store.credential_status(locator).await.unwrap(),
        CredentialVaultQueryResult::ConnectionNotFound
    ));
    sql.close().unwrap();
    store.shutdown().await.unwrap();
}
